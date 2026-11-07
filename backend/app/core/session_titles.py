"""Incrementally tail a session transcript for Claude Code's session titles.

Transcript JSONL files repeat ``{"type":"custom-title","customTitle":...}``
(the user's ``/rename``) and ``{"type":"ai-title","aiTitle":...}`` (Claude
Code's own title) many times; the last occurrence wins. We remember a byte
offset per session so each refresh only reads newly appended bytes, and the
very first read of a large file only looks at its tail (titles repeat, so the
tail is enough).
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from app.config import get_settings
from app.core.path_utils import is_safe_transcript_path

if TYPE_CHECKING:
    from app.core.state_machine import StateMachine

logger = logging.getLogger(__name__)

INITIAL_TAIL_BYTES = 512 * 1024
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_TITLE_CHARS = 200

__all__ = ["read_session_titles", "refresh_session_titles"]


def _clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:MAX_TITLE_CHARS] or None


def read_session_titles(path: str | Path, offset: int = 0) -> tuple[str | None, str | None, int]:
    """Read titles appended after *offset*.

    Returns ``(custom_title, ai_title, new_offset)``; a title is ``None`` when
    no entry for it appeared in the newly read bytes. Only complete lines are
    consumed, so a partially written last line is picked up next time.
    """
    p = Path(path)
    try:
        size = p.stat().st_size
        if size < offset:  # truncated/rotated: start over
            offset = 0
        start = offset
        if start == 0 and size > INITIAL_TAIL_BYTES:
            start = size - INITIAL_TAIL_BYTES
        start = max(start, size - MAX_READ_BYTES)
        if start >= size:
            return None, None, offset
        with open(p, "rb") as fh:
            fh.seek(start)
            chunk = fh.read(size - start)
    except OSError:
        return None, None, offset

    end = chunk.rfind(b"\n")
    if end < 0:
        return None, None, offset if start == offset else start
    consumed = chunk[: end + 1]
    new_offset = start + len(consumed)
    custom: str | None = None
    ai: str | None = None
    for line in consumed.splitlines():
        is_custom = b'"custom-title"' in line
        is_ai = b'"ai-title"' in line
        if not (is_custom or is_ai):
            continue
        try:
            parsed: object = json.loads(line)
        except ValueError:
            continue  # may be the cut first line of a tail read
        if not isinstance(parsed, dict):
            continue
        rec = cast(dict[str, Any], parsed)
        kind = rec.get("type")
        if kind == "custom-title":
            custom = _clean(rec.get("customTitle")) or custom
        elif kind == "ai-title":
            ai = _clean(rec.get("aiTitle")) or ai
    return custom, ai, new_offset


async def refresh_session_titles(sm: "StateMachine", transcript_path: str | None) -> bool:
    """Update ``sm.custom_title`` / ``sm.ai_title`` from the transcript tail.

    Cheap when nothing changed (one ``stat``). Returns True if a title changed.
    """
    if not transcript_path:
        return False
    path = Path(get_settings().translate_path(transcript_path)).expanduser()
    if not is_safe_transcript_path(path):
        return False
    try:
        size = os.stat(path).st_size
    except OSError:
        return False
    if sm.title_offset_path == str(path) and size == sm.title_offset:
        return False
    custom, ai, new_offset = await asyncio.to_thread(
        read_session_titles, path, sm.title_offset if sm.title_offset_path == str(path) else 0
    )
    sm.title_offset_path = str(path)
    sm.title_offset = new_offset
    changed = False
    if custom and custom != sm.custom_title:
        sm.custom_title = custom
        changed = True
    if ai and ai != sm.ai_title:
        sm.ai_title = ai
        changed = True
    return changed
