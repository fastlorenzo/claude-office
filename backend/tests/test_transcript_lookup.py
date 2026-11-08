"""Tests for core/transcript_lookup: bounded, symlink-safe tool_result lookup."""

import json
import os
from pathlib import Path

import pytest

from app.core import transcript_lookup as tl


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / ".claude" / "projects" / "proj").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: h))
    return h


def _write(path: Path, lines: list[dict[str, object]]) -> Path:
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    return path


def _result(tid: str, content: object) -> dict[str, object]:
    return {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tid, "content": content}],
        },
    }


def test_finds_string_and_block_content(home: Path) -> None:
    p = _write(
        home / ".claude" / "projects" / "proj" / "s.jsonl",
        [
            _result("toolu_a", "hello"),
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}},
            _result("toolu_b", [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]),
        ],
    )
    assert tl.find_tool_result(p, "toolu_a") == ("hello", False)
    assert tl.find_tool_result(p, "toolu_b") == ("one\ntwo", False)
    assert tl.find_tool_result(p, "toolu_missing") is None


def test_subagent_transcript(home: Path) -> None:
    d = home / ".claude" / "projects" / "proj" / "s" / "subagents"
    d.mkdir(parents=True)
    p = _write(d / "agent-1.jsonl", [_result("toolu_sub", "from subagent")])
    assert tl.find_tool_result(str(p), "toolu_sub") == ("from subagent", False)


def test_output_cap(home: Path) -> None:
    big = "x" * (tl.MAX_OUTPUT_BYTES + 5000)
    p = _write(home / ".claude" / "projects" / "proj" / "b.jsonl", [_result("toolu_big", big)])
    text, truncated = tl.find_tool_result(p, "toolu_big") or ("", False)
    assert truncated is True
    assert len(text.encode()) == tl.MAX_OUTPUT_BYTES


def test_scan_crosses_chunk_boundaries(home: Path) -> None:
    filler = [{"type": "assistant", "message": {"content": "y" * 1000}}] * 1500  # > 1 chunk
    lines = [_result("toolu_first", "old")] + filler
    p = _write(home / ".claude" / "projects" / "proj" / "c.jsonl", lines)
    assert p.stat().st_size > tl._CHUNK  # pyright: ignore[reportPrivateUsage]
    assert tl.find_tool_result(p, "toolu_first") == ("old", False)


def test_outside_roots_not_read(
    home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outside = _write(tmp_path / "evil.jsonl", [_result("toolu_x", "secret")])
    # Sibling under ~/.claude but outside ~/.claude/projects is also refused.
    sibling = _write(home / ".claude" / "other.jsonl", [_result("toolu_x", "secret")])
    opened: list[str] = []
    real_open = os.open
    monkeypatch.setattr(
        os, "open", lambda *a, **k: (opened.append(str(a[0])), real_open(*a, **k))[1]
    )
    assert tl.find_tool_result(outside, "toolu_x") is None
    assert tl.find_tool_result(sibling, "toolu_x") is None
    assert tl.find_tool_result("/etc/passwd", "toolu_x") is None
    assert tl.find_tool_result(home / ".claude/projects/../../../evil.jsonl", "toolu_x") is None
    assert opened == []


def test_symlink_out_of_root_rejected(home: Path, tmp_path: Path) -> None:
    outside = _write(tmp_path / "secret.jsonl", [_result("toolu_x", "secret")])
    link = home / ".claude" / "projects" / "proj" / "link.jsonl"
    link.symlink_to(outside)
    assert tl.resolve_safe_path(link) is None
    assert tl.find_tool_result(link, "toolu_x") is None
    # Directory symlink escaping the root is rejected too.
    dlink = home / ".claude" / "projects" / "dlink"
    dlink.symlink_to(tmp_path)
    assert tl.find_tool_result(dlink / "secret.jsonl", "toolu_x") is None


def test_non_jsonl_and_missing_rejected(home: Path) -> None:
    f = home / ".claude" / "projects" / "proj" / "a.txt"
    f.write_text("x")
    assert tl.resolve_safe_path(f) is None
    assert tl.resolve_safe_path(home / ".claude" / "projects" / "nope.jsonl") is None
    assert tl.resolve_safe_path(None) is None
