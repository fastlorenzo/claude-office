"""Tool-call tracker and agent tree for the Session Console (spec section 3.2).

A :class:`~app.core.state_machine.StateMachine` owns one :class:`AgentTree`
and one :class:`ToolCallTracker`, fed from ``StateMachine.transition``. Live
ingest, DB restore and replay therefore all rebuild them identically.

The tracker pairs pre / permission / post events into one :class:`ToolCall`
keyed by ``tool_use_id`` and merges the duplicate copies a subagent's tool call
produces (the hook stamps it ``agent_id="main"``; the transcript poller later
re-emits it under ``subagent_<toolu>``). The tree records every agent the
session has seen (main, subagents, background tasks), including ones the
office has already removed, with their parent links.

Everything here is synchronous and deterministic: timestamps come from the
events, never from the wall clock.
"""

from __future__ import annotations

import json
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, cast

from app.core.session_phase import classify_tool
from app.models.console import AgentNode, ToolCall, ToolCallStatus
from app.models.events import (
    AgentEvent,
    AnyEvent,
    BackgroundTaskEvent,
    EventType,
    ToolEvent,
)

__all__ = [
    "MAX_TRACKED_CALLS",
    "AgentTree",
    "ApplyOutcome",
    "ApplyResult",
    "ToolCallTracker",
    "build_input_preview",
    "build_target",
]

ApplyOutcome = Literal["created", "updated", "merged_duplicate", "ignored"]

MAX_TRACKED_CALLS = 5000
TARGET_MAX_CHARS = 200
INPUT_VALUE_MAX_CHARS = 2048
INPUT_TOTAL_MAX_CHARS = 8192
OUTPUT_PREVIEW_MAX_CHARS = 2048
ERROR_MAX_CHARS = 500
TASK_PREVIEW_MAX_CHARS = 1024
RESULT_PREVIEW_MAX_CHARS = 1024
ACTIVITY_MAX_CHARS = 120
# How far back a permission request without tool_use_id looks for its call.
_PERMISSION_LOOKBACK = 200

_SPAWN_TOOLS = ("Task", "Agent")
_ENDED: frozenset[str] = frozenset({"ok", "error", "denied", "interrupted"})
_STDERR_MARK = "--- stderr ---"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _iso(ts: datetime) -> str:
    """Normalise to an aware-UTC ISO string (restored rows come back naive)."""
    ts = ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts.astimezone(UTC)
    return ts.isoformat(timespec="microseconds")


def _ms_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    delta = datetime.fromisoformat(end) - datetime.fromisoformat(start)
    return max(0, int(delta.total_seconds() * 1000))


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def build_target(tool_name: str, tool_input: dict[str, Any] | None) -> str | None:
    """Short label for a call: path / command / pattern / url / description."""
    if not tool_input:
        return None

    def _s(key: str) -> str | None:
        value = tool_input.get(key)
        return value if isinstance(value, str) and value.strip() else None

    target: str | None
    if tool_name in ("Read", "Edit", "MultiEdit", "Write", "NotebookEdit"):
        target = _s("file_path") or _s("notebook_path") or _s("path")
    elif tool_name in ("Bash", "BashOutput"):
        command = _s("command")
        target = _first_line(command) if command else _s("bash_id")
    elif tool_name in ("Grep", "Glob"):
        pattern = _s("pattern")
        path = _s("path")
        target = f"{pattern} {path}" if pattern and path else pattern or path
    elif tool_name == "WebFetch":
        target = _s("url")
    elif tool_name == "WebSearch":
        target = _s("query")
    elif tool_name in _SPAWN_TOOLS:
        target = _s("description") or _s("subagent_type")
    else:
        target = None
        for key in ("file_path", "path", "command", "pattern", "query", "url"):
            target = _s(key)
            if target:
                break
        if target is None:
            target = next(
                (v for v in tool_input.values() if isinstance(v, str) and v.strip()), None
            )
        if target:
            target = _first_line(target)
    return _clip(target, TARGET_MAX_CHARS) if target else None


def _cap_nested(value: Any, flags: list[bool]) -> Any:
    """Cap every string inside *value* at INPUT_VALUE_MAX_CHARS (records truncation)."""
    if isinstance(value, str):
        if len(value) > INPUT_VALUE_MAX_CHARS:
            flags.append(True)
            return value[:INPUT_VALUE_MAX_CHARS]
        return value
    if isinstance(value, dict):
        return {str(k): _cap_nested(v, flags) for k, v in cast(dict[Any, Any], value).items()}
    if isinstance(value, list):
        return [_cap_nested(v, flags) for v in cast(list[Any], value)]
    return value


def build_input_preview(
    tool_input: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, bool]:
    """Each string value <= 2 KB, total <= 8 KB (JSON-encoded). Returns (preview, truncated)."""
    if tool_input is None:
        return None, False
    flags: list[bool] = []
    preview: dict[str, Any] = {}
    used = 2  # "{}"
    for key, raw in tool_input.items():
        value = _cap_nested(raw, flags)
        # '"key": ' plus the ", " separator before every entry but the first.
        overhead = len(json.dumps(key)) + 2 + (2 if preview else 0)
        size = overhead + len(json.dumps(value, default=str))
        if used + size > INPUT_TOTAL_MAX_CHARS:
            flags.append(True)
            room = INPUT_TOTAL_MAX_CHARS - used - overhead - 2
            if not isinstance(value, str) or room <= 64:
                continue
            value = value[:room]
            while value and used + overhead + len(json.dumps(value)) > INPUT_TOTAL_MAX_CHARS:
                value = value[: len(value) - max(1, len(value) // 16)]
            size = overhead + len(json.dumps(value))
        preview[key] = value
        used += size
    return preview, bool(flags)


def _error_from_output(output: str | None) -> str | None:
    if not output:
        return None
    if _STDERR_MARK in output:
        line = _first_line(output.split(_STDERR_MARK, 1)[1])
        if line:
            return _clip(line, ERROR_MAX_CHARS)
    for line in output.splitlines():
        low = line.lower()
        if "error" in low or "assert" in low or "failed" in low:
            return _clip(line.strip(), ERROR_MAX_CHARS)
    line = _first_line(output)
    return _clip(line, ERROR_MAX_CHARS) if line else None


def _spawn_id_of(agent_id: str | None) -> str | None:
    """``subagent_toolu_X`` -> ``toolu_X`` (synthetic ``subagent_<native>`` ids have none)."""
    if agent_id and agent_id.startswith("subagent_toolu_"):
        return agent_id[len("subagent_") :]
    return None


def _specificity(agent_id: str) -> int:
    return 0 if agent_id == "main" else 1


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class ApplyResult:
    """What one event did to the tracker and tree (the frames to broadcast)."""

    outcome: ApplyOutcome = "ignored"
    # Agent this event is attributed to (tool events): the call's owner.
    agent_id: str | None = None
    calls: list[ToolCall] = field(default_factory=lambda: cast(list[ToolCall], []))
    nodes: list[AgentNode] = field(default_factory=lambda: cast(list[AgentNode], []))

    def touch_call(self, call: ToolCall) -> None:
        if all(c is not call for c in self.calls):
            self.calls.append(call)

    def touch_node(self, node: AgentNode | None) -> None:
        if node is not None and all(n is not node for n in self.nodes):
            self.nodes.append(node)


# ---------------------------------------------------------------------------
# Agent tree
# ---------------------------------------------------------------------------


class AgentTree:
    """Every agent the session has seen, with parent links (``main`` is the root)."""

    def __init__(self) -> None:
        self._nodes: dict[str, AgentNode] = {}
        self._native_to_id: dict[str, str] = {}

    # -- read API -----------------------------------------------------------

    def nodes(self) -> list[AgentNode]:
        """All nodes, root first, then in creation order."""
        return list(self._nodes.values())

    def get(self, agent_id: str) -> AgentNode | None:
        return self._nodes.get(agent_id)

    def resolve_native(self, native_id: str | None) -> str | None:
        return self._native_to_id.get(native_id) if native_id else None

    # -- mutation (tracker-internal) ----------------------------------------

    def bump(self, node: AgentNode, result: ApplyResult) -> None:
        node.rev += 1
        result.touch_node(node)

    def ensure_main(self, ts: str, result: ApplyResult | None = None) -> AgentNode:
        node = self._nodes.get("main")
        if node is None:
            node = AgentNode(
                id="main",
                kind="main",
                name="Main agent",
                state="idle",
                started_at=ts,
                rev=1,
            )
            self._nodes["main"] = node
            if result is not None:
                result.touch_node(node)
        return node

    def ensure(self, agent_id: str, ts: str, result: ApplyResult) -> AgentNode:
        """Return the node for *agent_id*, creating a bare subagent node if unseen."""
        if agent_id == "main":
            return self.ensure_main(ts, result)
        node = self._nodes.get(agent_id)
        if node is None:
            self.ensure_main(ts, result)
            node = AgentNode(
                id=agent_id,
                kind="subagent",
                name=agent_id,
                parent_id="main",
                state="running",
                started_at=ts,
                spawn_tool_use_id=_spawn_id_of(agent_id),
                rev=1,
            )
            self._nodes[agent_id] = node
            result.touch_node(node)
        return node

    def add_node(self, node: AgentNode, result: ApplyResult) -> None:
        self._nodes[node.id] = node
        if node.native_id:
            self._native_to_id.setdefault(node.native_id, node.id)
        result.touch_node(node)

    def link(self, agent_id: str, native_id: str, result: ApplyResult) -> bool:
        """Record ``native_id`` for *agent_id* (never re-links either side)."""
        if not native_id or agent_id == "main":
            return False
        known = self._native_to_id.get(native_id)
        if known is not None:
            return known == agent_id
        node = self._nodes.get(agent_id)
        if node is not None and node.native_id not in (None, native_id):
            return False
        self._native_to_id[native_id] = agent_id
        if node is not None and node.native_id is None:
            node.native_id = native_id
            self.bump(node, result)
        return True


# ---------------------------------------------------------------------------
# Tool-call tracker
# ---------------------------------------------------------------------------


class ToolCallTracker:
    """Pairs, merges and classifies tool calls; keeps the last 5000 in memory."""

    def __init__(self, tree: AgentTree, max_calls: int = MAX_TRACKED_CALLS) -> None:
        self.tree = tree
        self._max_calls = max_calls
        self._calls: OrderedDict[str, ToolCall] = OrderedDict()
        self._seq = 0
        self._evicted = 0
        # Synthetic-id FIFO pairing for producers without tool_use_id.
        self._open_synthetic: dict[tuple[str, str], deque[str]] = {}
        # Calls attributed to "main" only for want of a known caller: their
        # raw caller native id, re-resolved once a link is learned.
        self._pending_caller: dict[str, str] = {}
        # agent id -> the call whose activity its node shows.
        self._activity_call: dict[str, str] = {}
        # Calls closed by inference (orphaned "running" at turn / agent /
        # session end): a late real post still settles them.
        self._closed_by_inference: set[str] = set()

    # -- read API (WS3) -----------------------------------------------------

    def snapshot(
        self, limit: int = 300, before_seq: int | None = None
    ) -> tuple[list[ToolCall], bool, int | None]:
        """Latest *limit* calls (ascending seq) older than *before_seq*.

        Returns ``(calls, has_more, oldest_seq)``. ``has_more`` is also true
        when older calls were evicted from memory (page them from the DB).
        """
        pool = list(self._calls.values())
        if before_seq is not None:
            pool = [c for c in pool if c.seq < before_seq]
        limit = max(0, limit)
        page = pool[-limit:] if limit else []
        has_more = len(pool) > len(page) or self._evicted > 0
        oldest = page[0].seq if page else None
        return [c.model_copy() for c in page], has_more, oldest

    def get(self, call_id: str) -> ToolCall | None:
        call = self._calls.get(call_id)
        return call.model_copy() if call is not None else None

    def __len__(self) -> int:
        return len(self._calls)

    # -- ingest -------------------------------------------------------------

    def apply(self, event: AnyEvent) -> ApplyResult:
        """Fold one event into the tracker/tree and report what changed."""
        result = ApplyResult()
        ts = _iso(event.timestamp)
        et = event.event_type
        if isinstance(event, ToolEvent):
            if et == EventType.PRE_TOOL_USE:
                self._on_pre(event, ts, result)
            elif et == EventType.POST_TOOL_USE:
                self._on_post(event, ts, result)
            elif et == EventType.PERMISSION_REQUEST:
                self._on_permission(event, ts, result)
        elif isinstance(event, AgentEvent):
            if et == EventType.SUBAGENT_START:
                self._on_subagent_start(event, ts, result)
            elif et == EventType.SUBAGENT_STOP:
                self._on_subagent_stop(event, ts, result)
            elif et == EventType.SUBAGENT_INFO:
                self._on_subagent_info(event, ts, result)
        elif isinstance(event, BackgroundTaskEvent):
            self._on_background(event, ts, result)
        elif et == EventType.USER_PROMPT_SUBMIT:
            self._set_main_state("working", ts, result)
        elif et == EventType.STOP:
            self._infer_denied("main", ts, result)
            self._close_orphans("main", ts, result)
            self._set_main_state("idle", ts, result)
        elif et == EventType.SESSION_END:
            self._infer_denied(None, ts, result)
            self._close_orphans(None, ts, result, keep_live_spawns=False)
            main = self._set_main_state("ended", ts, result)
            if main.ended_at is None:
                main.ended_at = ts
        elif et == EventType.SESSION_START:
            self.tree.ensure_main(ts, result)
        return result

    # -- internals: attribution --------------------------------------------

    def _owner_for(self, raw_agent: str | None, caller_native: str | None) -> tuple[str, bool]:
        """Resolve the agent an event belongs to. Returns (agent_id, caller_unresolved)."""
        agent = raw_agent or "main"
        if agent == "main" and caller_native:
            resolved = self.tree.resolve_native(caller_native)
            if resolved is not None:
                return resolved, False
            return "main", True
        return agent, False

    def _reassign(self, call: ToolCall, new_agent: str, ts: str, result: ApplyResult) -> None:
        """Move *call* to a more specific owner, fixing counters and spawned children."""
        old = self.tree.get(call.agent_id)
        if old is not None:
            old.tool_calls = max(0, old.tool_calls - 1)
            if call.status == "error":
                old.errors = max(0, old.errors - 1)
            if self._activity_call.get(call.agent_id) == call.id:
                old.current_activity = None
                self._activity_call.pop(call.agent_id, None)
            self.tree.bump(old, result)
        call.agent_id = new_agent
        node = self.tree.ensure(new_agent, ts, result)
        node.tool_calls += 1
        if call.status == "error":
            node.errors += 1
        if call.status in ("running", "waiting_permission"):
            node.current_activity = self._activity_text(call)
            self._activity_call[new_agent] = call.id
        self.tree.bump(node, result)
        self._pending_caller.pop(call.id, None)
        # A spawn call that moved reveals the true parent of its child.
        if call.spawned_agent_id:
            child = self.tree.get(call.spawned_agent_id)
            if child is not None and child.parent_id != new_agent:
                child.parent_id = new_agent
                self.tree.bump(child, result)

    def _learn_link(self, agent_id: str, native_id: str, ts: str, result: ApplyResult) -> None:
        """Record native->agent and re-resolve every call waiting on that caller."""
        if not self.tree.link(agent_id, native_id, result):
            return
        waiting = [cid for cid, nid in self._pending_caller.items() if nid == native_id]
        for cid in waiting:
            call = self._calls.get(cid)
            self._pending_caller.pop(cid, None)
            if call is None or call.agent_id != "main":
                continue
            self._reassign(call, agent_id, ts, result)
            self._bump(call, result)

    # -- internals: calls ---------------------------------------------------

    def _bump(self, call: ToolCall, result: ApplyResult) -> None:
        call.rev += 1
        result.touch_call(call)

    @staticmethod
    def _activity_text(call: ToolCall) -> str:
        text = f"{call.tool_name} {call.target}" if call.target else call.tool_name
        return _clip(text, ACTIVITY_MAX_CHARS)

    def _create(
        self,
        call_id: str,
        agent_id: str,
        tool_name: str,
        tool_input: dict[str, Any] | None,
        ts: str,
        status: ToolCallStatus,
        result: ApplyResult,
    ) -> ToolCall:
        self._seq += 1
        preview, truncated = build_input_preview(tool_input)
        call = ToolCall(
            id=call_id,
            seq=self._seq,
            rev=0,
            agent_id=agent_id,
            tool_name=tool_name,
            kind=classify_tool(tool_name, tool_input).kind if tool_name else None,
            target=build_target(tool_name, tool_input),
            input_preview=preview,
            input_truncated=truncated,
            status=status,
            started_at=ts,
        )
        if tool_name in _SPAWN_TOOLS:
            call.spawned_agent_id = f"subagent_{call_id}"
        self._calls[call_id] = call
        while len(self._calls) > self._max_calls:
            old_id, _ = self._calls.popitem(last=False)
            self._pending_caller.pop(old_id, None)
            self._closed_by_inference.discard(old_id)
            self._evicted += 1
        node = self.tree.ensure(agent_id, ts, result)
        node.tool_calls += 1
        if status in ("running", "waiting_permission"):
            node.current_activity = self._activity_text(call)
            self._activity_call[agent_id] = call_id
        self.tree.bump(node, result)
        self._bump(call, result)
        return call

    def _merge_identity(
        self,
        call: ToolCall,
        agent_id: str,
        caller_native: str | None,
        tool_name: str | None,
        tool_input: dict[str, Any] | None,
        ts: str,
        result: ApplyResult,
    ) -> None:
        """Merge agent / start time / name / input from another copy of the call."""
        if _specificity(agent_id) > _specificity(call.agent_id):
            pending = self._pending_caller.get(call.id)
            self._reassign(call, agent_id, ts, result)
            if pending:
                # The hook copy said "caller N", the poller copy says subagent S.
                self._learn_link(agent_id, pending, ts, result)
        elif call.agent_id == "main" and caller_native and call.id not in self._pending_caller:
            self._pending_caller[call.id] = caller_native
        if ts < call.started_at:
            call.started_at = ts
            if call.ended_at:
                call.duration_ms = _ms_between(call.started_at, call.ended_at)
        if tool_name and (not call.tool_name or call.tool_name in _SPAWN_TOOLS):
            call.tool_name = tool_name
        if tool_input is not None and call.input_preview is None:
            call.input_preview, call.input_truncated = build_input_preview(tool_input)
            call.target = build_target(call.tool_name, tool_input)
            call.kind = classify_tool(call.tool_name, tool_input).kind

    def _end_activity(self, call: ToolCall, result: ApplyResult) -> None:
        if self._activity_call.get(call.agent_id) == call.id:
            self._activity_call.pop(call.agent_id, None)
            node = self.tree.get(call.agent_id)
            if node is not None:
                node.current_activity = None
                self.tree.bump(node, result)

    def _set_status(self, call: ToolCall, status: ToolCallStatus, result: ApplyResult) -> None:
        if call.status == status:
            return
        node = self.tree.get(call.agent_id)
        if node is not None:
            if status == "error" and call.status != "error":
                node.errors += 1
                self.tree.bump(node, result)
            elif call.status == "error" and status != "error":
                node.errors = max(0, node.errors - 1)
                self.tree.bump(node, result)
        call.status = status
        if status in _ENDED:
            self._end_activity(call, result)

    def _infer_denied(self, agent_id: str | None, ts: str, result: ApplyResult) -> None:
        """A call still waiting for permission when its agent moves on was denied.

        ``agent_id=None`` applies to every agent (session end).
        """
        for call in reversed(self._calls.values()):
            if agent_id is not None and call.agent_id != agent_id:
                continue
            if call.status == "waiting_permission":
                self._set_status(call, "denied", result)
                call.ended_at = ts
                call.duration_ms = _ms_between(call.started_at, ts)
                call.permission_wait_ms = _ms_between(call.permission_requested_at, ts)
                self._bump(call, result)

    def _close_orphans(
        self,
        agent_id: str | None,
        ts: str,
        result: ApplyResult,
        keep_live_spawns: bool = True,
    ) -> None:
        """Close calls still ``running`` when their agent's turn / life ends.

        Their post never arrived (the hook POST timed out, or the tool was cut
        off), so they are marked ``interrupted`` instead of pulsing forever. A
        late real post still settles them (``_closed_by_inference``).
        ``agent_id=None`` closes every agent's calls (session end). For
        ``main``, hook copies whose caller id is not resolved yet are skipped:
        they belong to a subagent that may still be working. Spawn calls whose
        child is still running stay open unless *keep_live_spawns* is False.
        """
        for call in self._calls.values():
            if call.status != "running":
                continue
            if agent_id is not None and call.agent_id != agent_id:
                continue
            if agent_id == "main" and call.id in self._pending_caller:
                continue
            if keep_live_spawns and call.spawned_agent_id:
                child = self.tree.get(call.spawned_agent_id)
                if child is not None and child.ended_at is None:
                    continue
            self._set_status(call, "interrupted", result)
            call.ended_at = ts
            call.duration_ms = _ms_between(call.started_at, ts)
            self._closed_by_inference.add(call.id)
            self._bump(call, result)

    def _on_pre(self, event: ToolEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        tool_name = data.tool_name or ""
        agent_id, unresolved = self._owner_for(data.agent_id, data.caller_native_agent_id)
        call_id = data.tool_use_id
        existing = self._calls.get(call_id) if call_id else None
        if existing is not None:
            self._merge_identity(
                existing,
                agent_id,
                data.caller_native_agent_id if unresolved else None,
                tool_name or None,
                data.tool_input,
                ts,
                result,
            )
            self._bump(existing, result)
            result.outcome = "merged_duplicate"
            result.agent_id = existing.agent_id
            return
        if not tool_name and not call_id:
            return
        self._infer_denied(agent_id, ts, result)
        if call_id is None:
            call_id = f"evt-{self._seq + 1}"
            self._open_synthetic.setdefault((agent_id, tool_name), deque()).append(call_id)
        call = self._create(call_id, agent_id, tool_name, data.tool_input, ts, "running", result)
        if unresolved and data.caller_native_agent_id:
            self._pending_caller[call.id] = data.caller_native_agent_id
        if agent_id == "main":
            self._set_main_state("working", ts, result)
        result.outcome = "created"
        result.agent_id = call.agent_id

    def _find_for_permission(self, agent_id: str, tool_name: str) -> ToolCall | None:
        for i, call in enumerate(reversed(self._calls.values())):
            if i >= _PERMISSION_LOOKBACK:
                break
            if call.agent_id == agent_id and call.tool_name == tool_name:
                return call if call.status == "running" else None
        return None

    def _on_permission(self, event: ToolEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        tool_name = data.tool_name or ""
        agent_id, unresolved = self._owner_for(data.agent_id, data.caller_native_agent_id)
        call = self._calls.get(data.tool_use_id) if data.tool_use_id else None
        if call is None:
            call = self._find_for_permission(agent_id, tool_name)
        if call is None:
            call_id = data.tool_use_id or f"evt-{self._seq + 1}"
            call = self._create(
                call_id, agent_id, tool_name, data.tool_input, ts, "waiting_permission", result
            )
            if unresolved and data.caller_native_agent_id:
                self._pending_caller[call.id] = data.caller_native_agent_id
            result.outcome = "created"
        else:
            if call.status in ("running", "denied"):
                self._set_status(call, "waiting_permission", result)
            result.outcome = "updated"
        if call.permission_requested_at is None:
            call.permission_requested_at = ts
        self._bump(call, result)
        result.agent_id = call.agent_id
        if call.agent_id == "main":
            self._set_main_state("waiting", ts, result)

    def _on_post(self, event: ToolEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        tool_name = data.tool_name or ""
        agent_id, unresolved = self._owner_for(data.agent_id, data.caller_native_agent_id)
        call: ToolCall | None = None
        if data.tool_use_id:
            call = self._calls.get(data.tool_use_id)
        else:
            queue = self._open_synthetic.get((agent_id, tool_name))
            while queue and call is None:
                call = self._calls.get(queue.popleft())
        if call is None:
            call_id = data.tool_use_id or f"evt-{self._seq + 1}"
            call = self._create(
                call_id, agent_id, tool_name, data.tool_input, ts, "running", result
            )
            if unresolved and data.caller_native_agent_id:
                self._pending_caller[call.id] = data.caller_native_agent_id
            created = True
        else:
            created = False
        # A real post overrides an inferred denial; any other ended call means
        # this post is a second copy (hook + poller) of one already seen.
        inferred = call.id in self._closed_by_inference
        self._closed_by_inference.discard(call.id)
        duplicate = (
            not created
            and not inferred
            and (call.status in ("ok", "error", "interrupted") or call.status == "spawned")
        )
        if not created:
            self._merge_identity(
                call,
                agent_id,
                data.caller_native_agent_id if unresolved else None,
                tool_name or None,
                data.tool_input,
                ts,
                result,
            )

        # Output: the hook preview wins; the poller copy carries none.
        if data.tool_output is not None and call.output_preview is None:
            call.output_preview = data.tool_output[:OUTPUT_PREVIEW_MAX_CHARS]
            call.output_bytes = (
                data.tool_output_bytes
                if data.tool_output_bytes is not None
                else len(data.tool_output.encode("utf-8"))
            )
            call.output_truncated = bool(data.tool_output_truncated) or (
                len(data.tool_output) > OUTPUT_PREVIEW_MAX_CHARS
            )

        is_spawn = call.tool_name in _SPAWN_TOOLS
        if is_spawn and data.native_agent_id:
            child_id = call.spawned_agent_id or f"subagent_{call.id}"
            call.spawned_agent_id = child_id
            self._learn_link(child_id, data.native_agent_id, ts, result)

        # Status: any source saying success=false makes it an error.
        if data.interrupted:
            status: ToolCallStatus = "interrupted"
        elif data.success is False:
            status = "error"
        elif is_spawn and data.native_agent_id:
            child = self.tree.get(call.spawned_agent_id or "")
            # Async child still running -> spawned; already stopped -> done.
            status = "ok" if child is not None and child.ended_at is not None else "spawned"
        else:
            status = "ok"
        if status == "error" and call.error is None:
            call.error = _clip(data.error_message, ERROR_MAX_CHARS) if data.error_message else None
            call.error = call.error or _error_from_output(data.tool_output) or "Tool call failed"

        if not duplicate:
            if call.permission_requested_at and (
                call.permission_wait_ms is None or call.status == "denied"
            ):
                call.permission_wait_ms = _ms_between(call.permission_requested_at, ts)
            if status != "spawned":
                call.ended_at = ts
                call.duration_ms = _ms_between(call.started_at, ts)
            self._set_status(call, status, result)
        elif status in ("error", "interrupted") and call.status in ("ok", "spawned"):
            # A second copy carrying worse news still wins (error over ok).
            if call.ended_at is None:
                call.ended_at = ts
                call.duration_ms = _ms_between(call.started_at, ts)
            self._set_status(call, status, result)
        self._bump(call, result)

        result.outcome = "created" if created else ("merged_duplicate" if duplicate else "updated")
        result.agent_id = call.agent_id
        if call.agent_id == "main" and not duplicate:
            self._set_main_state("working", ts, result)

    # -- internals: agents --------------------------------------------------

    def _set_main_state(self, state: str, ts: str, result: ApplyResult) -> AgentNode:
        main = self.tree.ensure_main(ts, result)
        if main.state != state and main.state != "ended":
            main.state = state
            self.tree.bump(main, result)
        return main

    def _on_subagent_start(self, event: AgentEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        agent_id = data.agent_id
        if not agent_id:
            return
        spawn_id = data.tool_use_id or _spawn_id_of(agent_id)
        owner, unresolved = self._owner_for(None, data.caller_native_agent_id)
        self.tree.ensure_main(ts, result)

        if spawn_id:
            spawn_input: dict[str, Any] = {}
            if data.agent_name:
                spawn_input["description"] = data.agent_name
            if data.agent_type:
                spawn_input["subagent_type"] = data.agent_type
            if data.task_description:
                spawn_input["prompt"] = data.task_description
            call = self._calls.get(spawn_id)
            if call is None:
                call = self._create(
                    spawn_id, owner, "Agent", spawn_input or None, ts, "running", result
                )
                if unresolved and data.caller_native_agent_id:
                    self._pending_caller[call.id] = data.caller_native_agent_id
            call.spawned_agent_id = agent_id
            self._bump(call, result)
            owner = call.agent_id

        node = self.tree.get(agent_id)
        name = data.agent_name or data.agent_type or agent_id
        task = data.task_description or data.agent_name
        if node is None:
            node = AgentNode(
                id=agent_id,
                native_id=data.native_agent_id,
                parent_id=owner,
                kind="teammate" if data.teammate_name else "subagent",
                name=_clip(name, 200),
                agent_type=data.agent_type,
                task_preview=_clip(task, TASK_PREVIEW_MAX_CHARS) if task else None,
                state="running",
                started_at=ts,
                spawn_tool_use_id=spawn_id,
                rev=1,
            )
            self.tree.add_node(node, result)
        else:
            # Created bare by an earlier tool event: fill in what start knows.
            node.name = _clip(name, 200)
            node.agent_type = node.agent_type or data.agent_type
            if task and not node.task_preview:
                node.task_preview = _clip(task, TASK_PREVIEW_MAX_CHARS)
            node.spawn_tool_use_id = node.spawn_tool_use_id or spawn_id
            node.parent_id = owner
            if node.started_at is None or ts < node.started_at:
                node.started_at = ts
            self.tree.bump(node, result)
        if data.native_agent_id:
            self._learn_link(agent_id, data.native_agent_id, ts, result)
        result.outcome = "created"
        result.agent_id = agent_id

    def _resolve_stop_target(self, event: AgentEvent) -> AgentNode | None:
        data = event.data
        if data.agent_id:
            node = self.tree.get(data.agent_id)
            if node is not None:
                return node
        resolved = self.tree.resolve_native(data.native_agent_id)
        return self.tree.get(resolved) if resolved else None

    def _on_subagent_stop(self, event: AgentEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        node = self._resolve_stop_target(event)
        if node is None:
            return
        if data.agent_id and data.native_agent_id:
            self._learn_link(node.id, data.native_agent_id, ts, result)
        zombie = data.source == "zombie"
        node.state = "zombie" if zombie else ("error" if data.success is False else "done")
        node.ended_at = ts
        node.current_activity = None
        preview = data.tool_output or data.result_summary
        if preview:
            node.result_preview = _clip(preview, RESULT_PREVIEW_MAX_CHARS)
        self.tree.bump(node, result)
        # Its own calls cannot outlive it.
        self._infer_denied(node.id, ts, result)
        self._close_orphans(node.id, ts, result)

        call = self._calls.get(node.spawn_tool_use_id) if node.spawn_tool_use_id else None
        if call is not None:
            if data.tool_output is not None and call.output_preview is None:
                call.output_preview = data.tool_output[:OUTPUT_PREVIEW_MAX_CHARS]
                call.output_bytes = data.tool_output_bytes
                call.output_truncated = bool(data.tool_output_truncated) or (
                    len(data.tool_output) > OUTPUT_PREVIEW_MAX_CHARS
                )
            if call.status in ("running", "spawned", "waiting_permission") or (
                call.status == "interrupted" and not zombie
            ):
                if zombie:
                    status: ToolCallStatus = "interrupted"
                elif data.success is False:
                    status = "error"
                    call.error = call.error or "Subagent failed"
                else:
                    status = "ok"
                self._set_status(call, status, result)
                call.ended_at = ts
                call.duration_ms = _ms_between(call.started_at, ts)
            self._bump(call, result)
        result.outcome = "updated"
        result.agent_id = node.id

    def _on_subagent_info(self, event: AgentEvent, ts: str, result: ApplyResult) -> None:
        """Native SubagentStart: a known (linked) agent that was stopped resumed."""
        data = event.data
        resolved = self.tree.resolve_native(data.native_agent_id)
        node = self.tree.get(resolved) if resolved else None
        if node is None:
            return
        changed = False
        if node.ended_at is not None and node.state != "zombie":
            node.state = "running"
            node.ended_at = None
            changed = True
        if data.agent_type and not node.agent_type:
            node.agent_type = data.agent_type
            changed = True
        if changed:
            self.tree.bump(node, result)
            result.outcome = "updated"

    def _on_background(self, event: BackgroundTaskEvent, ts: str, result: ApplyResult) -> None:
        data = event.data
        task_id = data.background_task_id or "unknown"
        node_id = f"bg_{task_id}"
        summary = data.background_task_summary
        status = data.background_task_status or "completed"
        node = self.tree.get(node_id)
        if node is None:
            self.tree.ensure_main(ts, result)
            node = AgentNode(
                id=node_id,
                parent_id="main",
                kind="background",
                name=_clip(summary or f"Background task {task_id[:8]}", 200),
                state=status,
                started_at=ts,
                ended_at=ts,
                result_preview=_clip(summary, RESULT_PREVIEW_MAX_CHARS) if summary else None,
                errors=1 if status == "failed" else 0,
                rev=1,
            )
            self.tree.add_node(node, result)
        else:
            node.state = status
            node.ended_at = ts
            if summary:
                node.result_preview = _clip(summary, RESULT_PREVIEW_MAX_CHARS)
            self.tree.bump(node, result)
        result.outcome = "updated"

    # -- colours (filled from the office's Agent records) ------------------

    def sync_colors(self, colors: dict[str, str], result: ApplyResult) -> None:
        """Give nodes the colour the office assigned (first assignment sticks)."""
        for agent_id, color in colors.items():
            node = self.tree.get(agent_id)
            if node is not None and node.color is None and color:
                node.color = color
                self.tree.bump(node, result)
