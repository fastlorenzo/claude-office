"""Session Console WS2: ToolCallTracker, AgentTree, dedupe and slim state_update.

Spec: docs/design/session-console.md, sections 3.2 and 3.5.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.event_processor import EventProcessor
from app.core.handlers.agent_handler import discover_native_link
from app.core.state_machine import StateMachine
from app.core.telemetry import get_telemetry_store
from app.core.tool_calls import (
    INPUT_TOTAL_MAX_CHARS,
    INPUT_VALUE_MAX_CHARS,
    AgentTree,
    ToolCallTracker,
    build_input_preview,
)
from app.core.transcript_poller import PolledAgent, TranscriptPoller, get_transcript_poller
from app.db.database import AsyncSessionLocal, Base, get_engine, override_engine
from app.db.models import EventRecord, SessionRecord
from app.models.agents import BossState
from app.models.events import AnyEvent, EventAdapter

BASE = datetime(2026, 11, 8, 9, 58, 0, tzinfo=UTC)


def _ev(event_type: str, t: float, session_id: str = "ws2-test", **data: Any) -> AnyEvent:
    return EventAdapter.validate_python(
        {
            "event_type": event_type,
            "session_id": session_id,
            "timestamp": BASE + timedelta(seconds=t),
            "data": data,
        }
    )


# ---------------------------------------------------------------------------
# Sanitized fixture of the real duplicate pattern (local visualizer.db,
# session c9678b2a, rows 18937-19065): an async general-purpose subagent runs
# Bash calls; each call arrives as hook pre/post stamped agent_id="main", then
# ~1 s later as poller pre/post under subagent_<toolu> with the SAME
# tool_use_id (the poller post has no tool_name). Two calls overlap (parallel
# tool use). Ids, prompts, commands and paths are replaced; event order,
# agent ids, field presence and relative timing are kept.
# ---------------------------------------------------------------------------

SPAWN = "toolu_fx_spawn01"
SUB = f"subagent_{SPAWN}"
NATIVE = "afx0000000000001"
SUB_TRANSCRIPT = "/home/user/.claude/projects/-repo/sess/subagents/agent-afx0000000000001.jsonl"


def _hook_pre(t: float, tid: str, n: int) -> tuple[str, float, dict[str, Any]]:
    return (
        "pre_tool_use",
        t,
        {
            "agent_id": "main",
            "tool_name": "Bash",
            "tool_use_id": tid,
            "tool_input": {"command": f"echo step {n}", "description": f"step {n}"},
        },
    )


def _hook_post(t: float, tid: str, n: int) -> tuple[str, float, dict[str, Any]]:
    return (
        "post_tool_use",
        t,
        {
            "agent_id": "main",
            "tool_name": "Bash",
            "tool_use_id": tid,
            "tool_input": {"command": f"echo step {n}", "description": f"step {n}"},
            "success": True,
        },
    )


def _poll_pre(t: float, tid: str, n: int) -> tuple[str, float, dict[str, Any]]:
    return (
        "pre_tool_use",
        t,
        {
            "agent_id": SUB,
            "tool_name": "Bash",
            "tool_use_id": tid,
            "tool_input": {"command": f"echo step {n}", "description": f"step {n}"},
        },
    )


def _poll_post(t: float, tid: str) -> tuple[str, float, dict[str, Any]]:
    return ("post_tool_use", t, {"agent_id": SUB, "tool_use_id": tid, "success": True})


DUPLICATE_FIXTURE: list[tuple[str, float, dict[str, Any]]] = [
    (
        "subagent_start",
        13.707,
        {
            "agent_id": SUB,
            "tool_use_id": SPAWN,
            "agent_name": "Fixture task",
            "agent_type": "general-purpose",
            "task_description": "Do the fixture task.",
        },
    ),
    (
        "subagent_info",
        31.225,
        {
            "native_agent_id": NATIVE,
            "agent_type": "general-purpose",
            "agent_transcript_path": SUB_TRANSCRIPT,
        },
    ),
    (
        "post_tool_use",
        31.226,
        {
            "agent_id": "main",
            "tool_name": "Agent",
            "tool_use_id": SPAWN,
            "native_agent_id": NATIVE,
            "success": True,
        },
    ),
    _hook_pre(36.228, "toolu_fx_01", 1),
    _hook_post(37.003, "toolu_fx_01", 1),
    _poll_pre(37.303, "toolu_fx_01", 1),
    _poll_post(37.303, "toolu_fx_01"),
    _hook_pre(38.921, "toolu_fx_02", 2),
    _hook_post(39.450, "toolu_fx_02", 2),
    _poll_pre(40.321, "toolu_fx_02", 2),
    _poll_post(40.321, "toolu_fx_02"),
    # Parallel pair: both hook pres, both hook posts, then the poller copies.
    _hook_pre(41.499, "toolu_fx_03", 3),
    _hook_pre(42.001, "toolu_fx_04", 4),
    _hook_post(42.784, "toolu_fx_03", 3),
    _hook_post(42.789, "toolu_fx_04", 4),
    _poll_pre(43.348, "toolu_fx_03", 3),
    _poll_pre(43.349, "toolu_fx_04", 4),
    _poll_post(43.350, "toolu_fx_03"),
    _poll_post(43.351, "toolu_fx_04"),
    _hook_pre(45.884, "toolu_fx_05", 5),
    _hook_post(46.305, "toolu_fx_05", 5),
    _poll_pre(46.380, "toolu_fx_05", 5),
    _poll_post(47.389, "toolu_fx_05"),
    ("subagent_stop", 48.111, {"native_agent_id": NATIVE}),
    ("stop", 55.735, {}),
]
FIXTURE_CALLS = ["toolu_fx_01", "toolu_fx_02", "toolu_fx_03", "toolu_fx_04", "toolu_fx_05"]


def _fixture_events(session_id: str = "ws2-test") -> list[AnyEvent]:
    return [_ev(et, t, session_id, **data) for et, t, data in DUPLICATE_FIXTURE]


def _run(sm: StateMachine, events: list[AnyEvent]) -> None:
    for e in events:
        sm.transition(e)


def _tracker() -> ToolCallTracker:
    return ToolCallTracker(AgentTree())


# ---------------------------------------------------------------------------
# Tracker / tree unit tests
# ---------------------------------------------------------------------------


def test_pre_post_pair_into_one_call_with_duration() -> None:
    tr = _tracker()
    r1 = tr.apply(
        _ev("pre_tool_use", 0, tool_name="Read", tool_use_id="t1", tool_input={"file_path": "/a"})
    )
    r2 = tr.apply(_ev("post_tool_use", 1.5, tool_name="Read", tool_use_id="t1", success=True))
    assert (r1.outcome, r2.outcome) == ("created", "updated")
    calls, has_more, oldest = tr.snapshot()
    assert len(calls) == 1 and not has_more and oldest == 1
    call = calls[0]
    assert call.status == "ok"
    assert call.duration_ms == 1500
    assert call.target == "/a"
    assert call.kind == "researching" or call.kind is not None
    assert call.rev == 2


def test_synthetic_ids_pair_fifo_by_agent_and_tool() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_input={"command": "a"}))
    tr.apply(_ev("pre_tool_use", 1, tool_name="Bash", tool_input={"command": "b"}))
    tr.apply(_ev("post_tool_use", 2, tool_name="Bash", success=True))
    calls, _, _ = tr.snapshot()
    assert [c.id for c in calls] == ["evt-1", "evt-2"]
    assert [c.status for c in calls] == ["ok", "running"]


def test_fixture_duplicates_merge_into_subagent_calls() -> None:
    sm = StateMachine()
    _run(sm, _fixture_events())
    calls, _, _ = sm.tool_calls.snapshot()
    by_id = {c.id: c for c in calls}
    assert set(by_id) == {SPAWN, *FIXTURE_CALLS}
    for tid in FIXTURE_CALLS:
        call = by_id[tid]
        assert call.agent_id == SUB, tid
        assert call.status == "ok"
        assert call.tool_name == "Bash"
    # Earliest start (the hook copy) wins; the first (hook) post ends it.
    hook_times: dict[str, list[float]] = {}
    for et, t, data in DUPLICATE_FIXTURE:
        if data.get("agent_id") == "main" and et in ("pre_tool_use", "post_tool_use"):
            hook_times.setdefault(data["tool_use_id"], []).append(t)
    for tid in FIXTURE_CALLS:
        start, end = hook_times[tid]
        assert by_id[tid].duration_ms == round((end - start) * 1000), tid
    # seq is unique and ascending.
    assert [c.seq for c in calls] == sorted({c.seq for c in calls})

    spawn = by_id[SPAWN]
    assert spawn.agent_id == "main"
    assert spawn.status == "ok"  # spawned, then the native stop finished it
    assert spawn.spawned_agent_id == SUB

    main = sm.agent_tree.get("main")
    sub = sm.agent_tree.get(SUB)
    assert main is not None and sub is not None
    assert main.tool_calls == 1  # the spawn call only
    assert sub.tool_calls == 5
    assert sub.parent_id == "main"
    assert sub.native_id == NATIVE
    assert sub.state == "done"
    assert sub.agent_type == "general-purpose"
    assert sub.color is not None


def test_duplicate_copies_do_not_double_count_safety_counter() -> None:
    sm = StateMachine()
    _run(sm, _fixture_events())
    # 5 Bash calls + the Agent post; the 5 poller posts are merged duplicates.
    assert sm.tool_uses_since_compaction == 6


def test_caller_native_agent_id_routes_to_subagent_and_boss_stays() -> None:
    sm = StateMachine()
    _run(sm, _fixture_events()[:3])  # start, info, async Agent post (links NATIVE)
    boss_before = sm.boss_state
    pre = _ev(
        "pre_tool_use",
        40,
        agent_id="main",
        caller_native_agent_id=NATIVE,
        tool_name="Read",
        tool_use_id="toolu_routed",
        tool_input={"file_path": "/repo/x.py"},
    )
    sm.transition(pre)
    assert sm.last_console.agent_id == SUB
    assert sm.routed_agent_id(pre) == SUB
    call = sm.tool_calls.get("toolu_routed")
    assert call is not None and call.agent_id == SUB
    assert sm.boss_state == boss_before
    assert sm.boss_state != BossState.WORKING
    assert sm.agents[SUB].bubble is not None
    assert sm.last_tool_name != "Read"  # main-agent phase tracking untouched


def test_permission_wait_then_ok() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="p1"))
    r = tr.apply(_ev("permission_request", 1, tool_name="Bash", tool_use_id="p1"))
    assert r.outcome == "updated"
    call = tr.get("p1")
    assert call is not None and call.status == "waiting_permission"
    assert tr.tree.get("main") is not None
    assert tr.tree.get("main").state == "waiting"  # type: ignore[union-attr]
    tr.apply(_ev("post_tool_use", 6, tool_name="Bash", tool_use_id="p1", success=True))
    call = tr.get("p1")
    assert call is not None
    assert call.status == "ok"
    assert call.permission_requested_at is not None
    assert call.permission_wait_ms == 5000
    assert call.duration_ms == 6000


def test_permission_without_tool_use_id_matches_latest_running_call() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="p1"))
    tr.apply(_ev("permission_request", 1, tool_name="Bash"))
    call = tr.get("p1")
    assert call is not None and call.status == "waiting_permission"


def test_inferred_denied_on_next_pre_and_on_stop() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="d1"))
    tr.apply(_ev("permission_request", 1, tool_name="Bash", tool_use_id="d1"))
    tr.apply(_ev("pre_tool_use", 4, tool_name="Read", tool_use_id="d2"))
    d1 = tr.get("d1")
    assert d1 is not None and d1.status == "denied"
    assert d1.permission_wait_ms == 3000

    tr.apply(_ev("permission_request", 5, tool_name="Read", tool_use_id="d2"))
    tr.apply(_ev("stop", 7))
    d2 = tr.get("d2")
    assert d2 is not None and d2.status == "denied"

    # A late real post overrides the inference.
    tr.apply(_ev("post_tool_use", 9, tool_name="Read", tool_use_id="d2", success=True))
    d2 = tr.get("d2")
    assert d2 is not None and d2.status == "ok" and d2.permission_wait_ms == 4000


def test_orphaned_main_calls_close_at_stop_and_late_post_settles() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="m1"))
    # A hook copy of a subagent call whose caller is not linked yet: not main's.
    tr.apply(
        _ev(
            "pre_tool_use",
            1,
            tool_name="Read",
            tool_use_id="m2",
            caller_native_agent_id="anative_unknown",
        )
    )
    res = tr.apply(_ev("stop", 5))
    m1 = tr.get("m1")
    assert m1 is not None and m1.status == "interrupted" and m1.duration_ms == 5000
    assert any(c.id == "m1" for c in res.calls), "closing must emit a frame"
    m2 = tr.get("m2")
    assert m2 is not None and m2.status == "running"
    # The lost post shows up late: it still settles the call (not a duplicate).
    late = tr.apply(_ev("post_tool_use", 7, tool_name="Bash", tool_use_id="m1", success=True))
    assert late.outcome == "updated"
    m1 = tr.get("m1")
    assert m1 is not None and m1.status == "ok" and m1.duration_ms == 7000
    # A second copy after that is a duplicate again.
    dup = tr.apply(_ev("post_tool_use", 8, agent_id=SUB, tool_use_id="m1", success=True))
    assert dup.outcome == "merged_duplicate"


def test_orphaned_subagent_calls_close_on_its_stop() -> None:
    sm = StateMachine()
    sub = "subagent_toolu_orph"
    _run(
        sm,
        [
            _ev("subagent_start", 0, agent_id=sub, tool_use_id="toolu_orph", agent_name="O"),
            _ev("pre_tool_use", 1, agent_id=sub, tool_name="Bash", tool_use_id="toolu_o1"),
            _ev("pre_tool_use", 2, tool_name="Read", tool_use_id="toolu_main"),
        ],
    )
    sm.transition(_ev("subagent_stop", 9, agent_id=sub))
    o1 = sm.tool_calls.get("toolu_o1")
    assert o1 is not None and o1.status == "interrupted"
    assert any(c.id == "toolu_o1" for c in sm.last_console.calls)
    spawn = sm.tool_calls.get("toolu_orph")
    assert spawn is not None and spawn.status == "ok"
    main_call = sm.tool_calls.get("toolu_main")
    assert main_call is not None and main_call.status == "running"


def test_main_stop_keeps_spawn_call_of_live_async_child_open() -> None:
    sm = StateMachine()
    # Async spawn whose hook post was lost: running, child still alive.
    sm.transition(
        _ev("subagent_start", 0, agent_id="subagent_toolu_live", tool_use_id="toolu_live")
    )
    sm.transition(_ev("stop", 3))
    spawn = sm.tool_calls.get("toolu_live")
    assert spawn is not None and spawn.status == "running"
    sm.transition(_ev("session_end", 10))
    spawn = sm.tool_calls.get("toolu_live")
    assert spawn is not None and spawn.status == "interrupted"


def test_failure_is_error_with_message() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="e1"))
    tr.apply(
        _ev(
            "post_tool_use",
            1,
            tool_name="Bash",
            tool_use_id="e1",
            success=False,
            error_message="Exit code 2: no such file",
        )
    )
    call = tr.get("e1")
    assert call is not None and call.status == "error"
    assert call.error == "Exit code 2: no such file"
    main = tr.tree.get("main")
    assert main is not None and main.errors == 1


def test_error_message_falls_back_to_stderr_line() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="e2"))
    tr.apply(
        _ev(
            "post_tool_use",
            1,
            tool_name="Bash",
            tool_use_id="e2",
            success=False,
            tool_output="ok line\n--- stderr ---\nboom: it broke\nmore",
        )
    )
    call = tr.get("e2")
    assert call is not None and call.error == "boom: it broke"
    assert call.output_preview is not None and call.output_bytes is not None


def test_poller_error_copy_wins_over_hook_ok() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="x1"))
    tr.apply(_ev("post_tool_use", 1, tool_name="Bash", tool_use_id="x1", success=True))
    r = tr.apply(_ev("post_tool_use", 2, agent_id=SUB, tool_use_id="x1", success=False))
    assert r.outcome == "merged_duplicate"
    call = tr.get("x1")
    assert call is not None and call.status == "error" and call.agent_id == SUB


def test_interrupted_post() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="i1"))
    tr.apply(_ev("post_tool_use", 1, tool_name="Bash", tool_use_id="i1", interrupted=True))
    call = tr.get("i1")
    assert call is not None and call.status == "interrupted"


def test_hook_output_preview_is_kept_and_capped() -> None:
    tr = _tracker()
    tr.apply(_ev("pre_tool_use", 0, tool_name="Bash", tool_use_id="o1"))
    big = "x" * 4096
    tr.apply(
        _ev(
            "post_tool_use",
            1,
            tool_name="Bash",
            tool_use_id="o1",
            success=True,
            tool_output=big,
            tool_output_bytes=100_000,
            tool_output_truncated=True,
        )
    )
    tr.apply(_ev("post_tool_use", 2, agent_id=SUB, tool_use_id="o1", success=True))
    call = tr.get("o1")
    assert call is not None
    assert call.output_preview is not None and len(call.output_preview) == 2048
    assert call.output_bytes == 100_000 and call.output_truncated


def test_sync_agent_spawn_ok_on_subagent_stop() -> None:
    sm = StateMachine()
    sub = "subagent_toolu_sync"
    _run(
        sm,
        [
            _ev(
                "subagent_start",
                0,
                agent_id=sub,
                tool_use_id="toolu_sync",
                agent_name="Sync job",
                agent_type="Explore",
                task_description="Look around",
            ),
            _ev(
                "subagent_stop",
                30,
                agent_id=sub,
                native_agent_id="anative_sync",
                tool_output="Found three things.",
            ),
        ],
    )
    call = sm.tool_calls.get("toolu_sync")
    assert call is not None
    assert call.tool_name == "Agent"
    assert call.status == "ok" and call.duration_ms == 30_000
    assert call.output_preview == "Found three things."
    assert call.input_preview == {
        "description": "Sync job",
        "subagent_type": "Explore",
        "prompt": "Look around",
    }
    node = sm.agent_tree.get(sub)
    assert node is not None
    assert node.state == "done" and node.result_preview == "Found three things."
    assert node.native_id == "anative_sync"
    assert node.spawn_tool_use_id == "toolu_sync"
    assert node.task_preview == "Look around"


def test_async_agent_spawned_until_native_stop() -> None:
    sm = StateMachine()
    _run(sm, _fixture_events()[:3])
    spawn = sm.tool_calls.get(SPAWN)
    assert spawn is not None and spawn.status == "spawned"
    assert spawn.ended_at is None
    sm.transition(_ev("subagent_stop", 60, native_agent_id=NATIVE))
    spawn = sm.tool_calls.get(SPAWN)
    assert spawn is not None and spawn.status == "ok"
    assert spawn.duration_ms == int((60 - 13.707) * 1000)


def test_nested_subagent_gets_parent_after_merge() -> None:
    """A child spawned inside an unlinked subagent re-parents once a merge reveals it."""
    sm = StateMachine()
    parent = "subagent_toolu_parent"
    child = "subagent_toolu_child"
    _run(
        sm,
        [
            _ev("subagent_start", 0, agent_id=parent, tool_use_id="toolu_parent", agent_name="P"),
            # Nested spawn fired inside the parent (caller id not linked yet).
            _ev(
                "subagent_start",
                5,
                agent_id=child,
                tool_use_id="toolu_child",
                agent_name="C",
                caller_native_agent_id="anative_parent",
            ),
        ],
    )
    node = sm.agent_tree.get(child)
    assert node is not None and node.parent_id == "main"
    spawn_child = sm.tool_calls.get("toolu_child")
    assert spawn_child is not None and spawn_child.agent_id == "main"

    # The parent's own tool call: hook copy (main + caller), then poller copy.
    sm.transition(
        _ev(
            "pre_tool_use",
            6,
            agent_id="main",
            caller_native_agent_id="anative_parent",
            tool_name="Read",
            tool_use_id="toolu_p_read",
            tool_input={"file_path": "/repo/a"},
        )
    )
    sm.transition(
        _ev(
            "pre_tool_use",
            7,
            agent_id=parent,
            tool_name="Read",
            tool_use_id="toolu_p_read",
            tool_input={"file_path": "/repo/a"},
        )
    )
    res = sm.last_console
    assert res.outcome == "merged_duplicate"
    node = sm.agent_tree.get(child)
    assert node is not None and node.parent_id == parent
    assert any(n.id == child for n in res.nodes), "re-parented node must be re-broadcast"
    spawn_child = sm.tool_calls.get("toolu_child")
    assert spawn_child is not None and spawn_child.agent_id == parent
    parent_node = sm.agent_tree.get(parent)
    assert parent_node is not None and parent_node.native_id == "anative_parent"
    # Later hook copies from the parent now resolve immediately.
    sm.transition(
        _ev(
            "pre_tool_use",
            8,
            agent_id="main",
            caller_native_agent_id="anative_parent",
            tool_name="Grep",
            tool_use_id="toolu_p_grep",
        )
    )
    grep_call = sm.tool_calls.get("toolu_p_grep")
    assert grep_call is not None and grep_call.agent_id == parent


def test_zombie_stop_marks_node_zombie() -> None:
    sm = StateMachine()
    sub = "subagent_toolu_z"
    _run(
        sm,
        [
            _ev("subagent_start", 0, agent_id=sub, tool_use_id="toolu_z", agent_name="Z"),
            _ev("subagent_stop", 120, agent_id=sub, source="zombie"),
        ],
    )
    node = sm.agent_tree.get(sub)
    assert node is not None and node.state == "zombie"
    call = sm.tool_calls.get("toolu_z")
    assert call is not None and call.status == "interrupted"


def test_background_task_becomes_leaf_node() -> None:
    sm = StateMachine()
    sm.transition(
        _ev(
            "background_task_notification",
            0,
            background_task_id="bgtask01",
            background_task_status="failed",
            background_task_summary="Build failed",
        )
    )
    node = sm.agent_tree.get("bg_bgtask01")
    assert node is not None
    assert (node.kind, node.parent_id, node.state, node.errors) == (
        "background",
        "main",
        "failed",
        1,
    )


def test_snapshot_paging_and_memory_cap() -> None:
    tr = ToolCallTracker(AgentTree(), max_calls=10)
    for i in range(25):
        tr.apply(_ev("pre_tool_use", i, tool_name="Read", tool_use_id=f"c{i}"))
    assert len(tr) == 10
    calls, has_more, oldest = tr.snapshot(limit=4)
    assert [c.seq for c in calls] == [22, 23, 24, 25]
    assert has_more and oldest == 22
    calls, has_more, oldest = tr.snapshot(limit=4, before_seq=20)
    assert [c.seq for c in calls] == [16, 17, 18, 19]
    calls, has_more, oldest = tr.snapshot(limit=50, before_seq=17)
    assert [c.seq for c in calls] == [16]
    assert has_more  # older calls were evicted: page them from the DB
    calls_none, _, oldest_none = tr.snapshot(limit=5, before_seq=3)
    assert calls_none == [] and oldest_none is None
    assert tr.get("c0") is None and tr.get("c24") is not None
    # Snapshot entries are copies.
    calls[0].status = "error"
    kept = tr.get("c15")
    assert kept is not None and kept.status == "running"


def test_input_preview_caps() -> None:
    preview, truncated = build_input_preview({"a": "x" * 5000, "b": 1})
    assert preview is not None and truncated
    assert len(preview["a"]) == INPUT_VALUE_MAX_CHARS and preview["b"] == 1
    many = {f"k{i}": "y" * 2000 for i in range(10)}
    preview, truncated = build_input_preview(many)
    assert preview is not None and truncated
    assert len(json.dumps(preview)) <= INPUT_TOTAL_MAX_CHARS
    preview, truncated = build_input_preview({"edits": [{"old_string": "z" * 3000}]})
    assert preview is not None and truncated
    assert len(preview["edits"][0]["old_string"]) == INPUT_VALUE_MAX_CHARS
    assert build_input_preview(None) == (None, False)
    assert build_input_preview({"command": "ls"}) == ({"command": "ls"}, False)


def test_slim_history_keeps_last_50_with_tool_name_only() -> None:
    sm = StateMachine()
    for i in range(120):
        sm.history.append(
            {
                "id": f"h{i}",
                "type": "pre_tool_use",
                "agentId": "main",
                "summary": f"Using Read {i}",
                "timestamp": BASE.isoformat(),
                "detail": {"toolName": "Read", "toolInput": {"file_path": "/x"}},
            }
        )
    gs = sm.to_game_state("s")
    assert len(gs.history) == 50
    assert gs.history[0]["id"] == "h70"
    assert gs.history[-1]["detail"] == {"toolName": "Read"}
    assert len(sm.history) == 120  # the server-side list is untouched


# ---------------------------------------------------------------------------
# Processor-level tests (real pipeline + DB)
# ---------------------------------------------------------------------------


@pytest.fixture
def ws2_db() -> Iterator[None]:
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


class _FakeManager:
    """Captures what broadcast_service sends for one connected session."""

    def __init__(self, session_id: str) -> None:
        self.active_connections: dict[str, list[object]] = {session_id: [object()]}
        self.messages: list[dict[str, Any]] = []

    async def broadcast(self, message: dict[str, Any], session_id: str) -> None:
        self.messages.append(message)


async def _ingest(ep: EventProcessor, session_id: str, events: list[AnyEvent]) -> None:
    await ep.process_event(_ev("session_start", 0, session_id))
    for e in events:
        await ep.process_event(e)


@pytest.mark.asyncio
@pytest.mark.usefixtures("ws2_db")
async def test_processor_dedupes_history_frames_and_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = "ws2-proc-dedupe"
    await _wipe(sid)
    fake = _FakeManager(sid)
    monkeypatch.setattr("app.core.broadcast_service.get_manager", lambda: fake)
    ep = EventProcessor()
    try:
        await _ingest(ep, sid, _fixture_events(sid))
        sm = ep.sessions[sid]

        pre_entries = [h for h in sm.history if h["type"] == "pre_tool_use"]
        assert len(pre_entries) == 5, [h["agentId"] for h in pre_entries]
        post_entries = [h for h in sm.history if h["type"] == "post_tool_use"]
        assert len(post_entries) == 6  # 5 Bash + the Agent post
        tool_conv = [c for c in sm.conversation if c["role"] == "tool"]
        assert len(tool_conv) == 5

        assert get_telemetry_store().session_activity(sid).tool_calls == 5

        event_frames = [m for m in fake.messages if m["type"] == "event"]
        assert sum(1 for m in event_frames if m["event"]["type"] == "pre_tool_use") == 5
        call_frames = [m for m in fake.messages if m["type"] == "tool_call"]
        node_frames = [m for m in fake.messages if m["type"] == "agent_node"]
        assert call_frames and node_frames
        frame = call_frames[-1]
        assert frame["sessionId"] == sid
        assert {"id", "seq", "rev", "agentId", "toolName", "status", "startedAt"} <= set(
            frame["toolCall"]
        )
        last_by_id: dict[str, dict[str, Any]] = {}
        for m in call_frames:
            last_by_id[m["toolCall"]["id"]] = m["toolCall"]
        for tid in FIXTURE_CALLS:
            assert last_by_id[tid]["agentId"] == SUB
            assert last_by_id[tid]["status"] == "ok"
        # Revs only grow per call.
        revs: dict[str, int] = {}
        for m in call_frames:
            tc = m["toolCall"]
            assert tc["rev"] >= revs.get(tc["id"], 0)
            revs[tc["id"]] = tc["rev"]
        assert node_frames[0]["agent"]["id"] == "main"
        # The slim state_update never carries tool inputs.
        states = [m for m in fake.messages if m["type"] == "state_update"]
        assert states
        for h in states[-1]["state"]["history"]:
            assert set(h["detail"]) <= {"toolName"}
    finally:
        await _wipe(sid)


def _tracker_view(sm: StateMachine) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
    calls, _, _ = sm.tool_calls.snapshot(limit=10_000)
    call_view = [
        (c.id, c.seq, c.agent_id, c.tool_name, c.status, c.started_at, c.ended_at) for c in calls
    ]
    node_view = [
        (n.id, n.parent_id, n.kind, n.native_id, n.state, n.tool_calls, n.errors)
        for n in sm.agent_tree.nodes()
    ]
    return call_view, node_view


@pytest.mark.asyncio
@pytest.mark.usefixtures("ws2_db")
async def test_restored_tracker_equals_live() -> None:
    sid = "ws2-proc-restore"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        extra = [
            _ev("user_prompt_submit", 60, sid, prompt="next"),
            _ev("pre_tool_use", 61, sid, tool_name="Bash", tool_use_id="toolu_r1"),
            _ev("permission_request", 62, sid, tool_name="Bash", tool_use_id="toolu_r1"),
            _ev(
                "post_tool_use",
                65,
                sid,
                tool_name="Bash",
                tool_use_id="toolu_r1",
                success=False,
                error_message="nope",
            ),
            _ev("pre_tool_use", 66, sid, tool_name="Edit", tool_use_id="toolu_r2"),
            _ev("permission_request", 67, sid, tool_name="Edit", tool_use_id="toolu_r2"),
            _ev("pre_tool_use", 68, sid, tool_name="Bash", tool_use_id="toolu_r3"),
            _ev("stop", 70, sid),
        ]
        await _ingest(ep, sid, _fixture_events(sid) + extra)
        live = ep.sessions[sid]
        restored = await ep._build_restored_state_machine(sid)  # pyright: ignore[reportPrivateUsage]
        assert restored is not None
        live_calls, live_nodes = _tracker_view(live)
        rest_calls, rest_nodes = _tracker_view(restored)
        assert rest_calls == live_calls
        assert rest_nodes == live_nodes
        statuses = {c[0]: c[4] for c in live_calls}
        assert statuses["toolu_r1"] == "error" and statuses["toolu_r2"] == "denied"
        assert statuses["toolu_r3"] == "interrupted"  # orphan closed at turn end
        # History dedupe matches too (the persisted synthetic CLEANUP row only
        # exists for the restore: live never routes it through the pipeline).
        rest_ids = [h["id"] for h in restored.history if h["type"] != "cleanup"]
        assert rest_ids == [h["id"] for h in live.history]
    finally:
        await _wipe(sid)


@pytest.mark.asyncio
@pytest.mark.usefixtures("ws2_db")
@pytest.mark.timeout(60)  # 500 events through the real pipeline
async def test_state_update_at_least_70_percent_smaller() -> None:
    """500-event session with 8 KB tool inputs: slim vs. the old full history."""
    sid = "ws2-proc-size"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        blob = "q" * 8192
        events: list[AnyEvent] = []
        for i in range(250):
            tid = f"toolu_size_{i}"
            events.append(
                _ev(
                    "pre_tool_use",
                    1 + i,
                    sid,
                    tool_name="Write",
                    tool_use_id=tid,
                    tool_input={"file_path": f"/repo/f{i}.py", "content": blob},
                )
            )
            events.append(
                _ev(
                    "post_tool_use",
                    1.5 + i,
                    sid,
                    tool_name="Write",
                    tool_use_id=tid,
                    tool_input={"file_path": f"/repo/f{i}.py", "content": blob},
                    success=True,
                )
            )
        await _ingest(ep, sid, events[:-1])  # session_start + 499 = 500 events
        sm = ep.sessions[sid]
        assert len(sm.history) == 500
        gs = sm.to_game_state(sid)
        after = len(json.dumps(gs.model_dump(mode="json", by_alias=True)))
        before_state = gs.model_copy(update={"history": sm.history})
        before = len(json.dumps(before_state.model_dump(mode="json", by_alias=True)))
        reduction = 1 - after / before
        print(f"state_update bytes: before={before} after={after} ({reduction:.1%} smaller)")
        assert reduction >= 0.70
    finally:
        await _wipe(sid)


# ---------------------------------------------------------------------------
# Transcript poller
# ---------------------------------------------------------------------------


async def _noop(_event: AnyEvent) -> None:
    return None


def test_poller_drops_nested_spawns_and_tags_zombie_stops(tmp_path: Path) -> None:
    poller = TranscriptPoller(_noop)
    agent = PolledAgent(agent_id=SUB, session_id="ws2-test", transcript_path=tmp_path / "a.jsonl")
    for name in ("Task", "Agent"):
        block: dict[str, Any] = {"type": "tool_use", "name": name, "id": "toolu_n", "input": {}}
        assert poller._create_pre_tool_use_event(agent, block) is None  # pyright: ignore[reportPrivateUsage]
    read: dict[str, Any] = {
        "type": "tool_use",
        "name": "Read",
        "id": "toolu_r",
        "input": {"file_path": "/a"},
    }
    assert poller._create_pre_tool_use_event(agent, read) is not None  # pyright: ignore[reportPrivateUsage]
    zombie = poller._build_zombie_stop_event(agent)  # pyright: ignore[reportPrivateUsage]
    assert zombie.data.source == "zombie" and zombie.data.agent_id == SUB


# ---------------------------------------------------------------------------
# Async subagent lifecycle (sanitized from the orchestrator session c9678b2a:
# background agents stop at every turn end, notify via <task-notification>,
# resume with a new SubagentStart; some Agent posts never reach the backend).
# ---------------------------------------------------------------------------

ASYNC = "toolu_fx_async01"
ASYNC_SUB = f"subagent_{ASYNC}"
ASYNC_NATIVE = "a0f0f0f0f0f0f0f01"


def _async_spawn(t: float = 0.0, post: bool = True) -> list[AnyEvent]:
    events = [
        _ev(
            "subagent_start",
            t,
            agent_id=ASYNC_SUB,
            tool_use_id=ASYNC,
            agent_name="Fixture async job",
            agent_type="general-purpose",
            task_description="Do the async fixture job.",
        )
    ]
    if post:
        events.append(
            _ev(
                "post_tool_use",
                t + 0.2,
                agent_id="main",
                tool_name="Agent",
                tool_use_id=ASYNC,
                native_agent_id=ASYNC_NATIVE,
                success=True,
            )
        )
    return events


def _notify(t: float, task_id: str, summary: str, status: str = "completed") -> AnyEvent:
    return _ev(
        "background_task_notification",
        t,
        background_task_id=task_id,
        background_task_status=status,
        background_task_summary=summary,
    )


def test_async_agent_turn_end_waiting_resume_and_finish() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn())
    _run(
        sm,
        [
            _ev("stop", 5),  # main turn ends while the async child works
            _ev("subagent_stop", 20, native_agent_id=ASYNC_NATIVE),
            _notify(
                22, ASYNC_NATIVE, 'Agent "Fixture async job" is waiting on its own background work'
            ),
        ],
    )
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None
    assert node.state == "waiting" and node.ended_at is None
    spawn = sm.tool_calls.get(ASYNC)
    assert spawn is not None and spawn.status == "spawned"
    assert sm.agent_tree.get(f"bg_{ASYNC_NATIVE}") is None  # merged, no leaf

    sm.transition(_ev("subagent_info", 40, native_agent_id=ASYNC_NATIVE))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "running"
    sm.transition(_ev("stop", 45))  # another main turn end: child untouched
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "running"

    _run(
        sm,
        [
            _ev("subagent_stop", 60, native_agent_id=ASYNC_NATIVE),
            _notify(61, ASYNC_NATIVE, 'Agent "Fixture async job" finished'),
        ],
    )
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "done" and node.ended_at is not None
    spawn = sm.tool_calls.get(ASYNC)
    assert spawn is not None and spawn.status == "ok"
    assert [n.kind for n in sm.agent_tree.nodes()] == ["main", "subagent"]


def test_zombie_guess_never_ends_a_live_async_child() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn())
    sm.transition(_ev("subagent_stop", 200, agent_id=ASYNC_SUB, source="zombie"))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "running" and node.ended_at is None
    spawn = sm.tool_calls.get(ASYNC)
    assert spawn is not None and spawn.status == "spawned"


def test_zombie_on_finished_agent_is_ignored_and_new_work_revives() -> None:
    sm = StateMachine()
    sub = "subagent_toolu_rev"
    _run(
        sm,
        [
            _ev("subagent_start", 0, agent_id=sub, tool_use_id="toolu_rev", agent_name="R"),
            _ev("subagent_stop", 50, agent_id=sub, source="zombie"),
        ],
    )
    node = sm.agent_tree.get(sub)
    assert node is not None and node.state == "zombie"
    # It was alive after all: a new call after the guess revives it.
    sm.transition(_ev("pre_tool_use", 60, agent_id=sub, tool_name="Bash", tool_use_id="toolu_rv1"))
    node = sm.agent_tree.get(sub)
    assert node is not None and node.state == "running" and node.ended_at is None
    sm.transition(_ev("subagent_stop", 70, agent_id=sub))
    sm.transition(_ev("subagent_stop", 200, agent_id=sub, source="zombie"))
    node = sm.agent_tree.get(sub)
    assert node is not None and node.state == "done"
    # A late re-read copy of an old call does not revive it.
    sm.transition(_ev("pre_tool_use", 61, agent_id=sub, tool_name="Bash", tool_use_id="toolu_rv1"))
    node = sm.agent_tree.get(sub)
    assert node is not None and node.state == "done"


def test_link_record_links_unlinked_spawn_and_resolves_native_stop() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn(post=False))  # the Agent post was lost
    sm.transition(_ev("subagent_stop", 30, native_agent_id=ASYNC_NATIVE))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.state == "running"  # unresolvable so far
    sm.transition(
        _ev(
            "subagent_info",
            31,
            agent_id=ASYNC_SUB,
            native_agent_id=ASYNC_NATIVE,
            source="link",
        )
    )
    assert sm.agents[ASYNC_SUB].native_id == ASYNC_NATIVE  # office linked too
    sm.transition(_ev("subagent_stop", 32, native_agent_id=ASYNC_NATIVE))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.native_id == ASYNC_NATIVE and node.state == "done"


def test_link_record_creates_node_for_unseen_spawn() -> None:
    sm = StateMachine()
    sm.transition(
        _ev(
            "subagent_info",
            1,
            agent_id="subagent_toolu_unseen",
            native_agent_id="a1111111111111111",
            agent_name="Started before the backend",
            agent_type="Explore",
            source="link",
        )
    )
    node = sm.agent_tree.get("subagent_toolu_unseen")
    assert node is not None
    assert (node.kind, node.parent_id, node.name, node.native_id) == (
        "subagent",
        "main",
        "Started before the backend",
        "a1111111111111111",
    )


def test_agent_notification_merges_by_description_without_link() -> None:
    sm = StateMachine()
    _run(sm, _async_spawn(post=False))
    sm.transition(_notify(90, ASYNC_NATIVE, 'Agent "Fixture async job" finished'))
    node = sm.agent_tree.get(ASYNC_SUB)
    assert node is not None and node.native_id == ASYNC_NATIVE and node.state == "done"
    assert [n.id for n in sm.agent_tree.nodes()] == ["main", ASYNC_SUB]


def test_unplaceable_agent_notification_creates_no_node() -> None:
    sm = StateMachine()
    sm.transition(_notify(1, "a2222222222222222", 'Agent "Somebody else" finished'))
    assert all(n.kind == "main" for n in sm.agent_tree.nodes())


def test_background_command_is_a_background_leaf_under_its_starter() -> None:
    sm = StateMachine()
    _run(
        sm,
        [
            _ev(
                "pre_tool_use",
                0,
                tool_name="Bash",
                tool_use_id="toolu_bgcmd",
                tool_input={"command": "sleep 60", "run_in_background": True},
            ),
            _ev(
                "post_tool_use",
                0.5,
                tool_name="Bash",
                tool_use_id="toolu_bgcmd",
                success=True,
                tool_output="Command running in background with ID: bfx0001",
            ),
            _notify(61, "bfx0001", 'Background command "Wait a minute" completed (exit code 0)'),
            _notify(70, "bfx0002", 'Background command "Other" completed (exit code 0)'),
        ],
    )
    node = sm.agent_tree.get("bg_bfx0001")
    assert node is not None
    assert (node.kind, node.parent_id, node.spawn_tool_use_id) == (
        "background",
        "main",
        "toolu_bgcmd",
    )
    other = sm.agent_tree.get("bg_bfx0002")
    assert other is not None and other.kind == "background" and other.spawn_tool_use_id is None


@pytest.mark.asyncio
async def test_discover_native_link_reads_meta_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    subagents = home / ".claude" / "projects" / "p" / "sess" / "subagents"
    subagents.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    transcript = subagents / f"agent-{ASYNC_NATIVE}.jsonl"
    transcript.write_text("")
    (subagents / f"agent-{ASYNC_NATIVE}.meta.json").write_text(
        json.dumps(
            {"agentType": "general-purpose", "description": "Fixture async job", "toolUseId": ASYNC}
        )
    )
    sm = StateMachine()
    _run(sm, _async_spawn(post=False))
    stop = _ev(
        "subagent_stop", 30, native_agent_id=ASYNC_NATIVE, agent_transcript_path=str(transcript)
    )
    link = await discover_native_link(sm, stop)
    assert link is not None
    assert link.data.agent_id == ASYNC_SUB and link.data.native_agent_id == ASYNC_NATIVE
    assert link.data.source == "link" and link.timestamp < stop.timestamp
    assert await discover_native_link(sm, stop) is None  # probed once
    # Notifications derive the path from the main transcript.
    sm2 = StateMachine()
    note = _ev(
        "background_task_notification",
        40,
        background_task_id=ASYNC_NATIVE,
        transcript_path=str(home / ".claude" / "projects" / "p" / "sess.jsonl"),
    )
    link2 = await discover_native_link(sm2, note)
    assert link2 is not None and link2.data.agent_id == ASYNC_SUB
    # Outside ~/.claude: never read.
    sm3 = StateMachine()
    outside = _ev(
        "subagent_stop",
        1,
        native_agent_id="a3333333333333333",
        agent_transcript_path="/tmp/x.jsonl",
    )
    assert await discover_native_link(sm3, outside) is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("ws2_db")
async def test_processor_links_lost_spawn_and_restore_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    subagents = home / ".claude" / "projects" / "p" / "sess" / "subagents"
    subagents.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    transcript = subagents / f"agent-{ASYNC_NATIVE}.jsonl"
    transcript.write_text("")
    (subagents / f"agent-{ASYNC_NATIVE}.meta.json").write_text(
        json.dumps({"description": "Fixture async job", "toolUseId": ASYNC})
    )
    sid = "ws2-proc-link"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        events = [
            _ev(e.event_type, 0, sid, **e.data.model_dump(exclude_none=True))
            for e in _async_spawn(post=False)
        ]
        events += [
            _ev("stop", 5, sid),
            _ev(
                "subagent_stop",
                30,
                sid,
                native_agent_id=ASYNC_NATIVE,
                agent_transcript_path=str(transcript),
            ),
        ]
        await _ingest(ep, sid, events)
        live = ep.sessions[sid]
        node = live.agent_tree.get(ASYNC_SUB)
        assert node is not None and node.state == "done" and node.native_id == ASYNC_NATIVE
        restored = await ep._build_restored_state_machine(sid)  # pyright: ignore[reportPrivateUsage]
        assert restored is not None
        assert _tracker_view(restored) == _tracker_view(live)
    finally:
        poller = get_transcript_poller()
        if poller is not None:
            await poller.stop_all()
        await _wipe(sid)


# ---------------------------------------------------------------------------
# Poller: in-flight tools are not zombies; record timestamps; resume offsets
# ---------------------------------------------------------------------------


def _line(record: dict[str, Any]) -> str:
    return json.dumps(record) + "\n"


@pytest.mark.asyncio
async def test_poller_no_zombie_while_tool_in_flight_and_resumes_offset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    d = home / ".claude" / "projects" / "p" / "sess" / "subagents"
    d.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    path = d / "agent-afx.jsonl"
    path.write_text(
        _line(
            {
                "type": "assistant",
                "timestamp": "2026-11-08T10:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "name": "Bash", "id": "toolu_long", "input": {}}
                    ],
                },
            }
        )
    )
    seen: list[AnyEvent] = []

    async def collect(e: AnyEvent) -> None:
        seen.append(e)

    poller = TranscriptPoller(collect)
    await poller.start_polling(SUB, "ws2-test", str(path))
    state = poller._sessions[SUB]  # pyright: ignore[reportPrivateUsage]
    # The poll loop's own first read races a manual _check (both read the same
    # offset): let the loop read it, then run one more check, which must not
    # re-emit anything.
    for _ in range(100):
        if seen:
            break
        await asyncio.sleep(0.01)
    await poller._check(SUB, state)  # pyright: ignore[reportPrivateUsage]
    assert [e.event_type for e in seen] == ["pre_tool_use"]
    assert seen[0].timestamp == datetime(2026, 11, 8, 10, 0, tzinfo=UTC)  # record time
    # Silent for longer than the zombie timeout, but the Bash call is in flight.
    state.last_activity = datetime.now(UTC) - timedelta(minutes=5)
    await poller._check(SUB, state)  # pyright: ignore[reportPrivateUsage]
    assert all(e.event_type != "subagent_stop" for e in seen)
    assert await poller.is_polling(SUB)
    # Stop, append, restart: resumes at the remembered offset (no re-read).
    await poller.stop_polling(SUB)
    with path.open("a") as f:
        f.write(
            _line(
                {
                    "type": "user",
                    "timestamp": "2026-11-08T10:07:00.000Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": "toolu_long"}],
                    },
                }
            )
        )
    await poller.start_polling(SUB, "ws2-test", str(path))
    state = poller._sessions[SUB]  # pyright: ignore[reportPrivateUsage]
    # The in-flight call is carried over the restart (its post still pairs).
    assert state.active_tool_ids == {"toolu_long"}
    await poller._check(SUB, state)  # pyright: ignore[reportPrivateUsage]
    assert [e.event_type for e in seen] == ["pre_tool_use", "post_tool_use"]
    await poller.stop_all()
