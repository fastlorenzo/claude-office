"""GitHub CI/CD data for the campus projects, via the ``gh`` CLI.

Polls (default every 60 s per repo) ONLY while at least one ``/ws/campus``
client is connected, at most ``MAX_CONCURRENT_GH`` gh processes at a time, each
with a timeout. Failures back off exponentially; a missing or unauthenticated
``gh`` disables CI globally for a while (``ciAvailable=false``) instead of
retrying every tick. Nothing here ever raises into the caller.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from app.models.ci import (
    CheckKind,
    CheckRun,
    CheckState,
    CheckSummary,
    PipelineRun,
    PrLabel,
    PullRequestInfo,
)

logger = logging.getLogger(__name__)

__all__ = [
    "CiPoller",
    "GhResult",
    "RepoCi",
    "get_ci_poller",
    "map_pull_request",
    "map_pipeline_run",
    "rollup_checks",
    "reset_ci_poller",
]

MAX_CONCURRENT_GH = 2
GH_TIMEOUT_S = 20.0
POLL_INTERVAL_S = 60.0
TICK_S = 5.0
MAX_BACKOFF_S = 900.0
GH_DOWN_RETRY_S = 600.0  # gh missing / not logged in: look again after 10 min
REPO_GONE_RETRY_S = 1800.0
REPO_FORGET_S = 900.0  # stop polling repos no campus build asked about for this long
MAX_CHECK_RUNS = 12
MAX_PIPELINES = 10
MAX_PRS = 20
RECENT_PR_WINDOW = timedelta(hours=24)

PR_FIELDS = (
    "number,title,headRefName,author,url,isDraft,state,reviewDecision,mergeable,"
    "statusCheckRollup,updatedAt,mergedAt,closedAt,baseRefName,additions,deletions,changedFiles,"
    "labels,createdAt"
)
RUN_FIELDS = (
    "databaseId,workflowName,headBranch,headSha,event,status,conclusion,"
    "createdAt,updatedAt,url,attempt"
)


@dataclass
class GhResult:
    returncode: int
    stdout: str
    stderr: str = ""


GhRunner = Callable[[list[str]], Awaitable[GhResult]]


class GhMissingError(Exception):
    """``gh`` is not installed."""


class GhAuthError(Exception):
    """``gh`` is not authenticated."""


class RepoGoneError(Exception):
    """The repo is not reachable through GitHub (404 / no access)."""


# ---------------------------------------------------------------------------
# Mapping (pure)
# ---------------------------------------------------------------------------

_PENDING_RANK: dict[CheckState, int] = {
    "failure": 5,
    "running": 4,
    "queued": 3,
    "cancelled": 2,
    "success": 1,
    "none": 0,
}


def _parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value or value.startswith("0001"):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _s(v: Any) -> str | None:
    return v if isinstance(v, str) and v else None


def _duration(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None or end < start:
        return None
    return round((end - start).total_seconds(), 1)


def state_from_status_conclusion(status: Any, conclusion: Any) -> CheckState:
    """GitHub Actions/Checks ``status`` + ``conclusion`` -> CheckState."""
    st = str(status or "").upper()
    if st and st != "COMPLETED":
        return "running" if st == "IN_PROGRESS" else "queued"
    c = str(conclusion or "").upper()
    if c in ("SUCCESS", "NEUTRAL", "SKIPPED"):
        return "success"
    if c == "CANCELLED":
        return "cancelled"
    if c in ("FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE", "ERROR"):
        return "failure"
    return "none"


def _status_context_state(state: Any) -> CheckState:
    s = str(state or "").upper()
    if s == "SUCCESS":
        return "success"
    if s in ("FAILURE", "ERROR"):
        return "failure"
    if s in ("PENDING", "EXPECTED"):
        return "queued"
    return "none"


_KIND_PATTERNS: list[tuple[CheckKind, re.Pattern[str]]] = [
    (
        "security",
        re.compile(r"secur|codeql|snyk|trivy|semgrep|audit|vuln|secret|sast|dependabot", re.I),
    ),
    ("deploy", re.compile(r"deploy|rollout|\bcd\b|preview|staging", re.I)),
    ("release", re.compile(r"release|publish", re.I)),
    (
        "lint",
        re.compile(
            r"lint|format|fmt|prettier|ruff|eslint|style|typecheck|type-check|mypy|tsc", re.I
        ),
    ),
    ("test", re.compile(r"test|pytest|vitest|jest|spec|e2e|unit|integration|coverage", re.I)),
    ("build", re.compile(r"build|compile|bundle|package|docker|image", re.I)),
]


def classify_check(name: str) -> CheckKind:
    """Classify a check name into a CheckKind (first matching pattern wins)."""
    for kind, pat in _KIND_PATTERNS:
        if pat.search(name):
            return kind
    return "other"


def rollup_checks(entries: Any) -> CheckSummary:
    """Roll a ``statusCheckRollup`` array (CheckRun + StatusContext) into a summary.

    Re-runs of the same check name are de-duplicated (latest start wins).
    Precedence: failure > running > queued > cancelled > success > none; a lone
    cancelled run next to successes does not mask them (it is usually a
    superseded run), so ``cancelled`` only wins when nothing succeeded.
    """
    latest: dict[str, tuple[datetime | None, CheckRun]] = {}
    if isinstance(entries, list):
        for raw in cast(list[Any], entries):
            if not isinstance(raw, dict):
                continue
            e = cast(dict[str, Any], raw)
            if e.get("__typename") == "StatusContext" or ("context" in e and "name" not in e):
                name = _s(e.get("context")) or "status"
                state = _status_context_state(e.get("state"))
                started = _parse_dt(e.get("startedAt"))
                run = CheckRun(
                    name=name,
                    state=state,
                    started_at=_s(e.get("startedAt")),
                    url=_s(e.get("targetUrl")),
                    kind=classify_check(name),
                )
            else:
                name = _s(e.get("name")) or _s(e.get("workflowName")) or "check"
                state = state_from_status_conclusion(e.get("status"), e.get("conclusion"))
                started = _parse_dt(e.get("startedAt"))
                done = _parse_dt(e.get("completedAt"))
                run = CheckRun(
                    name=name,
                    state=state,
                    started_at=_s(e.get("startedAt")),
                    duration_s=_duration(started, done)
                    if state in ("success", "failure", "cancelled")
                    else None,
                    url=_s(e.get("detailsUrl")),
                    kind=classify_check(name),
                )
            prev = latest.get(name)
            if prev is None or (started or datetime.min.replace(tzinfo=UTC)) >= (
                prev[0] or datetime.min.replace(tzinfo=UTC)
            ):
                latest[name] = (started, run)

    runs = [r for _, r in latest.values()]
    counts: dict[CheckState, int] = {}
    for r in runs:
        counts[r.state] = counts.get(r.state, 0) + 1
    failed = counts.get("failure", 0)
    pending = counts.get("running", 0) + counts.get("queued", 0)
    passed = counts.get("success", 0)
    if failed:
        rolled: CheckState = "failure"
    elif counts.get("running"):
        rolled = "running"
    elif counts.get("queued"):
        rolled = "queued"
    elif passed:
        rolled = "success"
    elif counts.get("cancelled"):
        rolled = "cancelled"
    else:
        rolled = "none"
    runs.sort(key=lambda r: (-_PENDING_RANK[r.state], r.name))
    return CheckSummary(
        state=rolled,
        total=len(runs),
        passed=passed,
        failed=failed,
        pending=pending,
        runs=runs[:MAX_CHECK_RUNS],
    )


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _labels(raw: Any) -> list[PrLabel]:
    out: list[PrLabel] = []
    if isinstance(raw, list):
        for item in cast(list[Any], raw):
            if not isinstance(item, dict):
                continue
            d = cast(dict[str, Any], item)
            name = _s(d.get("name"))
            if not name:
                continue
            color = _s(d.get("color"))
            if color and not color.startswith("#"):
                color = f"#{color}"
            out.append(PrLabel(name=name, color=color))
    return out


def _is_bot(author: Any, login: str | None) -> bool:
    if isinstance(author, dict) and cast(dict[str, Any], author).get("is_bot") is True:
        return True
    return bool(login) and bool(_BOT_RE.search(login or ""))


_BOT_RE = re.compile(r"dependabot|renovate|github-actions|\[bot\]$|^app/", re.I)


def map_pull_request(raw: dict[str, Any]) -> PullRequestInfo | None:
    """One ``gh pr list --json`` entry -> PullRequestInfo (None when unusable)."""
    number = raw.get("number")
    if not isinstance(number, int):
        return None
    state_raw = str(raw.get("state") or "").upper()
    state = {"OPEN": "open", "MERGED": "merged", "CLOSED": "closed"}.get(state_raw)
    if state is None:
        return None
    author = raw.get("author")
    login = _s(cast(dict[str, Any], author).get("login")) if isinstance(author, dict) else None
    review = {
        "APPROVED": "approved",
        "CHANGES_REQUESTED": "changes_requested",
        "REVIEW_REQUIRED": "review_required",
    }.get(str(raw.get("reviewDecision") or "").upper())
    mergeable = {"MERGEABLE": "mergeable", "CONFLICTING": "conflicting", "UNKNOWN": "unknown"}.get(
        str(raw.get("mergeable") or "").upper()
    )
    return PullRequestInfo(
        base_branch=_s(raw.get("baseRefName")),
        additions=_int(raw.get("additions")),
        deletions=_int(raw.get("deletions")),
        changed_files=_int(raw.get("changedFiles")),
        labels=_labels(raw.get("labels")),
        bot=_is_bot(author, login),
        created_at=_s(raw.get("createdAt")),
        merged_at=_s(raw.get("mergedAt")),
        closed_at=_s(raw.get("closedAt")),
        number=number,
        title=_s(raw.get("title")) or f"#{number}",
        branch=_s(raw.get("headRefName")) or "",
        author=login,
        url=_s(raw.get("url")),
        draft=bool(raw.get("isDraft")),
        state=state,  # type: ignore[arg-type]
        review_decision=review,  # type: ignore[arg-type]
        mergeable=mergeable,  # type: ignore[arg-type]
        checks=rollup_checks(raw.get("statusCheckRollup")),
        updated_at=_s(raw.get("updatedAt")) or "",
    )


def map_pull_requests(raws: Any, now: datetime) -> list[PullRequestInfo]:
    """Open PRs plus PRs merged/closed within 24 h; open first, newest first, <= 20."""
    out: list[tuple[int, str, PullRequestInfo]] = []
    if not isinstance(raws, list):
        return []
    for item in cast(list[Any], raws):
        if not isinstance(item, dict):
            continue
        raw = cast(dict[str, Any], item)
        pr = map_pull_request(raw)
        if pr is None:
            continue
        if pr.state != "open":
            ended = _parse_dt(raw.get("mergedAt")) or _parse_dt(raw.get("closedAt"))
            if ended is None or now - ended > RECENT_PR_WINDOW:
                continue
        out.append((0 if pr.state == "open" else 1, pr.updated_at, pr))
    out.sort(key=lambda t: t[1], reverse=True)
    out.sort(key=lambda t: t[0])
    return [pr for _, _, pr in out][:MAX_PRS]


_DEPLOY_RE = re.compile(r"deploy|rollout|\bcd\b", re.I)
_RELEASE_RE = re.compile(r"release|publish|tag", re.I)
_CI_RE = re.compile(r"\bci\b|test|build|lint|check|verify|validate|pytest|typecheck", re.I)
_TAG_RE = re.compile(r"^v?\d+(\.\d+)+")


def _pipeline_kind(workflow: str, event: str) -> str:
    if _DEPLOY_RE.search(workflow):
        return "deploy"
    if event == "release" or _RELEASE_RE.search(workflow):
        return "release"
    if event == "pull_request" or _CI_RE.search(workflow):
        return "ci"
    return "other"


def map_pipeline_run(raw: dict[str, Any]) -> PipelineRun | None:
    rid = raw.get("databaseId")
    if not isinstance(rid, (int, str)) or isinstance(rid, bool):
        return None
    workflow = _s(raw.get("workflowName")) or "workflow"
    state = state_from_status_conclusion(raw.get("status"), raw.get("conclusion"))
    created = _parse_dt(raw.get("createdAt"))
    updated = _parse_dt(raw.get("updatedAt"))
    return PipelineRun(
        id=str(rid),
        workflow=workflow,
        kind=_pipeline_kind(workflow, str(raw.get("event") or "")),  # type: ignore[arg-type]
        branch=_s(raw.get("headBranch")),
        event=_s(raw.get("event")),
        head_sha=_s(raw.get("headSha")),
        attempt=_int(raw.get("attempt")),
        state=state,
        started_at=_s(raw.get("createdAt")),
        duration_s=_duration(created, updated)
        if state in ("success", "failure", "cancelled")
        else None,
        url=_s(raw.get("url")),
    )


def map_pipeline_runs(raws: Any, default_branch: str | None) -> list[PipelineRun]:
    """Runs on the default branch and on tags (version-like refs / release events)."""
    out: list[PipelineRun] = []
    if not isinstance(raws, list):
        return out
    for item in cast(list[Any], raws):
        if not isinstance(item, dict):
            continue
        raw = cast(dict[str, Any], item)
        branch = _s(raw.get("headBranch")) or ""
        is_tag = raw.get("event") == "release" or (
            raw.get("event") == "push" and bool(_TAG_RE.match(branch))
        )
        if default_branch and branch != default_branch and not is_tag:
            continue
        run = map_pipeline_run(raw)
        if run is not None:
            out.append(run)
    out.sort(key=lambda r: r.started_at or "", reverse=True)
    return out[:MAX_PIPELINES]


# ---------------------------------------------------------------------------
# Poller
# ---------------------------------------------------------------------------


@dataclass
class RepoCi:
    """Cached CI data for one repo."""

    pull_requests: list[PullRequestInfo] = field(
        default_factory=lambda: cast(list[PullRequestInfo], [])
    )
    pipelines: list[PipelineRun] = field(default_factory=lambda: cast(list[PipelineRun], []))
    available: bool = False
    fails: int = 0
    next_at: float = 0.0  # monotonic
    last_seen: float = 0.0  # monotonic, last time a campus build asked for this repo
    default_branch: str | None = None


async def _run_gh(args: list[str]) -> GhResult:
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1", "GH_NO_UPDATE_NOTIFIER": "1"}
    try:
        proc = await asyncio.create_subprocess_exec(
            "gh",
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as exc:
        raise GhMissingError from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=GH_TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return GhResult(
        proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    )


def _classify_failure(res: GhResult) -> Exception:
    err = res.stderr.lower()
    if (
        "auth login" in err
        or "not logged in" in err
        or "authentication" in err
        or "gh_token" in err
    ):
        return GhAuthError(res.stderr.strip()[:200])
    if "could not resolve to a repository" in err or "http 404" in err or "not found" in err:
        return RepoGoneError(res.stderr.strip()[:200])
    return RuntimeError(res.stderr.strip()[:200] or f"gh exited {res.returncode}")


class CiPoller:
    def __init__(
        self,
        *,
        run_gh: GhRunner | None = None,
        is_watched: Callable[[], bool] | None = None,
        on_change: Callable[[], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        interval: float = POLL_INTERVAL_S,
    ) -> None:
        self._run_gh = run_gh or _run_gh
        self._is_watched = is_watched or (lambda: False)
        self._on_change = on_change
        self._clock = clock
        self._interval = interval
        self._repos: dict[str, RepoCi] = {}
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_GH)
        self._gh_down_until = 0.0
        self.gh_available: bool | None = None  # None until the first call
        self._warned: set[str] = set()

    def configure(self, *, on_change: Callable[[], None] | None, interval: float) -> None:
        self._on_change = on_change
        self._interval = interval

    # -- read side (called while building the campus; no IO) ----------------

    def note_repo(self, repo: str, default_branch: str | None) -> RepoCi:
        entry = self._repos.get(repo)
        if entry is None:
            entry = self._repos[repo] = RepoCi()
        entry.last_seen = self._clock()
        if default_branch:
            entry.default_branch = default_branch
        return entry

    def get(self, repo: str) -> RepoCi | None:
        return self._repos.get(repo)

    # -- polling -------------------------------------------------------------

    async def tick(self) -> int:
        """Poll every due repo (only when a campus client is watching). Returns #polled."""
        if not self._is_watched():
            return 0
        now = self._clock()
        if now < self._gh_down_until:
            return 0
        for repo in [r for r, e in self._repos.items() if now - e.last_seen > REPO_FORGET_S]:
            del self._repos[repo]
        due = [r for r, e in self._repos.items() if e.next_at <= now]
        if not due:
            return 0
        results = await asyncio.gather(*(self._poll_repo(r) for r in due), return_exceptions=True)
        if any(r is True for r in results) and self._on_change is not None:
            self._on_change()
        return len(due)

    async def _call(self, args: list[str]) -> Any:
        async with self._sem:
            res = await self._run_gh(args)
        if res.returncode != 0:
            raise _classify_failure(res)
        try:
            return json.loads(res.stdout or "null")
        except ValueError as exc:
            raise RuntimeError("gh returned invalid JSON") from exc

    async def _poll_repo(self, repo: str) -> bool:
        """Fetch one repo; returns True when its cached data changed."""
        entry = self._repos.get(repo)
        if entry is None:
            return False
        before = (entry.pull_requests, entry.pipelines, entry.available)
        try:
            prs = await self._call(
                [
                    "pr",
                    "list",
                    "--repo",
                    repo,
                    "--state",
                    "all",
                    "--limit",
                    "30",
                    "--json",
                    PR_FIELDS,
                ]
            )
            runs = await self._call(
                ["run", "list", "--repo", repo, "--limit", "15", "--json", RUN_FIELDS]
            )
        except GhMissingError:
            self._gh_down("gh-missing", "gh CLI not found; CI/CD data disabled")
            return self._mark_unavailable(entry, before)
        except GhAuthError:
            self._gh_down(
                "gh-auth", "gh is not authenticated (run `gh auth login`); CI/CD data disabled"
            )
            return self._mark_unavailable(entry, before)
        except RepoGoneError:
            entry.next_at = self._clock() + REPO_GONE_RETRY_S
            self._warn_once(f"gone:{repo}", f"gh cannot access {repo}; skipping CI for it")
            return self._mark_unavailable(entry, before)
        except (TimeoutError, RuntimeError, OSError) as exc:
            entry.fails += 1
            delay = min(self._interval * 2 ** (entry.fails - 1), MAX_BACKOFF_S)
            entry.next_at = self._clock() + delay
            logger.debug("gh poll for %s failed (%s); retry in %.0fs", repo, exc, delay)
            return False
        self.gh_available = True
        entry.fails = 0
        entry.next_at = self._clock() + self._interval
        entry.available = True
        entry.pull_requests = map_pull_requests(prs, datetime.now(UTC))
        entry.pipelines = map_pipeline_runs(runs, entry.default_branch)
        return before != (entry.pull_requests, entry.pipelines, entry.available)

    def _mark_unavailable(self, entry: RepoCi, before: tuple[Any, ...]) -> bool:
        entry.available = False
        entry.pull_requests = []
        entry.pipelines = []
        return before != ([], [], False)

    def _gh_down(self, key: str, message: str) -> None:
        self.gh_available = False
        self._gh_down_until = self._clock() + GH_DOWN_RETRY_S
        self._warn_once(key, message)
        for entry in self._repos.values():
            entry.available = False

    def _warn_once(self, key: str, message: str) -> None:
        if key not in self._warned:
            self._warned.add(key)
            logger.info(message)

    async def run(self) -> None:
        """Background loop (started from the app lifespan)."""
        while True:
            await asyncio.sleep(TICK_S)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("CI poll tick failed", exc_info=True)


_poller: CiPoller | None = None


def get_ci_poller() -> CiPoller:
    global _poller
    if _poller is None:
        from app.core.connection_manager import get_manager

        _poller = CiPoller(is_watched=lambda: bool(get_manager().campus_connections))
    return _poller


def reset_ci_poller(poller: CiPoller | None = None) -> None:
    """Swap the process-wide poller (tests)."""
    global _poller
    _poller = poller
