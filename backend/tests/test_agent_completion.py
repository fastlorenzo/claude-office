"""Session Console agent tree: legacy names, completion, full transcript backfill.

Spec: docs/design/session-console.md, sections 3.2 and 3.3.

Fixtures are sanitized copies of the real shapes (local visualizer.db and
``~/.claude/projects/<p>/<session>/subagents/agent-<native>.jsonl`` /
``.meta.json``): ids, prompts, commands and paths are replaced; record types,
field presence, ordering and relative timing are kept.
"""

# pyright: reportPrivateUsage=false

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.event_processor import EventProcessor
from app.core.handlers.agent_handler import discover_native_link
from app.core.state_machine import StateMachine
from app.core.tool_calls import handback_native
from app.core.transcript_poller import TranscriptPoller, get_transcript_poller
from app.db.database import AsyncSessionLocal, Base, get_engine, override_engine
from app.db.models import EventRecord, SessionRecord
from app.models.events import AnyEvent, EventAdapter

BASE = datetime(2026, 11, 8, 9, 0, 0, tzinfo=UTC)

SPAWN = "toolu_fx_legacy01"
SUB = f"subagent_{SPAWN}"
NATIVE = "a0f0f0f0f0f0f0f01"


def _ev(event_type: str, t: float, session_id: str = "agent-done", **data: Any) -> AnyEvent:
    return EventAdapter.validate_python(
        {
            "event_type": event_type,
            "session_id": session_id,
            "timestamp": BASE + timedelta(seconds=t),
            "data": data,
        }
    )


def _run(sm: StateMachine, events: list[AnyEvent]) -> None:
    for e in events:
        sm.transition(e)


def _handback_prompt(
    t: float, native: str = NATIVE, sid: str = "agent-done", **extra: Any
) -> AnyEvent:
    # The hook truncates prompts; only the "[Subag" prefix survives.
    return _ev(
        "user_prompt_submit", t, sid, prompt=f'<agent-message from="{native}">\n[Subag...', **extra
    )


def _polled_call(t: float, tid: str, agent: str = SUB) -> list[AnyEvent]:
    """A call re-emitted by a transcript backfill (record timestamps, no tool_name on post)."""
    return [
        _ev(
            "pre_tool_use",
            t,
            agent_id=agent,
            tool_name="Bash",
            tool_use_id=tid,
            tool_input={"command": f"echo {tid}"},
        ),
        _ev("post_tool_use", t + 1, agent_id=agent, tool_use_id=tid, success=True),
    ]


def _link(t: float, name: str = "Fixture legacy job") -> AnyEvent:
    """The backend's ``.meta.json`` link record (source="link")."""
    return _ev(
        "subagent_info",
        t,
        agent_id=SUB,
        native_agent_id=NATIVE,
        agent_transcript_path="/home/user/.claude/projects/p/sess/subagents/agent-x.jsonl",
        agent_name=name,
        agent_type="general-purpose",
        source="link",
    )


# ---------------------------------------------------------------------------
# Names of agents spawned before the hook upgrade
# ---------------------------------------------------------------------------


def test_link_record_names_a_node_created_bare_by_backfilled_calls() -> None:
    # Real order on restore: the backfilled calls carry their transcript
    # timestamps, older than the link record discovered at the agent's stop.
    sm = StateMachine()
    _run(sm, _polled_call(10, "toolu_c1") + _polled_call(20, "toolu_c2"))
    node = sm.agent_tree.get(SUB)
    assert node is not None and node.name == SUB  # bare: only its id
    sm.transition(_link(4000))
    node = sm.agent_tree.get(SUB)
    assert node is not None
    assert node.name == "Fixture legacy job" and node.agent_type == "general-purpose"
    assert node.native_id == NATIVE and node.tool_calls == 2
    assert node.started_at == (BASE + timedelta(seconds=10)).isoformat(timespec="microseconds")
    # A real name is never overwritten by a later link.
    sm.transition(_link(4001, name="Other"))
    assert sm.agent_tree.get(SUB).name == "Fixture legacy job"  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_meta_link_from_handback_prompt_and_never_from_a_link_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    subagents = home / ".claude" / "projects" / "p" / "sess" / "subagents"
    subagents.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    (subagents / f"agent-{NATIVE}.jsonl").write_text("")
    (subagents / f"agent-{NATIVE}.meta.json").write_text(
        json.dumps(
            {
                "agentType": "general-purpose",
                "isBuiltIn": True,
                "description": "Fixture legacy job",
                "toolUseId": SPAWN,
                "spawnDepth": 1,
                "requestShape": "background",
                "finished": True,
            }
        )
    )
    main = str(home / ".claude" / "projects" / "p" / "sess.jsonl")
    sm = StateMachine()
    link = await discover_native_link(sm, _handback_prompt(100, transcript_path=main))
    assert link is not None
    assert (link.data.agent_id, link.data.agent_name, link.data.agent_type) == (
        SUB,
        "Fixture legacy job",
        "general-purpose",
    )
    # Replaying a persisted link record must not mint another one (a restore
    # used to add a duplicate row every time).
    sm2 = StateMachine()
    assert await discover_native_link(sm2, link) is None
    assert handback_native("plain prompt") is None
    assert handback_native(f'<agent-message from="{NATIVE}">\n[Subagent hand-back] x') == NATIVE


# ---------------------------------------------------------------------------
# Completion: hand-back, waiting, transcript end
# ---------------------------------------------------------------------------


def test_handback_before_link_finishes_legacy_agent_and_waiting_does_not_reopen() -> None:
    # The a6d5861 sequence: calls (backfilled), hand-back prompt, link record,
    # native stop, then "waiting on its own background work".
    sm = StateMachine()
    _run(sm, _polled_call(10, "toolu_c1") + _polled_call(4070, "toolu_handback"))
    sm.transition(_handback_prompt(4071.580))
    node = sm.agent_tree.get(SUB)
    assert node is not None and node.state == "running"  # native not linked yet
    _run(
        sm,
        [
            _link(4071.628),
            _ev("subagent_stop", 4071.629, native_agent_id=NATIVE),
            _ev(
                "background_task_notification",
                4075,
                background_task_id=NATIVE,
                background_task_status="completed",
                background_task_summary=(
                    'Agent "Fixture legacy job" is waiting on its own background work'
                ),
            ),
        ],
    )
    node = sm.agent_tree.get(SUB)
    assert node is not None
    assert node.state == "done" and node.name == "Fixture legacy job"
    assert node.ended_at == (BASE + timedelta(seconds=4071.580)).isoformat(timespec="microseconds")


ASYNC = "toolu_fx_async01"
ASYNC_SUB = f"subagent_{ASYNC}"
ASYNC_NATIVE = "a1f1f1f1f1f1f1f12"


def _async_spawn() -> list[AnyEvent]:
    return [
        _ev(
            "subagent_start",
            0,
            agent_id=ASYNC_SUB,
            tool_use_id=ASYNC,
            agent_name="Fix fixture regression",
            agent_type="general-purpose",
        ),
        _ev(
            "post_tool_use",
            0.3,
            agent_id="main",
            tool_name="Agent",
            tool_use_id=ASYNC,
            native_agent_id=ASYNC_NATIVE,
            success=True,
        ),
        _ev("subagent_info", 0.32, native_agent_id=ASYNC_NATIVE),
    ]


def test_handback_ends_a_live_async_agent_with_no_stop_and_resume_revives() -> None:
    # The floors-agent sequence: a zombie guess 2 min in (long thinking), work
    # for an hour, then only the hand-back prompt (no SubagentStop).
    sm = StateMachine()
    _run(sm, _async_spawn())
    _run(sm, [_ev("stop", 5), _ev("subagent_stop", 122, agent_id=ASYNC_SUB, source="zombie")])
    node = sm.agent_tree.get(ASYNC_SUB)
    # A live async child is never lost at the main turn end or by the guess.
    assert node is not None and node.state == "running"
    assert sm.tool_calls.get(ASYNC).status == "spawned"  # type: ignore[union-attr]
    _run(sm, _polled_call(130, "toolu_w1", ASYNC_SUB) + _polled_call(3900, "toolu_w2", ASYNC_SUB))
    sm.transition(_handback_prompt(3971, ASYNC_NATIVE))
    assert sm.last_console.handed_back == ASYNC_SUB
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "done" and node.tool_calls == 2
    assert sm.tool_calls.get(ASYNC).status == "ok"  # type: ignore[union-attr]
    # New work after the hand-back (a resume) revives it; its next end works.
    _run(sm, _polled_call(4000, "toolu_w3", ASYNC_SUB))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "running"
    sm.transition(
        _ev(
            "background_task_notification",
            4010,
            background_task_id=ASYNC_NATIVE,
            background_task_summary=(
                'Agent "Fix fixture regression" is waiting on its own background work'
            ),
        )
    )
    assert sm.agent_tree.get(ASYNC_SUB).state == "waiting"  # type: ignore[union-attr]
    sm.transition(_ev("subagent_stop", 4600, agent_id=ASYNC_SUB, source="transcript_end"))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "done"
    # The end time is its last recorded activity, not when the poller noticed.
    assert node.ended_at == (BASE + timedelta(seconds=4001)).isoformat(timespec="microseconds")


def test_transcript_end_never_rewrites_a_finished_agent() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn())
    sm.transition(_handback_prompt(50, ASYNC_NATIVE))
    ended = sm.agent_tree.get(ASYNC_SUB).ended_at  # type: ignore[union-attr]
    _run(
        sm,
        [
            _ev("subagent_stop", 51, native_agent_id=ASYNC_NATIVE),  # hook stop after hand-back
            _ev("subagent_stop", 90, agent_id=ASYNC_SUB, source="transcript_end"),
        ],
    )
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "done" and node.ended_at == ended


def test_handback_releases_the_office_desk() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn())
    assert ASYNC_SUB in sm.agents
    sm.transition(_handback_prompt(50, ASYNC_NATIVE))
    assert ASYNC_SUB in sm.handin_queue


# ---------------------------------------------------------------------------
# Poller: full backfill, completion, zombie keeps polling
# ---------------------------------------------------------------------------


def _rec(kind: str, ts: str, **extra: Any) -> str:
    """One transcript line shaped like Claude Code's (sanitized)."""
    base: dict[str, Any] = {
        "type": kind,
        "timestamp": ts,
        "isSidechain": True,
        "agentId": NATIVE,
        "sessionId": "sess",
        "uuid": f"u-{ts}",
    }
    base.update(extra)
    return json.dumps(base) + "\n"


def _assistant(ts: str, blocks: list[dict[str, Any]], stop: str | None) -> str:
    return _rec(
        "assistant", ts, message={"role": "assistant", "content": blocks, "stop_reason": stop}
    )


def _tool_result(ts: str, tid: str, ends_turn: bool = False) -> str:
    extra: dict[str, Any] = {"toolEndsTurn": True} if ends_turn else {}
    return _rec(
        "user",
        ts,
        message={
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}],
        },
        **extra,
    )


def _transcript(n_calls: int, handback: bool = True) -> str:
    lines = [
        _rec("user", "2026-11-08T11:03:46.000Z", message={"role": "user", "content": "Do the job."})
    ]
    for i in range(n_calls):
        ts = f"2026-11-08T11:{4 + i // 60:02d}:{i % 60:02d}.000Z"
        lines.append(_rec("api-request", ts, querySource="agent"))
        lines.append(_assistant(ts, [{"type": "thinking", "thinking": f"plan {i}"}], "tool_use"))
        lines.append(
            _assistant(
                ts,
                [
                    {
                        "type": "tool_use",
                        "id": f"toolu_t{i:03d}",
                        "name": "Bash",
                        "input": {"command": f"step {i}"},
                    }
                ],
                "tool_use",
            )
        )
        lines.append(_tool_result(ts, f"toolu_t{i:03d}"))
    if handback:
        end = "2026-11-08T12:09:55.807Z"
        lines.append(
            _assistant(
                end,
                [
                    {
                        "type": "tool_use",
                        "id": "toolu_hb",
                        "name": "SubagentHandback",
                        "input": {"message": "report"},
                    }
                ],
                "tool_use",
            )
        )
        lines.append(_tool_result("2026-11-08T12:09:56.001Z", "toolu_hb", ends_turn=True))
    return "".join(lines)


def _subagents_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    d = home / ".claude" / "projects" / "p" / "sess" / "subagents"
    d.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    return d


def _age(path: Path, seconds: float) -> None:
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def _manual_poller(collect: Any) -> TranscriptPoller:
    """A poller without its background loop: the test drives ``_check`` itself."""
    poller = TranscriptPoller(collect)

    async def _register(key: str, state: Any, *, task_name: str | None = None) -> None:
        poller._sessions[key] = state

    poller._register_polling = _register  # type: ignore[method-assign]
    return poller


async def _drain(poller: TranscriptPoller, key: str, ticks: int = 20) -> None:
    for _ in range(ticks):
        state = poller._sessions.get(key)
        if state is None:
            return
        await poller._check(key, state)


@pytest.mark.asyncio
async def test_poller_reads_from_start_in_chunks_and_ends_at_handback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d = _subagents_dir(tmp_path, monkeypatch)
    path = d / f"agent-{NATIVE}.jsonl"
    path.write_text(_transcript(170))
    _age(path, 3600)
    seen: list[AnyEvent] = []

    async def collect(e: AnyEvent) -> None:
        seen.append(e)

    poller = _manual_poller(collect)
    with (
        patch("app.core.transcript_poller.MAX_READ_BYTES", 16 * 1024),
    ):
        # Discovered late (after a reload): read from the start, not the end.
        await poller.start_polling(SUB, "agent-done", str(path))
        await _drain(poller, SUB, ticks=200)
    pres = [e for e in seen if e.event_type == "pre_tool_use"]
    posts = [e for e in seen if e.event_type == "post_tool_use"]
    assert len(pres) == 171 and len(posts) == 171  # 170 Bash + the hand-back
    assert len({e.data.tool_use_id for e in pres}) == 171  # type: ignore[union-attr]
    # Old thoughts are not replayed as bubbles while catching up.
    assert not [e for e in seen if e.event_type == "agent_update"]
    stops = [e for e in seen if e.event_type == "subagent_stop"]
    assert len(stops) == 1 and stops[0].data.source == "transcript_end"
    assert not await poller.is_polling(SUB)
    # A resume (native SubagentStart) carries on from the kept offset.
    await poller.start_polling(SUB, "agent-done", str(path))
    await _drain(poller, SUB, ticks=1)
    assert len([e for e in seen if e.event_type == "pre_tool_use"]) == 171
    await poller.stop_all()


@pytest.mark.asyncio
async def test_poller_final_message_ends_only_when_meta_finished(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d = _subagents_dir(tmp_path, monkeypatch)
    path = d / f"agent-{NATIVE}.jsonl"
    path.write_text(
        _transcript(2, handback=False)
        + _assistant("2026-11-08T11:30:00.000Z", [{"type": "text", "text": "Done."}], "end_turn")
    )
    _age(path, 3600)
    meta = d / f"agent-{NATIVE}.meta.json"
    meta.write_text(json.dumps({"agentType": "general-purpose", "toolUseId": SPAWN}))
    seen: list[AnyEvent] = []

    async def collect(e: AnyEvent) -> None:
        seen.append(e)

    poller = _manual_poller(collect)
    with patch("app.core.transcript_poller._zombie_timeout", return_value=timedelta(hours=1)):
        await poller.start_polling(SUB, "agent-done", str(path))
        await _drain(poller, SUB, ticks=3)
        assert poller._sessions[SUB].turn_end == "final"
        assert not [e for e in seen if e.event_type == "subagent_stop"]  # not finished yet
        meta.write_text(
            json.dumps({"agentType": "general-purpose", "toolUseId": SPAWN, "finished": True})
        )
        await _drain(poller, SUB, ticks=1)
    stops = [e for e in seen if e.event_type == "subagent_stop"]
    assert [s.data.source for s in stops] == ["transcript_end"]
    await poller.stop_all()


@pytest.mark.asyncio
async def test_zombie_guess_keeps_polling_and_later_calls_are_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The floors-agent bug: a 2-minute think tripped the zombie guess, polling
    # ended, and ~160 later calls were never read.
    d = _subagents_dir(tmp_path, monkeypatch)
    path = d / f"agent-{NATIVE}.jsonl"
    path.write_text(_transcript(3, handback=False))
    seen: list[AnyEvent] = []

    async def collect(e: AnyEvent) -> None:
        seen.append(e)

    poller = _manual_poller(collect)
    with patch("app.core.transcript_poller._zombie_timeout", return_value=timedelta(seconds=0)):
        await poller.start_polling(SUB, "agent-done", str(path))
        await _drain(poller, SUB, ticks=3)
        assert [e.data.source for e in seen if e.event_type == "subagent_stop"] == ["zombie"]
        assert await poller.is_polling(SUB)
        with path.open("a") as f:
            f.write(
                _assistant(
                    "2026-11-08T11:40:00.000Z",
                    [
                        {
                            "type": "tool_use",
                            "id": "toolu_late",
                            "name": "Read",
                            "input": {"file_path": "x"},
                        }
                    ],
                    "tool_use",
                )
            )
        await _drain(poller, SUB, ticks=1)
    assert any(e.data.tool_use_id == "toolu_late" for e in seen if e.event_type == "pre_tool_use")  # type: ignore[union-attr]
    await poller.stop_all()


# ---------------------------------------------------------------------------
# Processor: restart backfill and restore parity
# ---------------------------------------------------------------------------


@pytest.fixture
def agent_db() -> Iterator[None]:
    """A private in-memory database: other modules swap the global engine around."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False,
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    previous = get_engine()
    override_engine(engine)

    async def _create() -> None:
        import app.db.models  # noqa: F401  # pyright: ignore[reportUnusedImport]

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    yield
    asyncio.run(engine.dispose())
    override_engine(previous)


async def _wipe(session_id: str) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(EventRecord).where(EventRecord.session_id == session_id))
        await db.execute(delete(SessionRecord).where(SessionRecord.id == session_id))
        await db.commit()


def _tree_view(sm: StateMachine) -> list[tuple[Any, ...]]:
    return [
        (
            n.id,
            n.parent_id,
            n.kind,
            n.native_id,
            n.name,
            n.state,
            n.tool_calls,
            n.errors,
            n.ended_at,
        )
        for n in sm.agent_tree.nodes()
    ]


def _calls_view(sm: StateMachine) -> set[tuple[Any, ...]]:
    calls, _, _ = sm.tool_calls.snapshot(limit=10_000)
    return {(c.id, c.agent_id, c.tool_name, c.status) for c in calls}


async def _wait_for(predicate: Any, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("condition not reached")


@pytest.mark.asyncio
@pytest.mark.usefixtures("agent_db")
@pytest.mark.timeout(60)
async def test_restart_backfills_missed_calls_and_restore_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d = _subagents_dir(tmp_path, monkeypatch)
    main = str(d.parent.parent / "sess.jsonl")
    sub_path = str(d / f"agent-{ASYNC_NATIVE}.jsonl")
    sid = "agent-done-restart"
    await _wipe(sid)
    monkeypatch.setattr("app.core.transcript_poller.POLL_INTERVAL_SECONDS", 0.05)
    ep1 = EventProcessor()
    try:
        # Live: the spawn and two calls are seen, then polling is lost (zombie
        # guess, reload) while the agent works on; only the hand-back arrives.
        await ep1.process_event(_ev("session_start", 0, sid, transcript_path=main))
        for e in _async_spawn():
            await ep1.process_event(
                _ev(
                    e.event_type,
                    (e.timestamp - BASE).total_seconds(),
                    sid,
                    transcript_path=main,
                    agent_transcript_path=sub_path,
                    **e.data.model_dump(exclude_none=True),
                )
            )
        for i in range(2):
            for e in _polled_call(10 + i * 5, f"toolu_t{i:03d}", ASYNC_SUB):
                await ep1.process_event(
                    _ev(
                        e.event_type,
                        (e.timestamp - BASE).total_seconds(),
                        sid,
                        **e.data.model_dump(exclude_none=True),
                    )
                )
        poller = get_transcript_poller()
        assert poller is not None
        await poller.stop_all()
        Path(sub_path).write_text(_transcript(40).replace(NATIVE, ASYNC_NATIVE))
        _age(Path(sub_path), 600)
        await ep1.process_event(_handback_prompt(4000, ASYNC_NATIVE, sid, transcript_path=main))
        live1 = ep1.sessions[sid]
        node = live1.agent_tree.get(ASYNC_SUB)
        assert node is not None and node.state == "done" and node.tool_calls == 2
        assert ASYNC_SUB not in live1.agents  # the office let it go at the hand-back

        # Backend restart: the restore reads every subagent transcript from
        # the start and backfills what was missed (deduplicated by id).
        ep2 = EventProcessor()
        state = await ep2.get_current_state(sid)
        assert state is not None
        live2 = ep2.sessions[sid]
        await _wait_for(lambda: live2.agent_tree.get(ASYNC_SUB).tool_calls == 41)  # type: ignore[union-attr]
        await _wait_for(lambda: not live2.restored_polls)
        poller = get_transcript_poller()
        assert poller is not None
        await _wait_for(lambda: not poller._sessions)
        node = live2.agent_tree.get(ASYNC_SUB)
        assert node is not None and node.state == "done" and node.name == "Fix fixture regression"
        async with AsyncSessionLocal() as db:
            from sqlalchemy import func, select

            rows = await db.scalar(
                select(func.count()).select_from(EventRecord).where(EventRecord.session_id == sid)
            )
        # Another restart: same tree, nothing re-saved.
        ep3 = EventProcessor()
        restored = await ep3._build_restored_state_machine(sid)
        assert restored is not None
        assert _tree_view(restored) == _tree_view(live2)
        assert _calls_view(restored) == _calls_view(live2)
        ep3.sessions[sid] = restored
        await ep3._resume_restored_polls(sid, restored)
        poller = get_transcript_poller()
        assert poller is not None
        await _wait_for(lambda: not poller._sessions)
        async with AsyncSessionLocal() as db:
            from sqlalchemy import func, select

            rows_after = await db.scalar(
                select(func.count()).select_from(EventRecord).where(EventRecord.session_id == sid)
            )
        assert rows_after == rows
        assert _tree_view(restored) == _tree_view(live2)
    finally:
        poller = get_transcript_poller()
        if poller is not None:
            await poller.stop_all()
        await _wipe(sid)
