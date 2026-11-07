"""Tests for the /ws/campus feed: models, connections, broadcast, route order."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from starlette.websockets import WebSocketState

from app.api.routes.websockets import _MAX_CAMPUS_CONNECTIONS, router
from app.api.websocket import ConnectionManager
from app.core import broadcast_service
from app.core.event_processor import EventProcessor
from app.core.state_machine import OfficePhase, StateMachine
from app.models.agents import BossState
from app.models.campus import CampusSession, build_campus, build_campus_session


def _history(n: int, summary: str = "did a thing") -> list:  # type: ignore[type-arg]
    return [
        {
            "id": f"h{i}",
            "type": "pre_tool_use",
            "agentId": "main",
            "summary": f"{summary} {i}",
            "timestamp": f"2026-01-01T00:00:{i:02d}+00:00",
            "detail": {"secret": "x"},
        }
        for i in range(n)
    ]


def _sm(n_history: int = 0, summary: str = "did a thing") -> StateMachine:
    sm = StateMachine()
    sm.history = _history(n_history, summary)  # type: ignore[assignment]
    return sm


def _ws() -> AsyncMock:
    ws = AsyncMock()
    ws.client_state = WebSocketState.CONNECTED
    return ws


class TestRouteOrder:
    def test_campus_declared_before_session_id(self) -> None:
        paths = [getattr(r, "path", "") for r in router.routes]
        assert paths.index("/ws/campus") < paths.index("/ws/{session_id}")


class TestCampusConnections:
    @pytest.mark.asyncio
    async def test_connect_and_disconnect(self) -> None:
        mgr = ConnectionManager()
        ws = _ws()
        assert await mgr.connect_campus(ws, max_connections=2)
        assert ws in mgr.campus_connections
        await mgr.disconnect_campus(ws)
        assert ws not in mgr.campus_connections

    @pytest.mark.asyncio
    async def test_cap_refuses_without_accepting(self) -> None:
        mgr = ConnectionManager()
        assert _MAX_CAMPUS_CONNECTIONS == 8
        await mgr.connect_campus(_ws(), max_connections=1)
        extra = _ws()
        assert not await mgr.connect_campus(extra, max_connections=1)
        extra.accept.assert_not_called()
        assert len(mgr.campus_connections) == 1

    @pytest.mark.asyncio
    async def test_broadcast_prunes_failed(self) -> None:
        mgr = ConnectionManager()
        good, bad = _ws(), _ws()
        bad.send_json.side_effect = RuntimeError("boom")
        await mgr.connect_campus(good, max_connections=4)
        await mgr.connect_campus(bad, max_connections=4)
        await mgr.broadcast_campus({"type": "x"})
        good.send_json.assert_called_once_with({"type": "x"})
        assert mgr.campus_connections == [good]


class TestBuilder:
    def test_slim_session(self) -> None:
        sm = _sm(12)
        cs = build_campus_session("s1", sm)
        assert isinstance(cs, CampusSession)
        assert len(cs.recent_activity) == 8
        assert [a.summary for a in cs.recent_activity][0].endswith(" 4")
        assert cs.recent_activity[-1].summary.endswith(" 11")  # newest last
        assert cs.ended is False
        assert cs.bucket in ("needs_you", "working", "done")

    def test_summary_truncated(self) -> None:
        cs = build_campus_session("s1", _sm(1, "x" * 500))
        assert len(cs.recent_activity[0].summary) == 140
        assert cs.recent_activity[0].summary.endswith("…")

    def test_ended_flag(self) -> None:
        sm = _sm()
        sm.phase = OfficePhase.ENDED
        assert build_campus_session("s1", sm).ended is True

    def test_bucket_from_boss_state(self) -> None:
        sm = _sm()
        sm.boss_state = BossState.WORKING
        assert build_campus_session("s1", sm).bucket == "working"

    def test_build_campus_sorted(self) -> None:
        state = build_campus({"b": _sm(), "a": _sm()})
        assert [s.session_id for s in state.sessions] == ["a", "b"]


class TestBroadcast:
    @pytest.mark.asyncio
    async def test_no_watchers_short_circuit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mgr = ConnectionManager()
        monkeypatch.setattr(broadcast_service, "get_manager", lambda: mgr)
        called = MagicMock()
        monkeypatch.setattr("app.models.campus.build_campus", called)
        await broadcast_service.broadcast_campus_state({"a": _sm()})
        called.assert_not_called()

    @pytest.mark.asyncio
    async def test_payload_shape(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mgr = ConnectionManager()
        ws = _ws()
        await mgr.connect_campus(ws, max_connections=4)
        monkeypatch.setattr(broadcast_service, "get_manager", lambda: mgr)
        sm = _sm(12)
        sm.phase = OfficePhase.ENDED
        await broadcast_service.broadcast_campus_state({"s1": sm})
        msg = ws.send_json.call_args.args[0]
        assert msg["type"] == "state_update"
        state = msg["state"]
        assert set(state) == {"sessions", "lastUpdated"}
        sess = state["sessions"][0]
        assert set(sess) == {
            "sessionId",
            "bucket",
            "boss",
            "agents",
            "office",
            "todos",
            "recentActivity",
            "objective",
            "sessionName",
            "focus",
            "workItems",
            "gitBranch",
            "ended",
            "lastUpdated",
        }
        for banned in ("history", "conversation", "whiteboardData"):
            assert banned not in sess
        assert sess["ended"] is True
        assert len(sess["recentActivity"]) == 8
        assert set(sess["recentActivity"][0]) == {"timestamp", "type", "agentId", "summary"}


class TestRemoveSession:
    @pytest.mark.asyncio
    async def test_remove_session_schedules_campus_broadcast(self) -> None:
        ep = EventProcessor()
        ep.sessions["s1"] = _sm()
        ep._schedule_campus_broadcast = MagicMock()  # type: ignore[method-assign]
        await ep.remove_session("s1")
        ep._schedule_campus_broadcast.assert_called_once()
        assert "s1" not in ep.sessions

    @pytest.mark.asyncio
    async def test_clear_all_schedules_campus_broadcast(self) -> None:
        ep = EventProcessor()
        ep._schedule_campus_broadcast = MagicMock()  # type: ignore[method-assign]
        await ep.clear_all_sessions()
        ep._schedule_campus_broadcast.assert_called_once()
