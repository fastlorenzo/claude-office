/**
 * Round ops room plan: pure geometry derived from `layout.controlRoom`
 * (origin / size), shared by ControlRoom (meshes), Building (shell height)
 * and the node tests (sight lines). No Babylon.
 *
 *            ╭──────── curved video wall (±70°, two tiers on a plinth) ───────╮
 *          ╱    map     usage     SESSIONS BOARD     activity    projects       ╲
 *         │  feeds ▢▢▢▢       alerts · event log         ▢▢▢▢ feeds             │
 *         │          ╲──── row 1 consoles (floor) ────╱                         │
 *         │              ╲── row 2 consoles (tier) ─╱                           │
 *         │                    ● C (wall centre)                                │
 *         │             ═══ supervisor desk (30 cm platform) ═══                │
 *         │                                                                     │
 *         └──────────────────────────── door ───────────────────────────────────┘
 *
 * Angles are yaws measured from +Z towards +X (same as arcSlabData): a point
 * at angle a and radius r is C + r·(sin a, cos a). Screens face C. Seen from
 * inside (facing +Z) increasing angle runs left → right.
 */

import type { BuildingLayout } from "../contracts";

/** Clear height of the ops room (double height, like the lobby). */
export const CONTROL_CEIL_H = 5.2;

/** Fixed vertical stack of the video wall (metres above the floor). */
export const WALL_Y = {
  plinth: 0.85, // top of the cabinet plinth (vent grilles)
  lower0: 0.85,
  lower1: 1.95, // camera feeds · alerts · event log
  upper0: 1.99,
  upper1: 4.39, // map · usage · sessions board · activity · projects
  trim: 4.5,
} as const;

/** Half of the video wall arc (140° total). */
export const HALF_ARC = (70 * Math.PI) / 180;

/** Console / monitor dimensions (sight lines depend on these). */
export const CONSOLE = {
  deskH: 0.74,
  depth: 0.82,
  monW: 0.62,
  monH: 0.27, // 21:9 ultrawide
  /** Bottom edge of a monitor above the deck (low arms keep the wall clear). */
  monBottom: 0.77,
  /** Seated eye height above the deck. */
  eyeSeated: 1.2,
  /** Standing eye height above the deck (the player). */
  eyeStanding: 1.65,
} as const;

/** Upper-tier panels, left → right, as fractions of the arc. */
export const UPPER_SPANS = [
  ["map", 0.22],
  ["usage", 0.15],
  ["board", 0.26],
  ["activity", 0.15],
  ["projects", 0.22],
] as const;

export type UpperPanel = (typeof UPPER_SPANS)[number][0];

export interface Seat {
  /** Angle of the seat on its arc. */
  a: number;
  /** Monitor count on the arm (centre = session card). */
  monitors: number;
}

export interface ConsoleRow {
  /** Desk centre-line radius (operators sit on the inner side). */
  r: number;
  /** Deck height (tiered rows stand on a riser). */
  deck: number;
  /** Angular extent of each half (a centre aisle splits the row). */
  halves: Array<[number, number]>;
  seats: Seat[];
}

export interface Supervisor {
  /** Desk centre (world). */
  x: number;
  z: number;
  /** Desk arc: centre of curvature + radius + angles (faces +Z). */
  cz: number;
  r: number;
  a0: number;
  a1: number;
  deck: number;
  /** Platform footprint (z range, half width). */
  pz0: number;
  pz1: number;
  phw: number;
  seats: Seat[];
}

export interface ControlPlan {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  H: number;
  /** Wall centre of curvature. */
  cx: number;
  cz: number;
  /** Screen surface radius. */
  R: number;
  /** Room shell radius (behind the screens) = half width of the straight part. */
  roomR: number;
  a0: number;
  a1: number;
  rows: ConsoleRow[];
  supervisor: Supervisor | null;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export function controlPlan(layout: BuildingLayout): ControlPlan {
  const c = layout.controlRoom;
  const x0 = c.origin.x - c.size.x / 2;
  const x1 = c.origin.x + c.size.x / 2;
  const z0 = c.origin.z - c.size.z / 2;
  const z1 = c.origin.z + c.size.z / 2;
  const W = x1 - x0;
  const D = z1 - z0;
  const R = clamp(Math.min(W / 2 - 1.2, 0.5 * (D - 1.0)), 3.5, 8.2);
  const roomR = R + 0.7;
  const cx = c.origin.x;
  const cz = z1 - 0.7 - R;
  const H = Math.max(c.size.y, CONTROL_CEIL_H);

  const rows: ConsoleRow[] = [];
  const aisle = 0.75; // half width of the centre aisle (m)
  const row = (
    r: number,
    deck: number,
    span: number,
    n: number,
    mons: number,
  ) => {
    const g = aisle / r;
    const halves: Array<[number, number]> = [
      [-span, -g],
      [g, span],
    ];
    const seats: Seat[] = [];
    for (const [h0, h1] of halves)
      for (let i = 0; i < n; i++)
        seats.push({ a: h0 + ((h1 - h0) * (i + 0.5)) / n, monitors: mons });
    rows.push({ r, deck, halves, seats });
  };
  const r1 = 0.6 * R;
  if (R >= 6.4) {
    row(r1, 0, (52 * Math.PI) / 180, 2, 3);
    row(r1 - 1.85, 0.25, (60 * Math.PI) / 180, 2, 2);
  } else {
    row(r1, 0, (55 * Math.PI) / 180, Math.max(1, Math.floor(r1 / 2.2)), 3);
  }

  // Supervisor: behind the centre of curvature, if the room is deep enough.
  let supervisor: Supervisor | null = null;
  const sz = cz - (R >= 6.4 ? 2.1 : 1.0);
  if (sz - z0 >= 3.2) {
    const sr = 3.4; // gentle curve, centre of curvature behind the desk
    const half = 0.42; // ±24°
    supervisor = {
      x: cx,
      z: sz,
      cz: sz - sr,
      r: sr,
      a0: -half,
      a1: half,
      deck: 0.3,
      pz0: sz - 1.55,
      pz1: sz + 0.6,
      phw: sr * Math.sin(half) + 0.9,
      seats: [-0.2, 0.2].map((a) => ({ a, monitors: 2 })),
    };
  }
  return {
    x0,
    x1,
    z0,
    z1,
    H,
    cx,
    cz,
    R,
    roomR,
    a0: -HALF_ARC,
    a1: HALF_ARC,
    rows,
    supervisor,
  };
}

// ---------------------------------------------------------------------------
// Wall mapping helpers
// ---------------------------------------------------------------------------

/** Angle range of each upper panel (left → right). */
export function upperSpans(
  p: Pick<ControlPlan, "a0" | "a1">,
): Array<{ key: UpperPanel; a0: number; a1: number }> {
  const out: Array<{ key: UpperPanel; a0: number; a1: number }> = [];
  let a = p.a0;
  for (const [key, f] of UPPER_SPANS) {
    const b = a + (p.a1 - p.a0) * f;
    out.push({ key, a0: a, a1: b });
    a = b;
  }
  return out;
}

export interface FeedCell {
  a0: number;
  a1: number;
  /** Image area (feed mesh) heights; the caption sits below. */
  y0: number;
  y1: number;
  side: "west" | "east";
  index: number;
}

/** Feed cells on the lower tier, left and right of the centre (alerts) block. */
export function feedCells(p: ControlPlan): {
  cells: FeedCell[];
  center: [number, number];
} {
  const spans = upperSpans(p);
  const board = spans.find((s) => s.key === "board")!;
  const center: [number, number] = [board.a0, board.a1];
  const capH = 0.22;
  const y0 = WALL_Y.lower0 + 0.04 + capH;
  const y1 = WALL_Y.lower1 - 0.04;
  const imgW = ((y1 - y0) * 16) / 9;
  const pitch = imgW + 0.14;
  const da = pitch / p.R;
  const wa = imgW / p.R;
  const cells: FeedCell[] = [];
  const room = center[0] - p.a0 - 0.12 / p.R;
  const n = Math.max(0, Math.min(4, Math.floor(room / da)));
  for (let i = 0; i < n; i++) {
    // Left side fills from the centre outwards (index 0 nearest the centre).
    const lEnd = center[0] - 0.1 / p.R - i * da;
    cells.push({ a0: lEnd - wa, a1: lEnd, y0, y1, side: "west", index: i });
    const rStart = center[1] + 0.1 / p.R + i * da;
    cells.push({ a0: rStart, a1: rStart + wa, y0, y1, side: "east", index: i });
  }
  return { cells, center };
}

/** World point on a circle around (cx, cz). */
export function onArc(
  cx: number,
  cz: number,
  r: number,
  a: number,
): { x: number; z: number } {
  return { x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r };
}

// ---------------------------------------------------------------------------
// Sight lines (node-tested): nothing may block the lower tier from a seat.
// ---------------------------------------------------------------------------

export interface Blocker {
  /** Radius from C (along the viewing ray, approximated radially). */
  r: number;
  /** Top of the obstruction. */
  top: number;
}

/** Monitor tops of every console row (the obstructions in front of a seat). */
export function blockers(p: ControlPlan): Blocker[] {
  return p.rows.map((row) => ({
    r: row.r + CONSOLE.depth / 2 - 0.1,
    top: row.deck + CONSOLE.monBottom + CONSOLE.monH,
  }));
}

/** Eye positions (radius from C, height) of every seat. */
export function eyes(
  p: ControlPlan,
): Array<{ r: number; y: number; who: string }> {
  const out: Array<{ r: number; y: number; who: string }> = [];
  p.rows.forEach((row, i) =>
    out.push({
      r: row.r - CONSOLE.depth / 2 - 0.45,
      y: row.deck + CONSOLE.eyeSeated,
      who: `row${i + 1}`,
    }),
  );
  if (p.supervisor)
    out.push({
      r: -(p.cz - p.supervisor.z) - 0.55,
      y: p.supervisor.deck + CONSOLE.eyeStanding,
      who: "supervisor",
    });
  return out;
}

/**
 * Clearance (m) of the ray from an eye to the lower-tier bottom edge over
 * every obstruction between them (negative = blocked).
 */
export function sightClearance(
  p: ControlPlan,
): Array<{ who: string; clearance: number }> {
  const target = { r: p.R, y: WALL_Y.lower0 };
  const bl = blockers(p);
  return eyes(p).map((e) => {
    let worst = Infinity;
    for (const b of bl) {
      if (b.r <= e.r + 0.05 || b.r >= target.r) continue;
      const t = (b.r - e.r) / (target.r - e.r);
      const y = e.y + (target.y - e.y) * t;
      worst = Math.min(worst, y - b.top);
    }
    return { who: e.who, clearance: worst };
  });
}
