/**
 * Inspection-station planning (pure, Node-testable): colours, glyph atlas
 * mapping, arm kinematics and per-part instance matrices for `Stations.ts`.
 *
 * Station local frame (yaw = belt heading): origin on the FLOOR under the belt
 * centreline, +X downstream, +Y up, +Z across the belt (left). Geometry is
 * authored for a 0.9 m belt and stretched across (Z) for other widths.
 *
 *   housing  gantry (2 uprights + sensor box), hood bezel, beacon base/cap,
 *            arm pedestal + turret          — vertex-coloured, static
 *   hood     emissive light panel under the sensor box   — per-instance colour
 *   arm1-3   shoulder+upper arm, elbow+forearm, wrist+sensor head
 *   beacon   lens on the sensor box                      — per-instance colour
 *   glyph    a 7-face "kind drum" flush with each face of the sensor box; the
 *            instance rotation turns the CheckKind's face outward, the other
 *            six faces sit inside the opaque box (no custom shader needed)
 */
import type { CheckKind, CheckState } from "@/engine/contracts";
import { stateColor } from "@/engine/logic/factoryModel";
import {
  chain,
  hexToLinear,
  rotY,
  rotZ,
  scaling,
  translation,
  type Mat4,
} from "./poolMath";

export interface StationInstance {
  id: string;
  /** Floor-level position under the belt centreline. */
  x: number;
  y: number;
  z: number;
  /** Belt heading (yaw turning local +X downstream). */
  yaw: number;
  state: CheckState;
  kind: CheckKind;
  /** Belt width under the gantry (default 0.9). */
  beltWidth?: number;
}

export type Rgb = [number, number, number];

/** Nominal geometry (metres, station local frame, 0.9 m belt). */
export const STATION = {
  beltWidth: 0.9,
  uprightZ: 0.61,
  boxX: 0.3,
  boxY0: 1.95,
  boxY1: 2.35,
  boxZ: 0.72,
  hoodY: 1.928,
  beacon: { x: 0.17, z: 0.56, y0: 2.39, y1: 2.55, r: 0.05 },
  glyph: { w: 0.6, h: 0.15, faces: 7, y: 2.15 },
  pedestal: { x: 0.42, z: -0.87, h: 0.78, turret: 0.14 },
  arm: { l1: 0.55, l2: 0.5, tool: 0.2 },
} as const;

/** Atlas row order of the glyph drum faces. */
export const GLYPH_KINDS: readonly CheckKind[] = [
  "lint",
  "build",
  "test",
  "security",
  "deploy",
  "release",
  "other",
];

export const GLYPH_LABELS: Record<CheckKind, string> = {
  lint: "LINT",
  build: "BUILD",
  test: "TEST",
  security: "SECURITY",
  deploy: "DEPLOY",
  release: "RELEASE",
  other: "CHECK",
};

export function glyphIndex(kind: CheckKind): number {
  const i = GLYPH_KINDS.indexOf(kind);
  return i < 0 ? GLYPH_KINDS.length - 1 : i;
}

/** Apothem of the glyph drum (face h, N faces). */
export function drumApothem(): number {
  const { h, faces } = STATION.glyph;
  return h / (2 * Math.tan(Math.PI / faces));
}

// ---------------------------------------------------------------------------
// Colours (linear RGB, HDR where emissive)
// ---------------------------------------------------------------------------

/** Beacon colour at full strength: `stateColor` (CHECK_COLORS) in linear space. */
export function beaconBase(state: CheckState): Rgb {
  return hexToLinear(stateColor(state));
}

export function isAnimated(state: CheckState): boolean {
  return state === "running" || state === "failure" || state === "queued";
}

/** Steady beacon intensity per state (HDR multiplier; > 1 blooms). */
const BEACON_LEVEL: Record<CheckState, number> = {
  success: 4.5,
  queued: 4.0,
  running: 5.5,
  failure: 8,
  cancelled: 1,
  none: 1,
};

/** Slow amber blink period (s). */
export const QUEUED_PERIOD = 1.6;
/** Blue running beacon: sweeps per second of the "rotating" highlight. */
export const RUNNING_HZ = 1.25;

/**
 * Beacon intensity at time `t` (s):
 *   queued   slow soft-square amber blink (1.6 s period)
 *   running  rotating-beacon pulse (a sharp highlight sweeping at 1.25 Hz)
 *   failure  red double-flash strobe (1 Hz)
 *   others   steady (success green; cancelled / none are grey, see below)
 */
export function beaconLevel(state: CheckState, t: number): number {
  const base = BEACON_LEVEL[state];
  if (state === "queued") {
    const k = Math.min(
      1,
      Math.max(0, 0.5 + 1.3 * Math.sin((2 * Math.PI * t) / QUEUED_PERIOD)),
    );
    return base * (0.08 + 0.92 * k);
  }
  if (state === "running") {
    const c = 0.5 + 0.5 * Math.cos(2 * Math.PI * RUNNING_HZ * t);
    return base * (0.3 + 0.95 * c * c * c);
  }
  if (state === "failure") {
    const ph = ((t % 1) + 1) % 1;
    const on = ph < 0.07 || (ph > 0.16 && ph < 0.23);
    return on ? base * 1.6 : base * 0.18;
  }
  return base;
}

/** Unlit lens (no / cancelled check): frosted grey, not a black hole. */
export const BEACON_OFF: Rgb = [0.2, 0.21, 0.23];

const BASE_RGB: Record<CheckState, Rgb> = {
  success: beaconBase("success"),
  queued: beaconBase("queued"),
  running: beaconBase("running"),
  failure: beaconBase("failure"),
  cancelled: beaconBase("cancelled"),
  none: beaconBase("none"),
};

/** Allocation-free `beaconColor`: writes RGBA at `out[o..o+3]`. */
export function writeBeaconRgba(
  state: CheckState,
  t: number,
  out: Float32Array,
  o: number,
): void {
  if (state === "none" || state === "cancelled") {
    out[o] = BEACON_OFF[0];
    out[o + 1] = BEACON_OFF[1];
    out[o + 2] = BEACON_OFF[2];
  } else {
    const c = BASE_RGB[state];
    const k = beaconLevel(state, t);
    out[o] = c[0] * k;
    out[o + 1] = c[1] * k;
    out[o + 2] = c[2] * k;
  }
  out[o + 3] = 1;
}

export function beaconColor(state: CheckState, t: number): Rgb {
  if (state === "none" || state === "cancelled") return [...BEACON_OFF];
  const c = BASE_RGB[state];
  const k = beaconLevel(state, t);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Hood (inspection light) colour: bright cool white while scanning. */
export function hoodColor(state: CheckState): Rgb {
  switch (state) {
    case "running":
      return [2.6, 2.8, 3.0];
    case "failure":
      return [1.4, 0.22, 0.2];
    case "success":
      return [0.55, 0.6, 0.62];
    case "queued":
      return [0.32, 0.34, 0.37];
    default:
      return [0.05, 0.05, 0.06];
  }
}

/** Glyph plate tint: near-white, a touch of the state colour, dim when idle. */
export function glyphColor(state: CheckState): Rgb {
  const c = beaconBase(state);
  const dim = state === "none" || state === "cancelled";
  const k = dim ? 0.38 : 1.15;
  const mix = 0.22;
  return [
    (1 - mix + mix * c[0]) * k,
    (1 - mix + mix * c[1]) * k,
    (1 - mix + mix * c[2]) * k,
  ];
}

// ---------------------------------------------------------------------------
// Arm kinematics
// ---------------------------------------------------------------------------

/** Joint angles (rad): yaw of the arm plane, then shoulder / elbow / wrist pitch. */
export interface ArmPose {
  yaw: number;
  shoulder: number;
  elbow: number;
  wrist: number;
}

/** Static default poses (Phase 3 animates between them via `setArmPose`). */
export function armPoseFor(state: CheckState): ArmPose {
  const yaw = Math.PI / 2; // arm plane faces the belt (+Z local)
  switch (state) {
    case "running": // reaching over the belt, sensor pointing down
      return { yaw, shoulder: 0.6, elbow: 1.2, wrist: 0.9 };
    case "failure": // raised, alert
      return { yaw, shoulder: 0.15, elbow: 0.35, wrist: -0.2 };
    case "none":
    case "cancelled": // folded
      return { yaw, shoulder: -0.1, elbow: 2.2, wrist: 0.9 };
    default: // parked high, watching the belt
      return { yaw, shoulder: -0.25, elbow: 0.9, wrist: 0.95 };
  }
}

/** Station frame: (stretch across) → yaw → position. */
export function stationFrame(st: StationInstance): Mat4 {
  return chain(rotY(st.yaw), translation(st.x, st.y, st.z));
}

export function acrossScale(st: StationInstance): number {
  return (st.beltWidth ?? STATION.beltWidth) / STATION.beltWidth;
}

/** Housing / hood / beacon matrix (stretched across the belt). */
export function housingMatrix(st: StationInstance): Mat4 {
  return chain(scaling(1, 1, acrossScale(st)), stationFrame(st));
}

/**
 * Forward kinematics → the three arm segment matrices. Each segment mesh is
 * authored with its joint at the origin and the link along +Y.
 */
export function armMatrices(
  st: StationInstance,
  pose: ArmPose,
): [Mat4, Mat4, Mat4] {
  const P = STATION.pedestal;
  const A = STATION.arm;
  const base = chain(
    rotY(pose.yaw),
    translation(P.x, P.h + P.turret, P.z * acrossScale(st)),
    stationFrame(st),
  );
  const m1 = chain(rotZ(pose.shoulder), base);
  const m2 = chain(rotZ(pose.elbow), translation(0, A.l1, 0), m1);
  const m3 = chain(rotZ(pose.wrist), translation(0, A.l2, 0), m2);
  return [m1, m2, m3];
}

/**
 * Glyph drum matrices: front (downstream face, +X) and back (upstream face,
 * turned 180° about Y). The rotation about the drum axis (local Z) brings
 * face `glyphIndex(kind)` outward.
 */
export function glyphMatrices(st: StationInstance): [Mat4, Mat4] {
  const step = (2 * Math.PI) / STATION.glyph.faces;
  const k = glyphIndex(st.kind);
  const cx = STATION.boxX + 0.002 - drumApothem();
  const spin = rotZ(k * step);
  const frame = stationFrame(st);
  const front = chain(spin, translation(cx, STATION.glyph.y, 0), frame);
  const back = chain(
    spin,
    translation(cx, STATION.glyph.y, 0),
    rotY(Math.PI),
    frame,
  );
  return [front, back];
}

// ---------------------------------------------------------------------------
// Change detection / ordering
// ---------------------------------------------------------------------------

export function stationKey(list: readonly StationInstance[]): string {
  const f = (v: number) => v.toFixed(3);
  return list
    .map(
      (s) =>
        `${s.id}:${f(s.x)},${f(s.y)},${f(s.z)},${f(s.yaw)}:${s.state}:${s.kind}:${f(s.beltWidth ?? STATION.beltWidth)}`,
    )
    .join("|");
}

/**
 * Animated stations (running / failure) first, input order otherwise kept, so
 * a per-frame beacon refresh touches one contiguous prefix of the buffer.
 */
export function orderStations(list: readonly StationInstance[]): {
  order: StationInstance[];
  animated: number;
} {
  const anim = list.filter((s) => isAnimated(s.state));
  const rest = list.filter((s) => !isAnimated(s.state));
  return { order: [...anim, ...rest], animated: anim.length };
}

/** Write `beaconColor` for the first `count` stations into an RGBA buffer. */
export function writeBeaconColors(
  order: readonly StationInstance[],
  count: number,
  t: number,
  out: Float32Array,
  /** Optional per-instance time offsets (s); default: index-based stagger. */
  phases?: Float32Array,
): void {
  for (let i = 0; i < count; i++)
    writeBeaconRgba(
      order[i].state,
      t + (phases ? phases[i] : beaconPhase(i)),
      out,
      i * 4,
    );
}

/** Tiny per-station phase offset so a row of running beacons isn't lock-stepped. */
export function beaconPhase(i: number): number {
  return ((i * 0.618) % 1) * 0.35;
}
