"""Live (running) vs cumulative (spawned) subagent counting, and the main context gauge."""

from datetime import UTC, datetime
from pathlib import Path

from app.core.state_machine import StateMachine
from app.core.subagent_liveness import count_running_subagents, scan_agent_mtimes
from app.core.token_tracker import TokenTracker, _context_window_for_model
from app.models.agents import Agent, AgentState
from app.models.events import AgentEvent, AgentEventData, EventType

NOW = 1_800_000_000.0


def _agent(aid: str, native: str | None, state: AgentState = AgentState.WORKING) -> Agent:
    return Agent(id=aid, native_id=native, color="#fff", number=1, state=state)


def _count(
    agents: list[Agent],
    mtimes: dict[str, float],
    stopped: dict[str, float] | None = None,
    handin: tuple[str, ...] = (),
) -> int:
    return count_running_subagents({a.id: a for a in agents}, handin, stopped or {}, mtimes, NOW)


def test_tracked_agents_count_even_when_quiet_for_a_while() -> None:
    a = [_agent("s1", "n1"), _agent("s2", None)]  # n1 quiet 20 min, s2 not yet linked
    assert _count(a, {"n1": NOW - 20 * 60}) == 2


def test_tracked_agent_with_lost_stop_expires() -> None:
    assert _count([_agent("s1", "n1")], {"n1": NOW - 31 * 60}) == 0


def test_stopped_or_leaving_agents_do_not_count() -> None:
    a = [_agent("s1", "n1"), _agent("s2", "n2", AgentState.LEAVING), _agent("s3", "n3")]
    assert _count(a, {"n1": NOW - 5}, {"n1": NOW - 5}, handin=("s3",)) == 0


def test_resumed_background_agent_counts_after_its_stop() -> None:
    # Stop at NOW-120 (report handed back), agent removed from the office, but its
    # transcript kept growing (SendMessage resume): still running.
    assert _count([], {"n9": NOW - 10}, {"n9": NOW - 120}) == 1
    # Stopped and quiet since: done.
    assert _count([], {"n9": NOW - 118}, {"n9": NOW - 120}) == 0
    # Unknown agent whose file stopped changing minutes ago: done.
    assert _count([], {"nx": NOW - 600}) == 0


def test_six_background_agents_mixed_sources() -> None:
    tracked = [_agent(f"t{i}", f"n{i}") for i in range(3)]
    mt = {f"n{i}": NOW - 10 * i for i in range(3)}
    mt.update({"r1": NOW - 20, "r2": NOW - 30, "r3": NOW - 40})  # resumed / missed start
    stopped = {"r1": NOW - 500, "r2": NOW - 500, "r3": NOW - 500, "old": NOW - 900}
    mt["old"] = NOW - 899  # finished
    assert _count(tracked, mt, stopped) == 6


def test_scan_agent_mtimes(tmp_path: Path) -> None:
    main = tmp_path / "sess.jsonl"
    d = tmp_path / "sess" / "subagents"
    d.mkdir(parents=True)
    (d / "agent-abc.jsonl").write_text("{}")
    (d / "notes.txt").write_text("x")
    out = scan_agent_mtimes(str(main), now=NOW)
    assert list(out) == ["abc"]
    assert scan_agent_mtimes(None) == {}


def test_state_machine_records_stop_per_native_id() -> None:
    sm = StateMachine()
    ts = datetime(2026, 11, 7, 22, 0, 0)  # naive (as restored from the DB) means UTC
    sm.transition(
        AgentEvent(
            event_type=EventType.SUBAGENT_STOP,
            session_id="s",
            timestamp=ts,
            data=AgentEventData(native_agent_id="abc"),
        )
    )
    assert sm.stopped_native["abc"] == ts.replace(tzinfo=UTC).timestamp()


def test_subagent_events_never_move_the_main_context_gauge() -> None:
    t = TokenTracker()
    t.total_input_tokens = 168_000
    t.max_context_tokens = 1_000_000
    for et in (EventType.SUBAGENT_START, EventType.SUBAGENT_INFO, EventType.SUBAGENT_STOP):
        t.update_from_event(
            AgentEvent(
                event_type=et,
                session_id="s",
                timestamp=datetime.now(UTC),
                data=AgentEventData(
                    transcript_path="/home/x/.claude/projects/p/s.jsonl",
                    agent_transcript_path="/home/x/.claude/projects/p/s/subagents/agent-a.jsonl",
                    input_tokens=5,
                ),
            )
        )
    assert (t.total_input_tokens, t.max_context_tokens) == (168_000, 1_000_000)


def test_one_million_window_is_never_clamped() -> None:
    assert _context_window_for_model("claude-opus-4-7") == 1_000_000
    assert _context_window_for_model("mystery-model[1m]") == 1_000_000
    assert _context_window_for_model("mystery-model") == 200_000
