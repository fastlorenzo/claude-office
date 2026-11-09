/**
 * Exterior — the building is a software factory in an industrial park.
 *
 * The office floor is y = 0; the factory floor and the outside ground are at
 * GROUND_Y = -6. Two layers, both cheap:
 *  - FAR (three hazy ridgelines, a distant low skyline, ~700 low sheds,
 *    field/forest-patched ground) is built once as merged unlit meshes,
 *    rendered ONCE with the pure-sky HDRI and exponential aerial-perspective
 *    fog into a cube map from the floor's centre, then disposed. That cube
 *    becomes the skybox (zero per-frame cost).
 *  - NEAR (textured ground atlas: grass / asphalt / concrete / gravel with
 *    kerbs, markings and wear; neighbouring sheds with cladding, parapets,
 *    rooftop plant, loading doors; alpha-tested crossed-card trees; baked
 *    sun shadows) is real geometry merged into FIVE draws: ground,
 *    buildings, props, trees, shadows — plus TWO for the parked cars
 *    (exterior/cars.ts: lit clear-coat PBR bodies + thin-instanced wheels).
 *
 * Placement is the pure, tested `layout/exteriorPlan.ts`. Lighting is baked
 * into vertex colours on unlit PBR materials (warm sun side, cool sky side,
 * same direction as fx/Lighting.ts): no light budget, no runtime shadows
 * (the cars alone are lit, so paint and glass catch the sun and the sky).
 */
import {
  Color3,
  Mesh,
  PBRMaterial,
  RawTexture,
  ReflectionProbe,
  Scene,
  Vector3,
  VertexData,
  type AbstractMesh,
  Texture,
} from "@/engine/babylon";
import { rng } from "@/engine/art/random";
import {
  TERRAIN_R0,
  TERRAIN_R1,
  terrainHeight,
} from "@/engine/world/exterior/terrain";
import type { Lighting } from "@/engine/fx/Lighting";
import { LAYOUT } from "@/engine/contracts";
import { FACTORY } from "@/engine/layout/factoryLayout";
import { Colliders } from "@/engine/physics/Colliders";
import {
  EXTERIOR_PROPS_GROUP,
  exteriorPropBoxes,
} from "@/engine/world/forecourtColliders";
import {
  GROUND_Y,
  planExterior,
  type ExteriorPlan,
  type Footprint,
  type Rect,
} from "@/engine/layout/exteriorPlan";
import {
  buildParkedCars,
  carMaterial,
  setCarReflection,
} from "@/engine/world/exterior/cars";
import { carModel } from "@/engine/layout/carModels";
import {
  GROUND_TILE_M,
  TILE_ASPHALT,
  TILE_CONCRETE,
  TILE_GRASS,
  TILE_GRAVEL,
  TREE_BROADLEAF,
  TREE_COLUMNAR,
  TREE_SHRUB,
  TREE_TOP,
  CLAD_H_M,
  claddingAtlas,
  groundAtlas,
  tileUV,
  treeAtlas,
  type RGB,
} from "@/engine/world/exterior/textures";

export { GROUND_Y };

const HAZE = new Color3(0.86, 0.92, 1.0);
/** Live exterior fog (linear). The camera far plane is 220 m (Player). */
const FOG_START = 70;
const FOG_END = 520;
/** Haze fraction the baked ground veil holds beyond the clipped near ground. */
const FOG_CAP = 0.45;
const TERRAIN_SEED = 5;
/** Same direction as the interior sun (fx/Lighting.ts SUN_DIR). */
const SUN = new Vector3(-0.5, -0.62, 0.6).normalize();
const SUN_XZ = Math.hypot(SUN.x, SUN.z);
/** Ground shadow offset per metre of caster height (light travels along SUN). */
const SH_X = SUN.x / -SUN.y;
const SH_Z = SUN.z / -SUN.y;

interface Buf {
  pos: number[];
  nrm: number[];
  col: number[];
  uv: number[];
  idx: number[];
}
const newBuf = (): Buf => ({ pos: [], nrm: [], col: [], uv: [], idx: [] });

const GRASS_A: RGB = [0.4, 0.52, 0.26];
const GRASS_B: RGB = [0.5, 0.55, 0.28];
const LAWN: RGB = [0.34, 0.5, 0.24];
const ASPHALT: RGB = [0.27, 0.28, 0.3];
const CONCRETE: RGB = [0.72, 0.71, 0.68];
const PAINT_W: RGB = [0.92, 0.92, 0.88];
const PAINT_Y: RGB = [0.92, 0.74, 0.12];
const KERB: RGB = [0.66, 0.66, 0.63];
const ROOF: RGB = [0.4, 0.41, 0.42];

const SHED_TINTS: RGB[] = [
  [0.9, 0.9, 0.88],
  [0.8, 0.85, 0.9],
  [0.92, 0.88, 0.8],
  [0.76, 0.82, 0.78],
  [0.95, 0.94, 0.9],
  [0.7, 0.76, 0.84],
];
const ACCENTS: RGB[] = [
  [0.1, 0.42, 0.58],
  [0.78, 0.3, 0.1],
  [0.12, 0.34, 0.2],
  [0.62, 0.12, 0.14],
  [0.2, 0.26, 0.5],
  [0.8, 0.62, 0.1],
];
const SUN_TINT: RGB = [1.0, 0.94, 0.84];
const SKY_TINT: RGB = [0.74, 0.84, 1.0];

/** Baked light for a face normal: warm on the sun side, cool in the shade. */
function shade(nx: number, ny: number, nz: number): RGB {
  if (ny > 0.5) return [0.9, 0.92, 0.92];
  const s = Math.max(0, -(nx * SUN.x + nz * SUN.z) / SUN_XZ);
  const l = 0.52 + 0.48 * s;
  return [
    (SKY_TINT[0] + (SUN_TINT[0] - SKY_TINT[0]) * s) * l,
    (SKY_TINT[1] + (SUN_TINT[1] - SKY_TINT[1]) * s) * l,
    (SKY_TINT[2] + (SUN_TINT[2] - SKY_TINT[2]) * s) * l,
  ];
}

const mul = (c: RGB, s: number | RGB): RGB =>
  typeof s === "number"
    ? [c[0] * s, c[1] * s, c[2] * s]
    : [c[0] * s[0], c[1] * s[1], c[2] * s[2]];
const lerp = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** World-space smooth value noise (non-tiling) for large-scale colour drift. */
function vnoise(x: number, z: number, scale: number, seed: number): number {
  const h = (i: number, j: number) => {
    let n = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = h(x0, z0) + (h(x0 + 1, z0) - h(x0, z0)) * sx;
  const b = h(x0, z0 + 1) + (h(x0 + 1, z0 + 1) - h(x0, z0 + 1)) * sx;
  return a + (b - a) * sz;
}

function quad(
  b: Buf,
  p: number[][],
  c: RGB | RGB[],
  uvs: number[][] | null = null,
  alpha: number | number[] = 1,
): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    const ci = Array.isArray(c[0]) ? (c as RGB[])[i] : (c as RGB);
    b.pos.push(p[i][0], p[i][1], p[i][2]);
    b.col.push(
      ci[0],
      ci[1],
      ci[2],
      typeof alpha === "number" ? alpha : alpha[i],
    );
    b.uv.push(uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0);
  }
  b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** Flat horizontal rectangle (top-facing), untextured. */
function flat(b: Buf, r: Rect, y: number, c: RGB): void {
  quad(
    b,
    [
      [r.x0, y, r.z0],
      [r.x1, y, r.z0],
      [r.x1, y, r.z1],
      [r.x0, y, r.z1],
    ],
    c,
  );
}

/**
 * Textured ground rect, cut on the world grid of the tile's metre size so tile
 * joints line up between rects; colour sampled per vertex (smooth drift).
 */
function tiled(
  b: Buf,
  r: Rect,
  y: number,
  tile: number,
  colorAt: (x: number, z: number) => RGB,
): void {
  const m = GROUND_TILE_M[tile];
  const i0 = Math.floor(r.x0 / m);
  const i1 = Math.ceil(r.x1 / m);
  const j0 = Math.floor(r.z0 / m);
  const j1 = Math.ceil(r.z1 / m);
  for (let i = i0; i < i1; i++)
    for (let j = j0; j < j1; j++) {
      const x0 = Math.max(r.x0, i * m);
      const x1 = Math.min(r.x1, (i + 1) * m);
      const z0 = Math.max(r.z0, j * m);
      const z1 = Math.min(r.z1, (j + 1) * m);
      if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) continue;
      const uv = (x: number, z: number) =>
        tileUV(tile, (x - i * m) / m, (z - j * m) / m);
      quad(
        b,
        [
          [x0, y, z0],
          [x1, y, z0],
          [x1, y, z1],
          [x0, y, z1],
        ],
        [colorAt(x0, z0), colorAt(x1, z0), colorAt(x1, z1), colorAt(x0, z1)],
        [uv(x0, z0), uv(x1, z0), uv(x1, z1), uv(x0, z1)],
      );
    }
}

interface BoxOpts {
  yaw?: number;
  /** Facade UVs (cladding atlas): 0 glazed office, 1 warehouse. */
  facade?: 0 | 1;
  /** Skip the listed sides (px, nx, pz, nz). */
  skip?: string;
  top?: boolean;
}

/** Yaw-rotated box without a bottom face. */
function box(
  b: Buf,
  cx: number,
  cz: number,
  y0: number,
  y1: number,
  hw: number,
  hd: number,
  color: RGB,
  o: BoxOpts = {},
): void {
  const yaw = o.yaw ?? 0;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const P = (lx: number, y: number, lz: number) => [
    cx + lx * cs - lz * sn,
    y,
    cz + lx * sn + lz * cs,
  ];
  const N = (nx: number, nz: number): [number, number] => [
    nx * cs - nz * sn,
    nx * sn + nz * cs,
  ];
  const h = y1 - y0;
  const v0 = Math.min(y0 - GROUND_Y, CLAD_H_M - h - 0.01);
  const uOff = o.facade === 1 ? 6 : 0;
  const side = (
    key: string,
    a: number[],
    c: number[],
    nx: number,
    nz: number,
    len: number,
  ) => {
    if (o.skip?.includes(key)) return;
    const [rx, rz] = N(nx, nz);
    const col = mul(color, shade(rx, 0, rz));
    // Facade quads are cut into <= 5.9 m runs so the u range never leaves
    // its 6 m variant of the cladding atlas.
    const segs = o.facade === undefined ? 1 : Math.max(1, Math.ceil(len / 5.9));
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const lerpP = (t: number) => [
        a[0] + (c[0] - a[0]) * t,
        a[1] + (c[1] - a[1]) * t,
      ];
      const pa = lerpP(t0);
      const pc = lerpP(t1);
      const l0 = 0.03;
      const l1 = (t1 - t0) * len - 0.03;
      quad(
        b,
        [
          P(pa[0], y0, pa[1]),
          P(pc[0], y0, pc[1]),
          P(pc[0], y1, pc[1]),
          P(pa[0], y1, pa[1]),
        ],
        col,
        o.facade !== undefined
          ? [
              [uOff + l0, v0],
              [uOff + l1, v0],
              [uOff + l1, v0 + h],
              [uOff + l0, v0 + h],
            ]
          : null,
      );
    }
  };
  side("z", [-hw, hd], [hw, hd], 0, 1, 2 * hw);
  side("Z", [hw, -hd], [-hw, -hd], 0, -1, 2 * hw);
  side("x", [hw, hd], [hw, -hd], 1, 0, 2 * hd);
  side("X", [-hw, -hd], [-hw, hd], -1, 0, 2 * hd);
  if (o.top !== false) {
    quad(
      b,
      [P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd)],
      mul(color, shade(0, 1, 0)),
      o.facade !== undefined
        ? [
            [uOff + 3, 2],
            [uOff + 3, 2],
            [uOff + 3, 2],
            [uOff + 3, 2],
          ]
        : null,
    );
  }
}

/** Upright n-gon prism (tanks, stacks). */
function prism(
  b: Buf,
  cx: number,
  cz: number,
  y0: number,
  y1: number,
  r: number,
  n: number,
  color: RGB,
): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const col = mul(color, shade(Math.cos(am), 0, Math.sin(am)));
    quad(
      b,
      [
        [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r],
        [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r],
        [cx + Math.cos(a1) * r, y1, cz + Math.sin(a1) * r],
        [cx + Math.cos(a0) * r, y1, cz + Math.sin(a0) * r],
      ],
      [mul(col, 0.8), mul(col, 0.8), col, col],
    );
  }
  const base = b.pos.length / 3;
  b.pos.push(cx, y1, cz);
  b.col.push(...mul(color, 0.92), 1);
  b.uv.push(0, 0);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.pos.push(cx + Math.cos(a) * r, y1, cz + Math.sin(a) * r);
    b.col.push(...mul(color, 0.92), 1);
    b.uv.push(0, 0);
    if (i > 0) b.idx.push(base, base + i + 1, base + i);
  }
}

/** Convex hull (monotone chain) of 2D points, counter-clockwise. */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (
      lo.length >= 2 &&
      cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0
    )
      lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (
      up.length >= 2 &&
      cross(up[up.length - 2], up[up.length - 1], q) <= 0
    )
      up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const SHADOW_RGB: RGB = [0.04, 0.06, 0.14];
const SHADOW_A = 0.34;

/** Convex polygon as an alpha-blended fan at height y. */
function poly(b: Buf, pts: [number, number][], y: number, a = SHADOW_A): void {
  const base = b.pos.length / 3;
  for (const [x, z] of pts) {
    b.pos.push(x, y, z);
    b.col.push(SHADOW_RGB[0], SHADOW_RGB[1], SHADOW_RGB[2], a);
    b.uv.push(0, 0);
  }
  for (let i = 1; i < pts.length - 1; i++)
    b.idx.push(base, base + i + 1, base + i);
}

/** Ground shadow of an axis-aligned prism footprint of height h. */
function boxShadow(b: Buf, r: Rect, h: number, y: number): void {
  const sx = SH_X * h;
  const sz = SH_Z * h;
  const c: [number, number][] = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
  poly(
    b,
    hull([...c, ...c.map(([x, z]): [number, number] => [x + sx, z + sz])]),
    y,
  );
}

function toMesh(scene: Scene, name: string, b: Buf, mat: PBRMaterial): Mesh {
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = b.pos;
  vd.colors = b.col;
  if (b.nrm.length) vd.normals = b.nrm;
  vd.uvs = b.uv;
  vd.indices = b.idx;
  vd.applyToMesh(m);
  m.material = mat;
  m.isPickable = false;
  m.receiveShadows = false;
  m.doNotSyncBoundingInfo = true;
  m.alwaysSelectAsActiveMesh = true;
  m.freezeWorldMatrix();
  return m;
}

/** Radial heightfield ring (TERRAIN_R0..R1) with relief-lit vertex colours. */
function buildTerrain(cx: number, cz: number, g: number, r: () => number): Buf {
  const b = newBuf();
  const SEG = 720;
  const K = 200;
  const W = SEG + 1;
  const hs = new Float32Array((K + 1) * W);
  const rad: number[] = [];
  for (let k = 0; k <= K; k++)
    rad.push(TERRAIN_R0 * Math.pow(TERRAIN_R1 / TERRAIN_R0, k / K));
  for (let k = 0; k <= K; k++)
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const h =
        s === SEG
          ? hs[k * W]
          : terrainHeight(
              Math.sin(a) * rad[k],
              Math.cos(a) * rad[k],
              TERRAIN_SEED,
            );
      hs[k * W + s] = h;
      b.pos.push(cx + Math.sin(a) * rad[k], g + h, cz + Math.cos(a) * rad[k]);
      b.uv.push(0, 0);
    }
  const P = (k: number, s: number): [number, number, number] => {
    const i = (Math.min(K, Math.max(0, k)) * W + ((s + SEG) % SEG)) * 3;
    return [b.pos[i], b.pos[i + 1], b.pos[i + 2]];
  };
  const seed = Math.floor(r() * 1000);
  const forest: RGB = [0.16, 0.27, 0.15];
  const forest2: RGB = [0.2, 0.31, 0.17];
  const field: RGB = [0.42, 0.46, 0.25];
  const field2: RGB = [0.5, 0.48, 0.28];
  const rock: RGB = [0.47, 0.45, 0.4];
  const scree: RGB = [0.56, 0.54, 0.5];
  for (let k = 0; k <= K; k++)
    for (let s = 0; s <= SEG; s++) {
      const a = P(k, s - 1);
      const c = P(k, s + 1);
      const d = P(k - 1, s);
      const e = P(k + 1, s);
      const t1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const t2 = [e[0] - d[0], e[1] - d[1], e[2] - d[2]];
      let nx = t1[1] * t2[2] - t1[2] * t2[1];
      let ny = t1[2] * t2[0] - t1[0] * t2[2];
      let nz = t1[0] * t2[1] - t1[1] * t2[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      b.nrm.push(nx, ny, nz);
      const p = P(k, s);
      const h = hs[k * W + s];
      const slope = 1 - ny;
      const patch =
        vnoise(p[0], p[2], 260, seed) * 0.65 +
        vnoise(p[0], p[2], 60, seed + 1) * 0.35;
      const grain = vnoise(p[0], p[2], 25, seed + 2);
      // Low and gentle: fields; mid: forest; steep or high: rock / scree.
      let col = lerp(forest, forest2, grain);
      const meadow =
        (1 - smoothstep(60, 190, h)) * smoothstep(0.42, 0.58, patch);
      col = lerp(col, lerp(field, field2, grain), meadow);
      const rk = Math.max(
        smoothstep(0.16, 0.34, slope),
        smoothstep(230, 380, h) * 0.8,
      );
      col = lerp(
        col,
        lerp(rock, scree, smoothstep(0.3, 0.5, slope) * grain),
        rk,
      );
      const lit =
        0.5 + 0.62 * Math.max(0, -(nx * SUN.x + ny * SUN.y + nz * SUN.z));
      b.col.push(col[0] * lit, col[1] * lit, col[2] * lit, 1);
      if (k > 0 && s > 0) {
        const i = k * W + s;
        const j = i - W;
        b.idx.push(j - 1, i, j, j - 1, i - 1, i);
      }
    }
  return b;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const ROOF_COLS: RGB[] = [
  [0.55, 0.26, 0.2],
  [0.5, 0.22, 0.17],
  [0.38, 0.39, 0.41],
  [0.3, 0.32, 0.36],
  [0.62, 0.6, 0.55],
  [0.42, 0.3, 0.22],
];
const WALL_COLS: RGB[] = [
  [0.88, 0.85, 0.78],
  [0.82, 0.8, 0.74],
  [0.9, 0.9, 0.88],
  [0.78, 0.74, 0.66],
  [0.85, 0.82, 0.8],
];

/**
 * Distant built-up areas: clustered blocks on the terrain (cluster centres are
 * picked on low, flat ground). Industrial estates near the park, towns and
 * villages further out.
 */
function settlements(
  facade: Buf,
  roofs: Buf,
  cx: number,
  cz: number,
  g: number,
  heightAt: (x: number, z: number) => number,
  r: () => number,
): void {
  type Spec = {
    rMin: number;
    rMax: number;
    n: number;
    rad: [number, number];
    blocks: [number, number];
    industrial: boolean;
  };
  const specs: Spec[] = [
    {
      rMin: 320,
      rMax: 1300,
      n: 5,
      rad: [80, 220],
      blocks: [8, 22],
      industrial: true,
    },
    {
      rMin: 1500,
      rMax: 3200,
      n: 5,
      rad: [150, 420],
      blocks: [40, 110],
      industrial: false,
    },
    {
      rMin: 3200,
      rMax: 5200,
      n: 3,
      rad: [350, 800],
      blocks: [90, 220],
      industrial: false,
    },
  ];
  for (const sp of specs) {
    let placed = 0;
    for (let tries = 0; tries < 300 && placed < sp.n; tries++) {
      const a = r() * Math.PI * 2;
      const d = sp.rMin + r() * (sp.rMax - sp.rMin);
      const x = cx + Math.sin(a) * d;
      const z = cz + Math.cos(a) * d;
      // Valley floors only: low and flat around the centre.
      const rad = sp.rad[0] + r() * (sp.rad[1] - sp.rad[0]);
      const h0 = heightAt(x, z);
      const flat = [0, 1, 2, 3].every((q) => {
        const qa = q * 1.571;
        return (
          Math.abs(
            heightAt(x + Math.sin(qa) * rad, z + Math.cos(qa) * rad) - h0,
          ) < 14
        );
      });
      if (!sp.industrial && (h0 > 40 || !flat)) continue;
      if (sp.industrial && h0 > 1) continue;
      placed++;
      const nb = Math.round(sp.blocks[0] + r() * (sp.blocks[1] - sp.blocks[0]));
      const grid = r() * 1.5; // street grid yaw
      const wall = WALL_COLS[Math.floor(r() * WALL_COLS.length)];
      const roof = ROOF_COLS[Math.floor(r() * ROOF_COLS.length)];
      for (let i = 0; i < nb; i++) {
        // Gaussian-ish radial density: dense core, sparse edge.
        const rr = rad * Math.pow(r(), 0.7);
        const aa = r() * Math.PI * 2;
        const bx = x + Math.sin(aa) * rr;
        const bz = z + Math.cos(aa) * rr;
        const core = 1 - rr / rad;
        const w = sp.industrial ? 18 + r() * 40 : 7 + r() * 16;
        const dd = sp.industrial ? 16 + r() * 34 : 7 + r() * 14;
        const hgt = sp.industrial
          ? 6 + r() * 7
          : 5 +
            r() * 7 +
            (sp.rad[1] > 500 ? core * core * r() * 40 : core * r() * 10);
        const base = g + heightAt(bx, bz) - 3;
        const wc = mul(
          sp.industrial ? SHED_TINTS[Math.floor(r() * 6)] : wall,
          0.78 + r() * 0.2,
        );
        const rc = mul(
          r() < 0.65 ? roof : ROOF_COLS[Math.floor(r() * ROOF_COLS.length)],
          0.85 + r() * 0.25,
        );
        const yaw = grid + (r() < 0.2 ? r() : 0);
        box(facade, bx, bz, base, base + hgt + 3, w / 2, dd / 2, wc, {
          top: false,
          yaw,
        });
        box(
          roofs,
          bx,
          bz,
          base + hgt + 3,
          base + hgt + 3.1,
          w / 2,
          dd / 2,
          rc,
          { skip: "xXzZ", yaw },
        );
      }
    }
  }
}

function unlit(scene: Scene, name: string, tex: Texture | null): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.unlit = true;
  mat.albedoColor = Color3.White();
  if (tex) mat.albedoTexture = tex;
  mat.backFaceCulling = true;
  return mat;
}

/** Fields / forest / lots seen from far away; mean colour near the lawn. */
function farGroundTexture(scene: Scene, seed: number): RawTexture {
  const r = rng(seed);
  const cells = 8;
  const pat: RGB[] = [];
  for (let k = 0; k < cells * cells; k++) {
    const q = r();
    pat.push(
      q < 0.1
        ? [0.58, 0.56, 0.5] // yards / lots
        : q < 0.2
          ? [0.52, 0.48, 0.3] // stubble
          : q < 0.42
            ? mul([0.2, 0.34, 0.17], 0.85 + r() * 0.3) // woodland
            : mul(GRASS_A, 0.85 + r() * 0.25),
    );
  }
  const S = 128;
  const cell = S / cells;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const edge = x % cell < 1 || y % cell < 1; // hedgerow / track lines
      const c = mul(pat[gx + gy * cells], edge ? 0.72 : 0.92 + 0.16 * r());
      const i = (y * S + x) * 4;
      data[i] = Math.min(255, Math.round(c[0] * 255));
      data[i + 1] = Math.min(255, Math.round(c[1] * 255));
      data[i + 2] = Math.min(255, Math.round(c[2] * 255));
      data[i + 3] = 255;
    }
  const t = RawTexture.CreateRGBATexture(
    data,
    S,
    S,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  t.name = "exterior:farGround";
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

type Mats = {
  ground: PBRMaterial;
  build: PBRMaterial;
  props: PBRMaterial;
  trees: PBRMaterial;
  shadow: PBRMaterial;
};

export class Exterior {
  private near: Mesh[] = [];
  private probe: ReflectionProbe | null = null;
  private readonly owned: { dispose(): void }[] = [];
  private disposed = false;
  private mats: Mats;
  /** Parked cars: clear-coat paint / glass / rubber in one material. */
  private readonly carMat: PBRMaterial;
  plan: ExteriorPlan | null = null;
  /** ms from construction until the baked cube replaced the sky (null: pending). */
  bakeMs: number | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly lighting: Lighting,
    /** Centre of the office floor plate (x, z): the park is laid out around it. */
    private center: Vector3,
    /** Current factory envelope bounds (FactoryLayout.bounds). */
    bounds?: { min: { x: number; z: number }; max: { x: number; z: number } },
  ) {
    if (bounds) this.bounds = bounds;
    const gtex = groundAtlas(scene);
    const ctex = claddingAtlas(scene);
    const ttex = treeAtlas(scene);
    this.mats = {
      ground: unlit(scene, "exterior:groundMat", gtex),
      build: unlit(scene, "exterior:buildMat", ctex),
      props: unlit(scene, "exterior:propsMat", null),
      trees: unlit(scene, "exterior:treesMat", ttex),
      shadow: unlit(scene, "exterior:shadowMat", null),
    };
    this.owned.push(gtex, ctex, ttex, ...Object.values(this.mats));
    const car = carMaterial(scene);
    this.carMat = car.mat;
    this.owned.push(car.mat, ...car.textures);
    if (lighting.skyReflection)
      setCarReflection(this.carMat, lighting.skyReflection);
    this.mats.ground.backFaceCulling = false;
    const t = this.mats.trees;
    t.backFaceCulling = false;
    t.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    t.alphaCutOff = 0.5;
    const s = this.mats.shadow;
    s.backFaceCulling = false;
    s.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    s.disableDepthWrite = true;
    s.zOffset = -4;
    this.enableFog();
    this.buildNear();
    void this.bakeFar(performance.now());
  }

  /**
   * Live linear fog for the exterior only. Fog is opt-in per material: every
   * material that is not an "exterior:" one (library PBR, glTF props,
   * characters, factory, screens, sky) gets fogEnabled=false, so interior
   * sightlines of any length stay clear. Must run before Materials.freezeAll
   * (fog changes the effect defines); later-created materials are caught by
   * the observable.
   */
  private enableFog(): void {
    const scene = this.scene;
    const opt = (m: { name: string; fogEnabled: boolean }) => {
      m.fogEnabled = m.name.startsWith("exterior:");
    };
    for (const m of scene.materials) opt(m);
    const obs = scene.onNewMaterialAddedObservable.add(opt);
    this.owned.push({
      dispose: () => scene.onNewMaterialAddedObservable.remove(obs),
    });
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = FOG_START;
    scene.fogEnd = FOG_END;
    scene.fogColor = HAZE.clone();
  }

  /**
   * Office plate centre / factory bounds moved (more bays): re-place the near
   * park whenever the envelope the scatter is planned against changes.
   */
  setCenter(
    center: Vector3,
    bounds?: { min: { x: number; z: number }; max: { x: number; z: number } },
  ): void {
    this.center = center;
    if (bounds) this.bounds = bounds;
    if (this.footprintKey() !== this.fpKey) this.buildNear();
  }

  private bounds: {
    min: { x: number; z: number };
    max: { x: number; z: number };
  } | null = null;
  private fpKey = "";
  private footprintKey(): string {
    const f = this.footprint();
    return [f.halfW, f.zS, f.zN, f.entrance?.z0, f.entrance?.x1].join(",");
  }

  private footprint(): Footprint {
    // Building bounds run from the entrance façade (-LOBBY_D) to the
    // control room's end; the envelope starts at FACTORY.SOUTH_Z and the
    // entrance building projects south of it under the reception.
    const zFront = -LAYOUT.LOBBY_D;
    const controlEnd = 2 * this.center.z - zFront;
    const halfE = (LAYOUT.HALL_W + 2 * LAYOUT.ROOM_D) / 2;
    const b = this.bounds;
    return {
      halfW: b ? b.max.x : FACTORY.OUTER_X,
      zS: b ? b.min.z : FACTORY.SOUTH_Z,
      zN: b ? b.max.z : controlEnd + FACTORY.DOCK_D,
      entrance: { x0: -halfE, x1: halfE, z0: zFront, z1: FACTORY.SOUTH_Z },
    };
  }

  /** Near park: real geometry (parallax), merged into 5 draws. */
  private buildNear(): void {
    const t0 = performance.now();
    for (const m of this.near) m.dispose(false, false);
    this.near = [];
    const fp = this.footprint();
    this.fpKey = this.footprintKey();
    const plan = planExterior(fp);
    this.plan = plan;
    // Cars and trees in the walkable forecourt get collider boxes.
    const cols = Colliders.of(this.scene);
    if (cols) {
      cols.disposeGroup(EXTERIOR_PROPS_GROUP);
      for (const p of exteriorPropBoxes(plan))
        cols.addBox(
          EXTERIOR_PROPS_GROUP,
          new Vector3(p.x, p.y, p.z),
          new Vector3(p.sx, p.sy, p.sz),
          p.yaw,
        );
    }
    const ground = newBuf();
    const build = newBuf();
    const props = newBuf();
    const trees = newBuf();
    const shadow = newBuf();
    const gy = GROUND_Y - 0.06; // under the factory floor (y = GROUND_Y)
    const g = GROUND_Y;
    // Walkable surfaces sit within 1 cm of the walk colliders' top (GROUND_Y)
    // so feet neither float nor sink; layers stay 5 mm apart (no z-fight).
    const LAYER = {
      grass: g - 0.03,
      strip: g - 0.02,
      asphalt: g - 0.015,
      gravel: g - 0.015,
      concrete: g - 0.01,
      paint: g - 0.005,
    } as const;

    // --- Ground ------------------------------------------------------------
    const grassAt =
      (lawn: boolean) =>
      (x: number, z: number): RGB => {
        const t = vnoise(x, z, 38, 1) * 0.6 + vnoise(x, z, 11, 2) * 0.4;
        let c = lerp(lawn ? LAWN : GRASS_A, GRASS_B, t);
        // Dry/yellowed meadow patches on the unmown ground.
        if (!lawn)
          c = lerp(
            c,
            [0.55, 0.52, 0.3],
            Math.max(0, vnoise(x, z, 60, 3) - 0.6) * 1.6,
          );
        return mul(c, 0.9 + 0.2 * vnoise(x, z, 5, 4));
      };
    const cz = (fp.zS + fp.zN) / 2;
    const half = 200;
    tiled(
      ground,
      { x0: -half, x1: half, z0: cz - half, z1: cz + half },
      LAYER.grass,
      TILE_GRASS,
      grassAt(false),
    );
    const stripe = (x: number, z: number): RGB =>
      mul(grassAt(true)(x, z), Math.floor(z / 3.2) % 2 === 0 ? 1.0 : 0.93);
    for (const s of plan.strips)
      tiled(ground, s, LAYER.strip, TILE_GRASS, stripe);
    const asphaltAt = (x: number, z: number): RGB =>
      mul(ASPHALT, 0.86 + 0.28 * vnoise(x, z, 9, 5));
    for (const a of plan.asphalt)
      tiled(ground, a, LAYER.asphalt, TILE_ASPHALT, asphaltAt);
    const concreteAt = (x: number, z: number): RGB =>
      mul(CONCRETE, 0.93 + 0.14 * vnoise(x, z, 14, 6));
    for (const c of plan.concrete)
      tiled(ground, c, LAYER.concrete, TILE_CONCRETE, concreteAt);
    for (const s of plan.sheds) {
      const pad = {
        x0: s.x - s.w / 2 - 3,
        x1: s.x + s.w / 2 + 3,
        z0: s.z - s.d / 2 - 3,
        z1: s.z + s.d / 2 + 3,
      };
      tiled(ground, pad, LAYER.gravel, TILE_GRAVEL, (x, z) =>
        mul([0.62, 0.6, 0.56], 0.85 + 0.3 * vnoise(x, z, 6, 7)),
      );
    }
    // Painted markings: white stalls/bays, yellow road centre lines, worn.
    const pr = rng(404);
    const paintUV = tileUV(TILE_CONCRETE, 0.3, 0.3);
    for (const p of plan.paint) {
      const long = Math.max(p.x1 - p.x0, p.z1 - p.z0) > 100;
      const wear = 0.78 + 0.22 * pr();
      const c = mul(long ? PAINT_Y : PAINT_W, wear);
      quad(
        ground,
        [
          [p.x0, LAYER.paint, p.z0],
          [p.x1, LAYER.paint, p.z0],
          [p.x1, LAYER.paint, p.z1],
          [p.x0, LAYER.paint, p.z1],
        ],
        c,
        [paintUV, paintUV, paintUV, paintUV],
      );
    }
    // Plaza pedestrian crossing across the lot's central aisle.
    const plaza = plan.plaza;
    for (let i = 0; i < 8; i++) {
      const x = plaza.x0 + 1.5 + i * 2.7;
      if (x + 1.0 > plaza.x1) break;
      quad(
        ground,
        [
          [x, LAYER.paint, plaza.z0 + 0.4],
          [x + 1.2, LAYER.paint, plaza.z0 + 0.4],
          [x + 1.2, LAYER.paint, plaza.z0 + 2.8],
          [x, LAYER.paint, plaza.z0 + 2.8],
        ],
        mul(PAINT_W, 0.85),
        [paintUV, paintUV, paintUV, paintUV],
      );
    }

    // Kerbs along every pavement edge that borders planting (not other paving).
    const paved: Rect[] = [...plan.asphalt, ...plan.concrete];
    const covered = (x: number, z: number, self: Rect) =>
      paved.some(
        (q) =>
          q !== self &&
          x > q.x0 - 0.3 &&
          x < q.x1 + 0.3 &&
          z > q.z0 - 0.3 &&
          z < q.z1 + 0.3,
      );
    const kerbStep = 6;
    for (const a of plan.asphalt) {
      const run = (
        x0: number,
        z0: number,
        x1: number,
        z1: number,
        nx: number,
        nz: number,
      ) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.ceil(len / kerbStep));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const mx = x0 + (x1 - x0) * t;
          const mz = z0 + (z1 - z0) * t;
          if (covered(mx + nx * 0.6, mz + nz * 0.6, a)) continue;
          const alongX = z0 === z1;
          box(
            props,
            mx + nx * 0.1,
            mz + nz * 0.1,
            g - 0.0,
            g + 0.16,
            alongX ? len / n / 2 : 0.11,
            alongX ? 0.11 : len / n / 2,
            KERB,
          );
        }
      };
      run(a.x0, a.z0, a.x1, a.z0, 0, -1);
      run(a.x0, a.z1, a.x1, a.z1, 0, 1);
      run(a.x0, a.z0, a.x0, a.z1, -1, 0);
      run(a.x1, a.z0, a.x1, a.z1, 1, 0);
    }

    // --- Factory outer cladding on the long walls (lobby glazing + dock
    // doors stay open to the yard). Variant 0 = glazed bands.
    const zc = cz;
    const wallTop = FACTORY.ROOF_Y + 0.4;
    for (const s of [-1, 1])
      box(
        build,
        s * (fp.halfW + 0.2),
        zc,
        g,
        wallTop,
        0.2,
        (fp.zN - fp.zS) / 2,
        [0.9, 0.92, 0.94],
        { facade: 0, skip: s > 0 ? "XzZ" : "xzZ", top: false },
      );
    // Factory shadow: the west wall and the dock end swept along the sun.
    {
      const H = wallTop - g;
      const sx = SH_X * H;
      const sz = SH_Z * H;
      const w = fp.halfW;
      const y = gy + 0.07;
      poly(
        shadow,
        [
          [-w, fp.zS],
          [-w, fp.zN],
          [-w + sx, fp.zN + sz],
          [-w + sx, fp.zS + sz],
        ],
        y,
        0.3,
      );
      poly(
        shadow,
        [
          [-w, fp.zN],
          [w, fp.zN],
          [w + sx, fp.zN + sz],
          [-w + sx, fp.zN + sz],
        ].map(([x, z]) => [x, z] as [number, number]),
        y,
        0.3,
      );
    }

    // --- Neighbouring buildings -------------------------------------------
    plan.sheds.forEach((s, si) => {
      const sr = rng(9000 + si * 17);
      const tint = SHED_TINTS[s.tint % SHED_TINTS.length];
      const accent = ACCENTS[(s.tint + si) % ACCENTS.length];
      const top = g + s.h;
      const hw = s.w / 2;
      const hd = s.d / 2;
      const office = s.kind === 1;
      box(build, s.x, s.z, g, top, hw, hd, tint, {
        facade: office ? 0 : 1,
        top: false,
      });
      boxShadow(
        shadow,
        { x0: s.x - hw, x1: s.x + hw, z0: s.z - hd, z1: s.z + hd },
        s.h + 0.5,
        gy + 0.07,
      );
      // Roof membrane + parapet coping + accent band.
      flat(
        props,
        {
          x0: s.x - hw + 0.3,
          x1: s.x + hw - 0.3,
          z0: s.z - hd + 0.3,
          z1: s.z + hd - 0.3,
        },
        top + 0.03,
        mul(ROOF, 0.92 + 0.16 * sr()),
      );
      const COPING: RGB = [0.82, 0.82, 0.8];
      for (const sx of [-1, 1]) {
        box(
          props,
          s.x + sx * (hw - 0.15),
          s.z,
          top,
          top + 0.55,
          0.15,
          hd,
          COPING,
        );
        box(
          props,
          s.x,
          s.z + sx * (hd - 0.15),
          top,
          top + 0.55,
          hw - 0.3,
          0.15,
          COPING,
        );
      }
      box(props, s.x, s.z, top - 1.4, top - 0.6, hw + 0.05, hd + 0.05, accent, {
        top: false,
      });
      // Rooftop plant: HVAC units with fans, vent stacks, skylight strips.
      const nUnits = 1 + Math.floor(sr() * 3) + (s.w > 40 ? 1 : 0);
      for (let u = 0; u < nUnits; u++) {
        const ux = s.x + (sr() - 0.5) * (s.w - 8);
        const uz = s.z + (sr() - 0.5) * (s.d - 6);
        box(props, ux, uz, top, top + 1.15, 1.5, 0.9, [0.66, 0.68, 0.7]);
        box(
          props,
          ux - 0.6,
          uz,
          top + 1.15,
          top + 1.2,
          0.42,
          0.42,
          [0.12, 0.12, 0.13],
        );
        box(
          props,
          ux + 0.6,
          uz,
          top + 1.15,
          top + 1.2,
          0.42,
          0.42,
          [0.12, 0.12, 0.13],
        );
        if (sr() < 0.6)
          box(
            props,
            ux + 2.4,
            uz + 0.3,
            top,
            top + 2.1,
            0.16,
            0.16,
            [0.55, 0.56, 0.58],
          );
      }
      if (!office) {
        const nSky = Math.floor(s.w / 9);
        for (let k = 0; k < nSky; k++) {
          const kx = s.x - hw + 5 + k * 8.5;
          if (kx > s.x + hw - 4) break;
          box(
            props,
            kx,
            s.z + hd * 0.35,
            top,
            top + 0.3,
            2.0,
            0.9,
            [0.5, 0.64, 0.72],
          );
          box(
            props,
            kx,
            s.z - hd * 0.35,
            top,
            top + 0.3,
            2.0,
            0.9,
            [0.5, 0.64, 0.72],
          );
        }
      }
      // Loading doors + canopies on the face toward the park centre.
      if (s.kind !== 1) {
        const dx = -s.x;
        const dz = cz - s.z;
        const useX = Math.abs(dx) / s.w > Math.abs(dz) / s.d;
        const sg = useX ? Math.sign(dx) || 1 : Math.sign(dz) || 1;
        const len = useX ? s.d : s.w;
        const n = Math.max(1, Math.min(4, Math.floor(len / 11)));
        for (let k = 0; k < n; k++) {
          const along = -len / 2 + (len * (k + 0.5)) / n;
          const at = (
            off: number,
            h0: number,
            h1: number,
            hl: number,
            ht: number,
            c: RGB,
          ) => {
            if (useX)
              box(
                props,
                s.x + sg * (hw + off),
                s.z + along,
                g + h0,
                g + h1,
                ht,
                hl,
                c,
              );
            else
              box(
                props,
                s.x + along,
                s.z + sg * (hd + off),
                g + h0,
                g + h1,
                hl,
                ht,
                c,
              );
          };
          at(0.03, 0, 4.5, 2.0, 0.03, [0.16, 0.17, 0.19]); // opening frame
          at(0.07, 0, 4.1, 1.8, 0.04, [0.58, 0.62, 0.66]); // roller door
          for (let sl = 1; sl <= 5; sl++)
            at(0.1, sl * 0.7, sl * 0.7 + 0.07, 1.8, 0.03, [0.34, 0.37, 0.4]);
          at(0.75, 4.6, 4.75, 2.3, 0.75, [0.3, 0.32, 0.35]); // canopy
          at(0.4, 0, 0.8, 0.12, 0.12, [0.9, 0.7, 0.1]); // bollards
        }
      }
      // Workshop: tanks and a flue stack on the south side.
      if (s.kind === 2) {
        prism(
          props,
          s.x + hw + 2.8,
          s.z - hd * 0.3,
          g,
          g + 7.5,
          1.9,
          14,
          [0.82, 0.83, 0.82],
        );
        prism(
          props,
          s.x + hw + 2.8,
          s.z + hd * 0.3,
          g,
          g + 5.5,
          1.5,
          12,
          [0.78, 0.8, 0.78],
        );
        prism(
          props,
          s.x - hw * 0.6,
          s.z,
          top,
          top + 4.5,
          0.3,
          8,
          [0.5, 0.5, 0.52],
        );
      }
    });

    // --- Cars: real-proportion body variants (exterior/cars.ts), baked into
    // two draws (bodies + thin-instanced wheels); soft footprint shadows here.
    for (const c of plan.cars) {
      const md = carModel(c);
      const hx = md.width / 2 + 0.05;
      const hz = md.length / 2 - 0.1;
      const rot = Math.abs(Math.sin(c.yaw)) > 0.7;
      const [ex, ez] = rot ? [hz, hx] : [hx, hz];
      boxShadow(
        shadow,
        { x0: c.x - ex, x1: c.x + ex, z0: c.z - ez, z1: c.z + ez },
        md.height * 0.85,
        gy + 0.07,
      );
    }
    const cars = buildParkedCars(this.scene, plan.cars, g, this.carMat);

    // --- Trees: alpha-tested crossed cards + a top card, baked shading ------
    const tr = rng(6006);
    const card = (
      tile: number,
      cx: number,
      cy0: number,
      cz: number,
      yaw: number,
      size: number,
      tint: RGB,
    ) => {
      const dx = Math.cos(yaw) * size * 0.5;
      const dz = Math.sin(yaw) * size * 0.5;
      const u = (a: number, b: number) => tileUV(tile, a, b);
      quad(
        trees,
        [
          [cx - dx, cy0, cz - dz],
          [cx + dx, cy0, cz + dz],
          [cx + dx, cy0 + size, cz + dz],
          [cx - dx, cy0 + size, cz - dz],
        ],
        [mul(tint, 0.78), mul(tint, 0.78), tint, tint],
        [u(0, 0), u(1, 0), u(1, 1), u(0, 1)],
      );
    };
    for (const t of plan.trees) {
      const tint = mul([1, 1, 1], 0.88 + tr() * 0.24);
      const tintC = lerp(tint, [1.06, 0.98, 0.78], tr() < 0.2 ? 0.5 : 0);
      const yaw0 = tr() * Math.PI;
      const tile =
        t.species === 1
          ? TREE_COLUMNAR
          : t.species === 2
            ? TREE_SHRUB
            : TREE_BROADLEAF;
      const size = t.species === 2 ? t.h * 1.65 : t.h * 1.07;
      const n = t.species === 1 ? 2 : 3;
      for (let k = 0; k < n; k++)
        card(tile, t.x, g, t.z, yaw0 + (k * Math.PI) / n, size, tintC);
      if (t.species !== 1) {
        // Canopy seen from above: a horizontal card, so the elevated view
        // reads leaf mass rather than the card edges.
        const ts = size * 0.8;
        const y = g + size * (t.species === 2 ? 0.5 : 0.6);
        const a = tr() * Math.PI;
        const dx = Math.cos(a) * ts * 0.5;
        const dz = Math.sin(a) * ts * 0.5;
        const tp = mul(tintC, 1.05);
        quad(
          trees,
          [
            [t.x - dx + dz, y, t.z - dz - dx],
            [t.x + dx + dz, y, t.z + dz - dx],
            [t.x + dx - dz, y, t.z + dz + dx],
            [t.x - dx - dz, y, t.z - dz + dx],
          ],
          tp,
          [
            tileUV(TREE_TOP, 0, 0),
            tileUV(TREE_TOP, 1, 0),
            tileUV(TREE_TOP, 1, 1),
            tileUV(TREE_TOP, 0, 1),
          ],
        );
      }
      if (t.species !== 2) {
        // Crown shadow: a stretched disc thrown along the sun.
        const cy = size * 0.62;
        const pts: [number, number][] = [];
        const rr = size * (t.species === 1 ? 0.14 : 0.36);
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          pts.push([
            t.x + SH_X * cy + Math.cos(a) * rr * 1.25,
            t.z + SH_Z * cy + Math.sin(a) * rr,
          ]);
        }
        poly(shadow, hull(pts), gy + 0.07, 0.3);
      }
    }

    // --- Perimeter fence: posts + mesh panel + top rail, skipping gates ----
    const f = plan.fence;
    const FC: RGB = [0.4, 0.43, 0.46];
    const inGate = (x: number, z: number) =>
      plan.gates.some((q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
    /** Fence openings left for the gates (panel extents, runs along x). */
    const openings: { x0: number; x1: number; z: number }[] = [];
    const run = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.ceil(len / 3);
      const yaw = Math.atan2(bz - az, bx - ax);
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const mx = ax + (bx - ax) * ((t0 + t1) / 2);
        const mz = az + (bz - az) * ((t0 + t1) / 2);
        const sx = ax + (bx - ax) * t0;
        const sz = az + (bz - az) * t0;
        if (inGate(mx, mz)) {
          const ex = ax + (bx - ax) * t1;
          const o = openings.find(
            (q) =>
              Math.abs(q.z - sz) < 0.01 &&
              (Math.abs(q.x1 - Math.min(sx, ex)) < 0.01 ||
                Math.abs(q.x0 - Math.max(sx, ex)) < 0.01),
          );
          if (o) {
            o.x0 = Math.min(o.x0, sx, ex);
            o.x1 = Math.max(o.x1, sx, ex);
          } else
            openings.push({
              x0: Math.min(sx, ex),
              x1: Math.max(sx, ex),
              z: sz,
            });
          continue;
        }
        box(props, sx, sz, g, g + 2.4, 0.06, 0.06, FC);
        box(
          props,
          mx,
          mz,
          g + 0.15,
          g + 2.2,
          len / n / 2,
          0.012,
          mul(FC, 0.75),
          { yaw },
        );
        box(props, mx, mz, g + 2.2, g + 2.28, len / n / 2, 0.03, mul(FC, 1.2), {
          yaw,
        });
      }
    };
    run(f.x0, f.z0, f.x1, f.z0);
    run(f.x1, f.z0, f.x1, f.z1);
    run(f.x1, f.z1, f.x0, f.z1);
    run(f.x0, f.z1, f.x0, f.z0);
    // Closed cantilever sliding gates in the openings (the yard is shut: the
    // walk collider closes the south gate line, so it must look closed too):
    // heavy gate posts, a framed mesh leaf across the opening with vertical
    // stiffeners, its counterweight tail parked along the fence on a ground
    // track, and a red/white stripe at hand height.
    const GATE: RGB = mul(FC, 0.9);
    for (const o of openings) {
      const w = o.x1 - o.x0;
      const cx = (o.x0 + o.x1) / 2;
      const z = o.z;
      const inward = Math.abs(z - f.z0) < 0.01 ? 1 : -1;
      for (const x of [o.x0, o.x1])
        box(props, x, z, g, g + 2.6, 0.1, 0.1, mul(FC, 0.8));
      box(
        props,
        cx,
        z,
        g + 0.12,
        g + 2.15,
        w / 2 - 0.12,
        0.01,
        mul(GATE, 0.75),
      );
      for (const y of [0.08, 2.15])
        box(props, cx, z, g + y, g + y + 0.1, w / 2 - 0.1, 0.05, GATE);
      for (let x = o.x0 + 0.1 + w / 4; x < o.x1 - 0.1; x += w / 4)
        box(props, x, z, g + 0.12, g + 2.15, 0.035, 0.04, GATE);
      for (const side of [-1, 1])
        for (let k = 0; k < 8; k++)
          box(
            props,
            o.x0 + 0.1 + ((k + 0.5) * (w - 0.2)) / 8,
            z + side * 0.06,
            g + 1.0,
            g + 1.2,
            (w - 0.2) / 16,
            0.006,
            k % 2 ? [0.85, 0.85, 0.82] : [0.72, 0.08, 0.06],
          );
      // Counterweight tail along the fence (east of the opening) on its track.
      box(
        props,
        o.x1 + 2.2,
        z + inward * 0.12,
        g + 0.08,
        g + 0.5,
        2.1,
        0.06,
        GATE,
      );
      box(
        props,
        (o.x0 + o.x1 + 4.4) / 2,
        z + inward * 0.12,
        g,
        g + 0.06,
        w / 2 + 2.2,
        0.08,
        mul(FC, 0.6),
      );
    }

    // --- Light poles with arms + heads along the car park and the apron ----
    const pole = (x: number, z: number, dir: number) => {
      box(props, x, z, g, g + 8.5, 0.11, 0.11, [0.45, 0.47, 0.5]);
      box(
        props,
        x + dir * 0.9,
        z,
        g + 8.4,
        g + 8.52,
        1.0,
        0.07,
        [0.45, 0.47, 0.5],
      );
      box(
        props,
        x + dir * 1.8,
        z,
        g + 8.3,
        g + 8.45,
        0.55,
        0.22,
        [0.35, 0.37, 0.4],
      );
      box(
        props,
        x + dir * 1.8,
        z,
        g + 8.27,
        g + 8.3,
        0.45,
        0.16,
        [1.0, 0.96, 0.82],
      );
    };
    // Lot lights (clear of the central walk to the doors).
    for (const x of [-28, 2.4, 28]) pole(x, plan.lot.z1 - 9.2, x <= 0 ? 1 : -1);
    for (let x = -28; x <= 28; x += 28) pole(x, fp.zN + 20, x <= 0 ? 1 : -1);

    const m = (name: string, b: Buf, mat: PBRMaterial): Mesh =>
      toMesh(this.scene, name, b, mat);
    const sh = m("exterior:shadows", shadow, this.mats.shadow);
    sh.hasVertexAlpha = true;
    sh.renderingGroupId = 0;
    this.near.push(
      m("exterior:ground", ground, this.mats.ground),
      m("exterior:buildings", build, this.mats.build),
      m("exterior:props", props, this.mats.props),
      m("exterior:trees", trees, this.mats.trees),
      sh,
      ...cars,
    );
    console.warn(
      `[exterior] near build ${Math.round(performance.now() - t0)} ms, ${this.near.length} draws`,
    );
  }

  /** Far landscape: build, render once into the skybox cube, dispose. */
  private async bakeFar(t0: number): Promise<void> {
    const scene = this.scene;
    const r = rng(777);
    const facade = newBuf();
    const roofs = newBuf();
    const c = this.center;
    const g = GROUND_Y;

    const tTerrain = performance.now();
    const hills = buildTerrain(c.x, c.z, g, r);
    const heightAt = (x: number, z: number) =>
      terrainHeight(x - c.x, z - c.z, TERRAIN_SEED);
    // Settlements: industrial estates near the park, towns in the valleys.
    settlements(facade, roofs, c.x, c.z, g, heightAt, r);
    console.warn(
      `[exterior] terrain+settlements ${Math.round(performance.now() - tTerrain)} ms, ` +
        `${hills.pos.length / 3} terrain verts`,
    );
    // Ground disc (fan) under everything, field-patched.
    const ground = newBuf();
    const R = 9000;
    const seg = 48;
    ground.pos.push(c.x, g, c.z);
    ground.col.push(1, 1, 1, 1);
    ground.uv.push(c.x / 600, c.z / 600);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const x = c.x + Math.sin(a) * R;
      const z = c.z + Math.cos(a) * R;
      ground.pos.push(x, g - 0.2, z);
      ground.col.push(1, 1, 1, 1);
      ground.uv.push(x / 600, z / 600);
      if (k > 0) ground.idx.push(0, k + 1, k);
    }
    // Haze veil over the near disc of the baked ground, matching the live
    // linear fog (so the clipped near ground meets the cube without a seam).
    const veil = newBuf();
    const VEIL: [number, number][] = [
      [0, 0],
      [FOG_START, 0],
      [150, 0.18],
      [220, 0.33],
      [300, FOG_CAP],
      [R, FOG_CAP],
    ];
    const VSEG = 64;
    for (const [rad, al] of VEIL)
      for (let k = 0; k <= VSEG; k++) {
        const a = (k / VSEG) * Math.PI * 2;
        veil.pos.push(
          c.x + Math.sin(a) * rad,
          g - 0.15,
          c.z + Math.cos(a) * rad,
        );
        veil.col.push(HAZE.r, HAZE.g, HAZE.b, al);
        veil.uv.push(0, 0);
      }
    for (let ring = 1; ring < VEIL.length; ring++)
      for (let k = 1; k <= VSEG; k++) {
        const i = ring * (VSEG + 1) + k;
        const j = i - (VSEG + 1);
        veil.idx.push(j - 1, i, j, j - 1, i - 1, i);
      }
    const vmat = unlit(scene, "exterior:farVeil", null);
    vmat.backFaceCulling = false;
    vmat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    vmat.disableDepthWrite = true;
    const gtex = farGroundTexture(scene, 99);
    const fmat = unlit(scene, "exterior:farFacade", null);
    const rmat = unlit(scene, "exterior:farRoof", null);
    const hmat = unlit(scene, "exterior:hills", null);
    hmat.backFaceCulling = false;
    const gmat = unlit(scene, "exterior:farGroundMat", gtex);
    gmat.backFaceCulling = false;
    const meshes: AbstractMesh[] = [
      toMesh(scene, "exterior:far", facade, fmat),
      toMesh(scene, "exterior:farRoofs", roofs, rmat),
      toMesh(scene, "exterior:hills", hills, hmat),
      toMesh(scene, "exterior:farGround", ground, gmat),
      toMesh(scene, "exterior:farVeil", veil, vmat),
    ];
    meshes[meshes.length - 1].hasVertexAlpha = true;
    meshes[meshes.length - 1].alphaIndex = 10;
    const cleanup = () => {
      for (const m of meshes) m.dispose(false, false);
      for (const o of [gtex, fmat, rmat, hmat, gmat, vmat]) o.dispose();
    };

    const sky = this.lighting.sky;
    if (!sky || this.disposed) {
      cleanup();
      return;
    }
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.disposed) return resolve();
        const ready = [sky, ...meshes].every((m) => m.isReady(true));
        if (ready) resolve();
        else setTimeout(check, 120);
      };
      check();
    });
    if (this.disposed) {
      cleanup();
      return;
    }
    const probe = new ReflectionProbe(
      "exterior:bake",
      1024,
      scene,
      false,
      true,
      true,
    );
    probe.position.set(c.x, 1.6, c.z);
    probe.refreshRate = 0; // render once
    const list = probe.renderList!;
    list.push(sky, ...meshes);
    const rtt = probe.cubeTexture;
    const pi = scene.reflectionProbes.indexOf(probe);
    if (pi >= 0) scene.reflectionProbes.splice(pi, 1);
    scene.customRenderTargets.push(rtt);
    let fog: {
      mode: number;
      density: number;
      color: Color3;
      maxZ: number;
      minZ: number;
    } | null = null;
    let rendered = false;
    rtt.onAfterRenderObservable.add(() => {
      rendered = true;
    });
    const before = scene.onBeforeRenderTargetsRenderObservable.add(() => {
      const cam = scene.activeCamera;
      fog = {
        mode: scene.fogMode,
        density: scene.fogDensity,
        color: scene.fogColor.clone(),
        maxZ: cam?.maxZ ?? 220,
        minZ: cam?.minZ ?? 0.05,
      };
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.00021;
      scene.fogColor = HAZE.clone();
      if (cam) {
        cam.maxZ = 12000;
        cam.minZ = 1;
      }
    });
    const after = scene.onAfterRenderTargetsRenderObservable.add(() => {
      const cam = scene.activeCamera;
      if (fog) {
        scene.fogMode = fog.mode;
        scene.fogDensity = fog.density;
        scene.fogColor = fog.color;
        if (cam) {
          cam.maxZ = fog.maxZ;
          cam.minZ = fog.minZ;
        }
        fog = null;
      }
      if (!rendered) return;
      scene.onBeforeRenderTargetsRenderObservable.remove(before);
      scene.onAfterRenderTargetsRenderObservable.remove(after);
      const ci = scene.customRenderTargets.indexOf(rtt);
      if (ci >= 0) scene.customRenderTargets.splice(ci, 1);
      if (this.disposed) return;
      const refl = this.lighting.setSkyTexture(rtt);
      if (refl) setCarReflection(this.carMat, refl);
      cleanup();
      this.bakeMs = performance.now() - t0;
      (globalThis as { __exteriorBakeMs?: number }).__exteriorBakeMs =
        this.bakeMs;
      console.warn(`[exterior] bake ${Math.round(this.bakeMs)} ms`);
    });
    this.probe = probe;
  }

  get meshes(): Mesh[] {
    return this.near;
  }

  dispose(): void {
    this.disposed = true;
    Colliders.of(this.scene)?.disposeGroup(EXTERIOR_PROPS_GROUP);
    for (const m of this.near) m.dispose(false, false);
    for (const o of this.owned) o.dispose();
    this.probe?.dispose();
    this.probe = null;
  }
}
