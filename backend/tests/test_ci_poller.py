"""gh JSON mapping, check rollup precedence, poll-only-when-watched, backoff."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.core.ci_poller import (
    CiPoller,
    GhMissingError,
    GhResult,
    map_pipeline_runs,
    map_pull_request,
    map_pull_requests,
    rollup_checks,
)

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


def _cr(
    name: str,
    status: str = "COMPLETED",
    conclusion: str = "SUCCESS",
    start: str = "2026-11-07T11:00:00Z",
    end: str = "2026-11-07T11:02:00Z",
) -> dict[str, Any]:
    return {
        "__typename": "CheckRun",
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "startedAt": start,
        "completedAt": end,
        "detailsUrl": f"https://x/{name}",
    }


class TestRollup:
    def test_all_success(self) -> None:
        s = rollup_checks(
            [_cr("a"), _cr("b", conclusion="SKIPPED"), _cr("c", conclusion="NEUTRAL")]
        )
        assert (s.state, s.total, s.passed, s.failed, s.pending) == ("success", 3, 3, 0, 0)
        assert s.runs[0].duration_s == 120.0

    def test_failure_beats_running_beats_queued(self) -> None:
        run = _cr("r", status="IN_PROGRESS", conclusion="")
        queued = _cr("q", status="QUEUED", conclusion="")
        ok = _cr("ok")
        bad = _cr("bad", conclusion="FAILURE")
        assert rollup_checks([ok, queued, run, bad]).state == "failure"
        assert rollup_checks([ok, queued, run]).state == "running"
        assert rollup_checks([ok, queued]).state == "queued"
        s = rollup_checks([ok, queued, run, bad])
        assert (s.failed, s.pending, s.passed) == (1, 2, 1)
        assert [r.name for r in s.runs][0] == "bad"  # failures first

    def test_cancelled_only_wins_without_success(self) -> None:
        c = _cr("c", conclusion="CANCELLED")
        assert rollup_checks([c]).state == "cancelled"
        assert rollup_checks([c, _cr("ok")]).state == "success"

    def test_status_context(self) -> None:
        ctx = {
            "__typename": "StatusContext",
            "context": "ci/legacy",
            "state": "PENDING",
            "targetUrl": "u",
        }
        s = rollup_checks([ctx, _cr("ok")])
        assert s.state == "queued"
        assert s.runs[0].name == "ci/legacy"
        assert rollup_checks([{**ctx, "state": "ERROR"}]).state == "failure"

    def test_rerun_dedup_latest_wins(self) -> None:
        old = _cr("t", conclusion="FAILURE", start="2026-11-07T10:00:00Z")
        new = _cr("t", conclusion="SUCCESS", start="2026-11-07T11:00:00Z")
        assert rollup_checks([new, old]).state == "success"
        assert rollup_checks([old, new]).total == 1

    def test_empty_and_garbage(self) -> None:
        assert rollup_checks([]).state == "none"
        assert rollup_checks(None).total == 0
        assert rollup_checks(["x", 3]).total == 0

    def test_runs_capped(self) -> None:
        assert len(rollup_checks([_cr(f"c{i}") for i in range(30)]).runs) == 12
        assert rollup_checks([_cr(f"c{i}") for i in range(30)]).total == 30


def _pr(number: int, state: str = "OPEN", **kw: Any) -> dict[str, Any]:
    return {
        "number": number,
        "title": f"PR {number}",
        "headRefName": f"feat-{number}",
        "author": {"login": "fastlorenzo"},
        "url": f"https://github.com/o/n/pull/{number}",
        "isDraft": False,
        "state": state,
        "reviewDecision": "APPROVED",
        "mergeable": "MERGEABLE",
        "statusCheckRollup": [_cr("build")],
        "updatedAt": "2026-11-07T11:30:00Z",
        "mergedAt": None,
        "closedAt": None,
        **kw,
    }


class TestPullRequests:
    def test_mapping(self) -> None:
        pr = map_pull_request(
            _pr(7, isDraft=True, reviewDecision="CHANGES_REQUESTED", mergeable="CONFLICTING")
        )
        assert pr is not None
        assert (pr.number, pr.branch, pr.author, pr.draft, pr.state) == (
            7,
            "feat-7",
            "fastlorenzo",
            True,
            "open",
        )
        assert pr.review_decision == "changes_requested"
        assert pr.mergeable == "conflicting"
        assert pr.checks.state == "success"
        dumped = pr.model_dump(by_alias=True)
        assert "reviewDecision" in dumped and "updatedAt" in dumped

    def test_unknown_values_become_none(self) -> None:
        pr = map_pull_request(_pr(1, reviewDecision="", mergeable="WHATEVER"))
        assert pr is not None
        assert pr.review_decision is None and pr.mergeable is None
        assert map_pull_request({"number": 1, "state": "WEIRD"}) is None

    def test_recent_window_and_order(self) -> None:
        recent = (NOW - timedelta(hours=3)).isoformat()
        stale = (NOW - timedelta(hours=30)).isoformat()
        prs = map_pull_requests(
            [
                _pr(1, "MERGED", mergedAt=recent, updatedAt="2026-11-07T11:59:00Z"),
                _pr(2, "MERGED", mergedAt=stale),
                _pr(3, "CLOSED", closedAt=recent),
                _pr(4, "OPEN", updatedAt="2026-11-07T08:00:00Z"),
                _pr(5, "CLOSED"),  # no closedAt: dropped
            ],
            NOW,
        )
        assert [p.number for p in prs] == [4, 1, 3]  # open first, then newest


class TestPipelines:
    def _run(
        self,
        i: int,
        wf: str,
        branch: str,
        event: str = "push",
        status: str = "completed",
        conc: str = "success",
    ) -> dict[str, Any]:
        return {
            "databaseId": i,
            "workflowName": wf,
            "headBranch": branch,
            "event": event,
            "status": status,
            "conclusion": conc,
            "createdAt": f"2026-11-07T11:{i:02d}:00Z",
            "updatedAt": f"2026-11-07T11:{i:02d}:30Z",
            "url": f"https://x/{i}",
        }

    def test_filter_kind_order(self) -> None:
        runs = map_pipeline_runs(
            [
                self._run(1, "CI", "main"),
                self._run(2, "CI", "feature/x", event="pull_request"),
                self._run(3, "Deploy to prod", "main", conc="failure"),
                self._run(4, "Build wheels", "v1.2.0"),
                self._run(5, "Docs", "main", status="in_progress", conc=""),
                self._run(6, "Publish", "main", event="release"),
            ],
            "main",
        )
        assert [r.id for r in runs] == ["6", "5", "4", "3", "1"]
        kinds = {r.id: r.kind for r in runs}
        assert kinds == {"6": "release", "5": "other", "4": "ci", "3": "deploy", "1": "ci"}
        by_id = {r.id: r for r in runs}
        assert by_id["3"].state == "failure"
        assert by_id["5"].state == "running" and by_id["5"].duration_s is None
        assert by_id["1"].duration_s == 30.0

    def test_unknown_default_branch_keeps_all_and_caps(self) -> None:
        raws = [self._run(i % 50, "CI", f"b{i}") for i in range(15)]
        assert len(map_pipeline_runs(raws, None)) == 10


class FakeGh:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.fail: Exception | GhResult | None = None
        self.max_active = 0
        self._active = 0

    async def __call__(self, args: list[str]) -> GhResult:
        import asyncio

        self._active += 1
        self.max_active = max(self.max_active, self._active)
        try:
            await asyncio.sleep(0)
            self.calls.append(args)
            if isinstance(self.fail, Exception):
                raise self.fail
            if isinstance(self.fail, GhResult):
                return self.fail
            return GhResult(0, json.dumps([_pr(1)] if args[0] == "pr" else []))
        finally:
            self._active -= 1


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _poller(gh: FakeGh, watched: list[bool], clock: Clock, changes: list[int]) -> CiPoller:
    return CiPoller(
        run_gh=gh,
        is_watched=lambda: watched[0],
        on_change=lambda: changes.append(1),
        clock=clock,
        interval=60.0,
    )


class TestPoller:
    @pytest.mark.asyncio
    async def test_polls_only_while_watched(self) -> None:
        gh, watched, clock, changes = FakeGh(), [False], Clock(), []
        p = _poller(gh, watched, clock, changes)
        p.note_repo("o/n", "main")
        assert await p.tick() == 0
        assert gh.calls == []
        watched[0] = True
        assert await p.tick() == 1
        assert len(gh.calls) == 2
        assert gh.calls[0][:4] == ["pr", "list", "--repo", "o/n"]
        assert gh.calls[1][:2] == ["run", "list"]
        entry = p.get("o/n")
        assert entry is not None and entry.available and entry.pull_requests[0].number == 1
        assert changes == [1]
        # cached until the interval elapses; an unchanged refresh does not broadcast
        assert await p.tick() == 0
        clock.t += 61
        assert await p.tick() == 1
        assert changes == [1]
        # watcher leaves: no more calls even when due
        watched[0] = False
        clock.t += 500
        n = len(gh.calls)
        assert await p.tick() == 0
        assert len(gh.calls) == n

    @pytest.mark.asyncio
    async def test_at_most_two_concurrent_gh(self) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        p = _poller(gh, watched, clock, [])
        for i in range(6):
            p.note_repo(f"o/r{i}", "main")
        await p.tick()
        assert gh.max_active <= 2
        assert len(gh.calls) == 12

    @pytest.mark.asyncio
    async def test_exponential_backoff_and_recovery(self) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        p = _poller(gh, watched, clock, [])
        entry = p.note_repo("o/n", "main")
        gh.fail = GhResult(1, "", "HTTP 502 bad gateway")
        delays: list[float] = []
        for _ in range(4):
            start = clock.t
            p.note_repo("o/n", "main")
            await p.tick()
            delays.append(entry.next_at - start)
            clock.t = entry.next_at + 0.1
        assert delays == [60.0, 120.0, 240.0, 480.0]
        last = 0.0
        for _ in range(3):
            start = clock.t
            p.note_repo("o/n", "main")
            await p.tick()
            last = entry.next_at - start
            clock.t = entry.next_at + 0.1
        assert last == pytest.approx(900.0)  # capped
        gh.fail = None
        p.note_repo("o/n", "main")
        await p.tick()
        assert entry.fails == 0 and entry.available
        assert entry.next_at - clock.t == 60.0

    @pytest.mark.asyncio
    async def test_timeout_counts_as_failure(self) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        gh.fail = TimeoutError()
        p = _poller(gh, watched, clock, [])
        entry = p.note_repo("o/n", None)
        await p.tick()
        assert entry.fails == 1 and not entry.available

    @pytest.mark.asyncio
    async def test_gh_missing_disables_everything_quietly(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        gh.fail = GhMissingError()
        p = _poller(gh, watched, clock, [])
        p.note_repo("o/a", None)
        p.note_repo("o/b", None)
        with caplog.at_level("DEBUG"):
            await p.tick()
            n = len(gh.calls)
            clock.t += 120
            assert await p.tick() == 0  # globally parked, not retried every tick
            assert len(gh.calls) == n
        assert p.gh_available is False
        assert not any(p.get(r).available for r in ("o/a", "o/b"))  # type: ignore[union-attr]
        assert len([r for r in caplog.records if r.levelname == "INFO"]) <= 1
        clock.t += 700
        gh.fail = None
        assert await p.tick() == 2
        assert p.get("o/a").available  # type: ignore[union-attr]

    @pytest.mark.asyncio
    async def test_unauthenticated_and_repo_gone(self) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        p = _poller(gh, watched, clock, [])
        a = p.note_repo("o/a", None)
        gh.fail = GhResult(4, "", "To get started with GitHub CLI, please run:  gh auth login")
        await p.tick()
        assert p.gh_available is False and not a.available
        # repo-specific 404 only parks that repo
        gh2, p2 = FakeGh(), None
        p2 = _poller(gh2, [True], Clock(), [])
        b = p2.note_repo("o/b", None)
        gh2.fail = GhResult(
            1, "", "GraphQL: Could not resolve to a Repository with the name 'o/b'."
        )
        await p2.tick()
        assert not b.available and p2.gh_available is not False
        assert b.next_at - 1000.0 == 1800.0

    @pytest.mark.asyncio
    async def test_stale_repos_forgotten(self) -> None:
        gh, watched, clock = FakeGh(), [True], Clock()
        p = _poller(gh, watched, clock, [])
        p.note_repo("o/n", None)
        clock.t += 2000
        await p.tick()
        assert p.get("o/n") is None
