"""P5.1/P5.3: rate limit, adaptive intervals, backoff + ciError, pinned repos, releases, flags."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.ci_poller import (
    CiPoller,
    GhResult,
    derive_pr_flags,
    map_pipeline_run,
    map_pull_request,
    map_releases,
    normalize_repo,
    parse_rate_limit,
    rollup_checks,
    short_error,
)

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


def _check(name: str, conclusion: str, start: str) -> dict[str, Any]:
    return {
        "__typename": "CheckRun",
        "name": name,
        "status": "COMPLETED",
        "conclusion": conclusion,
        "startedAt": start,
        "completedAt": start,
    }


def _raw_pr(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "number": 7,
        "title": "t",
        "headRefName": "b",
        "state": "OPEN",
        "updatedAt": "2026-11-07T10:00:00Z",
        "author": {"login": "alice"},
    }
    base.update(kw)
    return base


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Gh:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.prs: list[dict[str, Any]] = [_raw_pr()]
        self.rate: dict[str, Any] | None = None
        self.fail: GhResult | None = None
        self.release_fail = False

    async def __call__(self, args: list[str]) -> GhResult:
        self.calls.append(args)
        if args[0] == "api":
            return GhResult(0, json.dumps(self.rate or {}))
        if args[0] == "release":
            if self.release_fail:
                return GhResult(1, "", "boom")
            return GhResult(
                0,
                json.dumps(
                    [
                        {"tagName": "v1", "publishedAt": "2026-01-01T00:00:00Z"},
                        {"tagName": "v3", "publishedAt": "2026-03-01T00:00:00Z"},
                        {"tagName": "v2", "publishedAt": "2026-02-01T00:00:00Z", "isDraft": True},
                    ]
                ),
            )
        if args[0] == "repo":
            return GhResult(0, json.dumps({"defaultBranchRef": {"name": "trunk"}}))
        if self.fail:
            return self.fail
        return GhResult(0, json.dumps(self.prs if args[0] == "pr" else []))

    def n(self, cmd: str) -> int:
        return sum(1 for c in self.calls if c[0] == cmd)


def _poller(gh: Gh, clock: Clock, wall: float = 5000.0, **kw: Any) -> CiPoller:
    return CiPoller(
        run_gh=gh,
        is_watched=lambda: True,
        clock=clock,
        wall_clock=lambda: wall,
        interval=60.0,
        **kw,
    )


def _rate(remaining: int, reset: float = 5600.0) -> dict[str, Any]:
    b = {"limit": 5000, "remaining": remaining, "reset": reset}
    return {"resources": {"core": {**b, "remaining": 5000}, "graphql": b}}


class TestRateLimit:
    def test_parse_picks_scarcer_bucket(self) -> None:
        assert parse_rate_limit(_rate(100)) == (100, 5000, 5600.0)
        assert parse_rate_limit({}) is None
        assert parse_rate_limit("x") is None

    @pytest.mark.asyncio
    async def test_low_remaining_pauses_until_reset(self) -> None:
        gh, clock = Gh(), Clock()
        p = _poller(gh, clock)
        entry = p.note_repo("o/n", "main")
        await p.tick()  # arms the probe; polls
        assert gh.n("api") == 0 and entry.available
        gh.rate = _rate(20)
        clock.t += 301
        p.note_repo("o/n", "main")
        before = gh.n("pr")
        await p.tick()
        assert gh.n("api") == 1 and p.rate_remaining == 20
        assert gh.n("pr") == before  # no polling while paused
        assert entry.error and "rate limit" in entry.error and entry.stale
        clock.t += 300
        assert await p.tick() == 0  # still inside the 600 s pause
        gh.rate = _rate(4000)
        clock.t += 400
        p.note_repo("o/n", "main")
        assert await p.tick() == 1
        assert entry.error is None and not entry.stale

    @pytest.mark.asyncio
    async def test_healthy_remaining_keeps_polling(self) -> None:
        gh, clock = Gh(), Clock()
        gh.rate = _rate(4500)
        p = _poller(gh, clock)
        p.note_repo("o/n", "main")
        await p.tick()
        clock.t += 301
        p.note_repo("o/n", "main")
        assert await p.tick() == 1
        assert gh.n("api") == 1

    @pytest.mark.asyncio
    async def test_rate_limit_error_from_gh_pauses(self) -> None:
        gh, clock = Gh(), Clock()
        gh.fail = GhResult(1, "", "GraphQL: API rate limit exceeded for user")
        p = _poller(gh, clock)
        entry = p.note_repo("o/n", "main")
        await p.tick()
        assert entry.error == "GitHub rate limit reached"
        n = len(gh.calls)
        clock.t += 30
        assert await p.tick() == 0 and len(gh.calls) == n


class TestAdaptiveAndErrors:
    @pytest.mark.asyncio
    async def test_fast_while_running_slow_when_idle(self) -> None:
        gh, clock = Gh(), Clock()
        p = _poller(gh, clock)
        entry = p.note_repo("o/n", "main")
        gh.prs = [_raw_pr(statusCheckRollup=[{"name": "t", "status": "IN_PROGRESS"}])]
        await p.tick()
        assert entry.next_at - clock.t == pytest.approx(20.0)
        gh.prs = []
        clock.t = entry.next_at + 1
        p.note_repo("o/n", "main")
        await p.tick()
        assert entry.next_at - clock.t == pytest.approx(180.0)

    @pytest.mark.asyncio
    async def test_failure_sets_short_error_and_stale_keeps_data(self) -> None:
        gh, clock = Gh(), Clock()
        p = _poller(gh, clock)
        entry = p.note_repo("o/n", "main")
        await p.tick()
        assert entry.fetched_at and not entry.stale
        gh.fail = GhResult(1, "", "HTTP 502: Bad Gateway\nlong stack trace here " * 5)
        clock.t = entry.next_at + 1
        p.note_repo("o/n", "main")
        await p.tick()
        assert entry.error == "GitHub returned HTTP 502"
        assert entry.stale and entry.available and entry.pull_requests  # last-good kept
        assert entry.fails == 1
        gh.fail = None
        clock.t = entry.next_at + 1
        p.note_repo("o/n", "main")
        await p.tick()
        assert entry.error is None and not entry.stale

    def test_short_error_messages(self) -> None:
        assert short_error(TimeoutError()) == "gh timed out"
        assert short_error(RuntimeError("")) == "gh failed"
        assert len(short_error(RuntimeError("x" * 500))) < 80


class TestPinnedAndReleases:
    def test_normalize(self) -> None:
        assert normalize_repo(" a/b ") == "a/b"
        assert normalize_repo("https://github.com/a/b/") == "a/b"
        assert normalize_repo("nope") is None
        assert normalize_repo("a/b/c") is None
        assert normalize_repo(3) is None

    @pytest.mark.asyncio
    async def test_pinned_polled_without_session_and_never_forgotten(self) -> None:
        gh, clock = Gh(), Clock()
        p = _poller(gh, clock)
        assert p.set_pinned(["o/a", "bad", "o/a", "o/b"]) == ("o/a", "o/b")
        clock.t += 5000  # no campus build asked for them for ages
        assert await p.tick() == 2
        a = p.get("o/a")
        assert a is not None and a.available and a.default_branch == "trunk"
        assert gh.n("repo") == 2

    @pytest.mark.asyncio
    async def test_releases_latest_n_non_draft_and_cadence(self) -> None:
        gh, clock = Gh(), Clock()
        p = _poller(gh, clock, releases_limit=5)
        entry = p.note_repo("o/n", "main")
        await p.tick()
        assert [r.tag for r in entry.releases] == ["v3", "v1"]
        assert entry.releases[0].url == "https://github.com/o/n/releases/tag/v3"
        clock.t = entry.next_at + 1
        p.note_repo("o/n", "main")
        await p.tick()
        assert gh.n("release") == 1  # releases refresh far less often than PRs
        gh.release_fail = True
        clock.t += 700
        p.note_repo("o/n", "main")
        await p.tick()
        assert [r.tag for r in entry.releases] == ["v3", "v1"]  # kept on failure
        assert entry.available

    def test_map_releases_limit(self) -> None:
        raws = [{"tagName": f"v{i}", "publishedAt": f"2026-01-0{i}"} for i in range(1, 6)]
        assert [r.tag for r in map_releases(raws, "o/n", 2)] == ["v5", "v4"]

    def test_pinned_endpoint_roundtrip(self) -> None:
        from app.main import app

        client = TestClient(app)
        from app.core.ci_poller import reset_ci_poller

        reset_ci_poller(CiPoller())
        try:
            assert client.get("/api/v1/ci/pinned-repos").json() == {"repos": []}
            r = client.put("/api/v1/ci/pinned-repos", json={"repos": ["o/a", "o/b"]})
            assert r.status_code == 200 and r.json() == {"repos": ["o/a", "o/b"]}
            assert client.get("/api/v1/ci/pinned-repos").json() == {"repos": ["o/a", "o/b"]}
            assert (
                client.put("/api/v1/ci/pinned-repos", json={"repos": ["nope"]}).status_code == 400
            )
        finally:
            reset_ci_poller(None)


class TestFlags:
    def test_flaky_check_failed_then_passed(self) -> None:
        s = rollup_checks(
            [
                _check("test", "FAILURE", "2026-11-07T10:00:00Z"),
                _check("test", "SUCCESS", "2026-11-07T10:30:00Z"),
                _check("lint", "SUCCESS", "2026-11-07T10:00:00Z"),
            ]
        )
        by = {r.name: r for r in s.runs}
        assert by["test"].flaky and by["test"].attempt == 2 and s.state == "success"
        assert not by["lint"].flaky and by["lint"].attempt is None

    def test_not_flaky_when_latest_failed_or_only_success_reruns(self) -> None:
        bad = rollup_checks(
            [
                _check("t", "SUCCESS", "2026-11-07T10:00:00Z"),
                _check("t", "FAILURE", "2026-11-07T10:30:00Z"),
            ]
        )
        assert not bad.runs[0].flaky and bad.state == "failure"
        ok = rollup_checks(
            [
                _check("t", "SUCCESS", "2026-11-07T10:00:00Z"),
                _check("t", "SUCCESS", "2026-11-07T10:30:00Z"),
            ]
        )
        assert not ok.runs[0].flaky

    def test_pr_flaky_rolls_up(self) -> None:
        pr = map_pull_request(
            _raw_pr(
                statusCheckRollup=[
                    _check("t", "FAILURE", "2026-11-07T10:00:00Z"),
                    _check("t", "SUCCESS", "2026-11-07T10:30:00Z"),
                ]
            )
        )
        assert pr is not None and pr.flaky

    def test_pipeline_flaky_needs_attempt_gt_1_and_success(self) -> None:
        def run(attempt: int, conclusion: str) -> bool:
            r = map_pipeline_run(
                {
                    "databaseId": 1,
                    "workflowName": "CI",
                    "status": "completed",
                    "conclusion": conclusion,
                    "attempt": attempt,
                }
            )
            assert r is not None
            return r.flaky

        assert run(2, "success") and not run(1, "success") and not run(3, "failure")

    @pytest.mark.parametrize(
        ("login", "is_bot", "expected"),
        [
            ("dependabot[bot]", False, True),
            ("renovate", False, True),
            ("github-actions", False, True),
            ("app/renovate", False, True),
            ("someone", True, True),
            ("alice", False, False),
        ],
    )
    def test_bot(self, login: str, is_bot: bool, expected: bool) -> None:
        pr = map_pull_request(_raw_pr(author={"login": login, "is_bot": is_bot}))
        assert pr is not None and pr.bot is expected

    def test_conflict(self) -> None:
        a = map_pull_request(_raw_pr(mergeable="CONFLICTING"))
        b = map_pull_request(_raw_pr(mergeable="MERGEABLE"))
        assert a is not None and a.conflict and b is not None and not b.conflict

    def test_stale_after_n_days_open_only(self) -> None:
        old = (NOW - timedelta(days=15)).isoformat()
        fresh = (NOW - timedelta(days=3)).isoformat()
        o = map_pull_request(_raw_pr(updatedAt=old))
        f = map_pull_request(_raw_pr(updatedAt=fresh))
        m = map_pull_request(_raw_pr(updatedAt=old, state="MERGED"))
        assert o and f and m
        assert derive_pr_flags(o, NOW, 14).stale
        assert not derive_pr_flags(f, NOW, 14).stale
        assert not derive_pr_flags(m, NOW, 14).stale
        assert not derive_pr_flags(o, NOW, 30).stale
