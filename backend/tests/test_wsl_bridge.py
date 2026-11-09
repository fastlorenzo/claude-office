"""WSL → Windows bridge (desktop app on Windows, Claude Code inside WSL)."""

from collections.abc import Iterator
from typing import Any

import pytest
from pydantic import TypeAdapter

from app.core import wsl_bridge
from app.core.state_machine import StateMachine
from app.models.events import AnyEvent

UNC = "\\\\wsl.localhost\\"
_ADAPTER: TypeAdapter[Any] = TypeAdapter(AnyEvent)


def _event(data: dict[str, Any], event_type: str = "pre_tool_use") -> Any:
    return _ADAPTER.validate_python(
        {"event_type": event_type, "session_id": "s1", "data": {"tool_name": "Bash", **data}}
    )


@pytest.fixture
def bridge_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CLAUDE_OFFICE_WSL_BRIDGE", "1")
    yield


@pytest.fixture
def bridge_off(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CLAUDE_OFFICE_WSL_BRIDGE", "0")
    yield


class TestToUnc:
    def test_translates_absolute_linux_path(self) -> None:
        assert (
            wsl_bridge.to_unc("Ubuntu-24.04", "/home/u/.claude/projects/p/a.jsonl")
            == UNC + "Ubuntu-24.04\\home\\u\\.claude\\projects\\p\\a.jsonl"
        )

    @pytest.mark.parametrize(
        ("distro", "path"),
        [
            ("Ubuntu", "relative/a.jsonl"),
            ("Ubuntu", "/home/../etc/a.jsonl"),
            ("Ubuntu", "/home/u\\x.jsonl"),
            ("bad name", "/home/u/a.jsonl"),
            ("Ubuntu", "/"),
        ],
    )
    def test_rejects_unsafe_input(self, distro: str, path: str) -> None:
        assert wsl_bridge.to_unc(distro, path) is None

    def test_dot_distro_never_allowed(self, bridge_on: None) -> None:
        # valid_distro permits dots (e.g. "Ubuntu-24.04"); the allowlist must
        # still refuse a ".." distro segment.
        assert not wsl_bridge.is_allowed_wsl_transcript(UNC + "..\\x\\.claude\\a.jsonl")


class TestAllowlist:
    def test_accepts_transcript_under_claude_dir(self, bridge_on: None) -> None:
        assert wsl_bridge.is_allowed_wsl_transcript(
            UNC + "Ubuntu\\home\\u\\.claude\\projects\\p\\a.jsonl"
        )

    @pytest.mark.parametrize(
        "path",
        [
            UNC + "Ubuntu\\home\\u\\notes\\a.jsonl",  # not under .claude
            UNC + "Ubuntu\\home\\u\\.claude\\settings.json",  # not a transcript
            UNC + "Ubuntu\\home\\u\\.claude\\..\\x.jsonl",  # traversal
            UNC + "bad name\\home\\u\\.claude\\a.jsonl",  # invalid distro
            "C:\\Users\\u\\.claude\\projects\\a.jsonl",  # not a WSL path
            UNC + "Ubuntu\\home\\u\\.claude.jsonl",  # .claude is the file, not a dir
        ],
    )
    def test_rejects(self, bridge_on: None, path: str) -> None:
        assert not wsl_bridge.is_allowed_wsl_transcript(path)

    def test_inactive_off_windows(self, bridge_off: None) -> None:
        assert not wsl_bridge.is_allowed_wsl_transcript(
            UNC + "Ubuntu\\home\\u\\.claude\\projects\\p\\a.jsonl"
        )


class TestTranslateEvent:
    def test_wsl_distro_survives_parsing(self) -> None:
        assert _event({"wsl_distro": "Ubuntu"}).data.wsl_distro == "Ubuntu"

    def test_rewrites_transcript_paths(self, bridge_on: None) -> None:
        ev = _event(
            {
                "wsl_distro": "Ubuntu",
                "transcript_path": "/home/u/.claude/projects/p/s1.jsonl",
                "agent_transcript_path": "/home/u/.claude/projects/p/s1/subagents/agent-x.jsonl",
                "working_dir": "/home/u/repo",
            }
        )
        wsl_bridge.translate_event(ev)
        assert ev.data.transcript_path == UNC + "Ubuntu\\home\\u\\.claude\\projects\\p\\s1.jsonl"
        assert ev.data.agent_transcript_path.startswith(UNC + "Ubuntu\\home\\u\\.claude\\")
        assert ev.data.working_dir == "/home/u/repo"  # display data stays Linux

    def test_idempotent(self, bridge_on: None) -> None:
        ev = _event({"wsl_distro": "Ubuntu", "transcript_path": "/home/u/.claude/p/a.jsonl"})
        wsl_bridge.translate_event(ev)
        once = ev.data.transcript_path
        wsl_bridge.translate_event(ev)
        assert ev.data.transcript_path == once

    def test_noop_without_distro_or_off_windows(self, bridge_on: None) -> None:
        native = _event({"transcript_path": "/home/u/.claude/p/a.jsonl"})
        wsl_bridge.translate_event(native)
        assert native.data.transcript_path == "/home/u/.claude/p/a.jsonl"

    def test_noop_when_bridge_inactive(self, bridge_off: None) -> None:
        ev = _event({"wsl_distro": "Ubuntu", "transcript_path": "/home/u/.claude/p/a.jsonl"})
        wsl_bridge.translate_event(ev)
        assert ev.data.transcript_path == "/home/u/.claude/p/a.jsonl"


def test_pid_registry_skipped_only_for_wsl_sessions_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAUDE_OFFICE_WSL_BRIDGE", "1")  # Windows desktop backend
    assert wsl_bridge.pid_registry_applies(None)
    assert not wsl_bridge.pid_registry_applies("Ubuntu")
    monkeypatch.setenv("CLAUDE_OFFICE_WSL_BRIDGE", "0")  # Linux backend inside WSL
    assert wsl_bridge.pid_registry_applies("Ubuntu")


def test_state_machine_remembers_wsl_distro() -> None:
    sm = StateMachine()
    sm.transition(_event({}))
    assert sm.wsl_distro is None
    sm.transition(_event({"wsl_distro": "Ubuntu"}))
    assert sm.wsl_distro == "Ubuntu"
    sm.transition(_event({}))  # later events without the tag keep it
    assert sm.wsl_distro == "Ubuntu"
