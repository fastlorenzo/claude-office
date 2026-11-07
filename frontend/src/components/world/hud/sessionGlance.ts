/**
 * Pure helpers for the "what is each session doing" glance UI (Overview strip,
 * Sessions/Inspect panels, minimap, door signs). No React, no Babylon.
 *
 * The backend /ws/campus feed may omit objective / focus / workItems / gitBranch
 * (older backend, or not computed yet), so everything falls back to data that
 * has always been on the wire: boss.currentTask and in-progress todos.
 */

import type { CampusSession, RoomStatus } from "@/engine/contracts";
import { roomStatus } from "@/engine/logic/status";
import type { Agent } from "@/types";

export const MAX_WORK_ITEMS = 4;

function clean(s: string | null | undefined): string | null {
  const v = s?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

/** Session objective, or null when the backend has none yet. */
export function sessionObjective(cs: CampusSession): string | null {
  return clean(cs.objective);
}

/** Current focus: backend `focus`, else the boss's current task. */
export function sessionFocus(cs: CampusSession): string | null {
  return clean(cs.focus) ?? clean(cs.boss?.currentTask);
}

/** Work items: backend list, else in-progress todos (activeForm preferred). */
export function sessionWorkItems(cs: CampusSession): string[] {
  const given = (cs.workItems ?? [])
    .map((w) => clean(w))
    .filter((w): w is string => w !== null);
  if (given.length > 0) return given.slice(0, MAX_WORK_ITEMS);
  const out: string[] = [];
  for (const td of cs.todos ?? []) {
    if (td.status !== "in_progress") continue;
    const text = clean(td.active_form) ?? clean(td.content);
    if (text) out.push(text);
    if (out.length >= MAX_WORK_ITEMS) break;
  }
  return out;
}

/**
 * Bold headline: objective, else focus / boss task, so nothing reads
 * "no objective" while the backend field is still missing.
 */
export function sessionHeadline(cs: CampusSession): string | null {
  return sessionObjective(cs) ?? sessionFocus(cs);
}

export function sessionBranch(cs: CampusSession): string | null {
  return clean(cs.gitBranch);
}

export function todoProgress(cs: CampusSession): {
  done: number;
  total: number;
  pct: number;
} {
  const todos = cs.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

const INACTIVE_AGENT = new Set(["completed", "leaving"]);

/** Subagents still around doing something. */
export function activeAgents(cs: CampusSession): Agent[] {
  return (cs.agents ?? []).filter((a) => !INACTIVE_AGENT.has(a.state));
}

const RANK: Record<RoomStatus, number> = {
  needs_you: 0,
  working: 1,
  done: 2,
  ended: 3,
};

/** needs_you, working, done, ended; most recently updated first within a rank. */
export function sortSessions(list: readonly CampusSession[]): CampusSession[] {
  return [...list].sort((a, b) => {
    const r = RANK[roomStatus(a)] - RANK[roomStatus(b)];
    if (r !== 0) return r;
    const t = (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "");
    return t !== 0 ? t : a.sessionId.localeCompare(b.sessionId);
  });
}

export const COLLAPSE_THRESHOLD = 6;

/** Cards collapse to dots when there are more than 6 sessions. */
export function shouldCollapse(count: number): boolean {
  return count > COLLAPSE_THRESHOLD;
}

/** Truncate for SVG text (no measuring available). */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
