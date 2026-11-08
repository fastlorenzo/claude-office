/**
 * Project map: a transit-style schematic of the whole building, shared by the
 * control-room video wall (canvas + moving 3D dots) and the DOM Ops dashboard
 * (SVG). Pure layout, no React / Babylon.
 *
 *   ◉ continuum ──●────●────●──╮
 *   ◉ claude-office ──●───●────╲───── ◎ OPS
 *   ◉ infra ──●─────────────────╯
 *
 *  - one LINE per project (CampusState.projects when present, else sessions
 *    grouped by `project`), with a terminal STATION carrying its name
 *  - one NODE per session on its line, coloured by status
 *  - every line runs into the OPS hub with a 45° bend (metro diagram style)
 *  - subagents are DOTS shuttling along the line next to their session
 */

import {
  type CampusProject,
  type CampusSession,
  type CheckState,
  type RoomStatus,
} from "../contracts";
import { worseState } from "./factoryModel";
import { roomStatus } from "./status";
import { sessionPhase } from "./sessionInfo";

export interface P {
  x: number;
  y: number;
}

export interface MapGroup {
  id: string;
  name: string;
  sessionIds: string[];
  /** Rolled-up CI state of the project's PRs / pipelines (null = unknown). */
  ci: CheckState | null;
  openPrs: number;
  /** Repo ("owner/name") when known. */
  repo: string | null;
}

export interface MapSession {
  sessionId: string;
  status: RoomStatus;
  label: string;
  subagents: number;
}

export interface MapLine {
  id: string;
  name: string;
  color: string;
  points: P[];
  status: RoomStatus;
  ci: CheckState | null;
  openPrs: number;
  live: number;
}

export interface MapNode {
  sessionId: string;
  lineId: string;
  x: number;
  y: number;
  status: RoomStatus;
  label: string;
}

export interface MapDot {
  id: string;
  lineId: string;
  sessionId: string;
  path: P[];
  phase: number;
  /** Round trips per second. */
  speed: number;
  color: string;
}

export interface ProjectMapLayout {
  w: number;
  h: number;
  hub: P & { r: number };
  lines: MapLine[];
  nodes: MapNode[];
  dots: MapDot[];
  /** Projects not drawn (over the line cap). */
  moreLines: number;
  /** Sessions not drawn (over the per-line node cap). */
  moreNodes: number;
}

export const LINE_COLORS = [
  "#8B5CF6",
  "#06B6D4",
  "#EC4899",
  "#F97316",
  "#84CC16",
  "#14B8A6",
  "#EAB308",
  "#6366F1",
] as const;

const RANK: Record<RoomStatus, number> = {
  needs_you: 0,
  working: 1,
  done: 2,
  ended: 3,
};

const INACTIVE_AGENT = new Set(["completed", "leaving"]);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function lineColor(id: string): string {
  return LINE_COLORS[hash(id) % LINE_COLORS.length];
}

function nameOf(cs: CampusSession, labels?: ReadonlyMap<string, string>) {
  return (
    cs.project?.trim() || labels?.get(cs.sessionId) || cs.sessionId.slice(0, 8)
  );
}

function rollupCi(p: CampusProject): { ci: CheckState | null; prs: number } {
  const states: CheckState[] = [];
  let prs = 0;
  for (const pr of p.pullRequests ?? []) {
    if (pr.state !== "open") continue;
    prs += 1;
    if (pr.checks?.state) states.push(pr.checks.state);
  }
  // Trunk health: the backend's rolled-up default-branch state, else the
  // newest run (same source the factory line uses).
  const trunk = p.mainHealth ?? (p.pipelines ?? [])[0]?.state;
  if (trunk) states.push(trunk);
  const real = states.filter((s) => s !== "none");
  if (!real.length) return { ci: null, prs };
  return { ci: real.reduce<CheckState>(worseState, "none"), prs };
}

/**
 * Sessions grouped by project. Uses CampusState.projects when the backend
 * sends it (sessions it does not list fall back to their `project` name),
 * else groups by `project` / room label. Groups with live work come first.
 */
export function projectGroups(
  campus: readonly CampusSession[],
  projects?: readonly CampusProject[] | null,
  labels?: ReadonlyMap<string, string>,
): MapGroup[] {
  const groups = new Map<string, MapGroup>();
  const known = new Set(campus.map((c) => c.sessionId));
  const placed = new Set<string>();
  for (const p of projects ?? []) {
    const ids = p.sessionIds.filter((id) => known.has(id) && !placed.has(id));
    ids.forEach((id) => placed.add(id));
    const { ci, prs } = rollupCi(p);
    groups.set(`p:${p.id}`, {
      id: p.id,
      name: p.name || p.id,
      sessionIds: ids,
      ci: p.ciAvailable === false ? null : ci,
      openPrs: prs,
      repo: p.repo ?? null,
    });
  }
  for (const cs of campus) {
    if (placed.has(cs.sessionId)) continue;
    const pid = cs.projectId?.trim();
    const byId = pid ? groups.get(`p:${pid}`) : undefined;
    if (byId) {
      byId.sessionIds.push(cs.sessionId);
      continue;
    }
    const name = nameOf(cs, labels);
    const key = `n:${name.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { id: name, name, sessionIds: [], ci: null, openPrs: 0, repo: null };
      groups.set(key, g);
    }
    g.sessionIds.push(cs.sessionId);
  }
  const byId = new Map(campus.map((c) => [c.sessionId, c]));
  const best = (g: MapGroup) =>
    Math.min(
      4,
      ...g.sessionIds.map((id) => {
        const cs = byId.get(id);
        return cs ? RANK[roomStatus(cs)] : 4;
      }),
    );
  return [...groups.values()].sort(
    (a, b) => best(a) - best(b) || a.name.localeCompare(b.name),
  );
}

/** Per-session facts the map needs. */
export function mapSessions(
  campus: readonly CampusSession[],
): Map<string, MapSession> {
  const out = new Map<string, MapSession>();
  for (const cs of campus) {
    const status = roomStatus(cs);
    out.set(cs.sessionId, {
      sessionId: cs.sessionId,
      status,
      label: sessionPhase(cs).label,
      subagents:
        status === "ended"
          ? 0
          : (cs.agents ?? []).filter((a) => !INACTIVE_AGENT.has(a.state))
              .length,
    });
  }
  return out;
}

export interface MapOptions {
  maxLines?: number;
  maxNodes?: number;
  maxDotsPerNode?: number;
}

/**
 * Lays the map out in a w × h box (any units: canvas px, SVG viewBox).
 * Deterministic for the same input.
 */
export function layoutProjectMap(
  groups: readonly MapGroup[],
  sessions: ReadonlyMap<string, MapSession>,
  w: number,
  h: number,
  opts: MapOptions = {},
): ProjectMapLayout {
  const maxLines = opts.maxLines ?? 7;
  const maxNodes = opts.maxNodes ?? 6;
  const maxDots = opts.maxDotsPerNode ?? 4;
  const shown = groups.slice(0, maxLines);
  const K = shown.length;
  const hubR = Math.min(h * 0.075, w * 0.05);
  const hub = { x: w - w * 0.03 - hubR * 1.6, y: h * 0.56, r: hubR };
  const top = h * 0.2;
  const bottom = h * 0.07;
  const span = h - top - bottom;
  const xs = w * 0.05 + hubR * 0.4;
  const lane = Math.min(h * 0.03, (hubR * 1.4) / Math.max(1, K));
  const lines: MapLine[] = [];
  const nodes: MapNode[] = [];
  const dots: MapDot[] = [];
  let moreNodes = 0;
  const ys = shown.map((_, k) => top + ((k + 0.5) * span) / Math.max(1, K));
  const ty = shown.map((_, k) => hub.y + (k - (K - 1) / 2) * lane);
  const maxDy = Math.max(0, ...ys.map((y, k) => Math.abs(y - ty[k])));
  const xb = Math.max(xs + w * 0.3, hub.x - hubR - w * 0.035 - maxDy);
  shown.forEach((g, k) => {
    const y = ys[k];
    const dy = ty[k] - y;
    const color = lineColor(g.id);
    const bendEnd = { x: xb + Math.abs(dy), y: ty[k] };
    const points: P[] = [
      { x: xs, y },
      { x: xb, y },
      bendEnd,
      { x: hub.x - hubR * 0.98, y: ty[k] },
    ];
    // Status: best (most urgent) of the line's sessions.
    let status: RoomStatus = "ended";
    let live = 0;
    for (const id of g.sessionIds) {
      const s = sessions.get(id);
      if (!s) continue;
      if (RANK[s.status] < RANK[status]) status = s.status;
      if (s.status !== "ended") live += 1;
    }
    lines.push({
      id: g.id,
      name: g.name,
      color,
      points,
      status,
      ci: g.ci,
      openPrs: g.openPrs,
      live,
    });
    const ids = [...g.sessionIds]
      .filter((id) => sessions.has(id))
      .sort((a, b) => {
        const sa = sessions.get(a)!;
        const sb = sessions.get(b)!;
        return RANK[sa.status] - RANK[sb.status] || a.localeCompare(b);
      });
    const drawn = ids.slice(0, maxNodes);
    moreNodes += ids.length - drawn.length;
    const n0 = xs + w * 0.12;
    const n1 = xb - w * 0.02;
    const step = drawn.length > 1 ? (n1 - n0) / (drawn.length - 1) : 0;
    const nodeX = drawn.map((_, i) =>
      drawn.length === 1 ? (n0 + n1) / 2 : n0 + i * step,
    );
    drawn.forEach((id, i) => {
      const s = sessions.get(id)!;
      const x = nodeX[i];
      nodes.push({
        sessionId: id,
        lineId: g.id,
        x,
        y,
        status: s.status,
        label: s.label,
      });
      const count = Math.min(maxDots, s.subagents);
      if (count <= 0) return;
      // Shuttle towards the next station (or along the bend into the hub).
      const path: P[] =
        i + 1 < drawn.length
          ? [
              { x, y },
              { x: nodeX[i + 1], y },
            ]
          : [{ x, y }, { x: xb, y }, bendEnd, { x: hub.x - hubR, y: ty[k] }];
      for (let d = 0; d < count; d++)
        dots.push({
          id: `${id}:${d}`,
          lineId: g.id,
          sessionId: id,
          path,
          phase: d / count + (hash(id) % 97) / 970,
          speed: 0.09 + (hash(`${id}${d}`) % 5) * 0.012,
          color,
        });
    });
  });
  return {
    w,
    h,
    hub,
    lines,
    nodes,
    dots,
    moreLines: Math.max(0, groups.length - shown.length),
    moreNodes,
  };
}

/** Polyline length. */
function pathLength(path: readonly P[]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++)
    L += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return L;
}

/** Point at fraction f ∈ [0,1] of a polyline's length. */
export function pointAt(path: readonly P[], f: number): P {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return { ...path[0] };
  let left = Math.max(0, Math.min(1, f)) * pathLength(path);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg || i === path.length - 1) {
      const t = seg > 0 ? Math.min(1, left / seg) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return { ...path[path.length - 1] };
}

/** Dot position at time t (seconds): eased ping-pong along its path. */
export function dotPosition(dot: MapDot, tSec: number): P {
  const s = (((tSec * dot.speed + dot.phase) % 1) + 1) % 1;
  const u = s < 0.5 ? s * 2 : 2 - s * 2;
  const e = u * u * (3 - 2 * u);
  return pointAt(dot.path, 0.06 + e * 0.88);
}

/** Stable key of what the static map shows (redraw only on change). */
export function mapKey(m: ProjectMapLayout): string {
  return JSON.stringify([
    m.lines.map((l) => [l.id, l.name, l.status, l.ci, l.openPrs, l.live]),
    m.nodes.map((n) => [n.sessionId, n.status, n.label, Math.round(n.x)]),
    m.moreLines,
    m.moreNodes,
  ]);
}
