"""Demo files: export a session, play a recorded/hand-written event stream."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core import demo_file
from app.core.demo_file import (
    DemoEvent,
    DemoFileError,
    export_lines,
    parse_demo,
    play,
    playback_gaps,
    rename_sessions,
)
from app.db.models import EventRecord, SessionRecord

BACKEND = Path(__file__).parent.parent

SAMPLE = "\n".join(
    [
        "﻿# hand-written demo",
        '{"claude_office_demo": 1, "name": "Checkout", "speed": 2, "max_gap": 1.5}',
        "",
        '{"event_type": "session_start", "data": {"project_name": "Acme"}}',
        '{"t": 2, "event_type": "user_prompt_submit", "data": {"prompt": "Add Apple Pay"}}',
        '{"delay": 0.25, "event_type": "pre_tool_use", '
        '"data": {"tool_name": "Read", "tool_input": {"file_path": "pay.ts"}}}',
        '{"event_type": "stop"}',
    ]
)


def _api_headers() -> dict[str, str]:
    return {"X-API-Key": get_settings().effective_api_key}


class TestParse:
    def test_header_timing_and_defaults(self) -> None:
        demo = parse_demo(SAMPLE)
        assert (demo.name, demo.speed, demo.max_gap) == ("Checkout", 2.0, 1.5)
        assert [e.t for e in demo.events] == [0.0, 2.0, 2.25, 2.75]
        assert [e.event_type for e in demo.events] == [
            "session_start",
            "user_prompt_submit",
            "pre_tool_use",
            "stop",
        ]
        assert {e.session_id for e in demo.events} == {"demo_session"}
        assert demo.events[3].data == {}

    @pytest.mark.parametrize(
        ("text", "message"),
        [
            ("", "no events"),
            ("# only a comment", "no events"),
            ("{not json", "line 1: not valid JSON"),
            ("[1, 2]", "line 1: expected a JSON object"),
            ('{"event_type": "teleport"}', "unknown event_type"),
            ('{"claude_office_demo": 99}', "unsupported demo format"),
            ('{"t": 5, "event_type": "stop"}\n{"t": 1, "event_type": "stop"}', "line 2: t=1"),
            ('{"t": -1, "event_type": "stop"}', "t must be >= 0"),
            ('{"delay": "soon", "event_type": "stop"}', "delay must be a number"),
            ('{"event_type": "stop", "session_id": "../x"}', "invalid session_id"),
            ('{"event_type": "stop", "data": [1]}', "data must be a JSON object"),
            (
                '{"event_type": "pre_tool_use", "data": {"tool_input": "nope"}}',
                "invalid pre_tool_use data",
            ),
        ],
    )
    def test_errors_name_the_line(self, text: str, message: str) -> None:
        with pytest.raises(DemoFileError, match=message.replace("(", r"\(")):
            parse_demo(text)

    def test_size_and_event_limits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(demo_file, "MAX_DEMO_EVENTS", 2)
        with pytest.raises(DemoFileError, match="more than 2 events"):
            parse_demo('{"event_type": "stop"}\n' * 3)
        monkeypatch.setattr(demo_file, "MAX_DEMO_BYTES", 10)
        with pytest.raises(DemoFileError, match="larger than"):
            parse_demo('{"event_type": "stop"}')


def test_rename_sessions_in_order_of_appearance() -> None:
    events = [
        DemoEvent(0, "session_start", "lead"),
        DemoEvent(1, "session_start", "mate"),
        DemoEvent(2, "stop", "lead"),
    ]
    assert rename_sessions(events, "talk") == ["talk", "talk_2"]
    assert [e.session_id for e in events] == ["talk", "talk_2", "talk"]
    with pytest.raises(DemoFileError):
        rename_sessions(events, "bad id")


def test_playback_caps_gaps_then_applies_speed() -> None:
    events = [DemoEvent(t, "stop", "s") for t in (10.0, 11.0, 71.0, 72.0)]
    assert playback_gaps(events) == [0.0, 1.0, 60.0, 1.0]
    assert playback_gaps(events, speed=2, max_gap=3) == [0.0, 0.5, 1.5, 0.5]


def test_play_uses_header_defaults_unless_overridden() -> None:
    demo = parse_demo(SAMPLE)
    slept: list[float] = []
    sent: list[str] = []
    play(demo, lambda e: sent.append(e.event_type), sleep=slept.append)
    assert sent == [e.event_type for e in demo.events]
    # header: speed 2, max_gap 1.5 -> 2 s gap capped to 1.5, then halved.
    assert slept == [0.75, 0.125, 0.25]
    slept.clear()
    play(demo, lambda e: None, speed=1, max_gap=10, sleep=slept.append)
    assert slept == [2.0, 0.25, 0.5]


def test_export_strips_machine_fields_and_round_trips() -> None:
    t0 = datetime(2026, 11, 9, 10, 0, 0)
    rows: list[tuple[datetime, str, dict[str, Any] | None]] = [
        (
            t0,
            "session_start",
            {
                "project_name": "Acme",
                "transcript_path": "/home/u/.claude/projects/x.jsonl",
                "wsl_distro": "Ubuntu",
                "summary": None,
            },
        ),
        (t0 + timedelta(seconds=1.5), "not_a_type", {}),
        (
            t0 + timedelta(seconds=90),
            "pre_tool_use",
            {"tool_name": "Bash", "tool_input": {"command": "ls", "timeout": None}},
        ),
        (t0 + timedelta(seconds=91), "stop", None),
    ]
    text = "".join(export_lines(rows, name="Acme work", source_session="abc"))
    lines = [json.loads(line) for line in text.splitlines()]
    assert lines[0] == {
        "claude_office_demo": 1,
        "name": "Acme work",
        "max_gap": 3.0,
        "source_session": "abc",
    }
    assert lines[1] == {"t": 0.0, "event_type": "session_start", "data": {"project_name": "Acme"}}
    assert lines[2]["t"] == 90.0 and lines[2]["data"]["tool_input"] == {"command": "ls"}
    assert len(lines) == 4  # unknown event type skipped
    demo = parse_demo(text)
    assert demo.max_gap == 3.0 and len(demo.events) == 3


def test_export_skips_backend_made_cleanups() -> None:
    t0 = datetime(2026, 11, 9, 10, 0, 0)
    rows: list[tuple[datetime, str, dict[str, Any] | None]] = [
        (t0, "subagent_start", {"agent_id": "a1"}),
        (t0, "subagent_start", {"agent_id": "orphan"}),
        (t0, "subagent_stop", {"agent_id": "a1"}),
        (t0, "cleanup", {"agent_id": "a1"}),
        (t0, "cleanup", {"agent_id": "orphan"}),
    ]
    kinds = [
        (e.event_type, e.data.get("agent_id"))
        for e in parse_demo("".join(export_lines(rows))).events
    ]
    assert kinds == [
        ("subagent_start", "a1"),
        ("subagent_start", "orphan"),
        ("subagent_stop", "a1"),
        ("cleanup", "orphan"),
    ]


def test_export_accepts_mixed_aware_and_naive_timestamps() -> None:
    aware = datetime(2026, 11, 9, 10, 0, 0, tzinfo=UTC)
    naive = datetime(2026, 11, 9, 10, 0, 2)
    text = "".join(export_lines([(aware, "stop", {}), (naive, "stop", {})]))
    assert json.loads(text.splitlines()[2])["t"] == 2.0


class TestRoutes:
    async def test_export_session(self, db_session: AsyncSession) -> None:
        from app.main import app

        sid = "export-me"
        now = datetime.now(UTC)
        db_session.add(SessionRecord(id=sid, project_name="Acme", display_name="Big Refactor"))
        db_session.add_all(
            [
                EventRecord(
                    session_id=sid,
                    timestamp=now,
                    event_type="session_start",
                    data={"project_name": "Acme", "transcript_path": "/x"},
                ),
                EventRecord(
                    session_id=sid,
                    timestamp=now + timedelta(seconds=4),
                    event_type="stop",
                    data={},
                ),
            ]
        )
        await db_session.commit()

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            prefix = get_settings().API_V1_STR
            missing = await client.get(f"{prefix}/sessions/nope/export", headers=_api_headers())
            assert missing.status_code == 404
            resp = await client.get(f"{prefix}/sessions/{sid}/export", headers=_api_headers())
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        assert 'filename="claude-office-big-refactor.jsonl"' in resp.headers["content-disposition"]
        demo = parse_demo(resp.text)
        assert demo.name == "Big Refactor"
        assert [(e.t, e.event_type) for e in demo.events] == [
            (0.0, "session_start"),
            (4.0, "stop"),
        ]
        assert "transcript_path" not in resp.text

    def _client(self) -> TestClient:
        from app.main import app

        return TestClient(app, base_url="http://127.0.0.1:8765")

    def test_play_file_validates_then_launches(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from app.api.routes import sessions

        captured: dict[str, Any] = {}

        class _FakeProc:
            def poll(self) -> int:
                return 0

            def terminate(self) -> None:
                pass

            def wait(self, timeout: float) -> int:
                return 0

        def fake_popen(cmd: list[str], **kwargs: Any) -> _FakeProc:
            captured["cmd"] = cmd
            captured["env"] = kwargs["env"]
            return _FakeProc()

        monkeypatch.setattr(sessions.subprocess, "Popen", fake_popen)
        upload = tmp_path / "uploaded-demo.jsonl"
        monkeypatch.setattr(sessions, "_demo_upload_path", lambda: str(upload))
        url = f"{get_settings().API_V1_STR}/sessions/simulate/file"

        bad = self._client().post(url, content=b'{"event_type": "nope"}', headers=_api_headers())
        assert bad.status_code == 400
        assert "line 1" in bad.json()["detail"]
        assert "cmd" not in captured

        two_rooms = SAMPLE + '\n{"event_type": "session_start", "session_id": "other"}'
        resp = self._client().post(
            f"{url}?speed=4&max_gap=2", content=two_rooms.encode(), headers=_api_headers()
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["events"] == 5
        assert body["name"] == "Checkout"
        assert body["sessionIds"] == ["demo_session", "demo_session_2"]
        assert captured["cmd"] == [
            sys.executable,
            "-m",
            "app",
            "simulate",
            "--file",
            str(upload),
            "--speed",
            "4.0",
            "--max-gap",
            "2.0",
        ]
        assert captured["env"]["CLAUDE_OFFICE_API_URL"] == "http://127.0.0.1:8765/api/v1/events"
        assert upload.read_text(encoding="utf-8") == two_rooms

    def test_play_file_rejects_oversized_and_binary(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.api.routes import sessions

        url = f"{get_settings().API_V1_STR}/sessions/simulate/file"
        not_utf8 = self._client().post(url, content=b"\xff\xfe\x00", headers=_api_headers())
        assert not_utf8.status_code == 400
        monkeypatch.setattr(sessions, "MAX_DEMO_BYTES", 8)
        big = self._client().post(url, content=b"x" * 64, headers=_api_headers())
        assert big.status_code == 413

    def test_play_file_requires_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.api.routes import sessions
        from app.main import app

        launched: list[list[str]] = []

        def fake_popen(cmd: list[str], **_kwargs: Any) -> None:
            launched.append(cmd)

        monkeypatch.setattr(sessions.subprocess, "Popen", fake_popen)
        settings = get_settings()
        monkeypatch.setattr(settings, "CLAUDE_OFFICE_API_KEY", "")
        url = f"{settings.API_V1_STR}/sessions/simulate/file"
        assert TestClient(app).post(url, content=SAMPLE.encode()).status_code == 401
        assert launched == []


def test_simulate_file_subcommand_posts_events(tmp_path: Path) -> None:
    received: list[dict[str, Any]] = []

    class _Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - http.server API
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append({"key": self.headers.get("X-API-Key"), **json.loads(body)})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    demo = tmp_path / "demo.jsonl"
    demo.write_text(SAMPLE, encoding="utf-8")
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-m",
                "app",
                "simulate",
                "--file",
                str(demo),
                "--session",
                "pitch",
                "--speed",
                "50",
                "--quiet",
            ],
            cwd=BACKEND,
            env={
                **os.environ,
                "CLAUDE_OFFICE_API_URL": f"http://127.0.0.1:{server.server_port}/api/v1/events",
                "CLAUDE_OFFICE_API_KEY": "k",
            },
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    finally:
        server.shutdown()
    assert proc.returncode == 0, proc.stderr
    assert [e["event_type"] for e in received] == [
        "session_start",
        "user_prompt_submit",
        "pre_tool_use",
        "stop",
    ]
    assert {e["session_id"] for e in received} == {"pitch"}
    assert {e["key"] for e in received} == {"k"}
    assert received[2]["data"]["tool_name"] == "Read"


def test_simulate_file_subcommand_reports_bad_file(tmp_path: Path) -> None:
    demo = tmp_path / "demo.jsonl"
    demo.write_text('{"event_type": "teleport"}', encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "app", "simulate", "--file", str(demo)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 2
    assert "line 1: unknown event_type" in proc.stderr


def test_shipped_example_demo_is_valid() -> None:
    example = BACKEND.parent / "scripts" / "demos" / "checkout-feature.jsonl"
    demo = parse_demo(example.read_text(encoding="utf-8"))
    assert demo.name and len(demo.events) > 10
