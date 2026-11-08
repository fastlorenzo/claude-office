/**
 * Console wire types (session-console spec section 3.3), re-exported from the
 * generated backend contract (`@/types/generated`, camelCase as the API and
 * WebSocket emit). Only the two WebSocket frame shapes (section 3.5) are
 * declared here. Keep every console import going through this file.
 */

import type {
  AgentNode,
  ConsoleHeader,
  ConsoleSnapshot,
  ConversationEntry,
  GitStatus,
  SessionPhase,
  SessionTelemetry,
  TodoItem,
  ToolCall,
  ToolCallDetail,
} from "@/types/generated";

export type {
  AgentNode,
  ConsoleHeader,
  ConsoleSnapshot,
  ConversationEntry,
  GitStatus,
  SessionPhase,
  SessionTelemetry,
  TodoItem,
  ToolCall,
  ToolCallDetail,
};

/** Lifecycle of one tool call. */
export type ToolCallStatus = ToolCall["status"];

/** Where an agent node comes from. */
export type AgentKind = AgentNode["kind"];

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
