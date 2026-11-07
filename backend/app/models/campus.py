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

from app.core.summary_service import OBJECTIVE_MAX_CHARS
from app.models.agents import Agent, AgentState, Boss, OfficeState
from app.models.common import TodoItem, TodoStatus
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
FOCUS_MAX_CHARS = 90
SESSION_NAME_MAX_CHARS = 80
WORK_ITEM_MAX_CHARS = 70
WORK_ITEMS_LIMIT = 4
_INACTIVE_AGENT_STATES = frozenset(
    {AgentState.COMPLETED, AgentState.LEAVING, AgentState.REPORTING_DONE, AgentState.IN_ELEVATOR}
)


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
    objective: str | None = None
    session_name: str | None = None
    focus: str | None = None
    work_items: list[str] = Field(default_factory=lambda: cast(list[str], []))
    git_branch: str | None = None
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


def _one_line(text: str | None, limit: int) -> str | None:
    """Collapse whitespace and truncate at a word boundary (None when empty)."""
    if not text:
        return None
    flat = " ".join(text.split())
    if not flat:
        return None
    if len(flat) <= limit:
        return flat
    cut = flat[: limit - 1]
    if flat[limit - 1] != " " and " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-.") + "…"


def _todo_text(todo: TodoItem) -> str | None:
    return todo.content or todo.active_form


def compute_focus(sm: StateMachine, todos: list[TodoItem]) -> str | None:
    """What the session is doing now: boss task, else in-progress todo, else last tool."""
    if focus := _one_line(sm.boss_current_task, FOCUS_MAX_CHARS):
        return focus
    for todo in todos:
        if todo.status == TodoStatus.IN_PROGRESS and (
            text := _one_line(todo.active_form or todo.content, FOCUS_MAX_CHARS)
        ):
            return text
    return _one_line(sm.latest_activity, FOCUS_MAX_CHARS)


def compute_work_items(todos: list[TodoItem], agents: list[Agent]) -> list[str]:
    """In-progress todos, then active subagent tasks; de-duplicated, capped."""
    candidates: list[str | None] = [
        _todo_text(t) for t in todos if t.status == TodoStatus.IN_PROGRESS
    ]
    for agent in agents:
        if agent.state in _INACTIVE_AGENT_STATES or not agent.current_task:
            continue
        name = agent.name or f"Agent {agent.number}"
        candidates.append(f"{name}: {agent.current_task}")

    items: list[str] = []
    seen: set[str] = set()
    for cand in candidates:
        item = _one_line(cand, WORK_ITEM_MAX_CHARS)
        if not item or item.casefold() in seen:
            continue
        seen.add(item.casefold())
        items.append(item)
        if len(items) >= WORK_ITEMS_LIMIT:
            break
    return items


def build_campus_session(session_id: str, sm: StateMachine) -> CampusSession:
    """Build the slim campus view of one session from its StateMachine."""
    from app.core.room_orchestrator import overview_bucket
    from app.core.state_machine import OfficePhase

    gs = sm.to_game_state(session_id)
    recent = list(gs.history)[-RECENT_ACTIVITY_LIMIT:]
    from app.services.git_branch import get_branch
    from app.services.git_service import git_service

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
        objective=_one_line(sm.effective_objective, OBJECTIVE_MAX_CHARS),
        session_name=_one_line(sm.custom_title, SESSION_NAME_MAX_CHARS),
        focus=compute_focus(sm, gs.todos),
        work_items=compute_work_items(gs.todos, gs.agents),
        git_branch=get_branch(git_service.get_session_root(session_id)),
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
