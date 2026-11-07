import type { CampusSession } from "../contracts";
import { sessionPhase, sessionSummary } from "./sessionInfo";
import type { Agent, TodoItem } from "@/types";

export const MONITOR_COLS = 46;
export const MONITOR_LINES = 13;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + "…";
}

/** Greedy word wrap into at most maxLines lines (last line ellipsised). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    if (w.length > width) w = w.slice(0, width);
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines) {
    if (cur) lines.push(cur);
    return lines;
  }
  // overflowed: ellipsise last kept line
  const last = lines[maxLines - 1];
  lines[maxLines - 1] =
    last.length >= width ? last.slice(0, width - 1) + "…" : last + "…";
  return lines.slice(0, maxLines);
}

function bar(frac: number, cells = 10): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const n = Math.round(f * cells);
  return "█".repeat(n) + "░".repeat(cells - n);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function buildMonitorLines(
  s: CampusSession,
  label: string,
  _nowMs: number,
): string[] {
  void _nowMs;
  const lines: string[] = [];
  lines.push(
    clip(`claude@${label} — ${s.boss.state.toUpperCase()}`, MONITOR_COLS),
  );

  // Header: summary + phase when known, else the boss task (2 lines).
  const summary = sessionSummary(s);
  const phase = s.ended ? null : sessionPhase(s);
  if (summary && phase) {
    const detail = phase.detail ? ` · ${phase.detail}` : "";
    lines.push(clip(summary, MONITOR_COLS));
    lines.push(clip(`▸ ${phase.label}${detail}`, MONITOR_COLS));
  } else {
    const task = s.boss.currentTask
      ? wrap(s.boss.currentTask, MONITOR_COLS, 2)
      : ["— idle —"];
    lines.push(task[0] ?? "", task[1] ?? "");
  }

  const acts = s.recentActivity.slice(-8);
  for (const a of acts) {
    const d = new Date(a.timestamp);
    const hhmm = Number.isNaN(d.getTime())
      ? "--:--"
      : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    lines.push(clip(`${hhmm}  ${a.summary}`, MONITOR_COLS));
  }
  for (let i = acts.length; i < 8; i++) lines.push("");

  const total = s.todos.length;
  const done = s.todos.filter((t) => t.status === "completed").length;
  lines.push(`todo [${bar(total ? done / total : 0)}] ${done}/${total}`);

  const ctx = s.office.contextUtilization ?? 0;
  lines.push(
    `ctx  [${bar(ctx)}] ${Math.round(Math.max(0, Math.min(1, ctx)) * 100)}%`,
  );
  return lines;
}

export function todosKey(todos: TodoItem[]): string {
  return todos.map((t) => `${t.status}:${t.content}`).join("\n");
}

export function agentScreenText(agent: Agent): string[] {
  const name = agent.name ?? `agent ${agent.number}`;
  const out = [clip(name, 24), clip(agent.state, 24)];
  if (agent.currentTask) out.push(...wrap(agent.currentTask, 24, 2));
  return out.slice(0, 4);
}
