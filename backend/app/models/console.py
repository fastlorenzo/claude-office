"""Session Console models (spec: docs/design/session-console.md, section 3.3).

``ToolCall`` and ``AgentNode`` are streamed over ``/ws/{id}`` as ``tool_call`` /
``agent_node`` frames and returned by the console snapshot endpoint. They carry
previews only; full payloads are fetched on demand as ``ToolCallDetail``.
"""

from __future__ import annotations

from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.models.campus import SessionPhase
from app.models.common import TodoItem
from app.models.sessions import ConversationEntry
from app.models.telemetry import SessionTelemetry

__all__ = [
    "AgentKind",
    "AgentNode",
    "ConsoleHeader",
    "ConsoleSnapshot",
    "ToolCall",
    "ToolCallDetail",
    "ToolCallStatus",
]

ToolCallStatus = Literal[
    "running", "waiting_permission", "ok", "error", "denied", "interrupted", "spawned"
]
AgentKind = Literal["main", "subagent", "teammate", "background"]

# Every field is always serialized, so the generated TS marks defaulted fields
# required too (no ``?``): consumers never have to guard against absent keys.
_CFG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    json_schema_serialization_defaults_required=True,
)


class ToolCall(BaseModel):
    """One tool call: pre, post and permission events merged (previews only)."""

    model_config = _CFG

    id: str  # tool_use_id or "evt-<seq>"
    seq: int  # per-session monotonic (ordering + paging cursor)
    rev: int  # bumps on every update (client drops stale frames)
    agent_id: str  # "main" | "subagent_<toolu>" | ...
    tool_name: str
    kind: str | None = None  # PhaseKind via classify_tool()
    target: str | None = None  # short label: path / command / pattern / url (<= 200 chars)
    input_preview: dict[str, Any] | None = None  # each string value <= 2 KB, total <= 8 KB
    input_truncated: bool = False
    output_preview: str | None = None  # <= 2 KB
    output_bytes: int | None = None
    output_truncated: bool = False
    error: str | None = None  # error_message or first stderr/assertion line
    status: ToolCallStatus
    started_at: str
    ended_at: str | None = None
    duration_ms: int | None = None
    permission_requested_at: str | None = None
    permission_wait_ms: int | None = None
    spawned_agent_id: str | None = None  # Task/Agent calls


class AgentNode(BaseModel):
    """One node of the session's agent tree (main is the root)."""

    model_config = _CFG

    id: str
    native_id: str | None = None
    parent_id: str | None = None  # None only for main
    kind: AgentKind
    name: str
    agent_type: str | None = None
    color: str | None = None
    task_preview: str | None = None  # <= 1 KB
    state: str
    started_at: str | None = None
    ended_at: str | None = None
    spawn_tool_use_id: str | None = None
    result_preview: str | None = None
    tool_calls: int = 0
    errors: int = 0
    current_activity: str | None = None
    rev: int


class ConsoleHeader(BaseModel):
    """Console header, assembled from CampusSession + telemetry + the sessions row."""

    model_config = _CFG

    session_id: str
    project: str | None = None
    branch: str | None = None
    phase: SessionPhase | None = None
    alive: bool | None = None
    ended: bool = False
    started_at: str | None = None
    last_event_at: str | None = None
    telemetry: SessionTelemetry | None = None


class ConsoleSnapshot(BaseModel):
    """``GET /api/v1/sessions/{id}/console`` response."""

    model_config = _CFG

    header: ConsoleHeader
    agents: list[AgentNode] = Field(default_factory=lambda: cast(list[AgentNode], []))
    # Latest ``limit`` calls (default 300), ascending seq.
    tool_calls: list[ToolCall] = Field(default_factory=lambda: cast(list[ToolCall], []))
    has_more: bool = False
    oldest_seq: int | None = None
    conversation: list[ConversationEntry] = Field(
        default_factory=lambda: cast(list[ConversationEntry], [])
    )
    todos: list[TodoItem] = Field(default_factory=lambda: cast(list[TodoItem], []))


class ToolCallDetail(BaseModel):
    """``GET /api/v1/sessions/{id}/tool-calls/{tool_use_id}``: on demand, never streamed."""

    model_config = _CFG

    call: ToolCall
    input: dict[str, Any] | None = None  # full, from the persisted event row
    output: str | None = None  # full, <= 256 KB
    output_source: Literal["transcript", "hook", "none"] = "none"
    output_truncated: bool = False
