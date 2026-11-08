"""WS1 (D2, D4, D9, D10): the /ws/campus feed stays honest and observable.

* one broken session is skipped, the frame still builds;
* every frame carries ``sentAt`` / content ``revs`` / ``stalePrDays``;
* an idle client gets a fresh full frame every heartbeat (so the frontend can
  tell a quiet backend from a frozen feed);
* refusals (4003 origin, 4013 cap) complete the handshake so the browser
  actually sees the close code.
"""

# pyright: reportPrivateUsage=false

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.routes import websockets as ws_routes
from app.core.state_machine import StateMachine
from app.models import campus as campus_mod
from app.models.campus import CampusState, build_campus

ORIGIN = {"origin": "http://localhost:3000"}


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(ws_routes.router)
    return app


def test_failing_session_is_skipped_and_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    real = campus_mod.build_campus_session

    def flaky(session_id: str, sm: StateMachine):  # type: ignore[no-untyped-def]
        if session_id == "bad":
            raise RuntimeError("corrupt")
        return real(session_id, sm)

    monkeypatch.setattr(campus_mod, "build_campus_session", flaky)
    state = build_campus({"a": StateMachine(), "bad": StateMachine(), "c": StateMachine()})
    assert [s.session_id for s in state.sessions] == ["a", "c"]
    assert state.stats is not None
    assert state.stats.sessions_by_status  # counted from the surviving sessions
    assert "skipping session bad" in caplog.text


def test_frame_carries_sent_at_revs_and_stale_threshold() -> None:
    state = build_campus({"a": StateMachine()})
    dumped = state.model_dump(mode="json", by_alias=True)
    assert isinstance(dumped["sentAt"], int) and dumped["sentAt"] > 1_700_000_000_000
    assert set(dumped["revs"]) == {"sessions", "projects", "stats"}
    assert dumped["stalePrDays"] == 14


def test_session_rev_moves_only_with_content() -> None:
    one = build_campus({"a": StateMachine()})
    two = build_campus({"a": StateMachine(), "b": StateMachine()})
    assert one.revs and two.revs
    assert one.revs["sessions"] != two.revs["sessions"]
    # No projects in either: that section's rev is identical.
    assert one.revs["projects"] == two.revs["projects"]


class _FakeProcessor:
    def __init__(self) -> None:
        self.snapshots = 0
        self.heartbeats = 0

    async def build_campus_snapshot(self) -> CampusState:
        self.snapshots += 1
        return build_campus({"a": StateMachine()})

    async def build_campus_heartbeat(self) -> CampusState:
        self.heartbeats += 1
        return build_campus({"a": StateMachine()})


def test_idle_client_gets_heartbeat_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProcessor()
    monkeypatch.setattr(ws_routes, "get_event_processor", lambda: proc)
    monkeypatch.setattr(
        ws_routes, "get_settings", lambda: SimpleNamespace(CAMPUS_HEARTBEAT_SECONDS=0.05)
    )
    with TestClient(_app()).websocket_connect("/ws/campus", headers=ORIGIN) as ws:
        frames = [ws.receive_json() for _ in range(3)]
    assert all(f["type"] == "state_update" for f in frames)
    assert all(f["state"]["sentAt"] for f in frames)
    assert proc.snapshots == 1
    assert proc.heartbeats >= 2


def test_heartbeat_build_failure_keeps_the_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProcessor()
    calls = {"n": 0}

    async def flaky_heartbeat() -> CampusState:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("build failed")
        return build_campus({"a": StateMachine()})

    proc.build_campus_heartbeat = flaky_heartbeat  # type: ignore[method-assign]
    monkeypatch.setattr(ws_routes, "get_event_processor", lambda: proc)
    monkeypatch.setattr(
        ws_routes, "get_settings", lambda: SimpleNamespace(CAMPUS_HEARTBEAT_SECONDS=0.05)
    )
    with TestClient(_app()).websocket_connect("/ws/campus", headers=ORIGIN) as ws:
        ws.receive_json()  # connect snapshot
        ws.receive_json()  # the second heartbeat; the first failed and was skipped
    assert calls["n"] >= 2


def test_origin_refusal_is_a_4003_close_frame() -> None:
    client = TestClient(_app())
    with pytest.raises(WebSocketDisconnect) as exc:  # noqa: SIM117
        with client.websocket_connect(
            "/ws/campus", headers={"origin": "http://evil.example"}
        ) as ws:
            ws.receive_json()
    assert exc.value.code == 4003


def test_client_cap_is_a_4013_close_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ws_routes, "_MAX_CAMPUS_CONNECTIONS", 0)
    client = TestClient(_app())
    with pytest.raises(WebSocketDisconnect) as exc:  # noqa: SIM117
        with client.websocket_connect("/ws/campus", headers=ORIGIN) as ws:
            ws.receive_json()
    assert exc.value.code == 4013
