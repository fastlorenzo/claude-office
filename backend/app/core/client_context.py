"""Sessions whose Claude Code runs on another machine (or outside our container).

The hook reports ``host`` with every event, plus ``client_git`` and the session
titles gathered where the files are (see the hooks' ``client_context.py``). A
session is *local* when its host is this machine: only then may the backend
read the session's paths (git root, task files, beads, the pid registry). For a
remote session the same path may exist here but belong to a different checkout,
so it is never opened; the client's report is used instead.

Old hooks send no ``host``: they are treated as local (previous behaviour).
"""

from __future__ import annotations

import os
import socket
from functools import lru_cache
from typing import TYPE_CHECKING

from app.models.git import ClientGit, GitStatus

if TYPE_CHECKING:
    from app.models.events import AnyEvent

__all__ = [
    "backend_host",
    "client_git_status",
    "context_mode",
    "host_label",
    "is_local_client",
    "path_basename",
]


@lru_cache(maxsize=1)
def backend_host() -> str:
    """This machine's name as the hook would report it (``socket.gethostname``)."""
    override = os.environ.get("CLAUDE_OFFICE_BACKEND_HOST", "").strip()
    if override:
        return override
    try:
        return socket.gethostname()
    except OSError:
        return ""


def is_local_client(host: str | None, wsl_distro: str | None = None) -> bool:
    """True when a session with this host / WSL distro runs on this machine.

    A WSL distro shares the Windows host name, so the distro must match too
    (our own ``WSL_DISTRO_NAME``, empty outside WSL).
    """
    if not host:
        return True
    if host.lower() != backend_host().lower():
        return False
    own_distro = os.environ.get("WSL_DISTRO_NAME") or None
    return (wsl_distro or None) == own_distro


def host_label(host: str | None, wsl_distro: str | None = None) -> str | None:
    """Human label for the machine: ``host`` or ``host (WSL Ubuntu)``."""
    if not host:
        return None
    return f"{host} (WSL {wsl_distro})" if wsl_distro else host


def path_basename(path: str | None) -> str | None:
    """Last segment of a POSIX or Windows path (the client may be either)."""
    if not path:
        return None
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    return parts[-1] if parts else None


def client_git_status(git: ClientGit | None) -> GitStatus | None:
    """The reported snapshot as the ``git_status`` frame the room view expects."""
    if git is None or git.changed_files is None and git.commits is None and not git.branch:
        return None
    return GitStatus(
        branch=git.branch or "unknown",
        ahead=git.ahead,
        behind=git.behind,
        changed_files=list(git.changed_files or []),
        commits=list(git.commits or []),
        repo_path=git.root,
    )


def context_mode(event: AnyEvent) -> str:
    """``"local"`` when we can read this session's files ourselves, else ``"push"``.

    Returned to the hook with every event: on "local" it stops gathering
    client context (git, titles, transcript lines) it would send for nothing.
    """
    data = event.data
    if not is_local_client(data.host, data.wsl_distro):
        return "push"
    path = data.transcript_path
    if path:
        from app.config import get_settings  # local import: config is heavy

        try:
            if not os.path.exists(get_settings().translate_path(path)):
                return "push"
        except (OSError, ValueError):
            return "push"
    return "local"
