"""Mirror of remote sessions' transcripts, fed by the hook (``transcript_sync``).

A backend on another machine (or in a container) cannot open the session's
``~/.claude/projects/...`` files, yet titles, telemetry, reply summaries,
subagent speech and tool details are all read from them. The hook therefore
sends the lines appended since its last event (trimmed: long strings capped,
images and file-history snapshots dropped; see the hooks' client_context.py),
and this module appends them to a local copy laid out like Claude Code's own
tree::

    <mirror root>/projects/<project dir>/<session>.jsonl
    <mirror root>/projects/<project dir>/<session>/subagents/agent-<id>.jsonl
    <mirror root>/projects/<project dir>/<session>/subagents/agent-<id>.meta.json

``Settings.translate_path`` maps a client transcript path to its mirror copy
when the path does not exist here, so every existing reader works unchanged.

Each line carries its byte offset in the client file; a sidecar ``.end`` file
records how far the copy has got, so overlapping sends (concurrent hooks,
retries) never duplicate a line.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from app.config import get_settings

if TYPE_CHECKING:
    from app.models.events import TranscriptChunk

logger = logging.getLogger(__name__)

__all__ = [
    "apply_chunks",
    "mirror_path",
    "mirror_root",
    "prune_mirror",
]

_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,255}$")
_MAX_DEPTH = 4  # <project>/<session>/subagents/<file>
MAX_META_BYTES = 64 * 1024
MIRROR_MAX_AGE_SECONDS = 14 * 24 * 3600

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def mirror_root() -> Path:
    """``TRANSCRIPT_MIRROR_DIR``, else ``mirror/`` next to the data dir / SQLite DB."""
    s = get_settings()
    if s.TRANSCRIPT_MIRROR_DIR:
        return Path(s.TRANSCRIPT_MIRROR_DIR).expanduser()
    if s.CLAUDE_OFFICE_DATA_DIR:
        return Path(s.CLAUDE_OFFICE_DATA_DIR).expanduser() / "mirror"
    prefix = "sqlite+aiosqlite:///"
    url = s.DATABASE_URL
    if url.startswith(prefix) and ":memory:" not in url:
        return Path(url[len(prefix) :]).expanduser().parent / "mirror"
    return Path(tempfile.gettempdir()) / "claude-office" / "mirror"


def mirror_path(client_path: str | None) -> Path | None:
    """Mirror location of a client transcript path (POSIX or Windows), or None.

    Only ``.../projects/<segments>`` ending in ``.jsonl`` or ``.meta.json`` with
    plain segments qualifies: the client's path never escapes the mirror root.
    """
    if not client_path:
        return None
    norm = client_path.replace("\\", "/")
    idx = norm.rfind("/projects/")
    if idx < 0:
        return None
    parts = norm[idx + len("/projects/") :].split("/")
    if not 2 <= len(parts) <= _MAX_DEPTH:
        return None
    if any(p in (".", "..") or not _SEGMENT.match(p) for p in parts):
        return None
    name = parts[-1]
    if not (name.endswith(".jsonl") or name.endswith(".meta.json")):
        return None
    return mirror_root().joinpath("projects", *parts)


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            if len(_locks) > 4096:
                _locks.clear()
            lock = _locks[key] = threading.Lock()
        return lock


def _read_end(sidecar: Path) -> int:
    try:
        return int(sidecar.read_text(encoding="ascii").strip() or 0)
    except (OSError, ValueError):
        return 0


def _apply_lines(target: Path, end: int | None, lines: list[tuple[int, str]]) -> int:
    """Append the lines at or past the copy's end; returns the new end."""
    sidecar = target.with_name(target.name + ".end")
    with _lock_for(str(target)):
        current = _read_end(sidecar) if target.exists() else 0
        fresh = [text for off, text in lines if off >= current and "\n" not in text]
        new_end = max(current, end or 0)
        if fresh:
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "a", encoding="utf-8") as fh:
                fh.write("\n".join(fresh) + "\n")
        if new_end != current or fresh:
            target.parent.mkdir(parents=True, exist_ok=True)
            sidecar.write_text(str(new_end), encoding="ascii")
        return new_end


def _apply_meta(target: Path, content: str) -> None:
    if len(content.encode("utf-8")) > MAX_META_BYTES:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target)


def apply_chunks(chunks: list[TranscriptChunk]) -> dict[str, int]:
    """Write the hook's chunks into the mirror; ``{client path: end}`` for jsonl ones.

    Never raises: a bad chunk is skipped (and logged at debug level).
    """
    ends: dict[str, int] = {}
    for chunk in chunks:
        target = mirror_path(chunk.path)
        if target is None:
            continue
        try:
            if target.name.endswith(".meta.json"):
                if chunk.content is not None:
                    _apply_meta(target, chunk.content)
                continue
            ends[chunk.path] = _apply_lines(target, chunk.end, list(chunk.lines or []))
        except OSError:
            logger.debug("Transcript mirror write failed for %s", target, exc_info=True)
    return ends


def prune_mirror(now: float | None = None) -> int:
    """Delete mirror files untouched for ``MIRROR_MAX_AGE_SECONDS``; returns count."""
    cutoff = (now or time.time()) - MIRROR_MAX_AGE_SECONDS
    root = mirror_root() / "projects"
    removed = 0
    if not root.is_dir():
        return 0
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        with contextlib.suppress(OSError):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
            elif path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    return removed
