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
 *   rampBox(f)        the hidden walkable ramp: its TOP face runs exactly
 *                     through the top and bottom nosings (flush with both
 *                     floors, no lip) and only extends below the bottom one
 *                     (sinking under the lower floor)
 *   guardBox(...)     vertical side guard over the flight's own z range only
 *                     (never pokes into a landing)
 *   railBox(...)      handrail bar along the nosing line (visual)
 *   balusterSpots(f)  baluster feet along a flight edge
 *   steelFlight(...)  galvanised treads + yellow nosings + painted stringers
 *                     + black flat-bar handrails, with ramp and guards
 *   steelLanding / steelRail / steelPost   the matching level parts
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
export function rampBox(f: Flight, T = 0.2, ext = 0.15): StairBox {
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
 * Vertical side guard at x from `floorY` to the top nosing + guard height,
 * over [za, zb] (default: the flight's own z range).
 */
export function guardBox(
  f: Flight,
  x: number,
  floorY: number,
  za = f.zTop,
  zb = f.zBot,
  thick = 0.05,
): StairBox {
  const top = f.yTop + STAIR_GUARD_H;
  return {
    c: new Vector3(x, (floorY + top) / 2, (za + zb) / 2),
    s: new Vector3(thick, top - floorY, Math.abs(zb - za)),
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
  /** Side guards run from here up (default: the bottom nosing). */
  guardFloor?: number;
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
 * below (visual), plus the ramp and the vertical side guards (colliders).
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
  const guardFloor = opts.guardFloor ?? f.yBot;
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
    addBox(sink, group, guardBox(f, sd.x, guardFloor, za, zb));
  }
  addBox(sink, group, rampBox(f));
}

export interface PlanBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Grating landing plate with an edge channel and a collider (top at y). */
export function steelLanding(
  b: ArtBatcher,
  sink: ColliderSink | null,
  group: string,
  r: PlanBox,
  y: number,
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
