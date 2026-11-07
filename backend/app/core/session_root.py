"""Find a session's git root when no hook event registered it with git_service.

``git_service`` only learns a root from a SESSION_START event or a room
WebSocket connect, so sessions that predate the backend (or were restored after
a restart) have none and the campus view cannot group them into a project.
Resolution order: persisted session record, Claude Code's session registry
(``~/.claude/sessions/<pid>.json``), then the transcript's ``cwd`` lines.
Results are cached per session id (misses for a short TTL).
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, cast

from app.config import get_settings
from app.core.session_liveness import load_registry

logger = logging.getLogger(__name__)

__all__ = ["clear_root_cache", "find_session_root"]

_MISS_TTL_SECONDS = 30.0
_TRANSCRIPT_SCAN_LINES = 200
_cache: dict[str, tuple[float, str | None]] = {}


def clear_root_cache() -> None:
    _cache.clear()


def _git_root(path: str | None) -> str | None:
    """Nearest ancestor of *path* (inclusive) containing ``.git``, else None."""
    if not path:
        return None
    try:
        start = Path(path)
        if not start.is_absolute():
            return None
        start = start.resolve()
        for d in (start, *start.parents):
            if (d / ".git").exists():
                return str(d)
    except OSError:
        return None
    return None


def _from_db(session_id: str) -> str | None:
    url = get_settings().DATABASE_URL
    prefix = "sqlite+aiosqlite:///"
    if not url.startswith(prefix) or ":memory:" in url:
        return None
    db = url[len(prefix) :]
    if not Path(db).is_file():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        try:
            row = con.execute(
                "SELECT project_root FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    return _git_root(row[0]) if row and isinstance(row[0], str) else None


def _from_registry(session_id: str) -> str | None:
    reg = load_registry(get_settings().CLAUDE_SESSIONS_DIR)
    if reg is None:
        return None
    for e in reg.entries:
        if e.session_id == session_id and e.cwd:
            root = _git_root(e.cwd)
            if root:
                return root
    return None


def _transcript_candidates(session_id: str, transcript_path: str | None) -> list[Path]:
    paths: list[Path] = []
    if transcript_path:
        paths.append(Path(transcript_path))
    projects = Path.home() / ".claude" / "projects"
    with contextlib.suppress(OSError):
        paths.extend(projects.glob(f"*/{session_id}.jsonl"))
    return paths


def _from_transcript(session_id: str, transcript_path: str | None) -> str | None:
    for path in _transcript_candidates(session_id, transcript_path):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i >= _TRANSCRIPT_SCAN_LINES:
                        break
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    cwd = cast(dict[str, Any], obj).get("cwd")
                    root = _git_root(cwd) if isinstance(cwd, str) else None
                    if root:
                        return root
        except OSError:
            continue
    return None


def find_session_root(session_id: str, transcript_path: str | None = None) -> str | None:
    """Git root for *session_id* from DB, session registry or transcript (cached)."""
    now = time.monotonic()
    hit = _cache.get(session_id)
    if hit is not None and (hit[1] is not None or now - hit[0] < _MISS_TTL_SECONDS):
        return hit[1]
    root = (
        _from_db(session_id)
        or _from_registry(session_id)
        or _from_transcript(session_id, transcript_path)
    )
    _cache[session_id] = (now, root)
    if len(_cache) > 1024:
        _cache.pop(next(iter(_cache)))
    return root
