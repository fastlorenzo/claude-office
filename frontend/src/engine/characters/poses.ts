/**
 * Procedural pose library for the mannequin (pure maths, no Babylon).
 *
 * A PoseFrame holds the hips offset (metres, rig-local, +Y up, +Z forward)
 * and one Euler triple (x = pitch, y = yaw, z = roll; applied as Babylon's
 * RotationYawPitchRoll) per joint. Sign conventions (Babylon, left-handed):
 *   - limb hanging down, rot.x < 0 swings it FORWARD (+Z); > 0 backward
 *   - knee flex is rot.x > 0, elbow flex is rot.x < 0
 *   - spine/neck/head rot.x > 0 leans/nods forward
 *   - rot.z > 0 swings a hanging limb toward +X (character's right)
 *
 * The character faces +Z; "L" joints sit at -X, "R" joints at +X.
 */

import type { CharacterPose } from "../contracts";

export const JOINTS = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "shoulderL",
  "elbowL",
  "wristL",
  "shoulderR",
  "elbowR",
  "wristR",
  "hipL",
  "kneeL",
  "ankleL",
  "hipR",
  "kneeR",
  "ankleR",
] as const;

export type Joint = (typeof JOINTS)[number];

export const JOINT_INDEX: Record<Joint, number> = Object.fromEntries(
  JOINTS.map((j, i) => [j, i]),
) as Record<Joint, number>;

/** Rest skeleton: parent + offset from parent (metres, standing). */
export const SKELETON: Record<
  Joint,
  { parent: Joint | null; offset: [number, number, number] }
> = {
  hips: { parent: null, offset: [0, 0.94, 0] },
  spine: { parent: "hips", offset: [0, 0.08, 0] },
  chest: { parent: "spine", offset: [0, 0.2, 0] },
  neck: { parent: "chest", offset: [0, 0.2, 0.0] },
  head: { parent: "neck", offset: [0, 0.08, 0.005] },
  shoulderL: { parent: "chest", offset: [-0.19, 0.175, -0.005] },
  elbowL: { parent: "shoulderL", offset: [0, -0.27, 0] },
  wristL: { parent: "elbowL", offset: [0, -0.245, 0] },
  shoulderR: { parent: "chest", offset: [0.19, 0.175, -0.005] },
  elbowR: { parent: "shoulderR", offset: [0, -0.27, 0] },
  wristR: { parent: "elbowR", offset: [0, -0.245, 0] },
  hipL: { parent: "hips", offset: [-0.093, -0.04, 0] },
  kneeL: { parent: "hipL", offset: [0, -0.425, 0] },
  ankleL: { parent: "kneeL", offset: [0, -0.405, 0] },
  hipR: { parent: "hips", offset: [0.093, -0.04, 0] },
  kneeR: { parent: "hipR", offset: [0, -0.425, 0] },
  ankleR: { parent: "kneeR", offset: [0, -0.405, 0] },
};

export const STAND_HIPS_Y = SKELETON.hips.offset[1];
/** Chair seat surface height (Poly Haven modern_arm_chair_01 ≈ 0.47 m). */
export const SEAT_HEIGHT = 0.47;
/** Hips bone height when seated: thigh underside (r≈0.075) rests on the seat. */
export const SEAT_HIPS_Y = SEAT_HEIGHT + 0.075 + 0.04;
/** Metres per full walk cycle (two steps). */
export const STRIDE_CYCLE_M = 1.45;

export interface PoseFrame {
  /** Hips bone position (rig-local). */
  hips: [number, number, number];
  /** JOINTS.length * 3 Euler angles. */
  rot: number[];
}

export interface PoseContext {
  /** Global animation clock (s). */
  t: number;
  /** Seconds since this pose became active (for one-shot clips). */
  age: number;
  /** Walk cycle phase (radians). */
  phase: number;
  /** Per-character 0..1 seed to desynchronise idles. */
  seed: number;
}

export function createFrame(): PoseFrame {
  return {
    hips: [0, STAND_HIPS_Y, 0],
    rot: new Array(JOINTS.length * 3).fill(0),
  };
}

export function copyFrame(src: PoseFrame, out: PoseFrame): PoseFrame {
  out.hips[0] = src.hips[0];
  out.hips[1] = src.hips[1];
  out.hips[2] = src.hips[2];
  for (let i = 0; i < src.rot.length; i++) out.rot[i] = src.rot[i];
  return out;
}

function reset(out: PoseFrame): PoseFrame {
  out.hips[0] = 0;
  out.hips[1] = STAND_HIPS_Y;
  out.hips[2] = 0;
  out.rot.fill(0);
  return out;
}

function set(out: PoseFrame, j: Joint, x: number, y = 0, z = 0): void {
  const i = JOINT_INDEX[j] * 3;
  out.rot[i] = x;
  out.rot[i + 1] = y;
  out.rot[i + 2] = z;
}

function add(out: PoseFrame, j: Joint, x: number, y = 0, z = 0): void {
  const i = JOINT_INDEX[j] * 3;
  out.rot[i] += x;
  out.rot[i + 1] += y;
  out.rot[i + 2] += z;
}

export function getJoint(f: PoseFrame, j: Joint): [number, number, number] {
  const i = JOINT_INDEX[j] * 3;
  return [f.rot[i], f.rot[i + 1], f.rot[i + 2]];
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, w: number): number => a + (b - a) * w;

/** out = a + (b - a) * w (component-wise; angles are small so Euler lerp is fine). */
export function blendFrames(
  a: PoseFrame,
  b: PoseFrame,
  w: number,
  out: PoseFrame,
): PoseFrame {
  const k = clamp01(w);
  for (let i = 0; i < 3; i++) out.hips[i] = lerp(a.hips[i], b.hips[i], k);
  for (let i = 0; i < a.rot.length; i++)
    out.rot[i] = lerp(a.rot[i], b.rot[i], k);
  return out;
}

/** Smooth pseudo-noise in [-1, 1] from layered sines (deterministic). */
function wobble(t: number, seed: number): number {
  const s = seed * 17.3;
  return (
    Math.sin(t * 0.73 + s) * 0.5 +
    Math.sin(t * 1.37 + s * 2.1) * 0.3 +
    Math.sin(t * 2.91 + s * 3.7) * 0.2
  );
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

function breathe(out: PoseFrame, c: PoseContext, rate = 0.27, amp = 1): number {
  const b = Math.sin((c.t + c.seed * 3) * Math.PI * 2 * rate);
  add(out, "chest", -0.018 * amp * b);
  add(out, "neck", 0.012 * amp * b);
  add(out, "shoulderL", 0, 0, 0.012 * amp * b);
  add(out, "shoulderR", 0, 0, -0.012 * amp * b);
  return b;
}

function standingIdle(out: PoseFrame, c: PoseContext): void {
  reset(out);
  const shift = Math.sin((c.t + c.seed * 10) * Math.PI * 2 * 0.09); // slow weight shift
  out.hips[0] = 0.018 * shift;
  out.hips[1] = STAND_HIPS_Y - 0.008 - 0.004 * Math.abs(shift);
  set(out, "hips", 0, 0.03 * wobble(c.t * 0.2, c.seed), -0.035 * shift);
  set(out, "spine", 0.02, 0, 0.02 * shift);
  set(out, "chest", 0.01, 0, 0.015 * shift);
  // Loaded leg straight, relaxed leg slightly bent.
  const relaxL = clamp01(0.5 + shift * 0.8);
  const relaxR = 1 - relaxL;
  set(out, "hipL", -0.04 * relaxL, 0.03, 0.035 * shift - 0.02);
  set(out, "kneeL", 0.13 * relaxL + 0.02);
  set(out, "ankleL", -0.09 * relaxL);
  set(out, "hipR", -0.04 * relaxR, -0.03, 0.035 * shift + 0.02);
  set(out, "kneeR", 0.13 * relaxR + 0.02);
  set(out, "ankleR", -0.09 * relaxR);
  set(out, "shoulderL", 0.03, 0.1, -0.09);
  set(out, "elbowL", -0.16);
  set(out, "wristL", 0, 0, 0.05);
  set(out, "shoulderR", 0.03, -0.1, 0.09);
  set(out, "elbowR", -0.18);
  set(out, "wristR", 0, 0, -0.05);
  set(out, "neck", 0.02);
  set(
    out,
    "head",
    0.03 + 0.04 * wobble(c.t * 0.5, c.seed + 0.3),
    0.25 * wobble(c.t * 0.35, c.seed),
    -0.02 * shift,
  );
  breathe(out, c);
}

/** Base seated frame: hips on the chair, thighs horizontal, shins down. */
function seatedBase(out: PoseFrame): void {
  reset(out);
  out.hips[1] = SEAT_HIPS_Y;
  out.hips[2] = 0;
  set(out, "hips", -0.06);
  set(out, "spine", 0.04);
  set(out, "chest", 0.02);
  // thigh pitch -1.45 (slightly downhill), knee flex brings shins vertical.
  set(out, "hipL", -1.47, 0.08, -0.05);
  set(out, "kneeL", 1.37);
  set(out, "ankleL", 0.06);
  set(out, "hipR", -1.47, -0.08, 0.05);
  set(out, "kneeR", 1.37);
  set(out, "ankleR", 0.06);
}

function sitting(out: PoseFrame, c: PoseContext): void {
  seatedBase(out);
  // Forearms resting on the desk edge.
  set(out, "shoulderL", -0.42, 0.25, -0.12);
  set(out, "elbowL", -1.0);
  set(out, "wristL", 0.1, 0, 0.15);
  set(out, "shoulderR", -0.42, -0.25, 0.12);
  set(out, "elbowR", -1.0);
  set(out, "wristR", 0.1, 0, -0.15);
  set(out, "neck", 0.04);
  set(
    out,
    "head",
    0.06 + 0.04 * wobble(c.t * 0.4, c.seed),
    0.18 * wobble(c.t * 0.3, c.seed + 0.5),
    0,
  );
  breathe(out, c);
}

function typing(out: PoseFrame, c: PoseContext): void {
  seatedBase(out);
  set(out, "spine", 0.1);
  set(out, "chest", 0.05);
  const burst = 0.55 + 0.45 * Math.sin(c.t * 0.9 + c.seed * 6); // typing intensity
  const tL = Math.max(0, Math.sin(c.t * 13.0 + c.seed * 4)) * burst;
  const tR = Math.max(0, Math.sin(c.t * 11.3 + 1.7 + c.seed * 9)) * burst;
  // Upper arms slightly forward and out, forearms near-horizontal toward keys.
  set(out, "shoulderL", -0.46 - 0.02 * tL, 0.3, -0.2);
  set(out, "elbowL", -1.34 + 0.05 * tL);
  set(out, "wristL", 0.18 + 0.16 * tL, 0, 0.1);
  set(out, "shoulderR", -0.46 - 0.02 * tR, -0.3, 0.2);
  set(out, "elbowR", -1.34 + 0.05 * tR);
  set(out, "wristR", 0.18 + 0.16 * tR, 0, -0.1);
  // Focused on the monitor: small reading saccades and micro nods.
  const read = Math.sin(c.t * 0.55 + c.seed * 5);
  set(out, "neck", 0.06);
  set(
    out,
    "head",
    0.1 + 0.02 * Math.sin(c.t * 1.9 + c.seed),
    0.07 * read,
    0.015 * Math.sin(c.t * 0.7),
  );
  breathe(out, c, 0.3, 0.8);
}

function thinking(out: PoseFrame, c: PoseContext): void {
  seatedBase(out);
  set(out, "spine", 0.12, 0.05, 0);
  set(out, "chest", 0.04, 0.05, -0.03);
  // Right elbow on the desk, fist to chin.
  const tap = Math.sin(c.t * 1.2 + c.seed * 3);
  set(out, "shoulderR", -0.88, -0.48, -0.02);
  set(out, "elbowR", -2.35 + 0.03 * tap);
  set(out, "wristR", 0.35, 0, -0.1);
  // Left forearm resting across the desk.
  set(out, "shoulderL", -0.45, 0.45, -0.15);
  set(out, "elbowL", -1.05);
  set(out, "wristL", 0.15, 0, 0.1);
  set(out, "neck", 0.05);
  set(
    out,
    "head",
    0.0 + 0.05 * wobble(c.t * 0.25, c.seed),
    -0.12 + 0.12 * wobble(c.t * 0.18, c.seed + 0.7),
    0.12,
  );
  breathe(out, c, 0.18, 1.2);
}

function raiseHand(out: PoseFrame, c: PoseContext): void {
  sitting(out, c);
  const wave = Math.sin(c.t * Math.PI * 2 * 1.6);
  set(out, "spine", 0.0, 0, -0.06);
  set(out, "chest", -0.02, 0, -0.05);
  // Right arm high, waving from the elbow.
  set(out, "shoulderR", -2.85, -0.2, 0.32 + 0.1 * wave);
  set(out, "elbowR", -0.42 - 0.18 * wave);
  set(out, "wristR", 0.1, 0, -0.25 * wave);
  set(out, "neck", -0.05);
  set(out, "head", -0.12, 0.15, -0.06);
}

function celebrating(out: PoseFrame, c: PoseContext): void {
  // Short cheer then settle back into the sitting pose.
  sitting(out, c);
  const env = 1 - smoothstep((c.age - 1.6) / 0.7);
  if (env <= 0) return;
  const cheer = createFrameCache();
  sitting(cheer, c);
  const pump = Math.sin(c.age * Math.PI * 2 * 2.2);
  const rise = smoothstep(c.age / 0.25);
  set(cheer, "spine", -0.08);
  set(cheer, "chest", -0.06);
  set(cheer, "shoulderL", -2.65 - 0.18 * pump, 0.1, -0.5);
  set(cheer, "elbowL", -0.35 - 0.25 * pump);
  set(cheer, "wristL", 0.2, 0, 0);
  set(cheer, "shoulderR", -2.65 - 0.18 * pump, -0.1, 0.5);
  set(cheer, "elbowR", -0.35 - 0.25 * pump);
  set(cheer, "wristR", 0.2, 0, 0);
  set(cheer, "neck", -0.08);
  set(cheer, "head", -0.18 + 0.05 * pump, 0, 0);
  cheer.hips[1] += 0.015 * Math.max(0, pump);
  blendFrames(out, cheer, env * rise, out);
}

let _cheerFrame: PoseFrame | null = null;
function createFrameCache(): PoseFrame {
  _cheerFrame ??= createFrame();
  return _cheerFrame;
}

/** Walk cycle at phase c.phase (radians). */
export function sampleWalk(out: PoseFrame, c: PoseContext): PoseFrame {
  reset(out);
  const p = c.phase;
  const sL = Math.sin(p);
  const sR = Math.sin(p + Math.PI);
  const cL = Math.cos(p);
  const cR = Math.cos(p + Math.PI);
  out.hips[1] = STAND_HIPS_Y - 0.03 + 0.022 * Math.cos(2 * p);
  out.hips[0] = 0.012 * Math.sin(p);
  set(out, "hips", 0.03, 0.09 * sL, 0.03 * Math.sin(p));
  set(out, "spine", 0.04, -0.06 * sL, 0);
  set(out, "chest", 0.01, -0.05 * sL, -0.02 * Math.sin(p));
  // Legs: thigh swing, knee folds during the swing phase (cos > 0).
  set(out, "hipL", -0.42 * sL, 0, -0.01);
  set(
    out,
    "kneeL",
    0.08 + 0.75 * Math.pow(Math.max(0, cL), 1.6) + 0.12 * Math.max(0, -sL),
  );
  set(out, "ankleL", 0.18 * sL - 0.1 * Math.max(0, cL));
  set(out, "hipR", -0.42 * sR, 0, 0.01);
  set(
    out,
    "kneeR",
    0.08 + 0.75 * Math.pow(Math.max(0, cR), 1.6) + 0.12 * Math.max(0, -sR),
  );
  set(out, "ankleR", 0.18 * sR - 0.1 * Math.max(0, cR));
  // Arms counter-swing.
  set(out, "shoulderL", 0.36 * sL, 0.08, -0.08);
  set(out, "elbowL", -0.28 - 0.18 * Math.max(0, -sL));
  set(out, "shoulderR", 0.36 * sR, -0.08, 0.08);
  set(out, "elbowR", -0.28 - 0.18 * Math.max(0, -sR));
  set(out, "neck", 0.02);
  set(out, "head", 0.02 - 0.015 * Math.cos(2 * p), 0.04 * sL, 0);
  return out;
}

/** Sample a pose clip into `out`. */
export function samplePose(
  pose: CharacterPose,
  c: PoseContext,
  out: PoseFrame,
): PoseFrame {
  switch (pose) {
    case "idle":
      standingIdle(out, c);
      break;
    case "walking":
      sampleWalk(out, c);
      break;
    case "sitting":
      sitting(out, c);
      break;
    case "typing":
      typing(out, c);
      break;
    case "thinking":
      thinking(out, c);
      break;
    case "raiseHand":
      raiseHand(out, c);
      break;
    case "celebrating":
      celebrating(out, c);
      break;
  }
  return out;
}

/** Poses that require the character to be on the chair. */
export function isSeatedPose(pose: CharacterPose): boolean {
  return pose !== "idle" && pose !== "walking";
}

/** Walk phase advance (radians) for a distance travelled. */
export function walkPhaseDelta(speed: number, dt: number): number {
  return ((Math.max(0, speed) * dt) / STRIDE_CYCLE_M) * Math.PI * 2;
}

/**
 * Pose cross-fader: snapshot of the previous output blended toward the live
 * target clip with a smoothstep weight.
 */
export class PoseBlender {
  readonly out = createFrame();
  private readonly from = createFrame();
  private readonly target = createFrame();
  private readonly walk = createFrame();
  private pose: CharacterPose = "idle";
  private blendDur = 0;
  private blendT = 1;
  private age = 0;
  private moveWeight = 0;
  private speed = 0;
  private phase = 0;
  private t = 0;

  constructor(private readonly seed: number) {
    this.t = seed * 13;
  }

  get current(): CharacterPose {
    return this.pose;
  }

  setPose(pose: CharacterPose, blendSec = 0.35): void {
    if (pose === this.pose) return;
    copyFrame(this.out, this.from);
    this.pose = pose;
    this.age = 0;
    this.blendDur = Math.max(0, blendSec);
    this.blendT = this.blendDur > 0 ? 0 : 1;
  }

  setMoving(speed: number): void {
    this.speed = Math.max(0, speed);
  }

  update(dt: number): PoseFrame {
    const d = Math.max(0, dt);
    this.t += d;
    this.age += d;
    const walkSpeed =
      this.speed > 0.01 ? this.speed : this.pose === "walking" ? 1.3 : 0;
    this.phase = (this.phase + walkPhaseDelta(walkSpeed, d)) % (Math.PI * 2);
    const ctx: PoseContext = {
      t: this.t,
      age: this.age,
      phase: this.phase,
      seed: this.seed,
    };
    samplePose(this.pose, ctx, this.target);
    if (this.blendT < 1) {
      this.blendT = Math.min(
        1,
        this.blendT + d / Math.max(1e-4, this.blendDur),
      );
      blendFrames(this.from, this.target, smoothstep(this.blendT), this.out);
    } else {
      copyFrame(this.target, this.out);
    }
    const wantMove = this.speed > 0.05 ? 1 : 0;
    this.moveWeight += (wantMove - this.moveWeight) * (1 - Math.exp(-10 * d));
    if (this.moveWeight > 0.002) {
      sampleWalk(this.walk, ctx);
      blendFrames(this.out, this.walk, this.moveWeight, this.out);
    }
    return this.out;
  }
}
