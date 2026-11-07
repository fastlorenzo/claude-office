"""Deterministic "where is this session at" classification (no AI).

:func:`classify_phase` is a pure function over :class:`PhaseInputs`, a snapshot
of live :class:`~app.core.state_machine.StateMachine` fields (boss state, the
main agent's current/last tool and its slimmed input, active subagents...).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

__all__ = [
    "PhaseInputs",
    "PhaseKind",
    "PhaseResult",
    "classify_bash",
    "classify_tool",
    "classify_phase",
    "slim_tool_input",
]

PhaseKind = Literal[
    "needs_approval",
    "waiting_user",
    "planning",
    "researching",
    "exploring",
    "coding",
    "testing",
    "building",
    "running",
    "git",
    "delegating",
    "compacting",
    "idle",
    "ended",
]

DETAIL_MAX_CHARS = 60
_SLIM_KEYS = ("file_path", "notebook_path", "path", "pattern", "query", "url", "command")
_SLIM_VALUE_MAX = 300


@dataclass(frozen=True)
class PhaseResult:
    kind: PhaseKind
    label: str
    detail: str | None = None


@dataclass(frozen=True)
class PhaseInputs:
    """Snapshot of what the classifier needs (all plain values)."""

    ended: bool = False
    waiting_permission: bool = False
    compacting: bool = False
    turn_active: bool = False
    has_prompted: bool = False  # the user has sent at least one prompt
    tool_running: bool = False  # main agent has a tool call in flight
    tool_name: str | None = None  # current (or last) main-agent tool
    tool_input: dict[str, Any] | None = None
    active_subagents: int = 0


def slim_tool_input(tool_input: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep only the small string fields the classifier reads (drops file bodies)."""
    if not tool_input:
        return None
    slim: dict[str, Any] = {}
    for key in _SLIM_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            slim[key] = value[:_SLIM_VALUE_MAX]
    return slim or None


def _clip(text: str, limit: int = DETAIL_MAX_CHARS) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _basename(path: str) -> str:
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    return parts[-1] if parts else path


# ---------------------------------------------------------------------------
# Bash classification
# ---------------------------------------------------------------------------

_SPLIT = re.compile(r"&&|\|\||[;|\n]")
_ENV_ASSIGN = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+")
_WRAPPERS = (
    r"(?:(?:uv run|uvx|npx|bunx|pnpm exec|pnpm dlx|yarn dlx|poetry run|python3? -m"
    r"|time|env|sudo|nice)\s+)*"
)
_PM = r"(?:npm|bun|pnpm|yarn)"


def _rx(body: str) -> re.Pattern[str]:
    return re.compile(rf"^{_WRAPPERS}(?:{body})(?:\s|$)")


_GIT_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^git(?:\s+-\S+(?:\s+\S+)?)*\s+commit\b"), "Committing"),
    (re.compile(r"^git(?:\s+-\S+(?:\s+\S+)?)*\s+push\b"), "Pushing"),
    (re.compile(r"^git(?:\s+-\S+(?:\s+\S+)?)*\s+rebase\b"), "Rebasing"),
    (re.compile(r"^git(?:\s+-\S+(?:\s+\S+)?)*\s+merge\b"), "Merging"),
    (re.compile(r"^gh\s+pr\b"), "Opening PR"),
]
_TEST_RULES = [
    _rx(r"pytest|vitest|jest|playwright test|playwright|go test|cargo test|cargo nextest"),
    _rx(rf"{_PM}(?:\s+run)?\s+test(?::\S+)?"),
    _rx(r"bun test"),
    _rx(r"make(?:\s+-\S+(?:\s+\S+)?)*\s+(?:test|checkall)"),
]
_BUILD_RULES = [
    _rx(r"tsc|eslint|ruff|pyright|mypy|prettier|biome|oxlint"),
    _rx(r"next build|vite build|webpack|turbo build|docker build|docker compose build"),
    _rx(rf"{_PM}(?:\s+run)?\s+(?:build|lint|typecheck|type-check|check)(?::\S+)?"),
    _rx(r"make(?:\s+-\S+(?:\s+\S+)?)*\s+(?:build|lint|typecheck|check)"),
    _rx(r"cargo (?:build|check|clippy)"),
    _rx(r"go build"),
]


def _segments(command: str) -> list[str]:
    out: list[str] = []
    for raw in _SPLIT.split(command):
        seg = _ENV_ASSIGN.sub("", raw.strip())
        if seg:
            out.append(seg)
    return out


def classify_bash(command: str | None) -> PhaseResult:
    """Classify a shell command (compound commands: first recognised segment wins)."""
    if not command or not command.strip():
        return PhaseResult("running", "Running a command")
    segs = _segments(command)
    for seg in segs:
        for rx, label in _GIT_RULES:
            if rx.match(seg):
                return PhaseResult("git", label, _clip(seg))
        if any(rx.match(seg) for rx in _TEST_RULES):
            return PhaseResult("testing", "Running tests", _clip(seg))
        if any(rx.match(seg) for rx in _BUILD_RULES):
            return PhaseResult("building", "Building", _clip(seg))
    # Unknown: describe the last meaningful segment's text (skip bare `cd`).
    shown = next((s for s in segs if not s.startswith("cd ")), segs[0] if segs else command)
    return PhaseResult("running", "Running a command", _clip(shown))


# ---------------------------------------------------------------------------
# Tool classification
# ---------------------------------------------------------------------------

_EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
_READ_TOOLS = frozenset({"Read", "Grep", "Glob", "LS"})
_WEB_TOOLS = frozenset({"WebSearch", "WebFetch"})
_AGENT_TOOLS = frozenset({"Agent", "Task"})
_PLAN_TOOLS = frozenset({"ExitPlanMode", "EnterPlanMode", "TodoWrite"})


def _target(tool_input: dict[str, Any] | None) -> str | None:
    inp = tool_input or {}
    for key in ("file_path", "notebook_path", "path"):
        v = inp.get(key)
        if isinstance(v, str) and v:
            return _basename(v)
    return None


def _delegating(n: int) -> PhaseResult:
    n = max(n, 1)
    return PhaseResult("delegating", f"Delegating to {n} agent{'' if n == 1 else 's'}")


def _classify_tool(
    tool: str | None, tool_input: dict[str, Any] | None, subagents: int
) -> PhaseResult:
    inp = tool_input or {}
    if not tool:
        return PhaseResult("planning", "Thinking")
    if tool in _EDIT_TOOLS:
        t = _target(inp)
        return PhaseResult("coding", "Coding", _clip(f"editing {t}") if t else None)
    if tool in _READ_TOOLS:
        t = _target(inp)
        pat = inp.get("pattern")
        if tool in ("Read",) and t:
            detail: str | None = f"reading {t}"
        elif isinstance(pat, str) and pat:
            detail = f"searching {pat}"
        else:
            detail = t
        return PhaseResult("exploring", "Reading code", _clip(detail) if detail else None)
    if tool in _WEB_TOOLS:
        q = inp.get("query") or inp.get("url")
        return PhaseResult("researching", "Researching", _clip(q) if isinstance(q, str) else None)
    if tool in _AGENT_TOOLS:
        return _delegating(subagents)
    if tool in _PLAN_TOOLS:
        return PhaseResult("planning", "Planning")
    if tool == "Bash":
        cmd = inp.get("command")
        return classify_bash(cmd if isinstance(cmd, str) else None)
    return PhaseResult("running", "Working", _clip(tool))


def classify_phase(inp: PhaseInputs) -> PhaseResult:
    """Classify the session's current phase. Priority: ended > approval > compacting >
    active work (tool / subagents / open turn) > waiting for the user > idle."""
    if inp.ended:
        return PhaseResult("ended", "Session ended")
    if inp.waiting_permission:
        tool = inp.tool_name or "a tool"
        detail: str | None = tool
        data = inp.tool_input or {}
        if tool == "Bash" and isinstance(data.get("command"), str):
            detail = _clip(data["command"])
        elif (target := _target(data)) is not None:
            detail = _clip(f"{tool} {target}")
        return PhaseResult("needs_approval", "Waiting for your approval", detail)
    if inp.compacting:
        return PhaseResult("compacting", "Compacting context")
    if inp.tool_running:
        if inp.active_subagents > 0 and inp.tool_name not in ("Bash", *_EDIT_TOOLS, *_READ_TOOLS):
            return _delegating(inp.active_subagents)
        return _classify_tool(inp.tool_name, inp.tool_input, inp.active_subagents)
    if inp.active_subagents > 0:
        return _delegating(inp.active_subagents)
    if inp.turn_active:
        # Between tool calls: keep showing the last activity rather than flicker.
        if inp.tool_name:
            return _classify_tool(inp.tool_name, inp.tool_input, 0)
        return PhaseResult("planning", "Thinking")
    if inp.has_prompted:
        return PhaseResult("waiting_user", "Waiting for your reply")
    return PhaseResult("idle", "Idle")


def classify_tool(
    tool: str | None, tool_input: dict[str, Any] | None, subagents: int = 0
) -> PhaseResult:
    """Public classifier for a single tool call (used for activity stats)."""
    return _classify_tool(tool, tool_input, subagents)
