"""Cheap, cached git branch lookup that never shells out.

Reads ``.git/HEAD`` directly (following the ``gitdir:`` pointer used by
worktrees and submodules). Results are cached per project root for
``BRANCH_TTL_SECONDS`` so the ``/ws/campus`` builder can call it per session on
every broadcast without touching the disk each time.
"""

import time
from pathlib import Path

BRANCH_TTL_SECONDS = 30.0
_MAX_HEAD_BYTES = 1024

# root -> (monotonic timestamp, branch or None)
_cache: dict[str, tuple[float, str | None]] = {}


def _read_head(root: str) -> str | None:
    try:
        git_entry = Path(root) / ".git"
        if git_entry.is_file():
            pointer = git_entry.read_text(encoding="utf-8", errors="replace")[:_MAX_HEAD_BYTES]
            if not pointer.startswith("gitdir:"):
                return None
            git_dir = Path(pointer[len("gitdir:") :].strip())
            if not git_dir.is_absolute():
                git_dir = Path(root) / git_dir
        else:
            git_dir = git_entry
        with open(git_dir / "HEAD", encoding="utf-8", errors="replace") as fh:
            head = fh.read(_MAX_HEAD_BYTES).strip()
    except OSError:
        return None
    prefix = "ref: refs/heads/"
    if head.startswith(prefix):
        return head[len(prefix) :] or None
    return None  # detached HEAD or unrecognised content


def get_branch(root: str | None, now: float | None = None) -> str | None:
    """Return the current branch of *root*, cached for ``BRANCH_TTL_SECONDS``."""
    if not root:
        return None
    ts = time.monotonic() if now is None else now
    hit = _cache.get(root)
    if hit is not None and ts - hit[0] < BRANCH_TTL_SECONDS:
        return hit[1]
    branch = _read_head(root)
    _cache[root] = (ts, branch)
    if len(_cache) > 256:
        _cache.pop(next(iter(_cache)))
    return branch


def clear_cache() -> None:
    """Drop all cached branches (tests)."""
    _cache.clear()
