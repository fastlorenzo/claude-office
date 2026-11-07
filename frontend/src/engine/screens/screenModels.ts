/**
 * Pure screen content models: parse the 13 terminal lines produced by
 * logic/monitorText.buildMonitorLines into structured fields (with a generic
 * fallback), and bucket todos into whiteboard kanban columns.
 */

import type { RoomStatus } from "../contracts";
import type { TodoItem } from "@/types";

export interface ActivityLine {
  time: string;
  text: string;
}

export interface MonitorModel {
  /** False when the lines did not match the expected format. */
  structured: boolean;
  label: string;
  state: string; // upper-case boss state, e.g. "WORKING"
  status: RoomStatus;
  task: string[]; // up to 2 lines ("" when idle)
  activity: ActivityLine[]; // oldest → newest, non-empty only
  todoDone: number;
  todoTotal: number;
  ctxPct: number; // 0..100
  raw: string[];
}

const HEADER = /^claude@(.+?)\s+—\s+(\S+)\s*$/;
const ACT = /^(\d\d:\d\d|--:--)\s+(.*)$/;
const TODO = /^todo\s+\[[^\]]*\]\s+(\d+)\/(\d+)\s*$/;
const CTX = /^ctx\s+\[[^\]]*\]\s+(\d+)%\s*$/;

export function statusForBossState(state: string): RoomStatus {
  const s = state.toLowerCase();
  if (s === "waiting_permission") return "needs_you";
  if (s === "idle" || s === "completing") return "done";
  return "working";
}

export function parseMonitorLines(lines: string[]): MonitorModel {
  const raw = lines.slice();
  const m: MonitorModel = {
    structured: false,
    label: "",
    state: "",
    status: "working",
    task: [],
    activity: [],
    todoDone: 0,
    todoTotal: 0,
    ctxPct: 0,
    raw,
  };
  const head = HEADER.exec(lines[0] ?? "");
  const todo = TODO.exec(lines[11] ?? "");
  const ctx = CTX.exec(lines[12] ?? "");
  if (!head || !todo || !ctx || lines.length < 13) return m;
  m.structured = true;
  m.label = head[1];
  m.state = head[2];
  m.status = statusForBossState(head[2]);
  m.task = [lines[1] ?? "", lines[2] ?? ""].filter(
    (l) => l && l !== "— idle —",
  );
  for (const l of lines.slice(3, 11)) {
    if (!l) continue;
    const a = ACT.exec(l);
    m.activity.push(a ? { time: a[1], text: a[2] } : { time: "", text: l });
  }
  m.todoDone = Number(todo[1]);
  m.todoTotal = Number(todo[2]);
  m.ctxPct = Math.max(0, Math.min(100, Number(ctx[1])));
  return m;
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

export type KanbanColumnId = "pending" | "in_progress" | "completed";

export interface KanbanColumn {
  id: KanbanColumnId;
  title: string;
  items: { text: string; index: number }[];
  overflow: number;
  total: number;
}

export const KANBAN_ORDER: KanbanColumnId[] = [
  "pending",
  "in_progress",
  "completed",
];
const TITLES: Record<KanbanColumnId, string> = {
  pending: "To do",
  in_progress: "In progress",
  completed: "Done",
};

/**
 * Bucket todos into 3 columns, keeping list order. In-progress items show
 * their active form when present. Done shows the most recent items first.
 */
export function bucketTodos(
  todos: TodoItem[],
  maxPerColumn: number,
): KanbanColumn[] {
  const cols = new Map<KanbanColumnId, { text: string; index: number }[]>(
    KANBAN_ORDER.map((id) => [id, []]),
  );
  todos.forEach((t, index) => {
    const id: KanbanColumnId =
      t.status === "in_progress" || t.status === "completed"
        ? t.status
        : "pending";
    const text =
      (id === "in_progress" && t.active_form ? t.active_form : t.content) ||
      "(untitled)";
    cols.get(id)?.push({ text, index });
  });
  return KANBAN_ORDER.map((id) => {
    let items = cols.get(id) ?? [];
    if (id === "completed") items = [...items].reverse();
    const cap = Math.max(0, maxPerColumn);
    const shown =
      items.length > cap ? items.slice(0, Math.max(0, cap - 1)) : items;
    return {
      id,
      title: TITLES[id],
      items: shown,
      overflow: items.length - shown.length,
      total: items.length,
    };
  });
}

/** Stable small rotation (radians) for a sticky note. */
export function noteTilt(index: number): number {
  const h = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return (h - Math.floor(h) - 0.5) * 0.07;
}
