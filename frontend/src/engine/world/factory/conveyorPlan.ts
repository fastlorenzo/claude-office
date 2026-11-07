/**
 * Conveyor geometry planning (pure, Node-testable): polylines → filleted
 * centrelines → ~1 m slices → box instances for the three conveyor pools.
 *
 * Input is a geometry-only `ConveyorPath` so this module does not depend on
 * the factory layout (an adapter from `FactoryLayout` lanes / trunks / main
 * line comes later).
 *
 * Shapes (local frame of every instance: +X along the belt, +Y up, +Z across):
 *   belt   unit box (rubber, UV v runs along +X) — one per slice
 *   frame  unit box, per-instance colour — side skirts, legs, feet, braces,
 *          rail brackets, end covers
 *   guard  unit cylinder along +X, per-instance colour — guide rails (light
 *          UHMW grey) and the safety-yellow end bumpers
 *
 * Corners are filleted with circular arcs (radius ≈ 1.35 × width), sliced at
 * ≤ 15°. On arcs every slice is a straight chord: the belt box is stretched to
 * the OUTER chord (no wedge gaps; alternate slices are lifted 2 mm so the
 * inner overlaps never z-fight) and skirts / rails use the chord of their own
 * radius.
 *
 * Merges: a path whose END lies on (or within reach of) another path's belt is
 * a side feeder (lane → trunk, trunk → main line). Its end is trimmed back to
 * the other belt's edge, it gets no end cover / bumper, and the target's guide
 * rail gets an opening on that side.
 */
import { hexToLinear, writeTRS } from "./poolMath";

export type ConveyorKind = "lane" | "trunk" | "main";

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface ConveyorPath {
  id: string;
  /** Centreline at FLOOR level (y = floor); the belt top sits `height` above. */
  points: P3[];
  /** Belt width incl. side skirts (m). Lanes ≈ 0.9. */
  width: number;
  kind: ConveyorKind;
  /** Belt-top height above the floor (default 0.85 m). */
  height?: number;
}

export type Rgb = [number, number, number];

/** A scaled, yawed unit primitive (centre position). */
export interface BoxInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  color?: Rgb;
}

export const CONVEYOR = {
  beltHeight: 0.85,
  /** Target straight slice length (m). */
  segment: 1,
  /** Max arc angle per slice. */
  curveStep: Math.PI / 12,
  /** Fillet radius = max(minRadius, radiusPerWidth × width). */
  minRadius: 1.2,
  radiusPerWidth: 1.35,
  beltThickness: 0.05,
  skirtThickness: 0.035,
  skirtHeight: 0.17,
  /** Skirt top above the belt top. */
  skirtLip: 0.004,
  railHeight: 0.1,
  railDiameter: 0.032,
  legSize: 0.06,
  legSpacing: { lane: 1.8, trunk: 2.4, main: 2.4 } as Record<
    ConveyorKind,
    number
  >,
  braceHeight: 0.24,
  /** Gap left between a trimmed feeder end and the target's belt edge. */
  mergeGap: 0.004,
} as const;

export const CONVEYOR_COLORS = {
  skirt: "#B9BEC4", // satin anodised aluminium
  leg: "#383E42", // RAL 7016 anthracite
  foot: "#24272A",
  cover: "#2B2E32",
  rail: "#D5D8DB", // UHMW-PE guide rail
  bumper: "#F2BE00", // safety yellow, used sparingly
} as const;

const COL = {
  skirt: hexToLinear(CONVEYOR_COLORS.skirt),
  leg: hexToLinear(CONVEYOR_COLORS.leg),
  foot: hexToLinear(CONVEYOR_COLORS.foot),
  cover: hexToLinear(CONVEYOR_COLORS.cover),
  rail: hexToLinear(CONVEYOR_COLORS.rail),
  bumper: hexToLinear(CONVEYOR_COLORS.bumper),
};

// ---------------------------------------------------------------------------
// Centreline geometry
// ---------------------------------------------------------------------------

export type Piece =
  | {
      kind: "line";
      ax: number;
      az: number;
      bx: number;
      bz: number;
      len: number;
    }
  | {
      kind: "arc";
      cx: number;
      cz: number;
      r: number;
      /** Angle of the start point around the centre. */
      a0: number;
      /** Signed sweep (rad); > 0 turns from +X toward +Z. */
      sweep: number;
      len: number;
    };

export interface PathGeom {
  id: string;
  kind: ConveyorKind;
  width: number;
  height: number;
  /** Floor level of the path. */
  y: number;
  pieces: Piece[];
  length: number;
  /** Effective end (arc length) after merge trimming. */
  end: number;
  /** True when the end feeds into another path. */
  merged: boolean;
}

export interface PathPoint {
  x: number;
  z: number;
  /** Unit tangent. */
  tx: number;
  tz: number;
}

export function filletRadius(width: number): number {
  return Math.max(CONVEYOR.minRadius, CONVEYOR.radiusPerWidth * width);
}

/** Polyline → straight pieces joined by tangent circular arcs. */
export function buildPathGeom(path: ConveyorPath): PathGeom {
  const pts = dedupe(path.points);
  const y = pts[0]?.y ?? 0;
  const R = filletRadius(path.width);
  const pieces: Piece[] = [];
  if (pts.length >= 2) {
    // Tangent length used at every corner (0 when collinear).
    const n = pts.length;
    const legLen: number[] = [];
    for (let i = 0; i < n - 1; i++)
      legLen.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z));
    const corner: { t: number; phi: number; cross: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      const ux = (pts[i].x - pts[i - 1].x) / legLen[i - 1];
      const uz = (pts[i].z - pts[i - 1].z) / legLen[i - 1];
      const vx = (pts[i + 1].x - pts[i].x) / legLen[i];
      const vz = (pts[i + 1].z - pts[i].z) / legLen[i];
      const cross = ux * vz - uz * vx;
      const dot = Math.max(-1, Math.min(1, ux * vx + uz * vz));
      const phi = Math.acos(dot);
      if (phi < 1e-4) {
        corner.push({ t: 0, phi: 0, cross: 0 });
        continue;
      }
      const availIn = i - 1 === 0 ? legLen[i - 1] : legLen[i - 1] / 2;
      const availOut = i === n - 2 ? legLen[i] : legLen[i] / 2;
      const t = Math.min(R * Math.tan(phi / 2), availIn, availOut);
      corner.push({ t, phi, cross });
    }
    let cx = pts[0].x;
    let cz = pts[0].z;
    for (let i = 1; i < n; i++) {
      const ux = (pts[i].x - pts[i - 1].x) / legLen[i - 1];
      const uz = (pts[i].z - pts[i - 1].z) / legLen[i - 1];
      const c = i < n - 1 ? corner[i - 1] : null;
      const t = c?.t ?? 0;
      const ax = pts[i].x - ux * t;
      const az = pts[i].z - uz * t;
      const len = Math.hypot(ax - cx, az - cz);
      if (len > 1e-6)
        pieces.push({ kind: "line", ax: cx, az: cz, bx: ax, bz: az, len });
      if (c && c.t > 0) {
        const r = c.t / Math.tan(c.phi / 2);
        const sgn = c.cross > 0 ? 1 : -1;
        // Normal of u toward the turn.
        const nx = -uz * sgn;
        const nz = ux * sgn;
        const ccx = ax + nx * r;
        const ccz = az + nz * r;
        const a0 = Math.atan2(az - ccz, ax - ccx);
        const sweep = sgn * c.phi;
        pieces.push({
          kind: "arc",
          cx: ccx,
          cz: ccz,
          r,
          a0,
          sweep,
          len: r * c.phi,
        });
        const vx = (pts[i + 1].x - pts[i].x) / legLen[i];
        const vz = (pts[i + 1].z - pts[i].z) / legLen[i];
        cx = pts[i].x + vx * t;
        cz = pts[i].z + vz * t;
      } else {
        cx = ax;
        cz = az;
      }
    }
  }
  const length = pieces.reduce((a, p) => a + p.len, 0);
  return {
    id: path.id,
    kind: path.kind,
    width: path.width,
    height: path.height ?? CONVEYOR.beltHeight,
    y,
    pieces,
    length,
    end: length,
    merged: false,
  };
}

function dedupe(points: P3[]): P3[] {
  const out: P3[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > 1e-4) out.push(p);
  }
  return out;
}

/** Position + tangent at arc length `s` (clamped to the path). */
export function evalAt(g: PathGeom, s: number): PathPoint {
  let rest = Math.max(0, Math.min(g.length, s));
  for (let i = 0; i < g.pieces.length; i++) {
    const p = g.pieces[i];
    if (rest > p.len && i < g.pieces.length - 1) {
      rest -= p.len;
      continue;
    }
    const f = p.len > 0 ? Math.min(1, rest / p.len) : 0;
    if (p.kind === "line") {
      const tx = (p.bx - p.ax) / (p.len || 1);
      const tz = (p.bz - p.az) / (p.len || 1);
      return {
        x: p.ax + (p.bx - p.ax) * f,
        z: p.az + (p.bz - p.az) * f,
        tx,
        tz,
      };
    }
    const a = p.a0 + p.sweep * f;
    const sg = p.sweep > 0 ? 1 : -1;
    return {
      x: p.cx + p.r * Math.cos(a),
      z: p.cz + p.r * Math.sin(a),
      tx: -Math.sin(a) * sg,
      tz: Math.cos(a) * sg,
    };
  }
  return { x: 0, z: 0, tx: 1, tz: 0 };
}

/** Lateral offset point: `side` > 0 is the left normal (−tz, tx). */
function offsetAt(g: PathGeom, s: number, o: number): { x: number; z: number } {
  const p = evalAt(g, s);
  return { x: p.x - p.tz * o, z: p.z + p.tx * o };
}

export interface Slice {
  s0: number;
  s1: number;
  /** Arc radius (Infinity on straights). */
  r: number;
  /** Index of the slice inside its arc (alternating lift), −1 on straights. */
  arcIndex: number;
}

/** Cut [0, g.end] into ≈ 1 m straight slices and ≤ 15° arc slices. */
export function slicePath(g: PathGeom): Slice[] {
  const out: Slice[] = [];
  let s = 0;
  for (const p of g.pieces) {
    const a = s;
    const b = Math.min(s + p.len, g.end);
    s += p.len;
    const len = b - a;
    if (len <= 1e-4) continue;
    if (p.kind === "line") {
      const n = Math.max(1, Math.round(len / CONVEYOR.segment));
      for (let k = 0; k < n; k++)
        out.push({
          s0: a + (len * k) / n,
          s1: a + (len * (k + 1)) / n,
          r: Infinity,
          arcIndex: -1,
        });
    } else {
      const ang = len / p.r;
      const n = Math.max(1, Math.ceil(ang / CONVEYOR.curveStep - 1e-9));
      for (let k = 0; k < n; k++)
        out.push({
          s0: a + (len * k) / n,
          s1: a + (len * (k + 1)) / n,
          r: p.r,
          arcIndex: k,
        });
    }
    if (s >= g.end) break;
  }
  return out;
}

/** Nearest point of a path's centreline to (x, z). */
export function nearestOnPath(
  g: PathGeom,
  x: number,
  z: number,
): { s: number; d: number; x: number; z: number } {
  let best = { s: 0, d: Infinity, x: 0, z: 0 };
  let s0 = 0;
  for (const p of g.pieces) {
    if (p.kind === "line") {
      const dx = p.bx - p.ax;
      const dz = p.bz - p.az;
      const t = Math.max(
        0,
        Math.min(1, ((x - p.ax) * dx + (z - p.az) * dz) / (p.len * p.len)),
      );
      const px = p.ax + dx * t;
      const pz = p.az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.d) best = { s: s0 + t * p.len, d, x: px, z: pz };
    } else {
      const ang = Math.atan2(z - p.cz, x - p.cx);
      let rel = (ang - p.a0) * Math.sign(p.sweep);
      rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const span = Math.abs(p.sweep);
      const cands: number[] = [0, span];
      if (rel <= span) cands.push(rel);
      for (const c of cands) {
        const a = p.a0 + Math.sign(p.sweep) * c;
        const px = p.cx + p.r * Math.cos(a);
        const pz = p.cz + p.r * Math.sin(a);
        const d = Math.hypot(x - px, z - pz);
        if (d < best.d) best = { s: s0 + c * p.r, d, x: px, z: pz };
      }
    }
    s0 += p.len;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------

export interface MergeInfo {
  /** Feeder path id. */
  from: string;
  /** Target path id. */
  into: string;
  /** Arc length on the target. */
  s: number;
  /** Side of the target (+1 left normal, −1 right). */
  side: 1 | -1;
  /** Opening half-length on the target's rail. */
  half: number;
  /** Arc length trimmed off the feeder's end. */
  trimmed: number;
}

/** Detect feeders, trim their ends (mutates `geoms[].end/merged`). */
export function resolveMerges(geoms: PathGeom[]): MergeInfo[] {
  const merges: MergeInfo[] = [];
  for (const a of geoms) {
    if (a.length <= 0) continue;
    const e = evalAt(a, a.length);
    let best: { g: PathGeom; n: ReturnType<typeof nearestOnPath> } | null =
      null;
    for (const b of geoms) {
      if (b === a || b.length <= 0) continue;
      const n = nearestOnPath(b, e.x, e.z);
      const reach = b.width / 2 + a.width * 0.6 + 0.25;
      if (n.d > reach) continue;
      const tb = evalAt(b, n.s);
      // End-to-end continuation (collinear butt joint) is not a merge.
      if (Math.abs(tb.tx * e.tx + tb.tz * e.tz) > 0.7) continue;
      if (!best || n.d < best.n.d) best = { g: b, n };
    }
    if (!best) continue;
    const b = best.g;
    const target = b.width / 2 + CONVEYOR.mergeGap;
    const dist = (t: number) => {
      const p = evalAt(a, a.length - t);
      return nearestOnPath(b, p.x, p.z).d;
    };
    let trimmed = 0;
    if (dist(0) < target) {
      let lo = 0;
      let hi = Math.min(a.length * 0.9, b.width + 1);
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (dist(mid) < target) lo = mid;
        else hi = mid;
      }
      trimmed = hi;
    }
    a.end = a.length - trimmed;
    a.merged = true;
    const tb = evalAt(b, best.n.s);
    const cross = tb.tx * (e.z - best.n.z) - tb.tz * (e.x - best.n.x);
    merges.push({
      from: a.id,
      into: b.id,
      s: best.n.s,
      side: cross >= 0 ? 1 : -1,
      half: a.width / 2 + 0.08,
      trimmed,
    });
  }
  return merges;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface ConveyorSegments {
  belt: BoxInstance[];
  frame: BoxInstance[];
  guard: BoxInstance[];
  merges: MergeInfo[];
  geoms: PathGeom[];
  /** Belt instance range [start, end) of every path (per-lane scroll). */
  beltRanges: BeltRange[];
}

export interface BeltRange {
  id: string;
  start: number;
  end: number;
}

/** Stable identity of a path set (rebuild only when this changes). */
export function conveyorKey(paths: readonly ConveyorPath[]): string {
  const f = (v: number) => v.toFixed(3);
  return paths
    .map(
      (p) =>
        `${p.id}:${p.kind}:${f(p.width)}:${f(p.height ?? CONVEYOR.beltHeight)}:` +
        p.points.map((q) => `${f(q.x)},${f(q.y)},${f(q.z)}`).join(";"),
    )
    .join("|");
}

/** Box spanning two plan points at height `y` (centre), across size sz. */
function between(
  a: { x: number; z: number },
  b: { x: number; z: number },
  y: number,
  sy: number,
  sz: number,
  extra: number,
  color?: Rgb,
): BoxInstance {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return {
    x: (a.x + b.x) / 2,
    y,
    z: (a.z + b.z) / 2,
    yaw: Math.atan2(-dz, dx),
    sx: len + extra,
    sy,
    sz,
    color,
  };
}

/** [a, b] minus the given intervals. */
function subtract(
  a: number,
  b: number,
  cuts: [number, number][],
): [number, number][] {
  let parts: [number, number][] = [[a, b]];
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) next.push([p0, p1]);
      else {
        if (c0 > p0) next.push([p0, c0]);
        if (c1 < p1) next.push([c1, p1]);
      }
    }
    parts = next;
  }
  return parts.filter(([p0, p1]) => p1 - p0 > 0.02);
}

export function buildConveyorSegments(
  paths: readonly ConveyorPath[],
): ConveyorSegments {
  const geoms = paths
    .filter((p) => p.points.length >= 2 && p.width > 0)
    .map(buildPathGeom);
  const merges = resolveMerges(geoms);
  const belt: BoxInstance[] = [];
  const frame: BoxInstance[] = [];
  const guard: BoxInstance[] = [];
  const beltRanges: BeltRange[] = [];
  const C = CONVEYOR;

  for (const g of geoms) {
    if (g.end <= 0.01) continue;
    const w = g.width;
    const H = g.height;
    const y0 = g.y;
    const top = y0 + H;
    const openings: Record<1 | -1, [number, number][]> = { 1: [], [-1]: [] };
    for (const m of merges)
      if (m.into === g.id) openings[m.side].push([m.s - m.half, m.s + m.half]);

    const slices = slicePath(g);
    const beltStart = belt.length;
    const skirtO = w / 2 - C.skirtThickness / 2;
    const railO = w / 2 - 0.03;
    for (const sl of slices) {
      const arc = Number.isFinite(sl.r);
      const a = evalAt(g, sl.s0);
      const b = evalAt(g, sl.s1);
      // Belt: centreline chord, stretched to the outer chord on arcs.
      const chord = Math.hypot(b.x - a.x, b.z - a.z);
      const lenB = arc ? (chord * (sl.r + w / 2)) / sl.r + 0.004 : chord;
      const lift = arc && sl.arcIndex % 2 === 1 ? 0.002 : 0;
      const bi = between(
        a,
        b,
        top - C.beltThickness / 2 + lift,
        C.beltThickness,
        w - 2 * C.skirtThickness + 0.002,
        0,
      );
      bi.sx = lenB;
      belt.push(bi);
      // Side skirts (own-radius chords).
      for (const side of [1, -1] as const) {
        const pa = offsetAt(g, sl.s0, side * skirtO);
        const pb = offsetAt(g, sl.s1, side * skirtO);
        frame.push(
          between(
            pa,
            pb,
            top + C.skirtLip - C.skirtHeight / 2,
            C.skirtHeight,
            C.skirtThickness,
            arc ? 0.006 : 0,
            COL.skirt,
          ),
        );
        // Guide rails, interrupted at merge openings.
        for (const [r0, r1] of subtract(sl.s0, sl.s1, openings[side])) {
          const ra = offsetAt(g, r0, side * railO);
          const rb = offsetAt(g, r1, side * railO);
          guard.push(
            between(
              ra,
              rb,
              top + C.railHeight,
              C.railDiameter,
              C.railDiameter,
              arc ? 0.01 : 0,
              COL.rail,
            ),
          );
        }
      }
    }

    beltRanges.push({ id: g.id, start: beltStart, end: belt.length });

    // Rail brackets every ~1 m.
    const nb = Math.max(1, Math.floor((g.end - 0.4) / 1));
    for (let k = 0; k <= nb; k++) {
      const s = 0.2 + ((g.end - 0.4) * k) / Math.max(1, nb);
      for (const side of [1, -1] as const) {
        if (openings[side].some(([c0, c1]) => s > c0 - 0.05 && s < c1 + 0.05))
          continue;
        const p = evalAt(g, s);
        const o = side * railO;
        frame.push({
          x: p.x - p.tz * o,
          y: top + C.railHeight / 2,
          z: p.z + p.tx * o,
          yaw: Math.atan2(-p.tz, p.tx),
          sx: 0.025,
          sy: C.railHeight,
          sz: 0.018,
          color: COL.skirt,
        });
      }
    }

    // Legs (pairs), feet and low braces.
    const spacing = C.legSpacing[g.kind];
    const span = Math.max(0, g.end - 0.7);
    const nLeg = Math.max(2, Math.ceil(span / spacing) + 1);
    const legTop = top + C.skirtLip - C.skirtHeight + 0.01;
    const legH = legTop - y0;
    const legO = w / 2 - C.legSize / 2 - C.skirtThickness;
    for (let k = 0; k < nLeg; k++) {
      const s =
        g.end < 0.7 ? g.end / 2 : 0.35 + (span * k) / Math.max(1, nLeg - 1);
      const p = evalAt(g, s);
      const yaw = Math.atan2(-p.tz, p.tx);
      for (const side of [1, -1]) {
        const o = side * legO;
        const lx = p.x - p.tz * o;
        const lz = p.z + p.tx * o;
        frame.push({
          x: lx,
          y: y0 + legH / 2,
          z: lz,
          yaw,
          sx: C.legSize,
          sy: legH,
          sz: C.legSize,
          color: COL.leg,
        });
        frame.push({
          x: lx,
          y: y0 + 0.006,
          z: lz,
          yaw,
          sx: 0.13,
          sy: 0.012,
          sz: 0.13,
          color: COL.foot,
        });
      }
      frame.push({
        x: p.x,
        y: y0 + C.braceHeight,
        z: p.z,
        yaw,
        sx: 0.04,
        sy: 0.04,
        sz: 2 * legO,
        color: COL.leg,
      });
      if (g.end < 0.7) break;
    }

    // End covers (drum housings) + safety-yellow bumpers at open ends.
    const ends: { s: number; dir: number }[] = [{ s: 0, dir: -1 }];
    if (!g.merged) ends.push({ s: g.end, dir: 1 });
    for (const { s, dir } of ends) {
      const p = evalAt(g, s);
      const yaw = Math.atan2(-p.tz, p.tx);
      frame.push({
        x: p.x + p.tx * dir * 0.03,
        y: top - 0.075,
        z: p.z + p.tz * dir * 0.03,
        yaw,
        sx: 0.06,
        sy: 0.16,
        sz: w,
        color: COL.cover,
      });
      guard.push({
        x: p.x + p.tx * dir * 0.085,
        y: top + 0.02,
        z: p.z + p.tz * dir * 0.085,
        yaw: yaw + Math.PI / 2,
        sx: w - 0.04,
        sy: 0.05,
        sz: 0.05,
        color: COL.bumper,
      });
    }
  }
  return { belt, frame, guard, merges, geoms, beltRanges };
}

/**
 * Pack instances into Babylon-layout matrix (16 floats) and optional colour
 * (RGBA) buffers. Buffers are reused when large enough; returns the count.
 */
export function packBoxes(
  list: readonly BoxInstance[],
  matrices: Float32Array,
  colors: Float32Array | null,
  fallback: Rgb = [1, 1, 1],
): number {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    writeTRS(matrices, i * 16, b.x, b.y, b.z, b.yaw, b.sx, b.sy, b.sz);
    if (colors) {
      const c = b.color ?? fallback;
      colors[i * 4] = c[0];
      colors[i * 4 + 1] = c[1];
      colors[i * 4 + 2] = c[2];
      colors[i * 4 + 3] = 1;
    }
  }
  return list.length;
}
