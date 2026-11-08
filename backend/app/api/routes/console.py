"""Session Console REST endpoints (spec: docs/design/session-console.md, 3.4)."""

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_processor import get_event_processor
from app.core.state_machine import StateMachine
from app.core.transcript_lookup import find_tool_result
from app.db.database import get_db
from app.db.models import EventRecord, SessionRecord
from app.models.console import (
    AgentNode,
    ConsoleHeader,
    ConsoleSnapshot,
    ToolCall,
    ToolCallDetail,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["console"])

DEFAULT_LIMIT = 300
MAX_LIMIT = 1000


async def _get_machine(session_id: str) -> StateMachine:
    """Return the session's machine (restoring from the DB if needed) or 404."""
    processor = get_event_processor()
    sm = processor.sessions.get(session_id)
    if sm is None:
        await processor.get_current_state(session_id)  # restores from the DB
        sm = processor.sessions.get(session_id)
    if sm is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return sm


def _snapshot_calls(
    sm: StateMachine, limit: int, before_seq: int | None
) -> tuple[list[ToolCall], bool, int | None]:
    tracker: Any = getattr(sm, "tool_calls", None)
    if tracker is None:
        return [], False, None
    calls, has_more, oldest = tracker.snapshot(limit, before_seq)
    return list(calls), bool(has_more), oldest


def _agent_nodes(sm: StateMachine) -> list[AgentNode]:
    tree: Any = getattr(sm, "agent_tree", None)
    if tree is None:
        return []
    return list(tree.nodes())


def _build_header(session_id: str, sm: StateMachine, started_at: str | None) -> ConsoleHeader:
    from app.models.campus import build_campus_session

    last = sm.last_event_at.isoformat() if sm.last_event_at else None
    try:
        cs = build_campus_session(session_id, sm)
    except Exception:
        logger.warning("Console header: campus build failed for %s", session_id, exc_info=True)
        return ConsoleHeader(session_id=session_id, started_at=started_at, last_event_at=last)
    return ConsoleHeader(
        session_id=session_id,
        project=cs.project,
        branch=cs.git_branch,
        phase=cs.phase,
        alive=cs.alive,
        ended=cs.ended,
        started_at=started_at,
        last_event_at=cs.last_event_at.isoformat() if cs.last_event_at else last,
        telemetry=cs.telemetry,
    )


@router.get("/{session_id}/console", response_model=ConsoleSnapshot, response_model_by_alias=True)
async def get_console_snapshot(
    session_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    before_seq: Annotated[int | None, Query(ge=0)] = None,
) -> ConsoleSnapshot:
    """Snapshot for the Session Console: header, agent tree, latest tool calls."""
    sm = await _get_machine(session_id)
    created = (
        await db.execute(select(SessionRecord.created_at).where(SessionRecord.id == session_id))
    ).scalar_one_or_none()
    started_at = created.isoformat() if created else None

    calls, has_more, oldest = _snapshot_calls(sm, limit, before_seq)
    return ConsoleSnapshot(
        header=_build_header(session_id, sm, started_at),
        agents=_agent_nodes(sm),
        tool_calls=calls,
        has_more=has_more,
        oldest_seq=oldest,
        conversation=list(sm.conversation),
        todos=sm.to_game_state(session_id).todos,
    )


async def _tool_event_rows(db: AsyncSession, session_id: str, tool_use_id: str) -> list[Any]:
    rows = await db.execute(
        select(EventRecord)
        .where(
            EventRecord.session_id == session_id,
            func.json_extract(EventRecord.data, "$.tool_use_id") == tool_use_id,
        )
        .order_by(EventRecord.id)
    )
    return list(rows.scalars())


async def _subagent_transcript_path(
    db: AsyncSession, session_id: str, sm: StateMachine, agent_id: str, main_path: str | None
) -> str | None:
    """Locate a subagent's transcript when its tool hooks carried no path.

    Hook events fired inside a subagent have no ``transcript_path``; the file is
    ``<main transcript minus .jsonl>/subagents/agent-<native id>.jsonl``.
    """
    agent = sm.agents.get(agent_id)
    native = getattr(agent, "native_id", None)
    if not native or not str(native).isalnum():
        return None
    if main_path is None:
        row = await db.execute(
            select(func.json_extract(EventRecord.data, "$.transcript_path"))
            .where(
                EventRecord.session_id == session_id,
                func.json_extract(EventRecord.data, "$.transcript_path").is_not(None),
            )
            .order_by(EventRecord.id.desc())
            .limit(1)
        )
        main_path = row.scalar_one_or_none()
    if not main_path or not str(main_path).endswith(".jsonl"):
        return None
    return f"{str(main_path)[:-6]}/subagents/agent-{native}.jsonl"


@router.get(
    "/{session_id}/tool-calls/{tool_use_id}",
    response_model=ToolCallDetail,
    response_model_by_alias=True,
)
async def get_tool_call_detail(
    session_id: str,
    tool_use_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ToolCallDetail:
    """Full input (DB row) and full output (transcript, else hook preview)."""
    sm = await _get_machine(session_id)
    tracker: Any = getattr(sm, "tool_calls", None)
    call: ToolCall | None = tracker.get(tool_use_id) if tracker is not None else None
    if call is None:
        raise HTTPException(status_code=404, detail="Tool call not found")

    rows = await _tool_event_rows(db, session_id, tool_use_id)
    full_input: dict[str, Any] | None = None
    main_path: str | None = None
    agent_path: str | None = None
    hook_output: str | None = None
    for row in rows:
        data: dict[str, Any] = row.data or {}
        if full_input is None and isinstance(data.get("tool_input"), dict):
            full_input = data["tool_input"]
        main_path = data.get("transcript_path") or main_path
        agent_path = data.get("agent_transcript_path") or agent_path
        if isinstance(data.get("tool_output"), str):
            hook_output = data["tool_output"]

    if agent_path is None and call.agent_id != "main":
        agent_path = await _subagent_transcript_path(db, session_id, sm, call.agent_id, main_path)

    output: str | None = None
    source: str = "none"
    truncated = False
    # Subagent calls live in the subagent's transcript; try it first. Paths come
    # from persisted hook events (untrusted), so lookup re-validates every one.
    for path in (agent_path, main_path):
        if not path:
            continue
        found = await asyncio.to_thread(find_tool_result, path, tool_use_id)
        if found is not None:
            output, truncated = found
            source = "transcript"
            break
    if output is None:
        output = hook_output if hook_output is not None else call.output_preview
        if output is not None:
            source = "hook"
            truncated = call.output_truncated

    return ToolCallDetail(
        call=call,
        input=full_input if full_input is not None else call.input_preview,
        output=output,
        output_source=source,  # type: ignore[arg-type]
        output_truncated=truncated,
    )
