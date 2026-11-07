"""P5.2: local git parsing, TTL cache, timeouts; build_projects pinned + localGit wiring."""

from datetime import UTC, datetime

import pytest

from app.core.ci_poller import CiPoller, reset_ci_poller
from app.core.local_git import (
    GitResult,
    LocalGitIntake,
    parse_status_v2,
    parse_worktrees,
    reset_local_git,
)
from app.core.projects import ProjectRef, _by_id  # pyright: ignore[reportPrivateUsage]
from app.models.campus import build_projects

STATUS = """# branch.oid abc
# branch.head feature/x
# branch.upstream origin/feature/x
# branch.ab +3 -1
1 .M N... 100644 100644 100644 a b src/a.py
2 R. N... 100644 100644 100644 a b R100 new old
u UU N... 1 2 3 4 a b c f
? untracked.txt
! ignored.txt
"""

WORKTREES = """worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo-wt
HEAD def
branch refs/heads/feature/x

worktree /repo-detached
HEAD 123
detached

worktree /gone
HEAD 456
branch refs/heads/old
prunable gitdir file points to non-existent location
"""


class TestParsing:
    def test_status(self) -> None:
        st = parse_status_v2(STATUS)
        assert (st.branch, st.upstream, st.ahead, st.behind, st.dirty) == (
            "feature/x",
            "origin/feature/x",
            3,
            1,
            4,
        )

    def test_status_detached_no_upstream_clean(self) -> None:
        st = parse_status_v2("# branch.oid x\n# branch.head (detached)\n")
        assert st.branch is None and st.upstream is None and st.ahead == st.behind == st.dirty == 0

    def test_status_garbage(self) -> None:
        st = parse_status_v2("# branch.ab nonsense\n\n")
        assert (st.ahead, st.behind) == (0, 0)

    def test_worktrees(self) -> None:
        assert parse_worktrees(WORKTREES) == [
            ("/repo", "main"),
            ("/repo-wt", "feature/x"),
            ("/repo-detached", None),
        ]
        assert parse_worktrees("") == []


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeGit:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.fail = False
        self.timeout = False

    async def __call__(self, cwd: str, args: list[str]) -> GitResult:
        self.calls.append((cwd, args))
        if self.timeout:
            raise TimeoutError
        if self.fail:
            return GitResult(128, "")
        if args[0] == "status":
            if cwd == "/repo-wt":
                return GitResult(0, "# branch.head feature/x\n# branch.ab +0 -0\n? a\n? b\n")
            return GitResult(0, STATUS)
        if args[0] == "worktree":
            return GitResult(0, WORKTREES)
        if args[0] == "rev-list":
            return GitResult(0, "2\n")
        if args[0] == "log":
            return GitResult(0, "abc1234\x00fix: thing\x002026-11-07T10:00:00+00:00\n")
        return GitResult(1, "")


def _intake(git: FakeGit, clock: Clock, watched: bool = True) -> LocalGitIntake:
    return LocalGitIntake(run_git=git, is_watched=lambda: watched, clock=clock, ttl=30.0)


class TestIntake:
    @pytest.mark.asyncio
    async def test_collects_state(self) -> None:
        git, clock = FakeGit(), Clock()
        li = _intake(git, clock)
        assert li.note_root("/repo") is None  # nothing cached yet, no IO on the read side
        assert git.calls == []
        assert await li.tick() == 1
        st = li.note_root("/repo")
        assert st is not None
        assert (st.branch, st.ahead, st.behind, st.dirty_files, st.unpushed) == (
            "feature/x",
            3,
            1,
            4,
            2,
        )
        assert st.branches == ["feature/x", "main"]
        assert st.last_commit is not None and st.last_commit.message == "fix: thing"
        wt = {w.path: w for w in st.worktrees}
        assert set(wt) == {"/repo", "/repo-wt", "/repo-detached"}
        assert wt["/repo-wt"].dirty_files == 2 and wt["/repo"].dirty_files == 4
        # all read-only, none touches the network
        assert not any(a[0] in ("fetch", "pull", "push", "remote") for _, a in git.calls)

    @pytest.mark.asyncio
    async def test_ttl_cache_and_not_watched(self) -> None:
        git, clock = FakeGit(), Clock()
        li = _intake(git, clock)
        li.note_root("/repo")
        await li.tick()
        n = len(git.calls)
        assert await li.tick() == 0 and len(git.calls) == n  # within TTL
        clock.t += 31
        li.note_root("/repo")
        assert await li.tick() == 1 and len(git.calls) > n
        idle = _intake(FakeGit(), Clock(), watched=False)
        idle.note_root("/repo")
        assert await idle.tick() == 0

    @pytest.mark.asyncio
    async def test_failure_and_timeout_back_off_keep_last_good(self) -> None:
        git, clock = FakeGit(), Clock()
        li = _intake(git, clock)
        li.note_root("/repo")
        await li.tick()
        git.timeout = True
        clock.t += 31
        li.note_root("/repo")
        assert await li.tick() == 1
        assert li.note_root("/repo") is not None  # last-good kept
        n = len(git.calls)
        clock.t += 31  # backoff (2x TTL) not yet elapsed
        li.note_root("/repo")
        assert await li.tick() == 0 and len(git.calls) == n

    @pytest.mark.asyncio
    async def test_unused_roots_forgotten(self) -> None:
        git, clock = FakeGit(), Clock()
        li = _intake(git, clock)
        li.note_root("/repo")
        clock.t += 2000
        assert await li.tick() == 0


class TestBuildProjects:
    @pytest.mark.asyncio
    async def test_pinned_without_session_and_local_git(self) -> None:
        git, clock = FakeGit(), Clock()
        li = _intake(git, clock)
        poller = CiPoller()
        poller.set_pinned(["o/solo", "o/repo"])
        reset_ci_poller(poller)
        reset_local_git(li)
        _by_id["o/repo"] = ProjectRef("o/repo", "repo", "/repo", "o/repo", "main")
        try:
            now = datetime(2026, 11, 7, tzinfo=UTC)
            first = build_projects([], now)
            assert [p.id for p in first] == ["o/repo", "o/solo"]
            assert all(p.pinned and p.session_ids == [] for p in first)
            assert first[0].local_git is None  # not refreshed yet
            await li.tick()
            again = build_projects([], now)
            lg = again[0].local_git
            assert lg is not None and lg.branch == "feature/x"
            assert again[1].local_git is None  # no local checkout known
        finally:
            _by_id.pop("o/repo", None)
            reset_ci_poller(None)
            reset_local_git(None)
