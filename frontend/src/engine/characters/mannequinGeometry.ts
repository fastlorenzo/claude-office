/**
 * Procedural mannequin geometry (pure maths, no Babylon).
 *
 * Builds ONE skinned mesh (rest pose: standing, arms hanging) out of lathed
 * parts. Every vertex carries a colour key (tinted by the rig), a material
 * slot encoded in UV.x (sampled from a 4×1 roughness texture so a single
 * material gives cloth / skin / hair / gloss roughness variation), and up to
 * two bone influences. Result: 1 draw call per character.
 */

import { JOINT_INDEX, SKELETON, type Joint } from "./poses";

export const COLOR_KEYS = [
  "shirt",
  "trousers",
  "collar",
  "skin",
  "lip",
  "hair",
  "brow",
  "shoes",
  "sole",
  "eyes",
  "belt",
  "headset",
  "accent",
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** Roughness slot per colour key: 0 cloth, 1 skin, 2 hair, 3 gloss. */
export const SLOT_OF: Record<ColorKey, number> = {
  shirt: 0,
  trousers: 0,
  collar: 0,
  sole: 0,
  skin: 1,
  lip: 1,
  hair: 2,
  brow: 2,
  shoes: 3,
  eyes: 3,
  belt: 3,
  headset: 3,
  accent: 3,
};
export const SLOT_COUNT = 4;
/** Roughness per slot (cloth, skin, hair, gloss). */
export const SLOT_ROUGHNESS = [0.9, 0.62, 0.48, 0.28];

export type HairStyle = 0 | 1 | 2;

export interface MannequinGeometryOptions {
  boss: boolean;
  hairStyle: HairStyle;
}

export interface MannequinGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Index into COLOR_KEYS per vertex. */
  keys: Uint8Array;
  indices: Uint32Array;
  matricesIndices: Float32Array;
  matricesWeights: Float32Array;
  vertexCount: number;
}

type Weights = [Joint, number][];
type WeightFn = (y: number) => Weights;
type V3 = [number, number, number];

interface ProfilePt {
  r: number;
  y: number;
  key?: ColorKey;
}

interface LatheOpts {
  center: V3;
  seg?: number;
  sx?: number;
  sz?: number;
  rot?: V3; // applied X, then Y, then Z
  key: ColorKey;
  bones: Joint | WeightFn;
  /** Flatten vertices below this world y onto it (shoe soles). */
  clampMinY?: number;
  /** Partial revolution [a0, a1] radians (default full circle). */
  arc?: [number, number];
}

function rotate(v: V3, r: V3 | undefined): V3 {
  if (!r) return v;
  let [x, y, z] = v;
  if (r[0]) {
    const c = Math.cos(r[0]);
    const s = Math.sin(r[0]);
    [y, z] = [y * c - z * s, y * s + z * c];
  }
  if (r[1]) {
    const c = Math.cos(r[1]);
    const s = Math.sin(r[1]);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  if (r[2]) {
    const c = Math.cos(r[2]);
    const s = Math.sin(r[2]);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}

/** Linear blend between two bones over [y0, y1] (rest-pose world y). */
export function blendY(lo: Joint, hi: Joint, y0: number, y1: number): WeightFn {
  return (y) => {
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    const s = t * t * (3 - 2 * t);
    if (s <= 0.001) return [[lo, 1]];
    if (s >= 0.999) return [[hi, 1]];
    return [
      [lo, 1 - s],
      [hi, s],
    ];
  };
}

/** Sphere / ellipsoid profile (unit radius scaled by r), from bottom to top. */
function sphereProfile(
  r: number,
  rings: number,
  from = -Math.PI / 2,
  to = Math.PI / 2,
): ProfilePt[] {
  const out: ProfilePt[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = from + ((to - from) * i) / rings;
    out.push({ r: Math.max(0, Math.cos(a) * r), y: Math.sin(a) * r });
  }
  if (from <= -Math.PI / 2 + 1e-6) out[0].r = 0;
  if (to >= Math.PI / 2 - 1e-6) out[out.length - 1].r = 0;
  return out;
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  key: number[] = [];
  mi: number[] = [];
  mw: number[] = [];
  idx: number[] = [];

  private pushVertex(p: V3, n: V3, key: ColorKey, w: Weights): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push((SLOT_OF[key] + 0.5) / SLOT_COUNT, 0.5);
    this.key.push(COLOR_KEYS.indexOf(key));
    const ws = w.slice(0, 4);
    let total = 0;
    for (const [, v] of ws) total += v;
    for (let i = 0; i < 4; i++) {
      const e = ws[i];
      this.mi.push(e ? JOINT_INDEX[e[0]] : 0);
      this.mw.push(e ? e[1] / (total || 1) : 0);
    }
  }

  lathe(profile: ProfilePt[], o: LatheOpts): void {
    const seg = o.seg ?? 12;
    const sx = o.sx ?? 1;
    const sz = o.sz ?? 1;
    const [a0, a1] = o.arc ?? [0, Math.PI * 2];
    const base = this.pos.length / 3;
    const n = profile.length;
    let key = o.key;
    const keys: ColorKey[] = profile.map((p) => (key = p.key ?? key));
    for (let i = 0; i < n; i++) {
      // Tangent from the nearest distinct neighbours.
      let ip = i - 1;
      while (
        ip >= 0 &&
        Math.hypot(profile[ip].r - profile[i].r, profile[ip].y - profile[i].y) <
          1e-7
      )
        ip--;
      let inx = i + 1;
      while (
        inx < n &&
        Math.hypot(
          profile[inx].r - profile[i].r,
          profile[inx].y - profile[i].y,
        ) < 1e-7
      )
        inx++;
      const pa = profile[Math.max(0, ip)];
      const pb = profile[Math.min(n - 1, inx)];
      let dr = pb.r - pa.r;
      let dy = pb.y - pa.y;
      const dl = Math.hypot(dr, dy) || 1;
      dr /= dl;
      dy /= dl;
      const nr = dy;
      const ny = -dr;
      for (let j = 0; j <= seg; j++) {
        const a = a0 + ((a1 - a0) * j) / seg;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const local: V3 = [
          profile[i].r * ca * sx,
          profile[i].y,
          profile[i].r * sa * sz,
        ];
        let ln: V3 = [(nr * ca) / sx, ny, (nr * sa) / sz];
        const ll = Math.hypot(ln[0], ln[1], ln[2]) || 1;
        ln = [ln[0] / ll, ln[1] / ll, ln[2] / ll];
        const rp = rotate(local, o.rot);
        const p: V3 = [
          rp[0] + o.center[0],
          rp[1] + o.center[1],
          rp[2] + o.center[2],
        ];
        let nn = rotate(ln, o.rot);
        if (o.clampMinY !== undefined && p[1] < o.clampMinY) {
          p[1] = o.clampMinY;
          nn = [0, -1, 0];
        }
        const w: Weights =
          typeof o.bones === "string" ? [[o.bones, 1]] : o.bones(p[1]);
        this.pushVertex(p, nn, keys[i], w);
      }
    }
    const row = seg + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * row + j;
        const b = a + 1;
        const c = a + row + 1;
        const d = a + row;
        // Winding chosen so (p1 - p2) x (p3 - p2) points outward (Babylon).
        this.idx.push(a, b, c, a, c, d);
      }
    }
  }

  ellipsoid(
    center: V3,
    radii: V3,
    key: ColorKey,
    bones: Joint | WeightFn,
    rot?: V3,
    seg = 10,
    clampMinY?: number,
  ): void {
    const rings = Math.max(4, Math.round(seg * 0.6));
    const prof = sphereProfile(1, rings).map((p) => ({
      r: p.r * radii[0],
      y: p.y * radii[1],
    }));
    this.lathe(prof, {
      center,
      seg,
      sx: 1,
      sz: radii[2] / radii[0],
      rot,
      key,
      bones,
      clampMinY,
    });
  }

  /**
   * Shell that hugs a lathe profile (r(y)) above an angle-dependent cut line —
   * hair that follows the head shape with a natural hairline.
   */
  shell(o: {
    center: V3;
    radiusAt: (y: number) => number;
    yTop: number;
    cut: (angle: number) => number;
    sz: number;
    key: ColorKey;
    bones: Joint;
    rings?: number;
    seg?: number;
  }): void {
    const rings = o.rings ?? 14;
    const seg = o.seg ?? 24;
    const base = this.pos.length / 3;
    let yMin = Infinity;
    for (let j = 0; j <= seg; j++)
      yMin = Math.min(yMin, o.cut((j / seg) * Math.PI * 2));
    for (let i = 0; i <= rings; i++) {
      const ringY = yMin + ((o.yTop - yMin) * i) / rings;
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const y = Math.min(o.yTop, Math.max(ringY, o.cut(a)));
        const r = i === rings ? 0 : o.radiusAt(y);
        const h = 0.004;
        const dr =
          (o.radiusAt(Math.min(o.yTop, y + h)) -
            o.radiusAt(Math.max(yMin, y - h))) /
          (2 * h);
        let nr = 1;
        let ny = -dr;
        const nl = Math.hypot(nr, ny) || 1;
        nr /= nl;
        ny /= nl;
        if (i === rings) {
          nr = 0;
          ny = 1;
        }
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const p: V3 = [
          o.center[0] + r * ca,
          o.center[1] + y,
          o.center[2] + r * sa * o.sz,
        ];
        let n: V3 = [nr * ca, ny, (nr * sa) / o.sz];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        n = [n[0] / l, n[1] / l, n[2] / l];
        this.pushVertex(p, n, o.key, [[o.bones, 1]]);
      }
    }
    const row = seg + 1;
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * row + j;
        this.idx.push(a, a + 1, a + row + 1, a, a + row + 1, a + row);
      }
    }
  }

  build(): MannequinGeometry {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      keys: new Uint8Array(this.key),
      indices: new Uint32Array(this.idx),
      matricesIndices: new Float32Array(this.mi),
      matricesWeights: new Float32Array(this.mw),
      vertexCount: this.pos.length / 3,
    };
  }
}

/** Rest-pose world position of a joint (standing). */
export function restJointPosition(j: Joint): V3 {
  let p: V3 = [0, 0, 0];
  let cur: Joint | null = j;
  while (cur) {
    const o: V3 = SKELETON[cur].offset;
    p = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
    cur = SKELETON[cur].parent;
  }
  return p;
}

const HEAD_SZ = 1.06;
const HEAD_PROFILE: ProfilePt[] = [
  { r: 0, y: -0.128 },
  { r: 0.05, y: -0.124 },
  { r: 0.079, y: -0.104 },
  { r: 0.096, y: -0.07 },
  { r: 0.106, y: -0.025 },
  { r: 0.11, y: 0.025 },
  { r: 0.106, y: 0.07 },
  { r: 0.09, y: 0.108 },
  { r: 0.06, y: 0.133 },
  { r: 0.03, y: 0.143 },
  { r: 0, y: 0.146 },
];

/** Head radius at a profile height (linear interpolation). */
export function headRadiusAt(y: number): number {
  const p = HEAD_PROFILE;
  if (y <= p[0].y) return p[0].r;
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i].y) {
      const t = (y - p[i - 1].y) / (p[i].y - p[i - 1].y);
      return p[i - 1].r + (p[i].r - p[i - 1].r) * t;
    }
  }
  return 0;
}

const smooth01 = (v: number): number => {
  const x = Math.min(1, Math.max(0, v));
  return x * x * (3 - 2 * x);
};

export function buildMannequinGeometry(
  opts: MannequinGeometryOptions,
): MannequinGeometry {
  const b = new Builder();
  const shoulderY = restJointPosition("shoulderR")[1];
  const elbowY = restJointPosition("elbowR")[1];
  const wristY = restJointPosition("wristR")[1];
  const hipJ = restJointPosition("hipR");
  const kneeY = restJointPosition("kneeR")[1];
  const headY = restJointPosition("head")[1];
  const neckY = restJointPosition("neck")[1];
  const headC: V3 = [0, headY + 0.11, 0.012];

  // --- Torso (shirt) ------------------------------------------------------
  b.lathe(
    [
      { r: 0, y: 0.99 },
      { r: 0.15, y: 0.992 },
      { r: 0.153, y: 1.03 },
      { r: 0.149, y: 1.1 },
      { r: 0.156, y: 1.17 },
      { r: 0.17, y: 1.25 },
      { r: 0.178, y: 1.31 },
      { r: 0.177, y: 1.36 },
      { r: 0.163, y: 1.405 },
      { r: 0.125, y: 1.44 },
      { r: 0.07, y: 1.462 },
      { r: 0, y: 1.468 },
    ],
    {
      center: [0, 0, 0],
      seg: 22,
      sz: 0.64,
      key: "shirt",
      bones: blendY("spine", "chest", 1.06, 1.22),
    },
  );
  // Collar ring.
  b.lathe(
    Array.from({ length: 9 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
      return { r: 0.058 + Math.cos(a) * 0.013, y: Math.sin(a) * 0.013 };
    }),
    {
      center: [0, 1.452, 0.004],
      seg: 16,
      sz: 0.92,
      key: "collar",
      bones: "chest",
    },
  );
  // --- Pelvis (trousers) + belt ------------------------------------------
  b.lathe(
    [
      { r: 0, y: 0.85 },
      { r: 0.09, y: 0.853 },
      { r: 0.136, y: 0.878 },
      { r: 0.149, y: 0.925 },
      { r: 0.151, y: 0.97 },
      { r: 0.148, y: 1.0 },
      { r: 0, y: 1.004 },
    ],
    { center: [0, 0, 0], seg: 20, sz: 0.72, key: "trousers", bones: "hips" },
  );
  b.lathe(
    [
      { r: 0.151, y: 0.972 },
      { r: 0.1545, y: 0.976 },
      { r: 0.1545, y: 1.0 },
      { r: 0.151, y: 1.005 },
    ],
    { center: [0, 0, 0], seg: 20, sz: 0.72, key: "belt", bones: "hips" },
  );

  // --- Legs ---------------------------------------------------------------
  for (const side of [-1, 1]) {
    const L = side < 0;
    const hip: Joint = L ? "hipL" : "hipR";
    const knee: Joint = L ? "kneeL" : "kneeR";
    const ankle: Joint = L ? "ankleL" : "ankleR";
    const x = side * Math.abs(hipJ[0]);
    b.lathe(
      [
        { r: 0, y: 0.088 },
        { r: 0.047, y: 0.09 },
        { r: 0.051, y: 0.125 },
        { r: 0.052, y: 0.2 },
        { r: 0.057, y: 0.3 },
        { r: 0.054, y: 0.4 },
        { r: 0.056, y: kneeY },
        { r: 0.062, y: 0.53 },
        { r: 0.072, y: 0.65 },
        { r: 0.079, y: 0.78 },
        { r: 0.082, y: 0.86 },
        { r: 0.075, y: 0.93 },
        { r: 0.04, y: 0.965 },
        { r: 0, y: 0.972 },
      ],
      {
        center: [x, 0, 0],
        seg: 14,
        sz: 1.05,
        key: "trousers",
        bones: (y) =>
          y < 0.16
            ? [
                [ankle, 0.35],
                [knee, 0.65],
              ]
            : blendY(knee, hip, kneeY - 0.035, kneeY + 0.06)(y),
      },
    );
    // Shoe + sole.
    b.ellipsoid(
      [x, 0.05, 0.035],
      [0.054, 0.058, 0.128],
      "shoes",
      ankle,
      undefined,
      14,
      0.018,
    );
    b.ellipsoid(
      [x, 0.016, 0.036],
      [0.057, 0.02, 0.131],
      "sole",
      ankle,
      undefined,
      14,
      0,
    );
  }

  // --- Arms (short sleeves) + hands ----------------------------------------
  for (const side of [-1, 1]) {
    const L = side < 0;
    const sh: Joint = L ? "shoulderL" : "shoulderR";
    const el: Joint = L ? "elbowL" : "elbowR";
    const wr: Joint = L ? "wristL" : "wristR";
    const x = side * 0.19;
    b.lathe(
      [
        { r: 0, y: wristY + 0.005, key: "skin" },
        { r: 0.029, y: wristY + 0.008 },
        { r: 0.033, y: wristY + 0.05 },
        { r: 0.039, y: wristY + 0.12 },
        { r: 0.042, y: elbowY - 0.06 },
        { r: 0.04, y: elbowY },
        { r: 0.042, y: elbowY + 0.03 },
        { r: 0.0435, y: elbowY + 0.03, key: "shirt" },
        { r: 0.053, y: elbowY + 0.034 },
        { r: 0.054, y: elbowY + 0.09 },
        { r: 0.056, y: elbowY + 0.18 },
        { r: 0.057, y: shoulderY - 0.03 },
        { r: 0.055, y: shoulderY + 0.005 },
        { r: 0.046, y: shoulderY + 0.03 },
        { r: 0.028, y: shoulderY + 0.048 },
        { r: 0, y: shoulderY + 0.054 },
      ],
      {
        center: [x, 0, -0.005],
        seg: 12,
        sz: 0.95,
        key: "skin",
        bones: blendY(el, sh, elbowY - 0.03, elbowY + 0.05),
      },
    );
    // Mitten hand (palm faces the body), thumb forward.
    b.ellipsoid(
      [x, wristY - 0.062, 0.004],
      [0.031, 0.068, 0.05],
      "skin",
      wr,
      undefined,
      12,
    );
    b.ellipsoid(
      [x - side * 0.012, wristY - 0.035, 0.036],
      [0.015, 0.03, 0.016],
      "skin",
      wr,
      [0.35, 0, 0],
      8,
    );
  }

  // --- Neck + head --------------------------------------------------------
  b.lathe(
    [
      { r: 0.05, y: neckY - 0.01 },
      { r: 0.046, y: neckY + 0.06 },
      { r: 0.049, y: headY + 0.06 },
    ],
    {
      center: [0, 0, 0.004],
      seg: 12,
      key: "skin",
      bones: blendY("neck", "head", neckY + 0.04, headY + 0.02),
    },
  );
  b.lathe(HEAD_PROFILE, {
    center: headC,
    seg: 22,
    sz: HEAD_SZ,
    key: "skin",
    bones: "head",
  });
  const faceZ = (x: number, yRel: number): number => {
    // Approximate the head profile radius at yRel for feature placement.
    const r = 0.11 - Math.max(0, Math.abs(yRel - 0.0) - 0.03) * 0.25;
    return headC[2] + 1.06 * Math.sqrt(Math.max(0, r * r - x * x));
  };
  for (const side of [-1, 1]) {
    const ex = side * 0.039;
    b.ellipsoid(
      [ex, headC[1] + 0.012, faceZ(ex, 0.012) - 0.006],
      [0.0135, 0.019, 0.01],
      "eyes",
      "head",
      undefined,
      8,
    );
    b.ellipsoid(
      [side * 0.041, headC[1] + 0.046, faceZ(0.041, 0.046) - 0.004],
      [0.022, 0.0055, 0.008],
      "brow",
      "head",
      [0, 0, side * -0.12],
      8,
    );
    b.ellipsoid(
      [side * 0.108, headC[1] - 0.005, 0.0],
      [0.014, 0.03, 0.022],
      "skin",
      "head",
      undefined,
      8,
    );
  }
  b.ellipsoid(
    [0, headC[1] - 0.022, faceZ(0, -0.022) - 0.004],
    [0.014, 0.022, 0.017],
    "skin",
    "head",
    [-0.2, 0, 0],
    8,
  );
  b.ellipsoid(
    [0, headC[1] - 0.06, faceZ(0, -0.06) - 0.006],
    [0.02, 0.0045, 0.006],
    "lip",
    "head",
    undefined,
    8,
  );

  // --- Hair ---------------------------------------------------------------
  // angle a: sin(a) > 0 is the face (+Z), < 0 the back of the head.
  const top = HEAD_PROFILE[HEAD_PROFILE.length - 1].y;
  if (opts.hairStyle === 2) {
    // Bob: hangs straight to jaw level at the back and sides, open face.
    b.shell({
      center: headC,
      radiusAt: (y) =>
        (Math.max(headRadiusAt(y), y < 0.02 ? 0.1 : 0) + 0.008) * 1.04,
      yTop: top + 0.012,
      cut: (a) => -0.115 + 0.165 * smooth01((Math.sin(a) - 0.2) / 0.55),
      sz: HEAD_SZ * 1.02,
      key: "hair",
      bones: "head",
    });
  } else {
    b.shell({
      center: headC,
      radiusAt: (y) => headRadiusAt(y) * 1.035 + 0.006,
      yTop: top + 0.01,
      cut: (a) =>
        -0.03 +
        0.072 * Math.sin(a) +
        (Math.sin(a) < 0 ? 0.04 * Math.sin(a) : 0),
      sz: HEAD_SZ * 1.01,
      key: "hair",
      bones: "head",
    });
    if (opts.hairStyle === 1) {
      b.ellipsoid(
        [0, headC[1] + 0.085, headC[2] - 0.11],
        [0.048, 0.044, 0.046],
        "hair",
        "head",
        undefined,
        10,
      );
    }
  }

  // --- Boss headset -------------------------------------------------------
  if (opts.boss) {
    const hc: V3 = [0, headC[1] + 0.005, headC[2] - 0.01];
    const ring = Array.from({ length: 9 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
      return { r: 0.131 + Math.cos(a) * 0.008, y: Math.sin(a) * 0.006 };
    });
    b.lathe(ring, {
      center: hc,
      seg: 18,
      arc: [0, Math.PI],
      rot: [-Math.PI / 2, 0, 0],
      key: "headset",
      bones: "head",
    });
    for (const side of [-1, 1]) {
      const cup = [
        { r: 0, y: -0.018 },
        { r: 0.034, y: -0.018 },
        { r: 0.037, y: -0.008 },
        { r: 0.037, y: 0.008, key: "accent" as ColorKey },
        { r: 0.034, y: 0.016, key: "headset" as ColorKey },
        { r: 0, y: 0.018 },
      ];
      b.lathe(cup, {
        center: [side * 0.122, hc[1] - 0.012, hc[2] + 0.005],
        seg: 14,
        rot: [0, 0, side * (Math.PI / 2)],
        key: "headset",
        bones: "head",
      });
    }
    // Mic boom from the left cup along the cheek toward the mouth.
    const cup: V3 = [-0.125, hc[1] - 0.03, hc[2] + 0.02];
    const tip: V3 = [-0.045, headC[1] - 0.066, headC[2] + 0.112];
    const d: V3 = [tip[0] - cup[0], tip[1] - cup[1], tip[2] - cup[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const mid: V3 = [
      (cup[0] + tip[0]) / 2,
      (cup[1] + tip[1]) / 2,
      (cup[2] + tip[2]) / 2,
    ];
    b.lathe(
      [
        { r: 0, y: -len / 2 },
        { r: 0.0045, y: -len / 2 + 0.002 },
        { r: 0.0045, y: len / 2 - 0.002 },
        { r: 0, y: len / 2 },
      ],
      {
        center: mid,
        seg: 6,
        rot: [Math.acos(d[1] / len), Math.atan2(d[0], d[2]), 0],
        key: "headset",
        bones: "head",
      },
    );
    b.ellipsoid(
      [-0.043, headC[1] - 0.067, headC[2] + 0.114],
      [0.011, 0.011, 0.013],
      "accent",
      "head",
      undefined,
      8,
    );
  }

  return b.build();
}
