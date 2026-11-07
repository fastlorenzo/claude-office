"""Cheap, network-free local git state per project root (and its worktrees).

Runs a handful of read-only ``git`` commands (``status --porcelain=v2``,
``worktree list``, ``rev-list``, ``log -1``) with a timeout each, at most
``MAX_CONCURRENT_GIT`` at a time, and caches the result per root for a TTL.
Refreshes happen only while a ``/ws/campus`` client is watching and never in a
tight loop: the read side (campus build) is IO-free and just returns the cache.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import cast

from app.models.ci import LocalCommit, LocalGitState, LocalWorktree

logger = logging.getLogger(__name__)

__all__ = [
    "GitResult",
    "LocalGitIntake",
    "get_local_git",
    "parse_status_v2",
    "parse_worktrees",
    "reset_local_git",
]

MAX_CONCURRENT_GIT = 2
GIT_TIMEOUT_S = 8.0
DEFAULT_TTL_S = 30.0
TICK_S = 5.0
FORGET_S = 900.0
MAX_BACKOFF_S = 300.0
MAX_WORKTREES = 8


@dataclass
class GitResult:
    returncode: int
    stdout: str


GitRunner = Callable[[str, list[str]], Awaitable[GitResult]]


@dataclass(frozen=True)
class StatusInfo:
    branch: str | None
    upstream: str | None
    ahead: int
    behind: int
    dirty: int


def parse_status_v2(text: str) -> StatusInfo:
    """``git status --porcelain=v2 --branch`` -> branch, upstream, ahead/behind, dirty count."""
    branch: str | None = None
    upstream: str | None = None
    ahead = behind = dirty = 0
    for line in text.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head ") :].strip()
            branch = None if head in ("", "(detached)") else head
        elif line.startswith("# branch.upstream "):
            upstream = line[len("# branch.upstream ") :].strip() or None
        elif line.startswith("# branch.ab "):
            parts = line.split()
            try:
                ahead = int(parts[2].lstrip("+"))
                behind = abs(int(parts[3]))
            except (IndexError, ValueError):
                ahead = behind = 0
        elif line[:2] in ("1 ", "2 ", "u ", "? "):
            dirty += 1
    return StatusInfo(branch, upstream, ahead, behind, dirty)


def parse_worktrees(text: str) -> list[tuple[str, str | None]]:
    """``git worktree list --porcelain`` -> [(path, branch or None)] (bare/prunable skipped)."""
    out: list[tuple[str, str | None]] = []
    path: str | None = None
    branch: str | None = None
    skip = False

    def flush() -> None:
        if path and not skip:
            out.append((path, branch))

    for line in [*text.splitlines(), ""]:
        if not line.strip():
            flush()
            path, branch, skip = None, None, False
        elif line.startswith("worktree "):
            path = line[len("worktree ") :]
        elif line.startswith("branch "):
            ref = line[len("branch ") :].strip()
            branch = ref.removeprefix("refs/heads/")
        elif line.strip() in ("bare", "prunable") or line.startswith("prunable"):
            skip = True
    return out


async def _run_git(cwd: str, args: list[str]) -> GitResult:
    env = {
        **os.environ,
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            cwd,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return GitResult(127, "")
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=GIT_TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return GitResult(proc.returncode or 0, out.decode("utf-8", "replace"))


@dataclass
class _Entry:
    state: LocalGitState | None = None
    next_at: float = 0.0
    last_seen: float = 0.0
    fails: int = 0
    worktree_paths: list[str] = field(default_factory=lambda: cast(list[str], []))


class LocalGitIntake:
    def __init__(
        self,
        *,
        run_git: GitRunner | None = None,
        is_watched: Callable[[], bool] | None = None,
        on_change: Callable[[], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        ttl: float = DEFAULT_TTL_S,
    ) -> None:
        self._run_git = run_git or _run_git
        self._is_watched = is_watched or (lambda: False)
        self._on_change = on_change
        self._clock = clock
        self._ttl = ttl
        self._entries: dict[str, _Entry] = {}
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_GIT)

    def configure(self, *, on_change: Callable[[], None] | None, ttl: float) -> None:
        self._on_change = on_change
        self._ttl = ttl

    # -- read side (no IO) ---------------------------------------------------

    def note_root(self, root: str) -> LocalGitState | None:
        """Mark *root* as wanted and return its cached state (None until first refresh)."""
        entry = self._entries.get(root)
        if entry is None:
            entry = self._entries[root] = _Entry()
        entry.last_seen = self._clock()
        return entry.state

    # -- refresh -------------------------------------------------------------

    async def tick(self) -> int:
        """Refresh every root whose TTL expired (only while watched). Returns #refreshed."""
        if not self._is_watched():
            return 0
        now = self._clock()
        for root in [r for r, e in self._entries.items() if now - e.last_seen > FORGET_S]:
            del self._entries[root]
        due = [r for r, e in self._entries.items() if e.next_at <= now]
        if not due:
            return 0
        results = await asyncio.gather(*(self._refresh(r) for r in due), return_exceptions=True)
        if any(r is True for r in results) and self._on_change is not None:
            self._on_change()
        return len(due)

    async def _git(self, cwd: str, args: list[str]) -> GitResult | None:
        async with self._sem:
            try:
                res = await self._run_git(cwd, args)
            except (TimeoutError, OSError):
                return None
        return res if res.returncode == 0 else None

    async def _status(self, cwd: str) -> StatusInfo | None:
        res = await self._git(cwd, ["status", "--porcelain=v2", "--branch"])
        return parse_status_v2(res.stdout) if res else None

    async def _refresh(self, root: str) -> bool:
        entry = self._entries.get(root)
        if entry is None:
            return False
        main = await self._status(root)
        if main is None:
            entry.fails += 1
            entry.next_at = self._clock() + min(self._ttl * 2**entry.fails, MAX_BACKOFF_S)
            return False
        entry.fails = 0
        entry.next_at = self._clock() + self._ttl
        wt_res = await self._git(root, ["worktree", "list", "--porcelain"])
        raw_wts = parse_worktrees(wt_res.stdout) if wt_res else []
        unpushed_res = await self._git(
            root, ["rev-list", "--count", "--branches", "--not", "--remotes"]
        )
        log_res = await self._git(root, ["log", "-1", "--format=%h%x00%s%x00%cI"])

        norm_root = os.path.realpath(root)
        worktrees: list[LocalWorktree] = []
        for path, branch in raw_wts[:MAX_WORKTREES]:
            if os.path.realpath(path) == norm_root:
                st: StatusInfo | None = main
            else:
                st = await self._status(path)
            worktrees.append(
                LocalWorktree(
                    path=path,
                    branch=branch if branch is not None else (st.branch if st else None),
                    dirty_files=st.dirty if st else 0,
                    ahead=st.ahead if st else 0,
                )
            )
        branches = sorted({w.branch for w in worktrees if w.branch})
        unpushed = 0
        if unpushed_res:
            try:
                unpushed = int(unpushed_res.stdout.strip() or 0)
            except ValueError:
                unpushed = 0
        last: LocalCommit | None = None
        if log_res:
            parts = log_res.stdout.strip().split("\x00")
            if len(parts) == 3:
                last = LocalCommit(hash=parts[0], message=parts[1][:120], at=parts[2])
        state = LocalGitState(
            branch=main.branch,
            ahead=main.ahead,
            behind=main.behind,
            dirty_files=main.dirty,
            unpushed=unpushed,
            branches=branches,
            last_commit=last,
            worktrees=worktrees,
        )
        changed = state != entry.state
        entry.state = state
        return changed

    async def run(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("local git tick failed", exc_info=True)


_intake: LocalGitIntake | None = None


def get_local_git() -> LocalGitIntake:
    global _intake
    if _intake is None:
        from app.config import get_settings
        from app.core.connection_manager import get_manager

        _intake = LocalGitIntake(
            is_watched=lambda: bool(get_manager().campus_connections),
            ttl=get_settings().LOCAL_GIT_TTL_SECONDS,
        )
    return _intake


def reset_local_git(intake: LocalGitIntake | None = None) -> None:
    global _intake
    _intake = intake
