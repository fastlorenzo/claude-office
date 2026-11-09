"""Tests for the Session Console capture additions (WS1)."""

import json
from pathlib import Path

import pytest

from claude_office_hooks import manage as manage_hooks
from claude_office_hooks.event_mapper import map_event
from claude_office_hooks.tool_output import build_tool_output

SID = "s1"
TRANSCRIPT = "/home/u/.claude/projects/proj/session.jsonl"


def _post(tool: str, response, **extra) -> dict:
    raw = {
        "tool_name": tool,
        "tool_use_id": "tu_1",
        "tool_input": {},
        "tool_response": response,
        "session_id": SID,
        "transcript_path": TRANSCRIPT,
    }
    raw.update(extra)
    result = map_event("post_tool_use", raw, SID)
    assert result is not None
    return result


def test_pre_tool_use_caller_fields() -> None:
    raw = {
        "tool_name": "Read",
        "tool_use_id": "tu_1",
        "tool_input": {"file_path": "/x"},
        "agent_id": "abc123",
        "agent_type": "Explore",
        "session_id": SID,
    }
    data = map_event("pre_tool_use", raw, SID)["data"]  # type: ignore[index]
    assert data["caller_native_agent_id"] == "abc123"
    assert data["caller_agent_type"] == "Explore"
    assert data["agent_id"] == "main"
    assert "native_agent_id" not in data


def test_pre_tool_use_without_caller() -> None:
    raw = {"tool_name": "Read", "tool_input": {}, "session_id": SID}
    data = map_event("pre_tool_use", raw, SID)["data"]  # type: ignore[index]
    assert "caller_native_agent_id" not in data


def test_agent_post_keeps_child_native_id() -> None:
    p = _post("Agent", {"agentId": "child1"}, agent_id="caller9", agent_type="Explore")
    assert p["data"]["native_agent_id"] == "child1"
    assert p["data"]["caller_native_agent_id"] == "caller9"


def test_prompt_full_and_summary_short() -> None:
    prompt = "x" * 200
    d = map_event("user_prompt_submit", {"prompt": prompt, "session_id": SID}, SID)["data"]  # type: ignore[index]
    assert d["prompt"] == prompt
    assert d["prompt_truncated"] is False
    assert d["summary"] == "User: " + "x" * 47 + "..."


def test_prompt_cap_16kb() -> None:
    prompt = "y" * (16 * 1024 + 10)
    d = map_event("user_prompt_submit", {"prompt": prompt, "session_id": SID}, SID)["data"]  # type: ignore[index]
    assert len(d["prompt"]) == 16 * 1024
    assert d["prompt_truncated"] is True


def test_bash_output_stdout_stderr_and_cap() -> None:
    p = _post("Bash", {"stdout": "out", "stderr": "err", "interrupted": False})
    d = p["data"]
    assert d["tool_output"] == "out\n--- stderr ---\nerr"
    assert d["tool_output_truncated"] is False
    assert d["tool_output_bytes"] == len(d["tool_output"])
    assert d["interrupted"] is False
    assert d["success"] is True

    big = _post("Bash", {"stdout": "a" * 10000, "stderr": ""})["data"]
    assert len(big["tool_output"]) == 4096
    assert big["tool_output_bytes"] == 10000
    assert big["tool_output_truncated"] is True


def test_bash_no_stderr_marker_when_empty() -> None:
    assert "stderr" not in build_tool_output("Bash", {"stdout": "o", "stderr": ""})["tool_output"]


def test_read_grep_webfetch_edit_agent() -> None:
    assert build_tool_output("Read", {"file": {"content": "hello"}})["tool_output"] == "hello"
    assert build_tool_output("Grep", {"filenames": ["a", "b"]})["tool_output"] == "a\nb"
    assert build_tool_output("Glob", {"filenames": [], "content": "c"})["tool_output"] == "c"
    assert build_tool_output("WebFetch", {"result": "page"})["tool_output"] == "page"
    assert build_tool_output("Edit", {"filePath": "/f", "oldString": "zzz"})["tool_output"] == "/f"
    assert build_tool_output("Write", {"filePath": "/f", "content": "zzz"})["tool_output"] == "/f"
    blocks = {"content": [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]}
    assert build_tool_output("Agent", blocks)["tool_output"] == "one\ntwo"


def test_unknown_tool_fallback_json_capped() -> None:
    resp = {"k": "v" * 9000}
    out = build_tool_output("Mystery", resp)
    assert out["tool_output"] == json.dumps(resp)[:4096]
    assert out["tool_output_truncated"] is True
    assert build_tool_output("Mystery", None)["tool_output"] == ""


def test_post_tool_use_failure() -> None:
    raw = {
        "tool_name": "Bash",
        "tool_use_id": "tu_2",
        "tool_input": {"command": "false"},
        "error": "Command exited with non-zero status code 1",
        "session_id": SID,
    }
    p = map_event("post_tool_use_failure", raw, SID)
    assert p is not None
    assert p["event_type"] == "post_tool_use"
    assert p["data"]["success"] is False
    assert p["data"]["error_message"].startswith("Command exited")
    assert p["data"]["agent_id"] == "main"


def test_one_mb_response_payload_under_24kb() -> None:
    huge = "z" * (1024 * 1024)
    for tool, resp in (
        ("Bash", {"stdout": huge, "stderr": huge}),
        ("Read", {"file": {"content": huge}}),
        ("Mystery", {"blob": huge}),
        ("Agent", {"content": [{"type": "text", "text": huge}]}),
    ):
        p = _post(tool, resp, tool_input={"command": "q" * 500_000})
        assert len(json.dumps(p)) < 24 * 1024, tool


def test_permission_request_passes_tool_use_id_and_caller() -> None:
    raw = {
        "tool_name": "Bash",
        "tool_input": {"command": "ls"},
        "tool_use_id": "tu_perm",
        "agent_id": "sub1",
        "session_id": SID,
    }
    d = map_event("permission_request", raw, SID)["data"]  # type: ignore[index]
    assert d["tool_use_id"] == "tu_perm"
    assert d["caller_native_agent_id"] == "sub1"


def test_install_uninstall_post_tool_use_failure_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    cmd = "/usr/local/bin/claude-office-hook"
    manage_hooks.install_hooks(cmd)
    first = (tmp_path / "settings.json").read_text()
    hooks = json.loads(first)["hooks"]
    entry = hooks["PostToolUseFailure"][0]
    assert entry["matcher"] == ".*"
    assert entry["hooks"][0]["command"] == f"{cmd} post_tool_use_failure"

    manage_hooks.install_hooks(cmd)
    assert (tmp_path / "settings.json").read_text() == first
    assert len(json.loads(first)["hooks"]["PostToolUseFailure"]) == 1

    manage_hooks.uninstall_hooks(cmd)
    after = json.loads((tmp_path / "settings.json").read_text())
    assert "PostToolUseFailure" not in after.get("hooks", {})
