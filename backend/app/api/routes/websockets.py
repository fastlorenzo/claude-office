"""WebSocket routes for the Claude Office backend.

Moved out of ``app.main`` in ARC-023. The three endpoints register on a
dedicated ``APIRouter`` that ``app.main`` includes without a prefix.

Declaration order is load-bearing: ``/ws/overview`` MUST be registered before
``/ws/{session_id}`` so the single-segment path ``/ws/overview`` isn't
captured by the session-id route (which would treat "overview" as a session
id, accept, find no state, and silently idle).
"""

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.websocket import get_manager
from app.config import get_settings
from app.core.event_processor import get_event_processor
from app.models.campus import CampusState
from app.services.git_service import git_service

logger = logging.getLogger(__name__)

# Upper bound on concurrent /ws/overview (Command Center) watchers. Each one
# amplifies the per-event overview rebuild cost, so refuse new ones past this.
_MAX_OVERVIEW_CONNECTIONS = 16

# Upper bound on concurrent /ws/campus (3D office) watchers; each one receives
# the slim state of every session on every (debounced) change.
_MAX_CAMPUS_CONNECTIONS = 8

router = APIRouter()


def _campus_frame(campus: CampusState) -> dict[str, object]:
    return {
        "type": "state_update",
        "timestamp": campus.last_updated.isoformat(),
        "state": campus.model_dump(mode="json", by_alias=True),
    }


@router.websocket("/ws/overview")
async def websocket_overview(websocket: WebSocket) -> None:
    """Overview WebSocket: boss status of every live session (Command Center).

    Declared BEFORE ``/ws/{session_id}`` so the single-segment path ``/ws/overview``
    isn't captured by the session route (which would treat "overview" as a session
    id, accept, find no state, and silently idle).
    """
    from app.api.websocket import validate_websocket_origin

    if not validate_websocket_origin(websocket):
        await websocket.close(code=4003, reason="Origin not allowed")
        return

    # Cap concurrent overview watchers: each connection amplifies the per-event
    # overview rebuild cost, so refuse beyond the limit instead of letting it
    # grow unbounded. The check is enforced atomically with the registration
    # inside connect_overview (under the manager lock) so a burst of concurrent
    # handshakes can't each pass the limit before any registers.
    accepted = await get_manager().connect_overview(
        websocket, max_connections=_MAX_OVERVIEW_CONNECTIONS
    )
    if not accepted:
        await websocket.close(code=4013, reason="Too many overview connections")
        return
    try:
        # Send the current overview snapshot on connect. Built under the same
        # ``_sessions_lock`` used by the per-event broadcast so it reads a
        # consistent registry snapshot and can't race a concurrent event handler
        # resizing ``sessions`` mid-iteration.
        overview = await get_event_processor().build_overview_snapshot()
        await websocket.send_json(
            {
                "type": "state_update",
                "timestamp": overview.last_updated.isoformat(),
                "state": overview.model_dump(mode="json", by_alias=True),
            }
        )
        # Keep alive -- discard incoming messages
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("Overview WebSocket error", exc_info=True)
    finally:
        await get_manager().disconnect_overview(websocket)


@router.websocket("/ws/campus")
async def websocket_campus(websocket: WebSocket) -> None:
    """Campus WebSocket: slim state of every live session (3D office).

    Declared BEFORE ``/ws/{session_id}`` for the same reason as ``/ws/overview``.
    """
    from app.api.websocket import validate_websocket_origin

    # Refusals complete the handshake first: closing an un-accepted socket is an
    # HTTP 403 the browser reports as 1006, so the 4003/4013 codes the frontend
    # acts on (stop retrying / "too many viewers") would never reach it.
    if not validate_websocket_origin(websocket):
        await websocket.accept()
        await websocket.close(code=4003, reason="Origin not allowed")
        return

    accepted = await get_manager().connect_campus(
        websocket, max_connections=_MAX_CAMPUS_CONNECTIONS
    )
    if not accepted:
        await websocket.accept()
        await websocket.close(code=4013, reason="Too many campus connections")
        return
    try:
        campus = await get_event_processor().build_campus_snapshot()
        await websocket.send_json(_campus_frame(campus))
        # Keep alive -- discard incoming messages. While idle, push a fresh
        # full frame every CAMPUS_HEARTBEAT_SECONDS: a quiet backend then keeps
        # advancing the client's "last frame" clock, while a feed that can no
        # longer be built (frozen data) goes silent and the client flags it.
        heartbeat = get_settings().CAMPUS_HEARTBEAT_SECONDS
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=heartbeat)
            except TimeoutError:
                try:
                    campus = await get_event_processor().build_campus_heartbeat()
                except Exception:
                    logger.exception("Campus heartbeat: snapshot failed")
                    continue
                await websocket.send_json(_campus_frame(campus))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("Campus WebSocket error", exc_info=True)
    finally:
        await get_manager().disconnect_campus(websocket)


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    from app.api.websocket import validate_session_id, validate_websocket_origin

    if not validate_session_id(session_id):
        await websocket.close(code=4000, reason="Invalid session ID format")
        return

    if not validate_websocket_origin(websocket):
        await websocket.close(code=4003, reason="Origin not allowed")
        return

    await get_manager().connect(websocket, session_id)
    # Ref-counted: the console opens a second socket per session, and closing
    # either must not stop git updates for the other.
    git_service.retain(session_id)

    try:
        current_state = await get_event_processor().get_current_state(session_id)
        if current_state:
            await get_manager().send_personal_message(
                {
                    "type": "state_update",
                    "timestamp": current_state.last_updated.isoformat(),
                    "state": current_state.model_dump(mode="json", by_alias=True),
                },
                websocket,
            )

        project_root = await get_event_processor().get_project_root(session_id)
        if project_root:
            git_service.configure(session_id=session_id, project_root=project_root)

        git_status = git_service.get_status(session_id=session_id)
        if git_status is None:
            # Remote session: the hook's latest git report (client_context).
            git_status = await get_event_processor().get_client_git_status(session_id)
        if git_status:
            await get_manager().send_personal_message(
                {
                    "type": "git_status",
                    "timestamp": git_status.last_updated.isoformat(),
                    "gitStatus": git_status.model_dump(mode="json"),
                },
                websocket,
            )

        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await get_manager().disconnect(websocket, session_id)
        git_service.release(session_id)


@router.websocket("/ws/room/{room_id}")
async def websocket_room(websocket: WebSocket, room_id: str) -> None:
    """Room-level WebSocket: sends merged state for all sessions in a room."""
    from app.api.websocket import validate_session_id, validate_websocket_origin

    if not validate_session_id(room_id):
        await websocket.close(code=4000, reason="Invalid room ID format")
        return

    if not validate_websocket_origin(websocket):
        await websocket.close(code=4003, reason="Origin not allowed")
        return

    from app.core.room_orchestrator import RoomOrchestrator

    await get_manager().connect_room(websocket, room_id)
    try:
        # Send current room state on connect
        orch: RoomOrchestrator | None = get_event_processor().orchestrators.get(room_id)
        if orch:
            state = orch.merge()
            if state:
                await websocket.send_json(
                    {
                        "type": "state_update",
                        "timestamp": state.last_updated.isoformat(),
                        "state": state.model_dump(mode="json", by_alias=True),
                    }
                )
        # Keep alive -- discard incoming messages
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("Room WebSocket error for %s", room_id, exc_info=True)
    finally:
        await get_manager().disconnect_room(websocket, room_id)
