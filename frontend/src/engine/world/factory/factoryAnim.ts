/**
 * Factory life (pure, Node-testable, zero per-frame allocations):
 *
 *   - arm motion: `armPoseAt()` (running scan sweep → probe dip → return,
 *     success nod, failure stop pose) + `StationAnimator`, which keeps a small
 *     work list of arms that are animating, writes only those (and only when
 *     visible / within the LOD radius or in a `full` cell) straight into the
 *     three arm matrix buffers, and reports the touched instance range;
 *   - `phaseOf(id)`: deterministic per-station phase so the plant is not in
 *     lockstep;
 *   - `hoodFlash()`: short red hood-light flash on the transition to failure;
 *   - belt scroll: `LaneScroll` (per-path speed → per-instance UV offsets).
 */
import type { CheckState } from "@/engine/contracts";
import {
  STATION,
  armPoseFor,
  stationFrame,
  acrossScale,
  type ArmPose,
  type StationInstance,
} from "./stationPlan";
import { chain, translation } from "./poolMath";

// ---------------------------------------------------------------------------
// Phase / easing helpers
// ---------------------------------------------------------------------------

/** FNV-1a of `id` → [0, 1). Deterministic: same id, same phase, every run. */
export function phaseOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/** Seconds a running inspection cycle takes (sweep, dip, return). */
export const SCAN_PERIOD = 6;
/** Seconds after which a success / failure transition pose is final. */
export const SETTLE = 1.6;
/** The animator keeps an arm on its work list this long after a transition. */
const SETTLE_WINDOW = SETTLE + 0.1;
/** Age used for stations that were already in their state when first seen. */
const SETTLED_AGE = 1e9;

/** Hood flash length (s) after a transition to failure. */
export const FLASH = 0.5;

// ---------------------------------------------------------------------------
// Arm poses
// ---------------------------------------------------------------------------

export function newPose(): ArmPose {
  return { yaw: 0, shoulder: 0, elbow: 0, wrist: 0 };
}

function lerpPose(out: ArmPose, a: ArmPose, b: ArmPose, k: number): void {
  out.yaw = a.yaw + (b.yaw - a.yaw) * k;
  out.shoulder = a.shoulder + (b.shoulder - a.shoulder) * k;
  out.elbow = a.elbow + (b.elbow - a.elbow) * k;
  out.wrist = a.wrist + (b.wrist - a.wrist) * k;
}

const REST: Record<CheckState, ArmPose> = {
  queued: armPoseFor("queued"),
  running: armPoseFor("running"),
  success: armPoseFor("success"),
  failure: armPoseFor("failure"),
  cancelled: armPoseFor("cancelled"),
  none: armPoseFor("none"),
};

const SCAN = REST.running;
const SWEEP_END = 0.58; // fraction of the cycle spent sweeping
const DIP_START = 0.62;
const DIP_END = 0.88;

/**
 * Running inspection cycle at cycle position `u` ∈ [0, 1): a scan sweep over
 * the belt (yaw there-and-back, small shoulder bob), a probe dip (lean in,
 * sensor towards the belt) and a smooth return to the scan pose.
 */
export function scanPose(out: ArmPose, u: number): void {
  let yaw = 0;
  let sh = 0;
  let el = 0;
  let wr = 0;
  if (u < SWEEP_END) {
    const k = u / SWEEP_END;
    yaw = 0.42 * Math.sin(2 * Math.PI * k);
    sh = 0.05 * Math.sin(4 * Math.PI * k);
  } else if (u >= DIP_START && u < DIP_END) {
    const d = Math.sin((Math.PI * (u - DIP_START)) / (DIP_END - DIP_START));
    const e = d * d * (3 - 2 * d); // soft in / out
    sh = 0.1 * e;
    el = 0.16 * e;
    wr = -0.19 * e; // keep the probe roughly vertical
    yaw = 0.06 * Math.sin(Math.PI * 6 * (u - DIP_START)) * e;
  }
  out.yaw = SCAN.yaw + yaw;
  out.shoulder = SCAN.shoulder + sh;
  out.elbow = SCAN.elbow + el;
  out.wrist = SCAN.wrist + wr;
}

const tmpA = newPose();

/**
 * Pose for `state` at absolute time `t`, `age` seconds after entering the
 * state, with the station `phase` ∈ [0, 1). Writes into `out`.
 *
 * - idle states (queued / none / cancelled): the rest pose, exactly;
 * - running: blend up from rest (0.6 s), then loop the scan cycle;
 * - success: a brief double nod while settling to rest;
 * - failure: snap to the raised stop pose (ease-out overshoot, decaying
 *   tremor), final after `SETTLE`.
 * Final poses are exact (no residual motion) once `age ≥ SETTLE`.
 */
export function armPoseAt(
  out: ArmPose,
  state: CheckState,
  t: number,
  age: number,
  phase: number,
): void {
  switch (state) {
    case "running": {
      const u = (((t / SCAN_PERIOD + phase) % 1) + 1) % 1;
      scanPose(tmpA, u);
      lerpPose(out, REST.queued, tmpA, smoothstep(age / 0.6));
      return;
    }
    case "success": {
      const rest = REST.success;
      if (age >= SETTLE) {
        lerpPose(out, rest, rest, 0);
        return;
      }
      lerpPose(out, SCAN, rest, smoothstep(age / 0.8));
      const env = 1 - smoothstep((age - 0.5) / (SETTLE - 0.5));
      out.wrist +=
        0.32 *
        Math.sin(2 * Math.PI * 1.6 * age) *
        env *
        (age > 0.1 ? 1 : age * 10);
      out.shoulder += 0.05 * Math.sin(2 * Math.PI * 1.6 * age) * env;
      return;
    }
    case "failure": {
      const stop = REST.failure;
      if (age >= SETTLE) {
        lerpPose(out, stop, stop, 0);
        return;
      }
      // Ease-out-back from the scan pose to the stop pose in 0.35 s.
      const x = clamp01(age / 0.35) - 1;
      const c = 2.2;
      const k = 1 + (c + 1) * x * x * x + c * x * x;
      lerpPose(out, SCAN, stop, k);
      const env = 1 - smoothstep((age - 0.35) / (SETTLE - 0.35));
      out.yaw += 0.05 * Math.sin(age * 55) * env;
      out.wrist += 0.08 * Math.sin(age * 47) * env;
      return;
    }
    default: {
      const rest = REST[state];
      // Entering an idle state from motion (e.g. cancelled): ease to rest.
      if (age >= SETTLE) {
        lerpPose(out, rest, rest, 0);
        return;
      }
      lerpPose(out, SCAN, rest, smoothstep(age / 0.9));
      return;
    }
  }
}

/** Hood light colour while flashing (age since the failure transition). */
export function hoodFlash(
  age: number,
  base: readonly [number, number, number],
  out: Float32Array,
  o: number,
): void {
  const k =
    age >= FLASH ? 0 : Math.exp(-age * 7) * (1 - smoothstep(age / FLASH));
  out[o] = base[0] + 9 * k;
  out[o + 1] = base[1] + 0.7 * k;
  out[o + 2] = base[2] + 0.6 * k;
  out[o + 3] = 1;
}

/** Does `state` keep an arm moving forever (until the state changes)? */
export function loopsForever(state: CheckState): boolean {
  return state === "running";
}

// ---------------------------------------------------------------------------
// In-place forward kinematics (no allocation)
// ---------------------------------------------------------------------------

const S1 = new Float32Array(16);
const S2 = new Float32Array(16);
const S3 = new Float32Array(16);

function mulInto(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  out: Float32Array,
  oo: number,
): void {
  for (let r = 0; r < 4; r++) {
    const a0 = a[ao + r * 4];
    const a1 = a[ao + r * 4 + 1];
    const a2 = a[ao + r * 4 + 2];
    const a3 = a[ao + r * 4 + 3];
    for (let c = 0; c < 4; c++)
      out[oo + r * 4 + c] =
        a0 * b[bo + c] +
        a1 * b[bo + 4 + c] +
        a2 * b[bo + 8 + c] +
        a3 * b[bo + 12 + c];
  }
}

/** rotZ(a) then translate (0, ty, 0), into `m` (identity elsewhere). */
function rotZT(m: Float32Array, a: number, ty: number): void {
  const s = Math.sin(a);
  const c = Math.cos(a);
  m.fill(0);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  m[10] = 1;
  m[13] = ty;
  m[15] = 1;
}

function rotYInto(m: Float32Array, a: number): void {
  const s = Math.sin(a);
  const c = Math.cos(a);
  m.fill(0);
  m[0] = c;
  m[2] = -s;
  m[5] = 1;
  m[8] = s;
  m[10] = c;
  m[15] = 1;
}

/**
 * Arm base frame (everything except the arm-plane yaw): turret position ·
 * station frame. 16 floats written at `out[o]`.
 */
export function writeArmBase(
  st: StationInstance,
  out: Float32Array,
  o: number,
): void {
  const P = STATION.pedestal;
  const m = chain(
    translation(P.x, P.h + P.turret, P.z * acrossScale(st)),
    stationFrame(st),
  );
  out.set(m, o);
}

/**
 * Same matrices as `armMatrices(st, pose)` (stationPlan), computed from the
 * cached `base` (see `writeArmBase`), written at `o` of the three buffers.
 */
export function writeArmMatrices(
  base: Float32Array,
  bo: number,
  pose: ArmPose,
  a1: Float32Array,
  a2: Float32Array,
  a3: Float32Array,
  o: number,
): void {
  // m1 = rotZ(shoulder) · rotY(yaw) · base
  rotZT(S1, pose.shoulder, 0);
  rotYInto(S2, pose.yaw);
  mulInto(S1, 0, S2, 0, S3, 0);
  mulInto(S3, 0, base, bo, a1, o);
  // m2 = rotZ(elbow) · T(0, l1, 0) · m1
  rotZT(S1, pose.elbow, STATION.arm.l1);
  mulInto(S1, 0, a1, o, a2, o);
  // m3 = rotZ(wrist) · T(0, l2, 0) · m2
  rotZT(S1, pose.wrist, STATION.arm.l2);
  mulInto(S1, 0, a2, o, a3, o);
}

// ---------------------------------------------------------------------------
// Station animator
// ---------------------------------------------------------------------------

export interface ArmBuffers {
  a1: Float32Array;
  a2: Float32Array;
  a3: Float32Array;
}

export interface AnimStep {
  /** Touched instance range [lo, hi] (hi < lo: nothing written). */
  lo: number;
  hi: number;
  /** Arms whose matrices were written this step. */
  written: number;
  /** Arms animating but skipped (outside the LOD radius / not `full`). */
  skipped: number;
}

/** Default LOD radius (m) for arm animation. */
export const ANIM_RADIUS = 30;

export class StationAnimator {
  private n = 0;
  private ids: string[] = [];
  private states: CheckState[] = [];
  private phase = new Float32Array(0);
  private since = new Float64Array(0);
  private settleEnd = new Float64Array(0);
  private base = new Float32Array(0);
  private pos = new Float32Array(0);
  private full = new Uint8Array(0);
  private fixed = new Uint8Array(0);
  private stale = new Uint8Array(0);
  private work = new Int32Array(0);
  private workN = 0;
  private flashFrom = new Float64Array(0);
  private flash = new Int32Array(0);
  private flashN = 0;
  private known = new Map<string, { state: CheckState; since: number }>();
  private readonly pose = newPose();
  private fullIds: ReadonlySet<string> | null = null;
  private vx = NaN;
  private vy = 0;
  private vz = 0;
  radius = ANIM_RADIUS;
  enabled = true;
  /** Write counters (arms written since creation). */
  armWrites = 0;
  hoodWrites = 0;
  readonly step_: AnimStep = { lo: 0, hi: -1, written: 0, skipped: 0 };

  get count(): number {
    return this.n;
  }

  get workSize(): number {
    return this.workN;
  }

  get flashing(): number {
    return this.flashN;
  }

  /** Viewer position for the distance LOD (NaN x disables the radius). */
  setViewer(x: number, y: number, z: number): void {
    this.vx = x;
    this.vy = y;
    this.vz = z;
  }

  /** Stations of `full` cells always animate regardless of distance. */
  setFullIds(ids: ReadonlySet<string> | null): void {
    this.fullIds = ids;
    for (let i = 0; i < this.n; i++)
      this.full[i] = ids?.has(this.ids[i]) ? 1 : 0;
  }

  /** Is arm `i` currently inside its LOD (distance / full)? */
  visible(i: number): boolean {
    if (this.full[i] === 1) return true;
    if (Number.isNaN(this.vx)) return true;
    const dx = this.pos[i * 3] - this.vx;
    const dy = this.pos[i * 3 + 1] - this.vy;
    const dz = this.pos[i * 3 + 2] - this.vz;
    const r = this.radius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  /** Mark station `i` as pinned to a static (overridden) pose or free it. */
  setFixed(i: number, on: boolean): void {
    if (i >= 0 && i < this.n) this.fixed[i] = on ? 1 : 0;
  }

  indexOf(id: string): number {
    return this.ids.indexOf(id);
  }

  /**
   * (Re)build per-station animation state for `order` at time `t`. State
   * changes relative to the previous call start a transition (success nod,
   * failure stop pose + hood flash); stations seen for the first time are
   * settled. Writes the pose of every arm into `arms`.
   */
  rebuild(
    order: readonly StationInstance[],
    t: number,
    arms: ArmBuffers,
    hoodBase: (state: CheckState) => readonly [number, number, number],
    hood: Float32Array | null,
  ): void {
    const n = order.length;
    this.n = n;
    this.ids = order.map((s) => s.id);
    this.states = order.map((s) => s.state);
    this.phase = new Float32Array(n);
    this.since = new Float64Array(n);
    this.settleEnd = new Float64Array(n);
    this.base = new Float32Array(n * 16);
    this.pos = new Float32Array(n * 3);
    this.full = new Uint8Array(n);
    this.fixed = new Uint8Array(n);
    this.stale = new Uint8Array(n);
    this.work = new Int32Array(n);
    this.flash = new Int32Array(n);
    this.flashFrom = new Float64Array(n);
    this.workN = 0;
    this.flashN = 0;
    const next = new Map<string, { state: CheckState; since: number }>();
    for (let i = 0; i < n; i++) {
      const st = order[i];
      const prev = this.known.get(st.id);
      let since = -SETTLED_AGE;
      if (prev) since = prev.state === st.state ? prev.since : t;
      next.set(st.id, { state: st.state, since });
      this.phase[i] = phaseOf(st.id);
      this.since[i] = since;
      this.pos[i * 3] = st.x;
      this.pos[i * 3 + 1] = st.y + 1;
      this.pos[i * 3 + 2] = st.z;
      this.full[i] = this.fullIds?.has(st.id) ? 1 : 0;
      writeArmBase(st, this.base, i * 16);
      const forever = loopsForever(st.state);
      this.settleEnd[i] = forever ? Infinity : since + SETTLE_WINDOW;
      if (t < this.settleEnd[i]) this.work[this.workN++] = i;
      if (prev && prev.state !== st.state && st.state === "failure") {
        this.flash[this.flashN++] = i;
        this.flashFrom[i] = t;
      }
      armPoseAt(this.pose, st.state, t, t - since, this.phase[i]);
      writeArmMatrices(
        this.base,
        i * 16,
        this.pose,
        arms.a1,
        arms.a2,
        arms.a3,
        i * 16,
      );
    }
    this.known = next;
    if (hood) {
      for (let k = 0; k < this.flashN; k++) {
        const i = this.flash[k];
        hoodFlash(t - this.flashFrom[i], hoodBase(this.states[i]), hood, i * 4);
      }
    }
  }

  /**
   * Advance arms to time `t`: writes matrices only for arms that are
   * animating and visible. Returns the touched range (shared object).
   */
  step(t: number, arms: ArmBuffers): AnimStep {
    const r = this.step_;
    r.lo = Infinity;
    r.hi = -1;
    r.written = 0;
    r.skipped = 0;
    if (!this.enabled) return r;
    const work = this.work;
    for (let k = this.workN - 1; k >= 0; k--) {
      const i = work[k];
      const animating = t < this.settleEnd[i];
      if (this.fixed[i] === 1 || (!animating && this.stale[i] === 0)) {
        work[k] = work[--this.workN];
        continue;
      }
      if (!this.visible(i)) {
        this.stale[i] = 1;
        r.skipped++;
        continue;
      }
      armPoseAt(this.pose, this.states[i], t, t - this.since[i], this.phase[i]);
      writeArmMatrices(
        this.base,
        i * 16,
        this.pose,
        arms.a1,
        arms.a2,
        arms.a3,
        i * 16,
      );
      this.stale[i] = 0;
      r.written++;
      if (i < r.lo) r.lo = i;
      if (i > r.hi) r.hi = i;
      if (!animating) work[k] = work[--this.workN];
    }
    this.armWrites += r.written;
    return r;
  }

  /**
   * Write hood colours of stations still flashing; returns the touched
   * range through `step_` style out-params (lo, hi) packed as [lo, hi].
   * Finished flashes get their base colour written once.
   */
  stepFlash(
    t: number,
    hood: Float32Array,
    hoodBase: (state: CheckState) => readonly [number, number, number],
    range: Int32Array,
  ): boolean {
    range[0] = 0x7fffffff;
    range[1] = -1;
    if (this.flashN === 0) return false;
    for (let k = this.flashN - 1; k >= 0; k--) {
      const i = this.flash[k];
      const age = t - this.flashFrom[i];
      hoodFlash(age, hoodBase(this.states[i]), hood, i * 4);
      this.hoodWrites++;
      if (i < range[0]) range[0] = i;
      if (i > range[1]) range[1] = i;
      if (age >= FLASH) this.flash[k] = this.flash[--this.flashN];
    }
    return range[1] >= 0;
  }
}

// ---------------------------------------------------------------------------
// Belt scroll (per lane)
// ---------------------------------------------------------------------------

export interface LaneRange {
  id: string;
  start: number;
  end: number;
}

/**
 * Per-path belt speed → per-instance UV offsets. Paths with speed 0 are
 * untouched (their offsets stay where they stopped); `step()` returns the
 * number of instances written.
 */
export class LaneScroll {
  offsets = new Float32Array(0);
  private ranges: LaneRange[] = [];
  private scroll = new Float64Array(0);
  private speeds = new Float32Array(0);
  private readonly explicit = new Map<string, number>();
  private fallback = 0;
  /** Instance span touched by the last step [lo, hi). */
  lo = 0;
  hi = 0;

  setRanges(ranges: readonly LaneRange[], count: number): void {
    this.ranges = ranges.slice();
    if (this.offsets.length < count) this.offsets = new Float32Array(count);
    else this.offsets.fill(0, 0, count);
    this.scroll = new Float64Array(ranges.length);
    this.speeds = new Float32Array(ranges.length);
    this.resolve();
  }

  /** Speed (m/s) for paths without an explicit one. */
  setDefault(mps: number): void {
    this.fallback = mps;
    this.resolve();
  }

  setLane(id: string, mps: number): void {
    this.explicit.set(id, mps);
    this.resolve();
  }

  speedOf(id: string): number {
    return this.explicit.get(id) ?? this.fallback;
  }

  private resolve(): void {
    for (let i = 0; i < this.ranges.length; i++)
      this.speeds[i] = this.explicit.get(this.ranges[i].id) ?? this.fallback;
  }

  /** Number of paths currently moving. */
  moving(): number {
    let n = 0;
    for (let i = 0; i < this.speeds.length; i++) if (this.speeds[i] !== 0) n++;
    return n;
  }

  /** Advance moving lanes by `dt`; returns instances written. */
  step(dt: number): number {
    this.lo = Infinity;
    this.hi = 0;
    if (dt <= 0) return 0;
    let w = 0;
    for (let i = 0; i < this.ranges.length; i++) {
      const v = this.speeds[i];
      if (v === 0) continue;
      const s = (this.scroll[i] - v * dt) % 1;
      this.scroll[i] = s;
      const { start, end } = this.ranges[i];
      for (let k = start; k < end; k++) this.offsets[k] = s;
      w += end - start;
      if (start < this.lo) this.lo = start;
      if (end > this.hi) this.hi = end;
    }
    return w;
  }
}
