"""Real liveness of Claude Code sessions (is the terminal still open?).

Claude Code writes one ``~/.claude/sessions/<pid>.json`` per running process
(``pid``, ``sessionId``, ``procStart``, ...). Files of crashed/killed processes
are left behind, so a session is alive iff some registry entry carries its
session id AND that pid still exists (and its start time still matches
``procStart``, which guards against pid reuse). ``--resume`` reuses a session id
under a new pid and ``/clear`` rewrites the id, both handled by matching on the
session id across all entries.

Without a registry the verdict is unknown (``None``); callers fall back to
staleness (no hook event and no transcript write for a while).
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

logger = logging.getLogger(__name__)

__all__ = [
    "RegistryEntry",
    "SessionRegistry",
    "is_stale",
    "last_activity",
    "load_registry",
    "pid_alive",
    "session_alive",
]

# A registry file is written at process start, before hooks fire; wait this long
# after the last event before trusting "not in registry" for a brand-new session.
REGISTRY_SETTLE_SECONDS = 120.0
_CACHE_TTL_SECONDS = 5.0


@dataclass(frozen=True)
class RegistryEntry:
    pid: int
    session_id: str
    proc_start: str | None


@dataclass(frozen=True)
class SessionRegistry:
    """Parsed ``~/.claude/sessions`` snapshot."""

    entries: tuple[RegistryEntry, ...]

    def live_session_ids(self) -> set[str]:
        return {e.session_id for e in self.entries if pid_alive(e.pid, e.proc_start)}


def _proc_start(pid: int) -> str | None:
    """Field 22 (starttime, clock ticks) of /proc/<pid>/stat, or None."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    # comm may contain spaces/parens: fields resume after the last ')'.
    rest = raw[raw.rfind(")") + 2 :].split()
    return rest[19] if len(rest) > 19 else None


def pid_alive(pid: int, proc_start: str | None = None) -> bool:
    """True when *pid* exists (and, where checkable, is the same process)."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass  # exists, owned by someone else
    except OSError:
        return False
    if proc_start:
        actual = _proc_start(pid)
        if actual is not None and actual != str(proc_start):
            return False  # pid reused by another process
    return True


_cache: dict[str, tuple[float, SessionRegistry | None]] = {}


def load_registry(directory: str | Path, now: float | None = None) -> SessionRegistry | None:
    """Read the per-process registry; None when unavailable/empty (cached ~5 s)."""
    key = str(directory)
    ts = time.monotonic() if now is None else now
    hit = _cache.get(key)
    if hit is not None and ts - hit[0] < _CACHE_TTL_SECONDS:
        return hit[1]
    entries: list[RegistryEntry] = []
    try:
        files = list(Path(directory).expanduser().glob("*.json"))
    except OSError:
        files = []
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        data = cast(dict[str, Any], data)
        pid = data.get("pid")
        sid = data.get("sessionId")
        ps = data.get("procStart")
        if isinstance(pid, int) and isinstance(sid, str) and sid:
            entries.append(RegistryEntry(pid, sid, str(ps) if ps is not None else None))
    reg = SessionRegistry(tuple(entries)) if entries else None
    _cache[key] = (ts, reg)
    return reg


def session_alive(
    session_id: str,
    registry: SessionRegistry | None,
    last_event_at: datetime,
    now: datetime | None = None,
) -> bool | None:
    """True/False from the registry, None when it cannot tell."""
    if registry is None:
        return None
    if session_id in registry.live_session_ids():
        return True
    age = ((now or datetime.now(UTC)) - last_event_at).total_seconds()
    if age < REGISTRY_SETTLE_SECONDS:
        return None
    return False


def last_activity(last_event_at: datetime, transcript_path: str | None) -> datetime:
    """Latest of the last hook event and the transcript's mtime."""
    best = last_event_at
    if transcript_path:
        try:
            mtime = datetime.fromtimestamp(os.stat(transcript_path).st_mtime, UTC)
        except OSError:
            return best
        best = max(best, mtime)
    return best


def is_stale(activity: datetime, stale_seconds: float, now: datetime | None = None) -> bool:
    return ((now or datetime.now(UTC)) - activity).total_seconds() > stale_seconds
