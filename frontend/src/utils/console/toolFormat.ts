/**
 * Per-tool formatting for timeline rows (spec section 2.5 table): the filter
 * kind, the collapsed target, the `+a -b` style stat and which expanded-body
 * renderer applies. Pure; operates on the input preview only.
 */

import { lineDiff } from "./lineDiff";
import type { ToolCall } from "./types";

/** Tool-kind filter buckets. */
export type ToolKind =
  "read" | "edit" | "bash" | "search" | "web" | "agent" | "mcp" | "other";

export const TOOL_KINDS: readonly ToolKind[] = [
  "read",
  "edit",
  "bash",
  "search",
  "web",
  "agent",
  "mcp",
  "other",
];

/** Expanded-body renderer chosen per tool. */
export type ToolRenderer =
  | "diff"
  | "write"
  | "read"
  | "bash"
  | "search"
  | "web"
  | "task"
  | "todo"
  | "mcp"
  | "json";

const KIND_BY_TOOL: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "agent",
  Agent: "agent",
};

const RENDERER_BY_TOOL: Record<string, ToolRenderer> = {
  Edit: "diff",
  MultiEdit: "diff",
  Write: "write",
  Read: "read",
  Bash: "bash",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "task",
  Agent: "task",
  TodoWrite: "todo",
};

/** Split `mcp__srv__tool` into server and tool, or null if it is not MCP. */
export function parseMcpName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const i = rest.indexOf("__");
  if (i < 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Filter bucket for a tool name. */
export function toolKindOf(toolName: string): ToolKind {
  if (parseMcpName(toolName)) return "mcp";
  return KIND_BY_TOOL[toolName] ?? "other";
}

/** Which expanded-body renderer to use. */
export function rendererFor(toolName: string): ToolRenderer {
  if (parseMcpName(toolName)) return "mcp";
  return RENDERER_BY_TOOL[toolName] ?? "json";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i);
}

function todoList(input: Record<string, unknown> | null | undefined) {
  const t = input?.todos;
  return Array.isArray(t) ? (t as Array<Record<string, unknown>>) : [];
}

/** Collapsed-row display for one call. */
export interface ToolSummary {
  kind: ToolKind;
  renderer: ToolRenderer;
  /** Display name: `srv › tool` for MCP, else the tool name. */
  label: string;
  /** Main target text (path, command first line, pattern, url, ...). */
  target: string;
  /** Right-aligned stat: `+12 −3`, `42 lines`, `3 todos (1 done)`, ... */
  stat: string | null;
  /** Secondary suffix, e.g. Read `:10-60`. */
  suffix: string | null;
}

/** Added/removed line counts for an Edit or MultiEdit input, or null. */
export function editStats(
  input: Record<string, unknown> | null | undefined,
): { added: number; removed: number } | null {
  if (!input) return null;
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(input.edits)) {
    for (const e of input.edits as Array<Record<string, unknown>>) {
      pairs.push([str(e?.old_string) ?? "", str(e?.new_string) ?? ""]);
    }
  } else if ("old_string" in input || "new_string" in input) {
    pairs.push([str(input.old_string) ?? "", str(input.new_string) ?? ""]);
  } else {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const [o, n] of pairs) {
    const d = lineDiff(o, n, { maxLines: 0 });
    added += d.added;
    removed += d.removed;
  }
  return { added, removed };
}

/** Summarise a call for its collapsed row. */
export function summarizeCall(
  call: Pick<ToolCall, "toolName" | "target" | "inputPreview">,
): ToolSummary {
  const name = call.toolName;
  const input = call.inputPreview ?? null;
  const kind = toolKindOf(name);
  const renderer = rendererFor(name);
  const mcp = parseMcpName(name);
  let label = name;
  let target = call.target ?? "";
  let stat: string | null = null;
  let suffix: string | null = null;

  if (mcp) {
    label = mcp.tool ? `${mcp.server} › ${mcp.tool}` : mcp.server;
    target = target || firstStringField(input) || "";
  } else {
    switch (name) {
      case "Edit":
      case "MultiEdit": {
        target = target || str(input?.file_path) || "";
        const s = editStats(input);
        if (s) stat = `+${s.added} −${s.removed}`;
        break;
      }
      case "Write": {
        target = target || str(input?.file_path) || "";
        const content = str(input?.content);
        if (content !== null) {
          const n = content.split("\n").length;
          stat = `${n} ${n === 1 ? "line" : "lines"}`;
        }
        break;
      }
      case "Read": {
        target = target || str(input?.file_path) || "";
        const off = num(input?.offset);
        const lim = num(input?.limit);
        if (off !== null || lim !== null) {
          const start = off ?? 0;
          suffix = lim !== null ? `:${start}-${start + lim}` : `:${start}`;
        }
        break;
      }
      case "Bash": {
        const cmd = str(input?.command);
        target = firstLine(cmd ?? target);
        break;
      }
      case "Grep":
      case "Glob": {
        const pattern = str(input?.pattern) ?? target;
        const path = str(input?.path);
        target = path ? `${pattern} ${path}` : pattern;
        break;
      }
      case "WebFetch":
        target = target || str(input?.url) || "";
        break;
      case "WebSearch":
        target = target || str(input?.query) || "";
        break;
      case "Task":
      case "Agent": {
        target = str(input?.description) ?? target;
        const type = str(input?.subagent_type);
        if (type) suffix = type;
        break;
      }
      case "TodoWrite": {
        const todos = todoList(input);
        const done = todos.filter((t) => t?.status === "completed").length;
        target = `${todos.length} ${todos.length === 1 ? "todo" : "todos"} (${done} done)`;
        break;
      }
      default:
        target = target || firstStringField(input) || "";
    }
  }
  return { kind, renderer, label, target, stat, suffix };
}

function firstStringField(
  input: Record<string, unknown> | null | undefined,
): string | null {
  if (!input) return null;
  for (const v of Object.values(input)) {
    const s = str(v);
    if (s) return firstLine(s);
  }
  return null;
}

/** `850ms`, `4.1s`, `3m12s`, `1h05m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
