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
import { carModel } from "./carModels";

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
  /** South wall and north wall (dock end). */
  zS: number;
  zN: number;
  /**
   * Entrance building projecting south of the envelope (its z0 is the
   * entrance façade). The car park, plaza and drop-off sit in front of it.
   */
  entrance?: Rect;
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
  /** 0 broadleaf · 1 columnar · 2 shrub */
  species: 0 | 1 | 2;
}

export interface ExteriorPlan {
  footprint: Footprint;
  apron: Rect;
  /** Paved areas drawn as asphalt. */
  asphalt: Rect[];
  /** Car park, entrance plaza, drop-off lay-by and the walk to the doors. */
  lot: Rect;
  plaza: Rect;
  dropOff: Rect;
  path: Rect;
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

/** Clear gap (m) between a tree canopy's edge and the factory/entrance walls. */
export const TREE_WALL_GAP = 3;

/** Half-extent of a tree's crossed cards (cards are `size` wide: Exterior.ts). */
export function treeRadius(t: Tree): number {
  return (t.species === 2 ? t.h * 1.65 : t.h * 1.07) / 2;
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
  // Front line: the entrance façade when the entrance projects, else the wall.
  const ent = fp.entrance;
  const zF = ent ? Math.min(ent.z0, zS) : zS;

  // --- Dock end: apron straight off the dock doors + access road north.
  const apron = rect(-halfW - 6, halfW + 6, zN, zN + 32);
  const roadN = rect(-7, 7, zN + 32, zN + 260);
  // --- Side service road (east) joining the car park to the apron.
  const sideRoad = rect(halfW + 8, halfW + 20, zF - 28, zN + 32);
  // --- Car park in front of the lobby + entrance plaza.
  const lot = rect(-halfW, halfW, zF - 36, zF - 8);
  const plaza = rect(-12, 12, zF - 8, zF);
  const driveS = rect(-4, 4, zF - 60, zF - 36);
  const roadS = rect(-260, 260, zF - 74, zF - 60);
  const connector = rect(halfW, halfW + 20, zF - 21.2, zF - 14.2);
  // Drop-off lay-by along the plaza edge (row A's centre stalls give way)
  // and a paved walk from the lot's central lane to the entrance doors.
  const dropOff = rect(-10, 10, zF - 13.2, zF - 8);
  const path = rect(-1.6, 1.6, zF - 36, zF - 13.2);
  const dockPad = rect(-halfW, halfW, zN, zN + 3);

  const asphalt = [apron, roadN, sideRoad, lot, driveS, roadS, connector];
  const concrete = [plaza, dockPad, path];

  const strips = [
    // Lawns along both long walls and between the lot and the lobby plaza.
    rect(-halfW - 6, -halfW, zF, zN),
    rect(halfW, halfW + 8, zF, zN),
    rect(-halfW, -12, zF - 8, zF),
    rect(12, halfW, zF - 8, zF),
  ];
  // Lawns either side of the projecting entrance building.
  if (ent && ent.z0 < zS - 1e-6)
    strips.push(rect(-halfW, ent.x0, zF, zS), rect(ent.x1, halfW, zF, zS));

  // --- Stalls: row A hugs the plaza edge, aisle 1, rows B + C back to back.
  const rowsZ: { zEdge: number; dir: 1 | -1 }[] = [
    { zEdge: zF - 8, dir: -1 }, // A: [zF-13.2, zF-8]
    { zEdge: zF - 21.2, dir: -1 }, // B: [zF-26.4, zF-21.2]
    { zEdge: zF - 26.4, dir: -1 }, // C: [zF-31.6, zF-26.4]
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
      // Keep the central pedestrian lane (and the drop-off) clear.
      const gap = row.zEdge === zF - 8 ? dropOff.x1 + 0.4 : 3;
      if (Math.abs(cx) < gap) continue;
      stalls.push({ x: cx, z: zc, yaw: row.zEdge === zF - 26.4 ? 0 : Math.PI });
    }
    for (let i = 0; i <= n; i++) {
      const lx = x0 + i * STALL_W;
      const gap = row.zEdge === zF - 8 ? dropOff.x1 - 0.2 : 3;
      if (Math.abs(lx) < gap) continue;
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
  paint.push(rect(-260, 260, zF - 67.1, zF - 66.9));
  // Drop-off: dashed lane edge toward the aisle + end lines.
  for (let x = dropOff.x0 + 0.5; x < dropOff.x1 - 0.5; x += 1.6)
    paint.push(rect(x, x + 0.9, dropOff.z0 + 0.15, dropOff.z0 + 0.27));
  for (const x of [dropOff.x0, dropOff.x1])
    paint.push(rect(x - 0.06, x + 0.06, dropOff.z0, dropOff.z1));

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
  const fence = rect(-halfW - 30, halfW + 30, zF - 46, zN + 44);
  const gates = [
    rect(-8, 8, fence.z0 - 1, fence.z0 + 1), // south drive
    rect(-8, 8, fence.z1 - 1, fence.z1 + 1), // north access road
  ];

  const keepOut: Rect[] = [
    grow(factory, 8),
    ...(ent ? [grow(ent, 8)] : []),
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
    const dist = 95 + r() * 70; // stays inside the 220 m far plane
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

  // --- Trees. Canopy cards are `size` wide (see Exterior.ts), so a tree's
  // footprint is a square of half-extent treeRadius(); it must clear the
  // factory + entrance walls by TREE_WALL_GAP, and never touch pavement/sheds.
  const trees: Tree[] = [];
  const wallBlockers = [grow(factory, TREE_WALL_GAP)].concat(
    ent ? [grow(ent, TREE_WALL_GAP)] : [],
  );
  const hardBlockers = [...asphalt, ...concrete];
  const fits = (t: Tree): boolean => {
    const rr = treeRadius(t);
    const f = rect(t.x - rr, t.x + rr, t.z - rr, t.z + rr);
    return (
      !wallBlockers.some((k) => overlaps(k, f)) &&
      !hardBlockers.some((k) => overlaps(k, f)) &&
      !sheds.some((s) => overlaps(grow(shedRect(s), 1), f))
    );
  };
  /** Add the tree, shrinking it until it fits; drop it when it never does. */
  const addTree = (t: Tree): void => {
    const min = t.species === 2 ? 0.5 : 2.2;
    for (let k = 0; k < 6 && t.h >= min; k++, t.h *= 0.82)
      if (fits(t)) {
        trees.push(t);
        return;
      }
  };
  for (const [si, s] of [strips[0], strips[1]].entries()) {
    for (let z = s.z0 + 6; z < s.z1 - 4; z += 9 + r() * 5) {
      const h = 4.5 + r() * 3;
      const species = r() < 0.25 ? 1 : 0;
      const u = r();
      // Lawn column between the wall gap and the side road / outer lawn.
      const rr = treeRadius({ x: 0, z: 0, h, species });
      const lo = si === 0 ? -halfW - 14 + rr : halfW + TREE_WALL_GAP + rr;
      const hi = si === 0 ? -halfW - TREE_WALL_GAP - rr : halfW + 8 - rr;
      const x =
        hi >= lo ? lo + (hi - lo) * u : si === 0 ? -halfW - 8 : halfW + 6;
      addTree({ x, z, h, species });
    }
  }
  for (const s of [strips[2], strips[3]]) {
    for (let x = s.x0 + 4; x < s.x1 - 3; x += 8 + r() * 4) {
      addTree({
        x,
        z: s.z0 + 2 + r() * 3,
        h: 3.5 + r() * 2,
        species: r() < 0.3 ? 1 : 0,
      });
    }
    // Low shrub hedge along the car-park edge (inset by its own radius).
    for (let x = s.x0 + 1.5; x < s.x1 - 1; x += 2.2 + r() * 1.2) {
      const h = 0.9 + r() * 0.7;
      addTree({
        x,
        z: s.z0 + 0.4 + treeRadius({ x, z: 0, h, species: 2 }),
        h,
        species: 2,
      });
    }
  }
  // Groves between the neighbouring sheds, clear of everything built.
  const treeFree = (x: number, z: number): boolean => {
    const t = rect(x - 2, x + 2, z - 2, z + 2);
    return (
      !keepOut.some((k) => overlaps(k, t)) &&
      !sheds.some((s) => overlaps(grow(shedRect(s), 3), t))
    );
  };
  for (let g = 0, placed = 0; g < 80 && placed < 14; g++) {
    const a = r() * Math.PI * 2;
    const dist = 75 + r() * 150;
    const gx = cx + Math.sin(a) * dist * 1.25;
    const gz = cz + Math.cos(a) * dist * 1.1;
    if (!treeFree(gx, gz)) continue;
    placed++;
    const n = 6 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      const ta = r() * Math.PI * 2;
      const td = Math.sqrt(r()) * 14;
      const x = gx + Math.cos(ta) * td;
      const z = gz + Math.sin(ta) * td;
      const h = 6 + r() * 6;
      const species = r() < 0.2 ? 1 : 0;
      if (!treeFree(x, z)) continue;
      addTree({ x, z, h, species });
    }
  }

  return {
    footprint: fp,
    apron,
    asphalt,
    lot,
    plaza,
    dropOff,
    path,
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
  const m = carModel(c);
  // Mirrors stick out ~0.1 m a side; bumpers / plates a few cm.
  const w = m.width + 0.2;
  const d = m.length + 0.1;
  const rot = Math.abs(Math.sin(c.yaw)) > 0.7;
  const hx = (rot ? d : w) / 2;
  const hz = (rot ? w : d) / 2;
  return rect(c.x - hx, c.x + hx, c.z - hz, c.z + hz);
}
