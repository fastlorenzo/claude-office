"""Campus (3D office) models: a slim state of every live session.

``/ws/campus`` streams one :class:`CampusSession` per live session so the
frontend can render all sessions at once. Heavy ``GameState`` fields
(history, conversation, whiteboard, queues) are deliberately excluded.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.models.agents import Agent, Boss, OfficeState
from app.models.common import TodoItem
from app.models.overview import OverviewBucket

if TYPE_CHECKING:
    from app.core.state_machine import StateMachine

__all__ = [
    "CampusActivity",
    "CampusSession",
    "CampusState",
    "build_campus",
    "build_campus_session",
]

RECENT_ACTIVITY_LIMIT = 8
SUMMARY_MAX_CHARS = 140


class CampusActivity(BaseModel):
    """One recent history entry (slimmed) for a session."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    timestamp: str
    type: str
    agent_id: str
    summary: str


class CampusSession(BaseModel):
    """Slim per-session state for the 3D office."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    session_id: str
    bucket: OverviewBucket
    boss: Boss
    agents: list[Agent]
    office: OfficeState
    todos: list[TodoItem] = Field(default_factory=lambda: cast(list[TodoItem], []))
    recent_activity: list[CampusActivity] = Field(
        default_factory=lambda: cast(list[CampusActivity], [])
    )
    ended: bool = False
    last_updated: datetime


class CampusState(BaseModel):
    """The full campus feed broadcast over ``/ws/campus``."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    sessions: list[CampusSession] = Field(default_factory=lambda: cast(list[CampusSession], []))
    last_updated: datetime


def _truncate(text: str, limit: int = SUMMARY_MAX_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def build_campus_session(session_id: str, sm: StateMachine) -> CampusSession:
    """Build the slim campus view of one session from its StateMachine."""
    from app.core.room_orchestrator import overview_bucket
    from app.core.state_machine import OfficePhase

    gs = sm.to_game_state(session_id)
    recent = list(gs.history)[-RECENT_ACTIVITY_LIMIT:]
    return CampusSession(
        session_id=session_id,
        bucket=overview_bucket(sm),
        boss=gs.boss,
        agents=gs.agents,
        office=gs.office,
        todos=gs.todos,
        recent_activity=[
            CampusActivity(
                timestamp=h["timestamp"],
                type=h["type"],
                agent_id=h["agentId"],
                summary=_truncate(h["summary"]),
            )
            for h in recent
        ],
        ended=sm.phase == OfficePhase.ENDED,
        last_updated=gs.last_updated,
    )


def build_campus(sessions: dict[str, StateMachine]) -> CampusState:
    """Build the campus feed for every session, sorted by session id."""
    items = sorted(sessions.items(), key=lambda kv: kv[0])
    return CampusState(
        sessions=[build_campus_session(sid, sm) for sid, sm in items],
        last_updated=datetime.now(UTC),
    )
