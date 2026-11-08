"""C6/D2: one broken session must not take the whole campus feed down.

``build_campus`` iterates every session; a single ``build_campus_session``
raising currently aborts the frame (and ``_flush_campus_broadcast`` swallows
the error, so clients keep frozen data on an apparently healthy socket).

WS1 landed the per-session guard; these are plain regression tests.
"""

# pyright: reportPrivateUsage=false

from unittest.mock import AsyncMock

import pytest
from starlette.websockets import WebSocketState

from app.api.websocket import ConnectionManager
from app.core import broadcast_service
from app.core.state_machine import StateMachine
from app.models import campus as campus_mod
from app.models.campus import build_campus


def _poison(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    real = campus_mod.build_campus_session

    def flaky(session_id: str, sm: StateMachine):  # type: ignore[no-untyped-def]
        if session_id == bad:
            raise RuntimeError("corrupt session")
        return real(session_id, sm)

    monkeypatch.setattr(campus_mod, "build_campus_session", flaky)


def test_baseline_all_sessions_build() -> None:
    state = build_campus({"a": StateMachine(), "b": StateMachine()})
    assert [s.session_id for s in state.sessions] == ["a", "b"]


def test_bad_session_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    _poison(monkeypatch, "b")
    state = build_campus({"a": StateMachine(), "b": StateMachine(), "c": StateMachine()})
    assert [s.session_id for s in state.sessions] == ["a", "c"]


@pytest.mark.asyncio
async def test_frame_still_broadcasts_with_a_bad_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mgr = ConnectionManager()
    ws = AsyncMock()
    ws.client_state = WebSocketState.CONNECTED
    await mgr.connect_campus(ws, max_connections=4)
    monkeypatch.setattr(broadcast_service, "get_manager", lambda: mgr)
    _poison(monkeypatch, "bad")
    await broadcast_service.broadcast_campus_state({"good": StateMachine(), "bad": StateMachine()})
    ws.send_json.assert_called_once()
    frame = ws.send_json.call_args.args[0]
    assert frame["type"] == "state_update"
    assert [s["sessionId"] for s in frame["state"]["sessions"]] == ["good"]
