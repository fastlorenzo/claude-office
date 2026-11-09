"""WSL → Windows bridge: Claude Code inside WSL, backend (desktop app) on Windows.

Hooks running in a WSL distro tag their events with ``data.wsl_distro``
(``WSL_DISTRO_NAME``). Their transcript paths are Linux paths
(``/home/u/.claude/projects/...``) that a Windows process reads through the
``\\\\wsl.localhost\\<distro>\\...`` UNC share. Translating once at event intake,
before the event is persisted, means every downstream reader (titles,
telemetry, pollers, restore replay) sees a readable path without knowing about
WSL.

The transcript allowlists (``path_utils``, ``transcript_lookup``) accept such a
path through :func:`is_allowed_wsl_transcript`, a stateless rule (no registry
to lose on restart): the *resolved* path is a UNC WSL path under a valid distro
name, inside a ``.claude`` directory, ending in ``.jsonl``.

Working directories stay Linux paths: they are display/grouping data, and
Windows git over the UNC share is slow and trips git's ownership check.
"""

from __future__ import annotations

import os
import re

from app.models.events import AnyEvent

UNC_PREFIX = "\\\\wsl.localhost\\"
# WSL distro names: letters, digits, dot, dash, underscore.
_DISTRO_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_PATH_FIELDS = ("transcript_path", "agent_transcript_path")


def bridge_active() -> bool:
    """True when this backend runs on Windows (where WSL paths need translating).

    ``CLAUDE_OFFICE_WSL_BRIDGE=1``/``0`` overrides the platform check (tests).
    """
    override = os.environ.get("CLAUDE_OFFICE_WSL_BRIDGE")
    if override is not None:
        return override == "1"
    return os.name == "nt"


def valid_distro(name: object) -> bool:
    # Dots are legal ("Ubuntu-24.04") but a dot-only name would be a path segment.
    return isinstance(name, str) and bool(_DISTRO_RE.match(name)) and name.strip(".") != ""


def to_unc(distro: str, linux_path: str) -> str | None:
    """``/home/u/x`` → ``\\\\wsl.localhost\\<distro>\\home\\u\\x``; None if not translatable."""
    if not valid_distro(distro) or not linux_path.startswith("/") or "\\" in linux_path:
        return None
    parts = [p for p in linux_path.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        return None
    return UNC_PREFIX + distro + "\\" + "\\".join(parts)


def is_unc_wsl_path(path: str | None) -> bool:
    return bool(path) and str(path).lower().startswith(UNC_PREFIX.lower())


def is_allowed_wsl_transcript(resolved: str) -> bool:
    """Allowlist rule for an already-resolved (realpath) transcript path."""
    if not bridge_active() or not is_unc_wsl_path(resolved):
        return False
    rest = resolved[len(UNC_PREFIX) :]
    distro, _, tail = rest.partition("\\")
    if not valid_distro(distro) or not tail:
        return False
    segments = tail.split("\\")
    if any(s in ("", ".", "..") for s in segments):
        return False
    return ".claude" in segments[:-1] and resolved.lower().endswith(".jsonl")


def pid_registry_applies(wsl_distro: str | None) -> bool:
    """Whether this backend's ``~/.claude/sessions`` pid registry can judge a session.

    Not for a WSL session seen by a Windows backend (Linux pids are invisible
    there). A Linux backend inside WSL keeps using it: hooks always tag
    ``WSL_DISTRO_NAME`` in WSL, and that backend shares the distro's registry.
    """
    return not (wsl_distro and bridge_active())


def translate_event(event: AnyEvent) -> None:
    """Rewrite a WSL event's transcript paths in place (no-op off Windows)."""
    data = event.data
    distro = getattr(data, "wsl_distro", None)
    if not bridge_active() or not isinstance(distro, str) or not valid_distro(distro):
        return
    for field in _PATH_FIELDS:
        value = getattr(data, field, None)
        if not isinstance(value, str) or not value or is_unc_wsl_path(value):
            continue
        unc = to_unc(distro, value)
        if unc is not None:
            setattr(data, field, unc)
