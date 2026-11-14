"""Bounded, symlink-safe lookup of a tool result inside a Claude Code transcript.

Used by the Session Console's tool-call detail endpoint (spec section 3.4).
Transcript paths originate from unauthenticated hook events, so every path is
resolved with ``realpath`` (symlinks followed *before* the root check, so a link
pointing out of the allowed roots is rejected) and must be a regular ``.jsonl``
file under ``~/.claude/projects`` or a configured transcript root. Nothing is
opened until that check passes. Reads are capped (output at 256 KB, scan window
at ``MAX_SCAN_BYTES`` from the end of the file).
"""

import json
import logging
import os
import stat
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_OUTPUT_BYTES = 256 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024  # how far back from EOF we look
MAX_LINE_BYTES = 8 * 1024 * 1024  # longer lines are skipped, never parsed
_CHUNK = 256 * 1024


def allowed_roots() -> list[str]:
    """Real paths of the directories transcripts may be read from."""
    roots = [os.path.realpath(Path.home() / ".claude" / "projects")]
    container = get_settings().CLAUDE_PATH_CONTAINER
    if container:
        roots.append(os.path.realpath(container))
    # Hook-fed copies of remote sessions' transcripts (transcript_mirror).
    from app.core.transcript_mirror import mirror_root

    roots.append(os.path.realpath(mirror_root()))
    return roots


def resolve_safe_path(path: str | Path | None) -> str | None:
    """Return the real path of *path* if it is a safe transcript, else None.

    Safe means: ``.jsonl`` suffix, ``realpath`` (symlinks resolved) inside an
    allowed root, and an existing regular file.
    """
    if not path:
        return None
    try:
        raw = get_settings().translate_path(str(path))
        real = os.path.realpath(os.path.expanduser(raw))
        if not real.endswith(".jsonl"):
            return None
        # Windows desktop app: transcripts of Claude Code running inside WSL
        # (\\wsl.localhost\<distro>\...\.claude\...), see app.core.wsl_bridge.
        from app.core.wsl_bridge import is_allowed_wsl_transcript

        if not is_allowed_wsl_transcript(real) and not any(
            os.path.commonpath([real, root]) == root for root in allowed_roots()
        ):
            return None
        if not stat.S_ISREG(os.stat(real).st_mode):
            return None
        return real
    except (OSError, ValueError):
        return None


def _reverse_lines(fd: int, size: int) -> Iterator[bytes]:
    """Yield lines of the file from the end, scanning at most MAX_SCAN_BYTES."""
    floor = max(0, size - MAX_SCAN_BYTES)
    pos = size
    carry = b""
    while pos > floor:
        start = max(floor, pos - _CHUNK)
        os.lseek(fd, start, os.SEEK_SET)
        block = os.read(fd, pos - start)
        pos = start
        parts = (block + carry).split(b"\n")
        carry = parts[0]
        if len(carry) > MAX_LINE_BYTES:
            carry = b""  # oversize line: drop it, resync at the next newline
        for line in reversed(parts[1:]):
            if line and len(line) <= MAX_LINE_BYTES:
                yield line
    if carry and floor == 0:
        yield carry


def _block_text(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out: list[str] = []
        for part in content:  # pyright: ignore[reportUnknownVariableType]
            if isinstance(part, dict):
                text = part.get("text")  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
                if isinstance(text, str):
                    out.append(text)
            elif isinstance(part, str):
                out.append(part)
        return "\n".join(out)
    return None


def _find_result(line: bytes, tool_use_id: str) -> str | None:
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    message = obj.get("message")  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
    content = message.get("content") if isinstance(message, dict) else None  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
    if not isinstance(content, list):
        return None
    for block in content:  # pyright: ignore[reportUnknownVariableType]
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_result"  # pyright: ignore[reportUnknownMemberType]
            and block.get("tool_use_id") == tool_use_id  # pyright: ignore[reportUnknownMemberType]
        ):
            return _block_text(block.get("content")) or ""  # pyright: ignore[reportUnknownMemberType]
    return None


def find_tool_result(
    transcript_path: str | Path | None,
    tool_use_id: str,
    max_bytes: int = MAX_OUTPUT_BYTES,
) -> tuple[str, bool] | None:
    """Find the ``tool_result`` for *tool_use_id*; return ``(text, truncated)``.

    Returns None when the path is not allowed, the file is unreadable, or no
    result is found within the scan window. The newest matching block wins.
    """
    real = resolve_safe_path(transcript_path)
    if real is None or not tool_use_id:
        return None
    needle = tool_use_id.encode()
    try:
        fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        size = os.fstat(fd).st_size
        for line in _reverse_lines(fd, size):
            if needle not in line:
                continue
            text = _find_result(line, tool_use_id)
            if text is None:
                continue
            raw = text.encode("utf-8", errors="replace")
            if len(raw) > max_bytes:
                return raw[:max_bytes].decode("utf-8", errors="ignore"), True
            return text, False
    except OSError as exc:
        logger.warning("Transcript lookup failed for %s: %s", real, exc)
    finally:
        os.close(fd)
    return None
