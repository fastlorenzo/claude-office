"""WebSocket broadcasting helpers for the EventProcessor.

Provides standalone async functions that send state and event payloads to all
WebSocket connections for a given session.  Extracted from EventProcessor so
that handler modules can import just what they need without pulling in the
full EventProcessor class.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.core.connection_manager import get_manager
from app.core.state_machine import StateMachine
from app.core.tool_calls import ApplyResult
from app.models.console import AgentNode, ToolCall
from app.models.sessions import GameState, HistoryEntry

if TYPE_CHECKING:
    from app.core.room_orchestrator import RoomOrchestrator

__all__ = [
    "broadcast_state",
    "broadcast_event",
    "broadcast_tool_call",
    "broadcast_agent_node",
    "broadcast_console",
    "broadcast_error",
    "broadcast_room_state",
    "broadcast_overview_state",
    "broadcast_campus_state",
]


async def broadcast_state(session_id: str, sm: StateMachine) -> None:
    """Broadcast the current GameState to all clients connected to *session_id*.

    Args:
        session_id: The session whose clients should receive the update.
        sm: The StateMachine holding current state.
    """
    # Skip the (up to 500+500 entry) GameState serialization when nobody is
    # listening for this session (ARC-015). Existence-check without the manager
    # lock is safe — same pattern as the ``overview_connections`` guard in
    # ``broadcast_overview_state``. A reconnect triggers a fresh snapshot via
    # the /ws/{session_id} connect path, so skipping here loses nothing.
    if not get_manager().active_connections.get(session_id):
        return
    game_state: GameState = sm.to_game_state(session_id)
    await get_manager().broadcast(
        {
            "type": "state_update",
            "timestamp": game_state.last_updated.isoformat(),
            "state": game_state.model_dump(mode="json", by_alias=True),
        },
        session_id,
    )


async def broadcast_event(
    session_id: str,
    event_dict: HistoryEntry,
) -> None:
    """Broadcast a single event payload to all clients connected to *session_id*.

    Args:
        session_id: The session whose clients should receive the event.
        event_dict: The history-entry TypedDict describing the event.
    """
    payload: dict[str, Any] = {
        "type": "event",
        "timestamp": event_dict["timestamp"],
        "event": dict(event_dict),
    }
    await get_manager().broadcast(payload, session_id)


async def broadcast_tool_call(session_id: str, call: ToolCall) -> None:
    """Send one upserted :class:`ToolCall` as a ``tool_call`` frame (spec 3.5)."""
    await get_manager().broadcast(
        {
            "type": "tool_call",
            "timestamp": datetime.now(UTC).isoformat(),
            "sessionId": session_id,
            "toolCall": call.model_dump(mode="json", by_alias=True),
        },
        session_id,
    )


async def broadcast_agent_node(session_id: str, node: AgentNode) -> None:
    """Send one upserted :class:`AgentNode` as an ``agent_node`` frame (spec 3.5)."""
    await get_manager().broadcast(
        {
            "type": "agent_node",
            "timestamp": datetime.now(UTC).isoformat(),
            "sessionId": session_id,
            "agent": node.model_dump(mode="json", by_alias=True),
        },
        session_id,
    )


async def broadcast_console(session_id: str, result: ApplyResult) -> None:
    """Broadcast everything one transition touched: agent nodes first, then calls.

    Nodes go first so a client never sees a call whose agent it does not know.
    Skips serialization entirely when nobody is connected to the session.
    """
    if not (result.nodes or result.calls):
        return
    if not get_manager().active_connections.get(session_id):
        return
    for node in result.nodes:
        await broadcast_agent_node(session_id, node)
    for call in result.calls:
        await broadcast_tool_call(session_id, call)


async def broadcast_error(session_id: str, message: str, timestamp: str) -> None:
    """Broadcast an error message to all clients connected to *session_id*.

    Args:
        session_id: The session whose clients should receive the error.
        message: Human-readable error description.
        timestamp: ISO-format timestamp string for the error.
    """
    await get_manager().broadcast(
        {
            "type": "error",
            "message": message,
            "timestamp": timestamp,
        },
        session_id,
    )


async def broadcast_room_state(room_id: str, orchestrator: RoomOrchestrator) -> None:
    """Broadcast merged room state to all WebSocket clients subscribed to a room."""
    merged_state = orchestrator.merge()
    if merged_state is None:
        return
    await get_manager().broadcast_room(
        {
            "type": "state_update",
            "timestamp": merged_state.last_updated.isoformat(),
            "state": merged_state.model_dump(mode="json", by_alias=True),
        },
        room_id,
    )


async def broadcast_overview_state(
    sessions: dict[str, StateMachine],
    sessions_lock: asyncio.Lock | None = None,
) -> None:
    """Broadcast the cross-session overview to all ``/ws/overview`` clients.

    Skips building the payload entirely when nobody is watching the Command
    Center, so the per-event hook stays cheap in the common case.

    ``build_overview`` reads the live session registry and each StateMachine's
    mutable collections, which concurrent event handlers rewrite (e.g.
    ``self.sessions[id] = ...`` / ``del sm.agents[id]``). When *sessions_lock*
    is supplied it is held across the build so the registry can't be resized
    mid-iteration. Callers must NOT already hold the lock (it is acquired here
    exactly once, so there is no re-entry / deadlock risk).
    """
    if not get_manager().overview_connections:
        return
    # Local import avoids any import-order coupling at module load.
    from app.core.room_orchestrator import build_overview

    if sessions_lock is not None:
        async with sessions_lock:
            overview = build_overview(sessions)
    else:
        overview = build_overview(sessions)
    await get_manager().broadcast_overview(
        {
            "type": "state_update",
            "timestamp": overview.last_updated.isoformat(),
            "state": overview.model_dump(mode="json", by_alias=True),
        }
    )


async def broadcast_campus_state(
    sessions: dict[str, StateMachine],
    sessions_lock: asyncio.Lock | None = None,
) -> None:
    """Broadcast the slim all-sessions state to all ``/ws/campus`` clients.

    Skips building the payload when nobody is watching. The build runs under
    *sessions_lock* (when supplied) so the registry can't be resized
    mid-iteration; callers must NOT already hold the lock.
    """
    if not get_manager().campus_connections:
        return
    from app.models.campus import build_campus

    if sessions_lock is not None:
        async with sessions_lock:
            campus = build_campus(sessions)
    else:
        campus = build_campus(sessions)
    await get_manager().broadcast_campus(
        {
            "type": "state_update",
            "timestamp": campus.last_updated.isoformat(),
            "state": campus.model_dump(mode="json", by_alias=True),
        }
    )
