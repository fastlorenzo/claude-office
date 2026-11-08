"""Normalize a Claude Code ``tool_response`` into a capped text preview.

IMPORTANT: This module must not produce any stdout/stderr output.
"""

import json
from typing import Any, cast

OUTPUT_CAP = 4096


def _text_blocks(content: Any) -> str:
    """Join the text of content blocks (or return a plain string as is)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in cast(list[Any], content):
            if isinstance(block, dict):
                text = cast(dict[str, Any], block).get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return ""


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _preview_text(tool_name: str | None, response: Any) -> str:
    if isinstance(response, str):
        return response
    if not isinstance(response, dict):
        return "" if response is None else json.dumps(response, default=str)
    resp = cast(dict[str, Any], response)

    if tool_name == "Bash":
        out = _as_str(resp.get("stdout"))
        err = _as_str(resp.get("stderr"))
        return f"{out}\n--- stderr ---\n{err}" if err else out
    if tool_name == "Read":
        file_info = resp.get("file")
        if isinstance(file_info, dict):
            return _as_str(cast(dict[str, Any], file_info).get("content"))
        return ""
    if tool_name in ("Edit", "Write", "MultiEdit"):
        return _as_str(resp.get("filePath"))
    if tool_name in ("Grep", "Glob"):
        filenames = resp.get("filenames")
        if isinstance(filenames, list) and filenames:
            return "\n".join(str(f) for f in cast(list[Any], filenames))
        content = resp.get("content")
        if isinstance(content, str):
            return content
        return ""
    if tool_name == "WebFetch":
        return _as_str(resp.get("result"))
    if tool_name in ("Agent", "Task"):
        return _text_blocks(resp.get("content"))
    return json.dumps(resp, default=str)


def build_tool_output(
    tool_name: str | None, response: Any, cap: int = OUTPUT_CAP
) -> dict[str, Any]:
    """Return ``tool_output``, ``tool_output_bytes`` and ``tool_output_truncated``.

    ``tool_output_bytes`` is the UTF-8 size of the full (uncapped) preview text.
    """
    try:
        text = _preview_text(tool_name, response)
    except (TypeError, ValueError):
        text = ""
    size = len(text.encode("utf-8", errors="replace"))
    truncated = len(text) > cap
    return {
        "tool_output": text[:cap],
        "tool_output_bytes": size,
        "tool_output_truncated": truncated,
    }


def extract_interrupted(response: Any) -> bool | None:
    """Return ``tool_response.interrupted`` when present."""
    if isinstance(response, dict):
        value = cast(dict[str, Any], response).get("interrupted")
        if isinstance(value, bool):
            return value
    return None
