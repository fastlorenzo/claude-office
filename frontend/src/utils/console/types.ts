/**
 * Interim console wire types (session-console spec section 3.3).
 *
 * These mirror the backend `models/console.py` contract exactly, in the
 * camelCase form the API and WebSocket emit. They are local on purpose: WS2
 * owns the backend models and `generated.ts` does not contain them yet. Phase 2
 * replaces this file's declarations with re-exports from `@/types/generated`;
 * nothing else should need to change, so keep every console import going
 * through `@/utils/console/types`.
 */

import type {
  ConversationEntry,
  GitStatus,
  SessionPhase,
  SessionTelemetry,
  TodoItem,
} from "@/types/generated";

export type { ConversationEntry, GitStatus, SessionPhase, SessionTelemetry };
export type { TodoItem };

/** Lifecycle of one tool call. */
export type ToolCallStatus =
  | "running"
  | "waiting_permission"
  | "ok"
  | "error"
  | "denied"
  | "interrupted"
  | "spawned";

/** Where an agent node comes from. */
export type AgentKind = "main" | "subagent" | "teammate" | "background";

/** One tool call, streamed with previews only (full payload: ToolCallDetail). */
export interface ToolCall {
  /** tool_use_id, or "evt-<seq>" when the hook had none. */
  id: string;
  /** Per-session monotonic number: ordering and paging cursor. */
  seq: number;
  /** Bumps on every update; the client drops frames at or below the stored rev. */
  rev: number;
  /** "main" | "subagent_<toolu>" | ... */
  agentId: string;
  toolName: string;
  /** PhaseKind from the backend classify_tool(), if any. */
  kind?: string | null;
  /** Short label: path, command, pattern or url (at most 200 chars). */
  target?: string | null;
  /** Raw tool input, each string value at most 2 KB, total at most 8 KB. */
  inputPreview?: Record<string, unknown> | null;
  inputTruncated?: boolean;
  /** At most 2 KB. */
  outputPreview?: string | null;
  outputBytes?: number | null;
  outputTruncated?: boolean;
  /** error_message or the first stderr/assertion line. */
  error?: string | null;
  status: ToolCallStatus;
  /** ISO timestamp. */
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  permissionRequestedAt?: string | null;
  permissionWaitMs?: number | null;
  /** Task/Agent calls: the agent node this call spawned. */
  spawnedAgentId?: string | null;
}

/** One node of the agent tree. */
export interface AgentNode {
  id: string;
  nativeId?: string | null;
  /** null only for main. */
  parentId?: string | null;
  kind: AgentKind;
  name: string;
  agentType?: string | null;
  color?: string | null;
  /** At most 1 KB. */
  taskPreview?: string | null;
  state: string;
  startedAt?: string | null;
  endedAt?: string | null;
  spawnToolUseId?: string | null;
  resultPreview?: string | null;
  toolCalls: number;
  errors: number;
  currentActivity?: string | null;
  rev: number;
}

/** Session header assembled by the backend. */
export interface ConsoleHeader {
  sessionId: string;
  project?: string | null;
  branch?: string | null;
  phase?: SessionPhase | null;
  alive?: boolean | null;
  ended: boolean;
  startedAt?: string | null;
  lastEventAt?: string | null;
  telemetry?: SessionTelemetry | null;
}

/** Response of GET /api/v1/sessions/{id}/console. */
export interface ConsoleSnapshot {
  header: ConsoleHeader;
  agents: AgentNode[];
  /** Latest `limit` calls, ascending seq. */
  toolCalls: ToolCall[];
  hasMore: boolean;
  oldestSeq?: number | null;
  conversation: ConversationEntry[];
  todos: TodoItem[];
}

/** Response of GET /api/v1/sessions/{id}/tool-calls/{id}; on demand only. */
export interface ToolCallDetail {
  call: ToolCall;
  input?: Record<string, unknown> | null;
  /** Full output, at most 256 KB. */
  output?: string | null;
  outputSource: "transcript" | "hook" | "none";
  outputTruncated: boolean;
}

/** `/ws/{id}` frame carrying one tool call. */
export interface ToolCallFrame {
  type: "tool_call";
  timestamp?: string;
  sessionId?: string;
  toolCall: ToolCall;
}

/** `/ws/{id}` frame carrying one agent node. */
export interface AgentNodeFrame {
  type: "agent_node";
  timestamp?: string;
  sessionId?: string;
  agent: AgentNode;
}

/** The two additive frames the console consumes (spec section 3.5). */
export type ConsoleFrame = ToolCallFrame | AgentNodeFrame;
