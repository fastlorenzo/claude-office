/**
 * Pure skeletal clip retargeting (no Babylon): bakes a clip recorded on one
 * skeleton onto another with different proportions, bone axes and rest pose.
 *
 * Per sample time, per mapped bone (world space, Hamilton quaternions, glTF
 * convention world = parent * local):
 *   D      = Wsrc(t) * inverse(Rsrc)          source rotation away from rest
 *   C      = fromTo(dirTgtRest, dirSrcRest)   rest-pose alignment (T vs A pose):
 *            swing that points the target bone like the source rest bone
 *   Wtgt   = D * C * Rtgt                      target world rotation
 *   local  = inverse(Wtgt(parent)) * Wtgt
 * Unmapped target bones keep their rest local rotation (they follow parents).
 * The hips translation is transferred as a world-space delta from rest,
 * scaled by the hips-height ratio. Bone lengths are never changed.
 *
 * Limits (documented in docs/characters.md): uniform scale per node only, no
 * IK (feet can slide / hands can miss props on very different proportions),
 * twist bones / face bones are not driven.
 */

export type Quat = [number, number, number, number]; // x, y, z, w
export type V3 = [number, number, number];

export interface Joint {
  name: string;
  /** index into the joint list, -1 = scene root; parents precede children */
  parent: number;
  t: V3;
  r: Quat;
  /** uniform scale (x component of the node scale) */
  s: number;
}

export interface Track {
  joint: string;
  /** seconds, ascending */
  times: number[];
  rotations?: Quat[];
  translations?: V3[];
}

export interface RetargetInput {
  src: Joint[];
  tgt: Joint[];
  /** source joint name → canonical name */
  srcCanon: ReadonlyMap<string, string>;
  /** target joint name → canonical name */
  tgtCanon: ReadonlyMap<string, string>;
  tracks: readonly Track[];
  /** canonical name of the hips (translation carrier); default "pelvis" */
  hips?: string;
  /** sample rate of the baked clip (default 30) */
  fps?: number;
  /** rest-pose direction alignment (default true) */
  alignRest?: boolean;
}

// ---------------------------------------------------------------------------
// Quaternion / vector helpers
// ---------------------------------------------------------------------------

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qinv(q: Quat): Quat {
  const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1;
  return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n];
}

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function qrot(q: Quat, v: V3): V3 {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q));
  return [p[0], p[1], p[2]];
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (d > 0.9995) {
    return qnorm([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return [
    a[0] * ka + bx * kb,
    a[1] * ka + by * kb,
    a[2] * ka + bz * kb,
    a[3] * ka + bw * kb,
  ];
}

/** Shortest rotation taking unit vector a onto unit vector b. */
export function qfromTo(a: V3, b: V3): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // 180°: any axis perpendicular to a
    let axis: V3 = [0, -a[2], a[1]];
    if (Math.hypot(...axis) < 1e-6) axis = [-a[2], 0, a[0]];
    const n = Math.hypot(...axis);
    return [axis[0] / n, axis[1] / n, axis[2] / n, 0];
  }
  const c: V3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

function vsub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vnorm(v: V3): V3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n < 1e-6 ? null : [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------
// Forward kinematics
// ---------------------------------------------------------------------------

export interface World {
  r: Quat[];
  t: V3[];
  s: number[];
}

/** World transforms for a joint list given per-joint local overrides. */
export function forwardKinematics(
  joints: readonly Joint[],
  localR?: (i: number) => Quat | undefined,
  localT?: (i: number) => V3 | undefined,
): World {
  const n = joints.length;
  const w: World = { r: new Array(n), t: new Array(n), s: new Array(n) };
  for (let i = 0; i < n; i++) {
    const j = joints[i];
    const r = localR?.(i) ?? j.r;
    const t = localT?.(i) ?? j.t;
    if (j.parent < 0) {
      w.r[i] = r;
      w.t[i] = t;
      w.s[i] = j.s;
      continue;
    }
    const p = j.parent;
    const pr = w.r[p];
    const ps = w.s[p];
    const off = qrot(pr, [t[0] * ps, t[1] * ps, t[2] * ps]);
    w.r[i] = qmul(pr, r);
    w.t[i] = [w.t[p][0] + off[0], w.t[p][1] + off[1], w.t[p][2] + off[2]];
    w.s[i] = ps * j.s;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function bracket(
  times: readonly number[],
  t: number,
): [number, number, number] {
  const n = times.length;
  if (n === 0 || t <= times[0]) return [0, 0, 0];
  if (t >= times[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  return [lo, hi, span > 0 ? (t - times[lo]) / span : 0];
}

export function sampleRotation(tr: Track, t: number): Quat | undefined {
  if (!tr.rotations?.length) return undefined;
  const [a, b, k] = bracket(tr.times, t);
  return qslerp(tr.rotations[a], tr.rotations[b], k);
}

export function sampleTranslation(tr: Track, t: number): V3 | undefined {
  if (!tr.translations?.length) return undefined;
  const [a, b, k] = bracket(tr.times, t);
  const A = tr.translations[a];
  const B = tr.translations[b];
  return [
    A[0] + (B[0] - A[0]) * k,
    A[1] + (B[1] - A[1]) * k,
    A[2] + (B[2] - A[2]) * k,
  ];
}

// ---------------------------------------------------------------------------
// Retarget
// ---------------------------------------------------------------------------

/** Canonical "next bone in the chain" used for rest-pose direction alignment. */
const CHAIN_CHILD: Record<string, string> = {
  spine_01: "spine_02",
  spine_02: "spine_03",
  spine_03: "neck_01",
  neck_01: "head",
};
for (const s of ["l", "r"]) {
  CHAIN_CHILD[`clavicle_${s}`] = `upperarm_${s}`;
  CHAIN_CHILD[`upperarm_${s}`] = `lowerarm_${s}`;
  CHAIN_CHILD[`lowerarm_${s}`] = `hand_${s}`;
  CHAIN_CHILD[`hand_${s}`] = `middle_01_${s}`;
  CHAIN_CHILD[`thigh_${s}`] = `calf_${s}`;
  CHAIN_CHILD[`calf_${s}`] = `foot_${s}`;
  CHAIN_CHILD[`foot_${s}`] = `ball_${s}`;
  for (const f of ["thumb", "index", "middle", "ring", "pinky"]) {
    CHAIN_CHILD[`${f}_01_${s}`] = `${f}_02_${s}`;
    CHAIN_CHILD[`${f}_02_${s}`] = `${f}_03_${s}`;
  }
}

function indexBy(joints: readonly Joint[]): Map<string, number> {
  const m = new Map<string, number>();
  joints.forEach((j, i) => m.set(j.name, i));
  return m;
}

/** Bake `tracks` (on `src`) onto `tgt`. Returns one track per driven target joint. */
export function retargetClip(input: RetargetInput): Track[] {
  const { src, tgt, srcCanon, tgtCanon, tracks } = input;
  const hipsCanon = input.hips ?? "pelvis";
  const fps = input.fps ?? 30;
  const align = input.alignRest ?? true;
  const srcIdx = indexBy(src);
  const tgtIdx = indexBy(tgt);

  const srcByCanon = new Map<string, number>();
  for (const [name, c] of srcCanon) {
    const i = srcIdx.get(name);
    if (i !== undefined) srcByCanon.set(c, i);
  }
  const tgtByCanon = new Map<string, number>();
  for (const [name, c] of tgtCanon) {
    const i = tgtIdx.get(name);
    if (i !== undefined) tgtByCanon.set(c, i);
  }
  // Driven target joint → source joint.
  const drive = new Map<number, number>();
  const canonOfTgt = new Map<number, string>();
  for (const [c, ti] of tgtByCanon) {
    const si = srcByCanon.get(c);
    if (si === undefined) continue;
    drive.set(ti, si);
    canonOfTgt.set(ti, c);
  }
  if (drive.size === 0) return [];

  const restS = forwardKinematics(src);
  const restT = forwardKinematics(tgt);

  // Rest-pose alignment per driven joint.
  const C = new Map<number, Quat>();
  if (align) {
    for (const [ti, si] of drive) {
      const childC = CHAIN_CHILD[canonOfTgt.get(ti)!];
      const tc = childC !== undefined ? tgtByCanon.get(childC) : undefined;
      const sc = childC !== undefined ? srcByCanon.get(childC) : undefined;
      if (tc === undefined || sc === undefined) continue;
      const dt = vnorm(vsub(restT.t[tc], restT.t[ti]));
      const ds = vnorm(vsub(restS.t[sc], restS.t[si]));
      if (!dt || !ds) continue;
      C.set(ti, qfromTo(dt, ds));
    }
  }

  const trackOf = new Map<number, Track>();
  let duration = 0;
  for (const tr of tracks) {
    const i = srcIdx.get(tr.joint);
    if (i === undefined) continue;
    trackOf.set(i, tr);
    if (tr.times.length)
      duration = Math.max(duration, tr.times[tr.times.length - 1]);
  }

  const hipsS = srcByCanon.get(hipsCanon);
  const hipsT = tgtByCanon.get(hipsCanon);
  const hipsScale =
    hipsS !== undefined &&
    hipsT !== undefined &&
    Math.abs(restS.t[hipsS][1]) > 1e-4
      ? restT.t[hipsT][1] / restS.t[hipsS][1]
      : 1;

  const frames = Math.max(1, Math.round(duration * fps));
  const times: number[] = [];
  for (let f = 0; f <= frames; f++) times.push(Math.min(duration, f / fps));

  const out = new Map<number, Track>();
  for (const ti of drive.keys())
    out.set(ti, { joint: tgt[ti].name, times, rotations: [] });
  if (hipsT !== undefined && hipsS !== undefined)
    out.get(hipsT)!.translations = [];

  const invRestS = restS.r.map(qinv);

  for (const t of times) {
    const ws = forwardKinematics(
      src,
      (i) => {
        const tr = trackOf.get(i);
        return tr ? sampleRotation(tr, t) : undefined;
      },
      (i) => {
        const tr = trackOf.get(i);
        return tr ? sampleTranslation(tr, t) : undefined;
      },
    );
    // Target world rotations, parents first.
    const wr: Quat[] = new Array(tgt.length);
    const wt: V3[] = new Array(tgt.length);
    const wsc: number[] = new Array(tgt.length);
    for (let i = 0; i < tgt.length; i++) {
      const j = tgt[i];
      const pr: Quat = j.parent >= 0 ? wr[j.parent] : [0, 0, 0, 1];
      const pt: V3 = j.parent >= 0 ? wt[j.parent] : [0, 0, 0];
      const ps = j.parent >= 0 ? wsc[j.parent] : 1;
      const si = drive.get(i);
      let local: Quat = j.r;
      let lt: V3 = j.t;
      if (si !== undefined) {
        const D = qmul(ws.r[si], invRestS[si]);
        const c = C.get(i);
        const world = qmul(D, c ? qmul(c, restT.r[i]) : restT.r[i]);
        local = qnorm(qmul(qinv(pr), world));
        const tr = out.get(i)!;
        tr.rotations!.push(local);
        if (i === hipsT && hipsS !== undefined) {
          const d = vsub(ws.t[hipsS], restS.t[hipsS]);
          const target: V3 = [
            restT.t[i][0] + d[0] * hipsScale,
            restT.t[i][1] + d[1] * hipsScale,
            restT.t[i][2] + d[2] * hipsScale,
          ];
          const rel = qrot(qinv(pr), vsub(target, pt));
          lt = [rel[0] / ps, rel[1] / ps, rel[2] / ps];
          tr.translations!.push(lt);
        }
      }
      const off = qrot(pr, [lt[0] * ps, lt[1] * ps, lt[2] * ps]);
      wr[i] = qmul(pr, local);
      wt[i] = [pt[0] + off[0], pt[1] + off[1], pt[2] + off[2]];
      wsc[i] = ps * j.s;
    }
  }
  return [...out.values()];
}
