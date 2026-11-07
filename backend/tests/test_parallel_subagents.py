"""Regression: parallel / background subagents are correlated by PostToolUse.

Fixtures are modelled on a real session log where six Agent tool calls were
started within seconds, SubagentStart ("subagent_info") events arrived out of
order, and native SubagentStop events for already-finished agents used to remove
whichever agent had started most recently.

Correlation key: the Agent tool's PostToolUse carries both ``tool_use_id`` (->
``subagent_<tool_use_id>``) and the native ``agentId``.
"""

from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import TypeAdapter
from sqlalchemy import delete

from app.core.event_processor import EventProcessor
from app.db.database import AsyncSessionLocal
from app.db.models import EventRecord, SessionRecord
from app.models.events import AnyEvent

SID = "parallel-subagents-test"
TS = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC).isoformat()
TRANSCRIPT = "/home/user/.claude/projects/proj/sess.jsonl"
_adapter: TypeAdapter[AnyEvent] = TypeAdapter(AnyEvent)

TOOLS = {i: f"toolu_{i:02d}AAAA" for i in range(1, 7)}
NATIVES = {i: f"a{i}0000000000000{i}" for i in range(1, 7)}
FINISHED_EARLIER = "abea0000deadbeef0"  # an agent from a previous batch


def _ev(event_type: str, data: dict[str, Any]) -> AnyEvent:
    return _adapter.validate_python(
        {
            "event_type": event_type,
            "session_id": SID,
            "timestamp": TS,
            "data": {"transcript_path": TRANSCRIPT, **data},
        }
    )


def start(i: int) -> AnyEvent:
    return _ev(
        "subagent_start",
        {
            "agent_id": f"subagent_{TOOLS[i]}",
            "agent_name": f"Task {i}",
            "agent_type": "general-purpose",
            "task_description": f"do thing {i}",
            "tool_use_id": TOOLS[i],
        },
    )


def post(i: int) -> AnyEvent:
    """Agent tool PostToolUse ("launched"): the correlation event."""
    return _ev(
        "post_tool_use",
        {
            "agent_id": "main",
            "tool_name": "Agent",
            "tool_use_id": TOOLS[i],
            "native_agent_id": NATIVES[i],
            "agent_transcript_path": f"/x/sess/subagents/agent-{NATIVES[i]}.jsonl",
        },
    )


def info(native: str) -> AnyEvent:
    return _ev(
        "subagent_info",
        {
            "native_agent_id": native,
            "agent_type": "general-purpose",
            "agent_transcript_path": f"/x/sess/subagents/agent-{native}.jsonl",
        },
    )


def stop(native: str | None = None, agent_id: str | None = None) -> AnyEvent:
    data: dict[str, Any] = {}
    if native:
        data["native_agent_id"] = native
    if agent_id:
        data["agent_id"] = agent_id
    return _ev("subagent_stop", data)


async def _wipe() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(EventRecord).where(EventRecord.session_id == SID))
        await db.execute(delete(SessionRecord).where(SessionRecord.id == SID))
        await db.commit()


def _running(ep: EventProcessor) -> set[str]:
    return set(ep.sessions[SID].agents)


def _expected(*idx: int) -> set[str]:
    return {f"subagent_{TOOLS[i]}" for i in idx}


@pytest.mark.asyncio
async def test_parallel_and_background_interleaving() -> None:
    ep = EventProcessor()
    await _wipe()
    try:
        await ep.process_event(_ev("session_start", {"project_name": "p"}))

        # Six starts in quick succession; none is linked yet.
        for i in range(1, 7):
            await ep.process_event(start(i))
        sm = ep.sessions[SID]
        assert _running(ep) == _expected(1, 2, 3, 4, 5, 6)  # (a) each exactly once
        assert all(a.native_id is None for a in sm.agents.values())

        # Infos arrive out of order, detached from their starts; posts later.
        # Infos must not link (or synthesise) anything.
        for i in (6, 3, 5):
            await ep.process_event(info(NATIVES[i]))
        assert all(a.native_id is None for a in sm.agents.values())
        assert _running(ep) == _expected(1, 2, 3, 4, 5, 6)

        # PostToolUse ("launched") in yet another order: links, never removes (d).
        for i in (3, 1, 6, 2, 5, 4):
            await ep.process_event(post(i))
            await ep.process_event(info(NATIVES[i]))
        assert _running(ep) == _expected(1, 2, 3, 4, 5, 6)
        for i in range(1, 7):
            assert sm.agents[f"subagent_{TOOLS[i]}"].native_id == NATIVES[i]

        # (c) a stop for a native we never tracked removes nothing.
        await ep.process_event(stop(FINISHED_EARLIER))
        assert _running(ep) == _expected(1, 2, 3, 4, 5, 6)

        # (b) stops remove exactly their own agent; background agent 3 outlives
        # the others.
        for done, remaining in [
            (6, (1, 2, 3, 4, 5)),
            (1, (2, 3, 4, 5)),
            (5, (2, 3, 4)),
            (2, (3, 4)),
            (4, (3,)),
        ]:
            await ep.process_event(stop(NATIVES[done]))
            assert _running(ep) == _expected(*remaining), f"after stopping {done}"

        # (e) duplicate / re-delivered stops are idempotent, and a sync-style
        # stop by tool id for an already-removed agent is ignored too.
        await ep.process_event(stop(NATIVES[4]))
        await ep.process_event(stop(NATIVES[6]))
        await ep.process_event(stop(agent_id=f"subagent_{TOOLS[1]}"))
        assert _running(ep) == _expected(3)

        # The long-running background agent finally stops.
        await ep.process_event(stop(NATIVES[3]))
        await ep.process_event(stop(NATIVES[3]))
        assert _running(ep) == set()
    finally:
        await _wipe()


@pytest.mark.asyncio
async def test_stop_by_tool_id_removes_only_that_agent() -> None:
    ep = EventProcessor()
    await _wipe()
    try:
        await ep.process_event(_ev("session_start", {"project_name": "p"}))
        for i in (1, 2, 3):
            await ep.process_event(start(i))
        await ep.process_event(stop(agent_id=f"subagent_{TOOLS[2]}"))
        assert _running(ep) == _expected(1, 3)
    finally:
        await _wipe()


@pytest.mark.asyncio
async def test_restore_from_db_keeps_links() -> None:
    """A restored session must not mass-link unlinked agents on SubagentInfo."""
    ep = EventProcessor()
    await _wipe()
    try:
        await ep.process_event(_ev("session_start", {"project_name": "p"}))
        for i in (1, 2, 3):
            await ep.process_event(start(i))
        await ep.process_event(info(NATIVES[2]))
        await ep.process_event(post(2))

        ep2 = EventProcessor()
        sm = await ep2._build_restored_state_machine(SID)  # pyright: ignore[reportPrivateUsage]
        assert sm is not None
        natives = {aid: a.native_id for aid, a in sm.agents.items()}
        assert natives[f"subagent_{TOOLS[2]}"] == NATIVES[2]
        assert natives[f"subagent_{TOOLS[1]}"] is None
        assert natives[f"subagent_{TOOLS[3]}"] is None
    finally:
        await _wipe()
