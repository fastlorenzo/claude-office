"""Deterministic session phase classification + state-machine wiring."""

from typing import Any

import pytest

from app.core.session_phase import PhaseInputs, classify_bash, classify_phase, slim_tool_input
from app.core.state_machine import StateMachine
from app.models.agents import BossState
from app.models.campus import compute_phase
from app.models.events import EventType, ToolEvent, ToolEventData


def _tool(name: str, **inp: Any) -> PhaseInputs:
    return PhaseInputs(turn_active=True, tool_running=True, tool_name=name, tool_input=inp or None)


@pytest.mark.parametrize(
    ("command", "kind", "label"),
    [
        ("pytest -q", "testing", "Running tests"),
        ("cd backend && pytest -q", "testing", "Running tests"),
        ("cd backend && uv run pytest tests/x.py::t", "testing", "Running tests"),
        ("python -m pytest", "testing", "Running tests"),
        ("FOO=1 vitest run", "testing", "Running tests"),
        ("bun run test", "testing", "Running tests"),
        ("bun test", "testing", "Running tests"),
        ("npm test", "testing", "Running tests"),
        ("pnpm run test:unit", "testing", "Running tests"),
        ("yarn test", "testing", "Running tests"),
        ("make test", "testing", "Running tests"),
        ("make checkall", "testing", "Running tests"),
        ("make -C backend checkall", "testing", "Running tests"),
        ("go test ./...", "testing", "Running tests"),
        ("cargo test", "testing", "Running tests"),
        ("npx playwright test", "testing", "Running tests"),
        ("npx jest --watch", "testing", "Running tests"),
        ("tsc --noEmit", "building", "Building"),
        ("bunx tsc -p .", "building", "Building"),
        ("next build", "building", "Building"),
        ("npm run build", "building", "Building"),
        ("bun run build", "building", "Building"),
        ("pnpm run build", "building", "Building"),
        ("make build", "building", "Building"),
        ("cargo build --release", "building", "Building"),
        ("uv run ruff check .", "building", "Building"),
        ("eslint src", "building", "Building"),
        ("pyright", "building", "Building"),
        ("docker build -t x .", "building", "Building"),
        ("git commit -m 'x'", "git", "Committing"),
        ("git add . && git commit -m x", "git", "Committing"),
        ("git -C repo push origin main", "git", "Pushing"),
        ("git rebase main", "git", "Rebasing"),
        ("git merge feat", "git", "Merging"),
        ("gh pr create --fill", "git", "Opening PR"),
        ("ls -la", "running", "Running a command"),
        ("git status", "running", "Running a command"),
        ("grep pytest README.md", "running", "Running a command"),
        ("echo hello | tee out.txt", "running", "Running a command"),
        ("", "running", "Running a command"),
    ],
)
def test_bash(command: str, kind: str, label: str) -> None:
    res = classify_bash(command)
    assert (res.kind, res.label) == (kind, label)


def test_bash_unknown_detail_is_clipped_and_skips_cd() -> None:
    res = classify_bash("cd /x && " + "echo " + "a" * 200)
    assert res.detail is not None
    assert res.detail.startswith("echo aaa")
    assert len(res.detail) <= 60


@pytest.mark.parametrize(
    ("inp", "kind", "label", "detail"),
    [
        (PhaseInputs(ended=True, turn_active=True), "ended", "Session ended", None),
        (
            PhaseInputs(
                waiting_permission=True, tool_name="Bash", tool_input={"command": "rm -rf x"}
            ),
            "needs_approval",
            "Waiting for your approval",
            "rm -rf x",
        ),
        (
            PhaseInputs(
                waiting_permission=True, tool_name="Edit", tool_input={"file_path": "/a/b.ts"}
            ),
            "needs_approval",
            "Waiting for your approval",
            "Edit b.ts",
        ),
        (
            PhaseInputs(waiting_permission=True),
            "needs_approval",
            "Waiting for your approval",
            "a tool",
        ),
        (PhaseInputs(compacting=True, turn_active=True), "compacting", "Compacting context", None),
        (PhaseInputs(has_prompted=True), "waiting_user", "Waiting for your reply", None),
        (PhaseInputs(), "idle", "Idle", None),
        (PhaseInputs(turn_active=True), "planning", "Thinking", None),
        (_tool("Edit", file_path="/src/app/World.ts"), "coding", "Coding", "editing World.ts"),
        (_tool("Write", file_path="x.py"), "coding", "Coding", "editing x.py"),
        (_tool("MultiEdit"), "coding", "Coding", None),
        (_tool("Read", file_path="/a/b.py"), "exploring", "Reading code", "reading b.py"),
        (_tool("Grep", pattern="foo"), "exploring", "Reading code", "searching foo"),
        (_tool("Glob", pattern="**/*.ts"), "exploring", "Reading code", "searching **/*.ts"),
        (_tool("WebSearch", query="babylon fog"), "researching", "Researching", "babylon fog"),
        (_tool("WebFetch", url="https://x.dev"), "researching", "Researching", "https://x.dev"),
        (_tool("ExitPlanMode"), "planning", "Planning", None),
        (_tool("Bash", command="pytest"), "testing", "Running tests", "pytest"),
        (_tool("mcp__x__y"), "running", "Working", "mcp__x__y"),
    ],
)
def test_classify(inp: PhaseInputs, kind: str, label: str, detail: str | None) -> None:
    res = classify_phase(inp)
    assert (res.kind, res.label, res.detail) == (kind, label, detail)


def test_delegating_counts_agents() -> None:
    one = classify_phase(
        PhaseInputs(turn_active=True, tool_running=True, tool_name="Agent", active_subagents=1)
    )
    assert (one.kind, one.label) == ("delegating", "Delegating to 1 agent")
    three = classify_phase(PhaseInputs(turn_active=True, active_subagents=3))
    assert three.label == "Delegating to 3 agents"
    # Tool just started, subagent not registered yet.
    assert classify_phase(_tool("Task")).label == "Delegating to 1 agent"
    # Agents still running after the turn ended.
    assert classify_phase(PhaseInputs(has_prompted=True, active_subagents=2)).kind == "delegating"
    # Main agent editing while subagents run: show the concrete tool.
    edit = PhaseInputs(
        turn_active=True, tool_running=True, tool_name="Edit", active_subagents=2,
        tool_input={"file_path": "a.py"},
    )  # fmt: skip
    assert classify_phase(edit).kind == "coding"


def test_between_tools_keeps_last_activity() -> None:
    inp = PhaseInputs(turn_active=True, tool_name="Edit", tool_input={"file_path": "a.py"})
    assert classify_phase(inp).kind == "coding"
    done = PhaseInputs(has_prompted=True, tool_name="Edit")
    assert classify_phase(done).kind == "waiting_user"


def test_slim_tool_input_drops_bodies() -> None:
    slim = slim_tool_input({"file_path": "a", "content": "x" * 10_000, "command": "y" * 999})
    assert slim is not None
    assert set(slim) == {"file_path", "command"}
    assert len(slim["command"]) == 300
    assert slim_tool_input({"content": "x"}) is None
    assert slim_tool_input(None) is None


# --- state machine wiring -------------------------------------------------


def _pre(name: str, **inp: Any) -> ToolEvent:
    return ToolEvent(
        event_type=EventType.PRE_TOOL_USE,
        session_id="s",
        data=ToolEventData(tool_name=name, tool_input=inp, agent_id="main"),
    )


def _evt(kind: EventType, name: str = "Bash", **inp: Any) -> ToolEvent:
    return ToolEvent(
        event_type=kind,
        session_id="s",
        data=ToolEventData(tool_name=name, tool_input=inp, agent_id="main"),
    )


def test_state_machine_tracks_tool_lifecycle_and_since() -> None:
    sm = StateMachine()
    sm.turn_active = True
    sm.transition(_pre("Bash", command="make checkall"))
    first = compute_phase(sm, [])
    assert first.kind == "testing"
    assert first.since

    sm.transition(_pre("Bash", command="pytest -x"))
    again = compute_phase(sm, [])
    assert again.since == first.since  # same kind: since does not reset

    sm.transition(_evt(EventType.POST_TOOL_USE, "Bash", command="pytest -x"))
    assert sm.tool_running is False

    sm.transition(_pre("Edit", file_path="/a/b.py"))
    edit = compute_phase(sm, [])
    assert edit.kind == "coding"
    assert edit.since is not None and edit.since >= first.since

    sm.transition(_evt(EventType.PERMISSION_REQUEST, "Bash", command="rm -rf build"))
    assert sm.boss_state == BossState.WAITING_PERMISSION
    ask = compute_phase(sm, [])
    assert (ask.kind, ask.detail) == ("needs_approval", "rm -rf build")
