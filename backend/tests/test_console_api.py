"""Tests for the Session Console REST endpoints (spec 3.4) and socket safety."""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.core.event_processor import event_processor
from app.main import app
from app.models.console import AgentNode, ToolCall

client = TestClient(app)
_WS_HEADERS = {"X-API-Key": get_settings().effective_api_key}


class FakeTracker:
    """Same read interface as WS2's ToolCallTracker."""

    def __init__(self, calls: list[ToolCall]) -> None:
        self._calls = sorted(calls, key=lambda c: c.seq)

    def snapshot(
        self, limit: int, before_seq: int | None = None
    ) -> tuple[list[ToolCall], bool, int | None]:
        pool = [c for c in self._calls if before_seq is None or c.seq < before_seq]
        page = pool[-limit:]
        return page, len(pool) > len(page), (page[0].seq if page else None)

    def get(self, call_id: str) -> ToolCall | None:
        return next((c for c in self._calls if c.id == call_id), None)


class FakeTree:
    def nodes(self) -> list[AgentNode]:
        return [AgentNode(id="main", kind="main", name="Main", state="working", rev=1)]


def _call(seq: int, call_id: str | None = None) -> ToolCall:
    return ToolCall(
        id=call_id or f"toolu_{seq}",
        seq=seq,
        rev=1,
        agent_id="main",
        tool_name="Bash",
        status="ok",
        started_at="2026-01-01T00:00:00+00:00",
        output_preview="preview",
    )


def _post(sid: str, event_type: str, data: dict[str, Any]) -> None:
    resp = client.post(
        "/api/v1/events",
        json={
            "event_type": event_type,
            "session_id": sid,
            "timestamp": datetime.now(UTC).isoformat(),
            "data": data,
        },
    )
    assert resp.status_code in (200, 201, 202), resp.text


def _seed(calls: list[ToolCall] | None = None) -> str:
    sid = f"con-{uuid4()}"
    _post(sid, "session_start", {})
    sm = event_processor.sessions[sid]
    sm.tool_calls = FakeTracker(calls or [])  # type: ignore[attr-defined]
    sm.agent_tree = FakeTree()  # type: ignore[attr-defined]
    return sid


def test_snapshot_live_session() -> None:
    sid = _seed([_call(i) for i in range(1, 6)])
    r = client.get(f"/api/v1/sessions/{sid}/console?limit=3")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["header"]["sessionId"] == sid
    assert [c["seq"] for c in body["toolCalls"]] == [3, 4, 5]
    assert body["hasMore"] is True and body["oldestSeq"] == 3
    assert body["agents"][0]["id"] == "main"
    assert "conversation" in body and "todos" in body


def test_snapshot_db_only_session_is_restored() -> None:
    sid = _seed()
    event_processor.sessions.pop(sid)  # simulate backend restart
    r = client.get(f"/api/v1/sessions/{sid}/console")
    assert r.status_code == 200, r.text
    assert r.json()["header"]["sessionId"] == sid
    assert sid in event_processor.sessions


def test_snapshot_unknown_session_404() -> None:
    assert client.get("/api/v1/sessions/nope-nope/console").status_code == 404


def test_snapshot_without_tracker_is_empty_not_crash() -> None:
    sid = _seed()
    sm = event_processor.sessions[sid]
    del sm.tool_calls  # type: ignore[attr-defined]
    del sm.agent_tree  # type: ignore[attr-defined]
    r = client.get(f"/api/v1/sessions/{sid}/console")
    assert r.status_code == 200
    assert r.json()["toolCalls"] == [] and r.json()["agents"] == []


def test_before_seq_paging_contiguous() -> None:
    sid = _seed([_call(i) for i in range(1, 26)])
    seen: list[int] = []
    before: int | None = None
    for _ in range(10):
        url = f"/api/v1/sessions/{sid}/console?limit=10"
        if before is not None:
            url += f"&before_seq={before}"
        body = client.get(url).json()
        page = [c["seq"] for c in body["toolCalls"]]
        seen = page + seen
        if not body["hasMore"]:
            break
        before = body["oldestSeq"]
    assert seen == list(range(1, 26))


def test_limit_validation() -> None:
    sid = _seed()
    assert client.get(f"/api/v1/sessions/{sid}/console?limit=0").status_code == 422
    assert client.get(f"/api/v1/sessions/{sid}/console?limit=100000").status_code == 422


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / ".claude" / "projects" / "p").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: h))
    return h


def _tr(tid: str, text: str) -> str:
    return json.dumps(
        {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]},
        }
    )


def _tool_event(
    sid: str, tid: str, transcript: Path | str, agent_transcript: Path | str | None = None
) -> None:
    data: dict[str, Any] = {
        "tool_name": "Bash",
        "tool_use_id": tid,
        "tool_input": {"command": "echo full-input", "extra": "y" * 5000},
        "transcript_path": str(transcript),
    }
    if agent_transcript:
        data["agent_transcript_path"] = str(agent_transcript)
    _post(sid, "pre_tool_use", data)


def test_detail_main_transcript(home: Path) -> None:
    tp = home / ".claude" / "projects" / "p" / "s.jsonl"
    tp.write_text(_tr("toolu_m", "FULL MAIN OUTPUT") + "\n")
    sid = _seed([_call(1, "toolu_m")])
    _tool_event(sid, "toolu_m", tp)
    r = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_m")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["output"] == "FULL MAIN OUTPUT"
    assert body["outputSource"] == "transcript" and body["outputTruncated"] is False
    assert body["input"]["command"] == "echo full-input"
    assert len(body["input"]["extra"]) == 5000  # full, not preview
    assert body["call"]["id"] == "toolu_m"


def test_detail_subagent_transcript(home: Path) -> None:
    d = home / ".claude" / "projects" / "p" / "s" / "subagents"
    d.mkdir(parents=True)
    main = home / ".claude" / "projects" / "p" / "s.jsonl"
    main.write_text(_tr("other", "nope") + "\n")
    sub = d / "agent-1.jsonl"
    sub.write_text(_tr("toolu_s", "FROM SUBAGENT") + "\n")
    sid = _seed([_call(1, "toolu_s")])
    _tool_event(sid, "toolu_s", main, sub)
    body = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_s").json()
    assert body["output"] == "FROM SUBAGENT" and body["outputSource"] == "transcript"


def test_detail_cap_and_truncated_flag(home: Path) -> None:
    tp = home / ".claude" / "projects" / "p" / "big.jsonl"
    tp.write_text(_tr("toolu_b", "z" * (300 * 1024)) + "\n")
    sid = _seed([_call(1, "toolu_b")])
    _tool_event(sid, "toolu_b", tp)
    body = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_b").json()
    assert body["outputTruncated"] is True
    assert len(body["output"]) == 256 * 1024


def test_detail_falls_back_to_hook_preview(home: Path) -> None:
    tp = home / ".claude" / "projects" / "p" / "empty.jsonl"
    tp.write_text("")
    sid = _seed([_call(1, "toolu_h")])
    _tool_event(sid, "toolu_h", tp)
    body = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_h").json()
    assert body["outputSource"] == "hook" and body["output"] == "preview"


def test_detail_no_output_source_none(home: Path) -> None:
    sid = _seed([_call(1, "toolu_n").model_copy(update={"output_preview": None})])
    body = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_n").json()
    assert body["outputSource"] == "none" and body["output"] is None


def test_detail_outside_root_path_never_read(
    home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    evil = tmp_path / "evil.jsonl"
    evil.write_text(_tr("toolu_e", "SECRET") + "\n")
    sid = _seed([_call(1, "toolu_e")])
    _tool_event(sid, "toolu_e", evil)
    import os

    opened: list[str] = []
    real_open = os.open
    monkeypatch.setattr(
        os, "open", lambda *a, **k: (opened.append(str(a[0])), real_open(*a, **k))[1]
    )
    body = client.get(f"/api/v1/sessions/{sid}/tool-calls/toolu_e").json()
    assert "SECRET" not in json.dumps(body)
    assert body["outputSource"] != "transcript"
    assert str(evil) not in opened


def test_detail_unknown_call_404() -> None:
    sid = _seed([_call(1)])
    assert client.get(f"/api/v1/sessions/{sid}/tool-calls/nope").status_code == 404
    assert client.get("/api/v1/sessions/nope-nope/tool-calls/x").status_code == 404


def test_openapi_lists_console_models() -> None:
    schemas = app.openapi()["components"]["schemas"]
    for name in ("ConsoleSnapshot", "ToolCallDetail", "ToolCall", "AgentNode", "ConsoleHeader"):
        assert name in schemas, name


# --- socket safety: ref-counted git polling -------------------------------


def test_git_service_refcount_keeps_session_for_second_socket(tmp_path: Path) -> None:
    import subprocess

    from app.services.git_service import GitService

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    svc = GitService()
    svc.retain("s1")
    svc.configure("s1", str(repo))
    svc.retain("s1")
    assert svc.release("s1") == 1
    assert svc.get_session_root("s1") is not None
    assert svc.get_status(session_id="s1") is not None
    assert svc.release("s1") == 0
    assert svc.get_session_root("s1") is None


def test_two_sockets_close_one_other_still_gets_git_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    from app.core.connection_manager import get_manager
    from app.services.git_service import git_service

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    sid = f"ws-{uuid4()}"

    async def _root(_sid: str) -> str:
        return str(repo)

    monkeypatch.setattr(event_processor, "get_project_root", _root)
    with client.websocket_connect(f"/ws/{sid}", headers=_WS_HEADERS) as ws2:
        with client.websocket_connect(f"/ws/{sid}", headers=_WS_HEADERS) as ws1:
            assert ws1.receive_json()["type"] == "git_status"  # handler is past configure
            assert ws2.receive_json()["type"] == "git_status"
            assert git_service.get_session_root(sid) is not None
            ws1.close()
        # ws1 closed; session must still be tracked and ws2 still registered.
        assert git_service.get_session_root(sid) is not None
        assert len(get_manager().active_connections.get(sid, [])) == 1
        status = git_service.get_status(session_id=sid)
        assert status is not None
        # Poller broadcasts target sessions in git_service._sessions: still there.
        assert sid in git_service._sessions  # pyright: ignore[reportPrivateUsage]
        ws2.close()
    assert git_service.get_session_root(sid) is None
