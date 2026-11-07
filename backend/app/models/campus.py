"""Campus (3D office) models: a slim state of every live session.

``/ws/campus`` streams one :class:`CampusSession` per live session so the
frontend can render all sessions at once. Heavy ``GameState`` fields
(history, conversation, whiteboard, queues) are deliberately excluded.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.config import get_settings
from app.core.ci_poller import get_ci_poller
from app.core.projects import ProjectRef, get_project_ref, resolve_project
from app.core.session_liveness import is_stale, last_activity
from app.core.session_phase import PhaseInputs, PhaseKind, classify_phase
from app.core.session_root import find_session_root
from app.core.session_summary import extract_refs, project_name_for_root, resolve_summary
from app.core.subagent_liveness import count_running_subagents, scan_agent_mtimes
from app.core.summary_service import OBJECTIVE_MAX_CHARS
from app.core.telemetry import get_telemetry_store
from app.models.agents import Agent, AgentState, Boss, BossState, OfficeState
from app.models.ci import CampusProject, CheckState, PipelineRun, PullRequestInfo
from app.models.common import TodoItem, TodoStatus
from app.models.overview import OverviewBucket
from app.models.telemetry import CampusStats, SessionActivityStats, SessionTelemetry

if TYPE_CHECKING:
    from app.core.state_machine import StateMachine

__all__ = [
    "CampusActivity",
    "CampusSession",
    "CampusState",
    "SessionPhase",
    "build_campus",
    "build_projects",
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


class SessionPhase(BaseModel):
    """Deterministic "where is the session at" (see ``core.session_phase``)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    kind: PhaseKind
    label: str
    detail: str | None = None
    since: str | None = None  # ISO timestamp the kind last changed


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
    summary: str | None = None
    refs: list[str] = Field(default_factory=lambda: cast(list[str], []))
    project: str | None = None
    # Key of the CampusProject this session belongs to (CampusState.projects[].id).
    project_id: str | None = None
    phase: SessionPhase | None = None
    git_branch: str | None = None
    ended: bool = False
    # Process liveness: True/False from Claude Code's pid registry, None = unknown.
    alive: bool | None = None
    telemetry: SessionTelemetry | None = None
    activity: SessionActivityStats | None = None
    last_event_at: datetime | None = None
    last_updated: datetime


class CampusState(BaseModel):
    """The full campus feed broadcast over ``/ws/campus``."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    sessions: list[CampusSession] = Field(default_factory=lambda: cast(list[CampusSession], []))
    projects: list[CampusProject] | None = None
    stats: CampusStats | None = None
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


def compute_phase(
    sm: StateMachine, agents: list[Agent], now: datetime | None = None
) -> SessionPhase:
    """Classify the live phase; ``since`` only moves when the kind changes."""
    from app.core.state_machine import OfficePhase

    result = classify_phase(
        PhaseInputs(
            ended=sm.phase == OfficePhase.ENDED,
            waiting_permission=sm.boss_state == BossState.WAITING_PERMISSION,
            compacting=sm.compacting,
            turn_active=sm.turn_active,
            has_prompted=sm.last_user_prompt is not None,
            tool_running=sm.tool_running,
            tool_name=sm.last_tool_name,
            tool_input=sm.last_tool_input,
            active_subagents=sum(1 for a in agents if a.state not in _INACTIVE_AGENT_STATES),
        )
    )
    if sm.phase_kind != result.kind or sm.phase_since is None:
        sm.phase_kind = result.kind
        sm.phase_since = now or datetime.now(UTC)
    return SessionPhase(
        kind=result.kind,
        label=result.label,
        detail=result.detail,
        since=sm.phase_since.isoformat(),
    )


def build_campus_session(session_id: str, sm: StateMachine) -> CampusSession:
    """Build the slim campus view of one session from its StateMachine."""
    from app.core.room_orchestrator import overview_bucket
    from app.core.state_machine import OfficePhase

    gs = sm.to_game_state(session_id)
    recent = list(gs.history)[-RECENT_ACTIVITY_LIMIT:]
    from app.services.git_branch import get_branch
    from app.services.git_service import git_service

    root = git_service.get_session_root(session_id)
    if root is None:
        root = find_session_root(session_id, sm.title_offset_path)
        if root:
            git_service.configure(session_id=session_id, project_root=root)
    branch = get_branch(root)
    proj = resolve_project(root)
    session_name = _one_line(sm.custom_title, SESSION_NAME_MAX_CHARS)
    objective = _one_line(sm.effective_objective, OBJECTIVE_MAX_CHARS)

    settings = get_settings()
    store = get_telemetry_store()
    last_act = last_activity(sm.last_event_at, sm.title_offset_path)
    bucket = overview_bucket(sm)
    if sm.alive is not True and is_stale(last_act, settings.CAMPUS_STALE_SECONDS):
        bucket = "done"  # possibly alive but silent: show idle, not "working"

    now_ts = time.time()
    telemetry = store.session_telemetry(session_id)
    if telemetry is not None and telemetry.context_used_pct is not None:
        # One source of truth for the context gauge: the status line (or its estimate),
        # not the token tracker (200k default, fed by hook events).
        gs.office.context_utilization = max(0.0, min(telemetry.context_used_pct / 100, 1.0))
    activity = store.session_activity(session_id)
    activity.subagents_running = count_running_subagents(
        sm.agents,
        sm.handin_queue,
        sm.stopped_native,
        scan_agent_mtimes(sm.title_offset_path, now_ts),
        now_ts,
    )

    return CampusSession(
        session_id=session_id,
        bucket=bucket,
        alive=sm.alive,
        telemetry=telemetry,
        activity=activity,
        last_event_at=sm.last_event_at,
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
        objective=objective,
        session_name=session_name,
        summary=resolve_summary(
            ai_summary=sm.summary_ai,
            ai_title=sm.ai_title,
            objective=sm.objective_ai or sm.objective,
            branch=branch,
        ),
        refs=extract_refs(
            session_name=sm.custom_title,
            branch=branch,
            objective=sm.effective_objective,
            prompts=sm.first_prompts,
        ),
        project=project_name_for_root(root),
        project_id=proj.id if proj else None,
        phase=compute_phase(sm, gs.agents),
        focus=compute_focus(sm, gs.todos),
        work_items=compute_work_items(gs.todos, gs.agents),
        git_branch=branch,
        ended=sm.phase == OfficePhase.ENDED,
        last_updated=gs.last_updated,
    )


def build_projects(sessions: list[CampusSession], now: datetime) -> list[CampusProject]:
    """Group live sessions by project; attach cached CI data (no IO)."""
    groups: dict[str, list[CampusSession]] = {}
    for cs in sessions:
        if cs.project_id and not cs.ended:
            groups.setdefault(cs.project_id, []).append(cs)
    poller = get_ci_poller()
    out: list[CampusProject] = []
    for pid in sorted(groups):
        members = groups[pid]
        ref: ProjectRef | None = get_project_ref(pid)
        repo = ref.repo if ref else None
        ci = poller.note_repo(repo, ref.default_branch if ref else None) if repo else None
        available = bool(ci and ci.available)
        by_branch = {m.git_branch: m.session_id for m in members if m.git_branch}
        prs: list[PullRequestInfo] = []
        if ci and available:
            prs = [
                pr.model_copy(update={"session_id": by_branch.get(pr.branch)})
                for pr in ci.pull_requests
            ]
        updated = max(
            (m.last_updated for m in members),
            default=now,
        )
        out.append(
            CampusProject(
                id=pid,
                name=ref.name if ref else (members[0].project or pid),
                repo=repo,
                default_branch=ref.default_branch if ref else None,
                session_ids=[m.session_id for m in members],
                pull_requests=prs,
                pipelines=list(ci.pipelines) if ci and available else [],
                ci_available=available,
                updated_at=updated.isoformat(),
                main_health=_main_health(ci.pipelines, ref.default_branch if ref else None)
                if ci and available
                else "none",
            )
        )
    return out


def _main_health(pipelines: list[PipelineRun], default_branch: str | None) -> CheckState:
    """State of the newest CI pipeline on the default branch (pipelines are newest first)."""
    for run in pipelines:
        if run.kind == "ci" and (default_branch is None or run.branch == default_branch):
            return run.state
    return "none"


def build_campus(sessions: dict[str, StateMachine]) -> CampusState:
    """Build the campus feed for every session, sorted by session id."""
    items = sorted(
        ((sid, sm) for sid, sm in sessions.items() if not sm.campus_hidden),
        key=lambda kv: kv[0],
    )
    built = [build_campus_session(sid, sm) for sid, sm in items]
    by_status: dict[str, int] = {}
    subagents = 0
    for cs in built:
        key = "ended" if cs.ended else cs.bucket
        by_status[key] = by_status.get(key, 0) + 1
        if not cs.ended:
            running = cs.activity.subagents_running if cs.activity else None
            subagents += (
                running
                if running is not None
                else sum(1 for a in cs.agents if a.state not in _INACTIVE_AGENT_STATES)
            )
    now = datetime.now(UTC)
    return CampusState(
        sessions=built,
        projects=build_projects(built, now),
        stats=get_telemetry_store().stats(by_status, subagents),
        last_updated=now,
    )
