/**
 * Straight stair flights: one geometry for every stair in the world (the
 * entrance feature stairs, the factory spine / cell stairs, the dock's
 * loading stair and the belt crossovers), plus the industrial steel builder
 * the factory and the crossovers share.
 *
 * A flight runs along z between x ∈ [xa, xb], from its TOP nosing
 * (zTop, yTop) to its BOTTOM nosing (zBot, yBot). Colliders follow
 * `Colliders.addBox`: pitch rotates about the box's local X axis and a
 * positive pitch lowers its +z end.
 *
 *   flight(...)       pure numbers (risers, going, pitch, slope normal)
 *   rampBox(f)        the hidden walkable ramp: a thin slab whose TOP face
 *                     runs exactly through the top and bottom nosings (flush
 *                     with both floors, no lip) and only extends below the
 *                     bottom one (sinking under the lower floor)
 *   guardBoxes(...)   side guard: a band from just under the treads up to
 *                     guard height, stepped along the slope over the
 *                     flight's own z range only (never pokes into a landing,
 *                     never reaches down to the floor under the flight)
 *   underBlockers(...) the closed nook under the low end: fills the space
 *                     under the flight where headroom < STAIR_HEADROOM (the
 *                     player capsule could wedge there); the rest of the
 *                     underside stays walkable
 *   railBox(...)      handrail bar along the nosing line (visual)
 *   balusterSpots(f)  baluster feet along a flight edge
 *   steelFlight(...)  galvanised treads + yellow nosings + painted stringers
 *                     + black flat-bar handrails, with ramp and guards
 *   steelLanding / steelRail / steelPost   the matching level parts
 *
 * Under a flight or landing the floor stays free wherever the structure's
 * underside is at least STAIR_HEADROOM above it; lower than that a blocker
 * closes it (a real stair's closed soffit / storage nook).
 */
import { Vector3 } from "@/engine/babylon";
import { paintOf, type ArtBatcher } from "@/engine/art/geometry";
import type { ColliderSink } from "@/engine/physics/Colliders";
import { v3 } from "@/engine/util/MeshBatcher";

/** Every flight is at most this steep (rise / going ≈ 0.7). */
export const STAIR_MAX_DEG = 35;
/** Handrail height above the nosing line / deck (stairs, landings). */
export const STAIR_RAIL_TOP = 0.95;
/** Side guards and level guard rails reach this far above their floor. */
export const STAIR_GUARD_H = 1.1;
/** Clear height a walker needs under a flight or landing (capsule 1.8 m). */
export const STAIR_HEADROOM = 2.0;
/** Hidden ramp thickness (perpendicular to the slope). */
const RAMP_T = 0.2;
/** Side guard segments: length along z, reach below the nosing line. */
const GUARD_SEG = 0.6;
const GUARD_BELOW = 0.25;
/** Under-flight blocker slices (length along z). */
const BLOCK_SEG = 0.4;
/** Steel stringer: height (perpendicular) and centre below the nosing line. */
const STRINGER_H = 0.26;
const STRINGER_OFF = 0.08;
/** Baluster spacing under the steel handrails. */
const BALUSTER_PITCH = 0.24;
/** Safety yellow of the steel nosings. */
export const NOSING_YELLOW = "#E3B417";

export interface Flight {
  xa: number;
  xb: number;
  zTop: number;
  zBot: number;
  yTop: number;
  yBot: number;
  run: number;
  drop: number;
  /** +1 when the bottom is at larger z. */
  dir: number;
  /** Slope angle (rad, positive). */
  th: number;
  /** `addBox` pitch of a box laid along the slope. */
  pitch: number;
  /** Slope length (nosing line). */
  len: number;
  /** Risers and their rise / going. */
  n: number;
  rise: number;
  going: number;
  xm: number;
  zm: number;
  ym: number;
  /** Up-normal of the slope (y, z components). */
  ny: number;
  nz: number;
}

/** A straight flight; `rise` is the target riser height. */
export function flight(
  xa: number,
  xb: number,
  zTop: number,
  zBot: number,
  yTop: number,
  yBot: number,
  rise = 0.2,
): Flight {
  const run = Math.abs(zBot - zTop);
  const drop = yTop - yBot;
  const dir = Math.sign(zBot - zTop) || 1;
  const th = Math.atan2(drop, run);
  const n = Math.max(2, Math.round(drop / rise));
  return {
    xa,
    xb,
    zTop,
    zBot,
    yTop,
    yBot,
    run,
    drop,
    dir,
    th,
    pitch: dir * th,
    len: Math.hypot(run, drop),
    n,
    rise: drop / n,
    going: run / n,
    xm: (xa + xb) / 2,
    zm: (zTop + zBot) / 2,
    ym: (yTop + yBot) / 2,
    ny: Math.cos(th),
    nz: dir * Math.sin(th),
  };
}

/** Nosing-line height at z (clamped to the flight's run). */
export function nosingY(f: Flight, z: number): number {
  const t = Math.min(1, Math.max(0, ((z - f.zTop) * f.dir) / f.run));
  return f.yTop - t * f.drop;
}

/** Vertical depth of the hidden ramp's underside below the nosing line. */
export const rampDepth = (f: Flight): number => RAMP_T / f.ny;

/**
 * Vertical depth of a steel flight's underside (stringer bottom; the ramp
 * underside if deeper) below the nosing line.
 */
export const steelDepth = (f: Flight): number =>
  Math.max(rampDepth(f), (STRINGER_OFF + STRINGER_H / 2) / f.ny);

/** Pitch of a flight in degrees. */
export const pitchDeg = (f: Flight): number => (f.th * 180) / Math.PI;

/** Nosing-line point at fraction t (0 = top nosing, 1 = bottom). */
export function nosingAt(f: Flight, t: number): { z: number; y: number } {
  return { z: f.zTop + f.dir * t * f.run, y: f.yTop - t * f.drop };
}

/**
 * Treads below the top floor: k = 1 … n − 1 (the lower floor is the n-th).
 * Riser k drops at the previous nosing; tread k spans one going from there
 * to its own nosing (its downhill edge), which lies ON the nosing line — so
 * the ramp through the nosings never sits below a tread. `zc` is the tread
 * centre, `yt` its top, `zNose` its nosing edge.
 */
export function treads(
  f: Flight,
): { k: number; zc: number; yt: number; zNose: number }[] {
  const out: { k: number; zc: number; yt: number; zNose: number }[] = [];
  for (let k = 1; k < f.n; k++) {
    const yt = f.yTop - k * f.rise;
    const zNose = f.zTop + f.dir * k * f.going;
    out.push({ k, zc: zNose - (f.dir * f.going) / 2, yt, zNose });
  }
  return out;
}

export interface StairBox {
  c: Vector3;
  s: Vector3;
  pitch: number;
}

/**
 * Hidden walkable ramp (thickness `T`): top face through both nosings,
 * extended `ext` past the bottom only (it sinks under the lower floor).
 */
export function rampBox(f: Flight, T = RAMP_T, ext = 0.15): StairBox {
  const w = f.xb - f.xa;
  const dz = (f.dir * f.run) / f.len;
  const dy = -f.drop / f.len;
  return {
    c: new Vector3(
      f.xm,
      f.ym + (dy * ext) / 2 - f.ny * (T / 2),
      f.zm + (dz * ext) / 2 - f.nz * (T / 2),
    ),
    s: new Vector3(w, T, f.len + ext),
    pitch: f.pitch,
  };
}

/**
 * Side guard at x over [za, zb] (default: the flight's own z range): vertical
 * segments ≤ GUARD_SEG long, each from GUARD_BELOW under the nosing line to
 * STAIR_GUARD_H over it (at the segment's uphill end), so the band follows
 * the slope, stops the walker stepping off the open side anywhere along the
 * flight, and leaves the space under the flight free.
 */
export function guardBoxes(
  f: Flight,
  x: number,
  za = f.zTop,
  zb = f.zBot,
  thick = 0.05,
): StairBox[] {
  const len = Math.abs(zb - za);
  if (len < 1e-6) return [];
  const n = Math.max(1, Math.ceil(len / GUARD_SEG - 1e-9));
  const out: StairBox[] = [];
  for (let i = 0; i < n; i++) {
    const z0 = za + ((zb - za) * i) / n;
    const z1 = za + ((zb - za) * (i + 1)) / n;
    const hi = Math.max(nosingY(f, z0), nosingY(f, z1));
    const y0 = hi - GUARD_BELOW;
    const y1 = hi + STAIR_GUARD_H;
    out.push({
      c: new Vector3(x, (y0 + y1) / 2, (z0 + z1) / 2),
      s: new Vector3(thick, y1 - y0, len / n),
      pitch: 0,
    });
  }
  return out;
}

/**
 * z (along the run) where the headroom under the flight reaches `clear`:
 * headroom is the underside (`depth` under the nosing line) above `floorY`.
 * Between the low end and this z the flight is too low to walk under; null
 * when the whole underside clears it.
 */
export function headroomZ(
  f: Flight,
  floorY: number,
  depth: number,
  clear = STAIR_HEADROOM,
): number | null {
  const h0 = f.yBot - depth - floorY;
  if (h0 >= clear) return null;
  const u = Math.min(f.run, ((clear - h0) / f.drop) * f.run);
  return f.zBot - f.dir * u;
}

/**
 * The closed nook under a flight's low end: full-width vertical slices from
 * `floorY` up to just under the flight's underside (`depth` below the
 * nosing line), over the run where the headroom is below `clear`. Uphill of
 * it the floor under the flight is free.
 */
export function underBlockers(
  f: Flight,
  floorY: number,
  depth: number,
  clear = STAIR_HEADROOM,
): StairBox[] {
  const zHi = headroomZ(f, floorY, depth, clear);
  if (zHi === null) return [];
  const slope = f.drop / f.run;
  const h0 = f.yBot - depth - floorY;
  // Run (from the bottom nosing) where the underside leaves the floor.
  const uLo = Math.max(0, -h0 / slope);
  const uHi = Math.abs(zHi - f.zBot);
  if (uHi <= uLo + 1e-6) return [];
  const n = Math.max(1, Math.ceil((uHi - uLo) / BLOCK_SEG - 1e-9));
  const w = f.xb - f.xa;
  const out: StairBox[] = [];
  for (let i = 0; i < n; i++) {
    const u0 = uLo + ((uHi - uLo) * i) / n;
    const u1 = uLo + ((uHi - uLo) * (i + 1)) / n;
    // Headroom at the slice's downhill end: the box never reaches the ramp.
    const h = h0 + slope * u0 - 0.01;
    if (h < 0.05) continue;
    out.push({
      c: new Vector3(f.xm, floorY + h / 2, f.zBot - f.dir * ((u0 + u1) / 2)),
      s: new Vector3(w, h, u1 - u0),
      pitch: 0,
    });
  }
  return out;
}

/**
 * Blocker under a level landing / deck (plan `r`, underside at `bottomY`)
 * when it is lower than `clear` above `floorY`; null when it clears it.
 */
export function landingBlocker(
  r: PlanBox,
  bottomY: number,
  floorY: number,
  clear = STAIR_HEADROOM,
): StairBox | null {
  if (bottomY - floorY >= clear) return null;
  const h = bottomY - floorY - 0.01;
  if (h < 0.05) return null;
  return {
    c: new Vector3((r.x0 + r.x1) / 2, floorY + h / 2, (r.z0 + r.z1) / 2),
    s: new Vector3(r.x1 - r.x0, h, r.z1 - r.z0),
    pitch: 0,
  };
}

/** Bar following the nosing line at height `h` above it (handrails). */
export function railBox(
  f: Flight,
  x: number,
  h = STAIR_RAIL_TOP,
  size = 0.04,
  trim = 0,
): StairBox {
  return {
    c: new Vector3(x, f.ym + h, f.zm),
    s: new Vector3(size, size, f.len - 2 * trim),
    pitch: f.pitch,
  };
}

/** Baluster feet along a flight edge (nosing line), ends inset 4 %. */
export function balusterSpots(
  f: Flight,
  pitch = BALUSTER_PITCH,
): { z: number; y: number }[] {
  const nb = Math.max(2, Math.round(f.run / pitch));
  const out: { z: number; y: number }[] = [];
  for (let i = 0; i <= nb; i++) out.push(nosingAt(f, 0.04 + (0.92 * i) / nb));
  return out;
}

const addBox = (
  sink: ColliderSink | null,
  group: string,
  b: StairBox,
  seeThrough = false,
): void => {
  sink?.addBox(group, b.c, b.s, 0, {
    pitch: b.pitch || undefined,
    seeThrough: seeThrough || undefined,
  });
};

function painted(b: ArtBatcher, hex: string, fn: () => void): void {
  const prev = b.paint;
  b.paint = paintOf(hex);
  fn();
  b.paint = prev;
}

export interface SteelFlightOpts {
  /** Handrails on the xa / xb edges. */
  rails?: { a: boolean; b: boolean };
  /**
   * The floor under the flight (default: the bottom nosing): where the
   * headroom over it is below STAIR_HEADROOM the underside is closed.
   */
  floorY?: number;
  /**
   * Side guards to shorten (world x of the side, which end, length): where
   * two flights meet a shared landing at the same level the divider stops
   * short so the landing is turnable.
   */
  trims?: { x: number; end: "top" | "bottom"; len: number }[];
  /** Skip the side guards (a wall or another guard closes that side). */
  guards?: { a: boolean; b: boolean };
}

/**
 * Industrial steel flight: galvanised treads with yellow nosings, two
 * painted stringers, slim black flat-bar handrails at 0.95 m with balusters
 * below (visual), plus the ramp, the side guard bands and the low-end
 * nook (colliders). Where the flight also has walkable headroom under it, a
 * yellow guard rail marks the nook's open faces (front at the 2 m line,
 * both sides back to the stringers).
 */
export function steelFlight(
  b: ArtBatcher,
  sink: ColliderSink | null,
  group: string,
  f: Flight,
  opts: SteelFlightOpts = {},
): void {
  const rails = opts.rails ?? { a: true, b: true };
  const guards = opts.guards ?? { a: true, b: true };
  const floorY = opts.floorY ?? f.yBot;
  const w = f.xb - f.xa;
  for (const t of treads(f)) {
    b.box(
      "galvanised",
      v3(f.xm, t.yt - 0.02, t.zc),
      v3(w - 0.08, 0.04, f.going + 0.03),
    );
    painted(b, NOSING_YELLOW, () =>
      b.box(
        "paint",
        v3(f.xm, t.yt + 0.001, t.zNose - f.dir * 0.03),
        v3(w - 0.1, 0.006, 0.05),
      ),
    );
  }
  for (const x of [f.xa + 0.04, f.xb - 0.04])
    b.box(
      "steelPainted",
      v3(x, f.ym - 0.08 * f.ny, f.zm - 0.08 * f.nz),
      v3(0.06, 0.26, f.len),
      { pitch: f.pitch },
    );
  const sides = [
    { x: f.xa + 0.025, rail: rails.a, guard: guards.a },
    { x: f.xb - 0.025, rail: rails.b, guard: guards.b },
  ];
  for (const sd of sides) {
    if (sd.rail) {
      const r = railBox(f, sd.x);
      b.box("blackMetal", r.c, r.s, { pitch: r.pitch });
      for (const p of balusterSpots(f))
        b.box(
          "blackMetal",
          v3(sd.x, p.y + 0.04 + (STAIR_RAIL_TOP - 0.06) / 2, p.z),
          v3(0.018, STAIR_RAIL_TOP - 0.06, 0.018),
        );
    }
    if (!sd.guard) continue;
    const trim = opts.trims?.find((t) => Math.abs(t.x - sd.x) < 0.1);
    let za = f.zTop;
    let zb = f.zBot;
    if (trim?.end === "top") za = f.zTop + f.dir * trim.len;
    if (trim?.end === "bottom") zb = f.zBot - f.dir * trim.len;
    for (const g of guardBoxes(f, sd.x, za, zb)) addBox(sink, group, g);
  }
  addBox(sink, group, rampBox(f));
  const depth = steelDepth(f);
  for (const k of underBlockers(f, floorY, depth)) addBox(sink, group, k);
  painted(b, NOSING_YELLOW, () => nookRail(b, "paint", f, floorY, depth));
}

/**
 * Guard rail round the nook under a flight's low end (where `underBlockers`
 * closes it), drawn only when the flight also has walkable headroom under
 * it: posts at both edges on the 2 m headroom line, front and side rails at
 * 0.5 and 1.0 m (each side rail runs downhill until it meets the underside).
 */
export function nookRail(
  b: ArtBatcher,
  mat: "paint" | "blackMetal",
  f: Flight,
  floorY: number,
  depth: number,
): void {
  const zHi = headroomZ(f, floorY, depth);
  if (zHi === null || Math.abs(zHi - f.zTop) < 0.05) return;
  const xs = [f.xa + 0.04, f.xb - 0.04];
  const hPost = nosingY(f, zHi) - depth - floorY;
  for (const x of xs)
    b.box(mat, v3(x, floorY + hPost / 2, zHi), v3(0.05, hPost, 0.05));
  for (const h of [0.5, 1.0]) {
    b.box(mat, v3(f.xm, floorY + h, zHi), v3(xs[1] - xs[0], 0.04, 0.04));
    const zEnd = headroomZ(f, floorY, depth, h) ?? f.zBot;
    const len = Math.abs(zHi - zEnd);
    if (len < 0.05) continue;
    for (const x of xs)
      b.box(mat, v3(x, floorY + h, (zHi + zEnd) / 2), v3(0.04, 0.04, len));
  }
}

export interface PlanBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Grating landing plate with an edge channel and a collider (top at y).
 * With `floorY`, a landing lower than STAIR_HEADROOM over that floor gets a
 * blocker under it (no wedging under a head-height deck).
 */
export function steelLanding(
  b: ArtBatcher,
  sink: ColliderSink | null,
  group: string,
  r: PlanBox,
  y: number,
  floorY?: number,
): void {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  b.box(
    "galvanised",
    v3(cx, y - 0.025, cz),
    v3(r.x1 - r.x0, 0.05, r.z1 - r.z0),
  );
  b.box("steelPainted", v3(cx, y - 0.12, cz), v3(r.x1 - r.x0, 0.14, 0.08));
  addBox(sink, group, {
    c: new Vector3(cx, y - 0.1, cz),
    s: new Vector3(r.x1 - r.x0, 0.2, r.z1 - r.z0),
    pitch: 0,
  });
  if (floorY === undefined) return;
  const k = landingBlocker(r, y - 0.2, floorY);
  if (k) addBox(sink, group, k);
}

/**
 * Level guard rail (black flat bar at 0.95 m + balusters) along an axis at
 * height y0; its collider reaches 1.1 m from `colliderY0`.
 */
export function steelRail(
  b: ArtBatcher,
  sink: ColliderSink | null,
  group: string,
  axis: "x" | "z",
  fixed: number,
  a0: number,
  a1: number,
  y0: number,
  colliderY0 = y0,
): void {
  const len = Math.abs(a1 - a0);
  if (len < 0.05) return;
  const c = (a0 + a1) / 2;
  const at = (y: number) => (axis === "z" ? v3(fixed, y, c) : v3(c, y, fixed));
  const sz = (t: number, h: number) =>
    axis === "z" ? v3(t, h, len) : v3(len, h, t);
  b.box("blackMetal", at(y0 + STAIR_RAIL_TOP), sz(0.04, 0.04));
  const nb = Math.max(2, Math.round(len / BALUSTER_PITCH));
  for (let i = 0; i <= nb; i++) {
    const a = Math.min(a0, a1) + 0.03 + ((len - 0.06) * i) / nb;
    b.box(
      "blackMetal",
      axis === "z"
        ? v3(fixed, y0 + STAIR_RAIL_TOP / 2, a)
        : v3(a, y0 + STAIR_RAIL_TOP / 2, fixed),
      v3(0.018, STAIR_RAIL_TOP, 0.018),
    );
  }
  const h = y0 + STAIR_GUARD_H - colliderY0;
  addBox(sink, group, {
    c:
      axis === "z"
        ? new Vector3(fixed, colliderY0 + h / 2, c)
        : new Vector3(c, colliderY0 + h / 2, fixed),
    s: axis === "z" ? new Vector3(0.08, h, len) : new Vector3(len, h, 0.08),
    pitch: 0,
  });
}

/** Square steel post (visual + collider) from y0 to y1. */
export function steelPost(
  b: ArtBatcher,
  sink: ColliderSink | null,
  group: string,
  x: number,
  z: number,
  y0: number,
  y1: number,
): void {
  b.box("steelPainted", v3(x, (y0 + y1) / 2, z), v3(0.12, y1 - y0, 0.12));
  addBox(sink, group, {
    c: new Vector3(x, (y0 + y1) / 2, z),
    s: new Vector3(0.14, y1 - y0, 0.14),
    pitch: 0,
  });
}
