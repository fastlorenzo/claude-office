/**
 * Industrial-park exterior plan (pure data, no Babylon).
 *
 * The factory envelope (75 m wide, lobby at the south end, dock at the north
 * end, floor at y = GROUND_Y) sits in a fenced yard: truck apron + access road
 * at the dock end, a car park and entrance plaza in front of the lobby, a side
 * service road, landscaping strips and a handful of neighbouring low sheds.
 * Everything is deterministic from `seed` and keeps buildings/cars clear of the
 * apron, the roads and the factory. See docs/design/software-factory.md §6.
 */

import { rng } from "../art/random";

/** Outside ground / factory floor level (the office floor is y = 0). */
export const GROUND_Y = -6;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface Footprint {
  /** Factory envelope half-width (x in [-halfW, halfW]). */
  halfW: number;
  /** South wall (lobby front) and north wall (dock end). */
  zS: number;
  zN: number;
}

export interface Stall {
  x: number;
  z: number;
  /** Yaw so the car nose points away from the aisle. */
  yaw: number;
}

export interface CarSpot extends Stall {
  /** Index into the exterior car palette. */
  color: number;
  van: boolean;
}

export interface Shed {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Low-pitch roof lift (m) or 0 for flat. */
  ridge: number;
  /** 0 warehouse · 1 office block · 2 workshop */
  kind: 0 | 1 | 2;
  tint: number;
}

export interface Tree {
  x: number;
  z: number;
  h: number;
}

export interface ExteriorPlan {
  footprint: Footprint;
  apron: Rect;
  /** Paved areas drawn as asphalt. */
  asphalt: Rect[];
  /** Pale concrete: the entrance plaza and the dock-door pad. */
  concrete: Rect[];
  strips: Rect[];
  /** Painted stall lines + dock-bay markings, drawn as thin rects. */
  paint: Rect[];
  stalls: Stall[];
  cars: CarSpot[];
  fence: Rect;
  /** Gaps in the fence (rects the fence skips). */
  gates: Rect[];
  sheds: Shed[];
  trees: Tree[];
  /** Everything that must stay free of sheds and cars: factory, roads, apron, lot. */
  keepOut: Rect[];
}

export const STALL_W = 2.6;
export const STALL_D = 5.2;

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  x1: Math.max(x0, x1),
  z0: Math.min(z0, z1),
  z1: Math.max(z0, z1),
});

export const grow = (r: Rect, m: number): Rect => ({
  x0: r.x0 - m,
  x1: r.x1 + m,
  z0: r.z0 - m,
  z1: r.z1 + m,
});

export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

export function planExterior(fp: Footprint, seed = 31337): ExteriorPlan {
  const r = rng(seed);
  const { halfW, zS, zN } = fp;
  const factory = rect(-halfW, halfW, zS, zN);

  // --- Dock end: apron straight off the dock doors + access road north.
  const apron = rect(-halfW - 6, halfW + 6, zN, zN + 32);
  const roadN = rect(-7, 7, zN + 32, zN + 260);
  // --- Side service road (east) joining the car park to the apron.
  const sideRoad = rect(halfW + 8, halfW + 20, zS - 28, zN + 32);
  // --- Car park in front of the lobby + entrance plaza.
  const lot = rect(-halfW, halfW, zS - 36, zS - 8);
  const plaza = rect(-12, 12, zS - 8, zS);
  const driveS = rect(-4, 4, zS - 60, zS - 36);
  const roadS = rect(-260, 260, zS - 74, zS - 60);
  const connector = rect(halfW, halfW + 20, zS - 21.2, zS - 14.2);
  const dockPad = rect(-halfW, halfW, zN, zN + 3);

  const asphalt = [apron, roadN, sideRoad, lot, driveS, roadS, connector];
  const concrete = [plaza, dockPad];

  const strips = [
    // Lawns along both long walls and between the lot and the lobby plaza.
    rect(-halfW - 6, -halfW, zS, zN),
    rect(halfW, halfW + 8, zS, zN),
    rect(-halfW, -12, zS - 8, zS),
    rect(12, halfW, zS - 8, zS),
  ];

  // --- Stalls: row A hugs the plaza edge, aisle 1, rows B + C back to back.
  const rowsZ: { zEdge: number; dir: 1 | -1 }[] = [
    { zEdge: zS - 8, dir: -1 }, // A: [zS-13.2, zS-8]
    { zEdge: zS - 21.2, dir: -1 }, // B: [zS-26.4, zS-21.2]
    { zEdge: zS - 26.4, dir: -1 }, // C: [zS-31.6, zS-26.4]
  ];
  const stalls: Stall[] = [];
  const paint: Rect[] = [];
  for (const row of rowsZ) {
    const zc = row.zEdge + (row.dir * STALL_D) / 2;
    const zFar = row.zEdge + row.dir * STALL_D;
    const n = Math.floor((2 * halfW - 8) / STALL_W);
    const x0 = -(n * STALL_W) / 2;
    for (let i = 0; i < n; i++) {
      const cx = x0 + (i + 0.5) * STALL_W;
      // Keep the central pedestrian lane to the plaza clear.
      if (Math.abs(cx) < 3) continue;
      stalls.push({ x: cx, z: zc, yaw: row.zEdge === zS - 26.4 ? 0 : Math.PI });
    }
    for (let i = 0; i <= n; i++) {
      const lx = x0 + i * STALL_W;
      if (Math.abs(lx) < 3) continue;
      paint.push(
        rect(lx - 0.06, lx + 0.06, zc - STALL_D / 2, zc + STALL_D / 2),
      );
    }
    paint.push(rect(x0, -x0, zFar - 0.06, zFar + 0.06));
  }
  // Dock-bay markings on the apron.
  for (let x = -halfW + 6; x <= halfW - 6; x += 12) {
    paint.push(rect(x - 0.1, x + 0.1, zN + 3, zN + 28));
  }
  // Road centre lines.
  paint.push(rect(-0.1, 0.1, zN + 32, zN + 260));
  paint.push(rect(-260, 260, zS - 67.1, zS - 66.9));

  // Cars: ~40% occupancy, deterministic, never off a stall.
  const cars: CarSpot[] = [];
  for (const s of stalls) {
    if (r() > 0.42) continue;
    cars.push({
      ...s,
      yaw: s.yaw + (r() - 0.5) * 0.06,
      color: Math.floor(r() * 8),
      van: r() < 0.14,
    });
  }

  // --- Fence around the yard; gates where roads cross.
  const fence = rect(-halfW - 30, halfW + 30, zS - 46, zN + 44);
  const gates = [
    rect(-8, 8, fence.z0 - 1, fence.z0 + 1), // south drive
    rect(-8, 8, fence.z1 - 1, fence.z1 + 1), // north access road
  ];

  const keepOut: Rect[] = [
    grow(factory, 8),
    ...asphalt.map((a) => grow(a, 6)),
    ...concrete,
    grow(fence, 8),
  ];

  // --- Neighbouring low industrial buildings, outside the fence.
  const sheds: Shed[] = [];
  const cx = 0;
  const cz = (zS + zN) / 2;
  for (let tries = 0; tries < 240 && sheds.length < 16; tries++) {
    const a = r() * Math.PI * 2;
    const dist = 95 + r() * 125;
    const w = 24 + r() * 40;
    const d = 18 + r() * 30;
    const x = cx + Math.sin(a) * dist * 1.25;
    const z = cz + Math.cos(a) * dist * 1.1;
    const box = rect(x - w / 2, x + w / 2, z - d / 2, z + d / 2);
    const clear = grow(box, 4);
    if (keepOut.some((k) => overlaps(k, clear))) continue;
    if (sheds.some((s) => overlaps(grow(shedRect(s), 6), clear))) continue;
    const kind = (r() < 0.55 ? 0 : r() < 0.6 ? 1 : 2) as 0 | 1 | 2;
    sheds.push({
      x,
      z,
      w,
      d,
      h: kind === 1 ? 7 + r() * 5 : 5.5 + r() * 4,
      ridge: kind === 0 && r() < 0.6 ? 1.2 + r() * 1.2 : 0,
      kind,
      tint: Math.floor(r() * 6),
    });
  }

  // --- Trees on the lawn strips (clear of the dock end and pad).
  const trees: Tree[] = [];
  for (const s of [strips[0], strips[1]]) {
    for (let z = s.z0 + 6; z < s.z1 - 4; z += 9 + r() * 5) {
      trees.push({
        x: s.x0 + (s.x1 - s.x0) * (0.3 + r() * 0.4),
        z,
        h: 4.5 + r() * 3,
      });
    }
  }
  for (const s of [strips[2], strips[3]]) {
    for (let x = s.x0 + 4; x < s.x1 - 3; x += 8 + r() * 4) {
      trees.push({ x, z: s.z0 + 2 + r() * 3, h: 3.5 + r() * 2 });
    }
  }

  return {
    footprint: fp,
    apron,
    asphalt,
    concrete,
    strips,
    paint,
    stalls,
    cars,
    fence,
    gates,
    sheds,
    trees,
    keepOut,
  };
}

export function shedRect(s: Shed): Rect {
  return rect(s.x - s.w / 2, s.x + s.w / 2, s.z - s.d / 2, s.z + s.d / 2);
}

/** Car body footprint (axis-aligned bound, regardless of yaw). */
export function carRect(c: CarSpot): Rect {
  const w = 2.0;
  const d = c.van ? 5.0 : 4.4;
  const rot = Math.abs(Math.sin(c.yaw)) > 0.7;
  const hx = (rot ? d : w) / 2;
  const hz = (rot ? w : d) / 2;
  return rect(c.x - hx, c.x + hx, c.z - hz, c.z + hz);
}
