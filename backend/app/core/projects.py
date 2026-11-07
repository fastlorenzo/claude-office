"""Group sessions by git repository (worktrees map to their main repo).

Pure filesystem reads (no ``git`` subprocess): walk up to the toplevel, follow a
worktree's ``gitdir:`` pointer back to the main repo, read ``origin`` from
``.git/config`` and the default branch from ``refs/remotes/origin/HEAD``.
Results are cached per root.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "ProjectRef",
    "clear_project_cache",
    "get_project_ref",
    "parse_github_repo",
    "resolve_project",
]

_TTL_SECONDS = 300.0
_MAX_READ = 64 * 1024

_GITHUB_RE = re.compile(
    r"^(?:https?://(?:[^@/]+@)?|ssh://(?:[^@/]+@)?|git://|[^@/\s]+@)"
    r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ProjectRef:
    id: str  # "owner/name" or the main repo root path
    name: str  # repo directory basename
    root: str  # main repo toplevel
    repo: str | None  # "owner/name" when origin is GitHub
    default_branch: str | None


def parse_github_repo(url: str | None) -> str | None:
    """``owner/name`` for a GitHub remote URL (https, ssh, scp-like), else None."""
    if not url:
        return None
    m = _GITHUB_RE.match(url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _read(path: Path) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read(_MAX_READ)
    except OSError:
        return None


def _main_repo_root(root: str) -> Path | None:
    """Main repo toplevel above *root* (worktrees resolve to the repo that owns them)."""
    try:
        start = Path(root).resolve()
        for d in (start, *start.parents):
            git = d / ".git"
            if git.is_dir():
                return d
            if git.is_file():
                text = (_read(git) or "").strip()
                if text.startswith("gitdir:"):
                    gd = Path(text[len("gitdir:") :].strip())
                    if not gd.is_absolute():
                        gd = d / gd
                    parts = gd.parts
                    if "worktrees" in parts:  # <repo>/.git/worktrees/<name>
                        idx = len(parts) - 1 - parts[::-1].index("worktrees")
                        if idx >= 2 and parts[idx - 1] == ".git":
                            return Path(*parts[: idx - 1])
                return d
    except OSError:
        return None
    return None


def _origin_url(repo_root: Path) -> str | None:
    text = _read(repo_root / ".git" / "config")
    if text is None:
        return None
    in_origin = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_origin = bool(re.fullmatch(r'\[remote\s+"origin"\]', line))
        elif in_origin and line.lower().startswith("url"):
            _, _, value = line.partition("=")
            if value.strip():
                return value.strip()
    return None


def _default_branch(repo_root: Path) -> str | None:
    git = repo_root / ".git"
    head = (_read(git / "refs" / "remotes" / "origin" / "HEAD") or "").strip()
    prefix = "ref: refs/remotes/origin/"
    if head.startswith(prefix):
        return head[len(prefix) :] or None
    packed = _read(git / "packed-refs") or ""
    for cand in ("main", "master"):
        if (git / "refs" / "heads" / cand).exists() or f" refs/heads/{cand}\n" in packed + "\n":
            return cand
    return None


_cache: dict[str, tuple[float, ProjectRef | None]] = {}
_by_id: dict[str, ProjectRef] = {}


def resolve_project(root: str | None, now: float | None = None) -> ProjectRef | None:
    """Project for a session root, or None when it is not inside a git repo."""
    if not root:
        return None
    ts = time.monotonic() if now is None else now
    hit = _cache.get(root)
    if hit is not None and ts - hit[0] < _TTL_SECONDS:
        return hit[1]
    ref: ProjectRef | None = None
    top = _main_repo_root(root)
    if top is not None:
        repo = parse_github_repo(_origin_url(top))
        ref = ProjectRef(
            id=repo or str(top),
            name=top.name,
            root=str(top),
            repo=repo,
            default_branch=_default_branch(top),
        )
        _by_id[ref.id] = ref
    _cache[root] = (ts, ref)
    if len(_cache) > 256:
        _cache.pop(next(iter(_cache)))
    return ref


def get_project_ref(project_id: str) -> ProjectRef | None:
    return _by_id.get(project_id)


def clear_project_cache() -> None:
    _cache.clear()
    _by_id.clear()
