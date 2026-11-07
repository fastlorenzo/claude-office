/**
 * Exterior — the building is a software factory in an industrial park.
 *
 * The office floor is y = 0; the factory floor and the outside ground are at
 * GROUND_Y = -6. Two layers, both cheap:
 *  - FAR (hills, a distant low skyline, ~700 low sheds, field-patched ground)
 *    is built once as merged unlit meshes, rendered ONCE with the pure-sky HDRI
 *    and exponential aerial-perspective fog into a cube map from the floor's
 *    centre, then disposed. That cube becomes the skybox (zero per-frame cost).
 *  - NEAR (yard, truck apron, access road, car park with parked cars, lawn
 *    strips, fence, neighbouring sheds, the factory's own outer cladding) is
 *    real geometry merged into THREE draws: ground (vertex colours), buildings
 *    (cladding + window-band texture) and props (cars, trees, fence, poles).
 *
 * Placement is the pure, tested `layout/exteriorPlan.ts`. Shading is baked
 * into vertex colours on unlit PBR materials: no light budget, no shadows.
 */
import {
  Color3,
  Mesh,
  PBRMaterial,
  RawTexture,
  ReflectionProbe,
  Scene,
  Texture,
  Vector3,
  VertexData,
  type AbstractMesh,
} from "@/engine/babylon";
import { rng } from "@/engine/art/random";
import type { Lighting } from "@/engine/fx/Lighting";
import { LAYOUT } from "@/engine/contracts";
import { FACTORY } from "@/engine/layout/factoryLayout";
import {
  GROUND_Y,
  planExterior,
  type ExteriorPlan,
  type Footprint,
  type Rect,
} from "@/engine/layout/exteriorPlan";

export { GROUND_Y };

const HAZE = new Color3(0.86, 0.92, 1.0);
const SUN = new Vector3(-0.5, -0.62, 0.6).normalize();
const SUN_XZ = Math.hypot(SUN.x, SUN.z);

type RGB = [number, number, number];

interface Buf {
  pos: number[];
  col: number[];
  uv: number[];
  idx: number[];
}
const newBuf = (): Buf => ({ pos: [], col: [], uv: [], idx: [] });

const GRASS: RGB = [0.33, 0.45, 0.25];
const ASPHALT: RGB = [0.2, 0.21, 0.23];
const CONCRETE: RGB = [0.6, 0.6, 0.57];
const PAINT: RGB = [0.88, 0.88, 0.84];
const LAWN: RGB = [0.27, 0.43, 0.2];

const SHED_TINTS: RGB[] = [
  [0.78, 0.78, 0.76],
  [0.66, 0.7, 0.74],
  [0.74, 0.7, 0.62],
  [0.6, 0.64, 0.6],
  [0.82, 0.8, 0.74],
  [0.56, 0.6, 0.66],
];
const CAR_COLORS: RGB[] = [
  [0.75, 0.76, 0.78],
  [0.12, 0.13, 0.15],
  [0.62, 0.1, 0.1],
  [0.15, 0.25, 0.5],
  [0.85, 0.85, 0.85],
  [0.3, 0.32, 0.34],
  [0.2, 0.4, 0.28],
  [0.7, 0.55, 0.2],
];

/** Unlit shade for a face normal (sun side bright, shade side cool/dark). */
function shade(nx: number, ny: number, nz: number): number {
  if (ny > 0.5) return 0.82;
  const sun = Math.max(0, -(nx * SUN.x + nz * SUN.z) / SUN_XZ);
  return 0.55 + 0.42 * sun;
}

const mul = (c: RGB, s: number): RGB => [c[0] * s, c[1] * s, c[2] * s];

function quad(
  b: Buf,
  p: number[][],
  c: RGB,
  uvs: number[][] | null = null,
): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    b.pos.push(p[i][0], p[i][1], p[i][2]);
    b.col.push(c[0], c[1], c[2], 1);
    b.uv.push(uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0);
  }
  b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** Flat horizontal rectangle (top-facing). */
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

interface BoxOpts {
  yaw?: number;
  /** Facade UVs (metres, v = height above ground) instead of zeros. */
  facade?: boolean;
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
  const v0 = y0 - GROUND_Y;
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
    quad(
      b,
      [
        P(a[0], y0, a[1]),
        P(c[0], y0, c[1]),
        P(c[0], y1, c[1]),
        P(a[0], y1, a[1]),
      ],
      col,
      o.facade
        ? [
            [0, v0],
            [len, v0],
            [len, v0 + h],
            [0, v0 + h],
          ]
        : null,
    );
  };
  side("z", [-hw, hd], [hw, hd], 0, 1, 2 * hw);
  side("Z", [hw, -hd], [-hw, -hd], 0, -1, 2 * hw);
  side("x", [hw, hd], [hw, -hd], 1, 0, 2 * hd);
  side("X", [-hw, -hd], [-hw, hd], -1, 0, 2 * hd);
  if (o.top !== false) {
    quad(
      b,
      [P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd)],
      mul(color, 0.82),
      // Plain corrugated texel row.
      o.facade
        ? [
            [3, 0.8],
            [3, 0.8],
            [3, 0.8],
            [3, 0.8],
          ]
        : null,
    );
  }
}

function toMesh(scene: Scene, name: string, b: Buf, mat: PBRMaterial): Mesh {
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = b.pos;
  vd.colors = b.col;
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

function unlit(scene: Scene, name: string, tex: Texture | null): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.unlit = true;
  mat.albedoColor = Color3.White();
  if (tex) mat.albedoTexture = tex;
  mat.backFaceCulling = true;
  return mat;
}

function rawTex(
  scene: Scene,
  name: string,
  S: number,
  fill: (x: number, y: number) => RGB,
): RawTexture {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const c = fill(x, y);
      const i = (y * S + x) * 4;
      data[i] = Math.round(Math.min(1, c[0]) * 255);
      data[i + 1] = Math.round(Math.min(1, c[1]) * 255);
      data[i + 2] = Math.round(Math.min(1, c[2]) * 255);
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
  t.name = name;
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

/**
 * Metal cladding with a glazed strip. 1 repeat = 6 m × 8 m: plinth, a window
 * band at 3.0-4.2 m (and again at 11-12.2 m on the tall factory wall), ribs.
 */
function claddingTexture(scene: Scene): RawTexture {
  const t = rawTex(scene, "exterior:cladding", 128, (x, y) => {
    const v = y / 128;
    const rib = x % 8 < 1 ? 0.9 : 1;
    if (v >= 0.375 && v < 0.525) {
      const mull = x % 64 < 3;
      const g = mull ? 0.3 : 0.42 + 0.2 * ((v - 0.375) / 0.15);
      return mull ? [g, g, g] : [g * 0.78, g * 0.9, g * 1.05];
    }
    if (v < 0.3) return [0.72 * rib, 0.72 * rib, 0.7 * rib]; // plinth
    return [0.92 * rib, 0.92 * rib, 0.9 * rib];
  });
  t.uScale = 1 / 6;
  t.vScale = 1 / 8;
  t.anisotropicFilteringLevel = 4;
  return t;
}

/** Fields / lots seen from far away; mean colour ≈ GRASS (the near ground). */
function farGroundTexture(scene: Scene, seed: number): RawTexture {
  const r = rng(seed);
  const cells = 8;
  const pat: RGB[] = [];
  for (let k = 0; k < cells * cells; k++) {
    const q = r();
    pat.push(
      q < 0.12
        ? [0.55, 0.53, 0.48] // yards / lots
        : q < 0.2
          ? [0.5, 0.46, 0.3] // stubble
          : mul(GRASS, 0.88 + r() * 0.24),
    );
  }
  const S = 128;
  const cell = S / cells;
  return rawTex(scene, "exterior:farGround", S, (x, y) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const edge = x % cell < 1 || y % cell < 1; // hedgerow / track lines
    const c = pat[gx + gy * cells];
    return edge ? mul(c, 0.8) : c;
  });
}

export class Exterior {
  private near: Mesh[] = [];
  private probe: ReflectionProbe | null = null;
  private readonly owned: { dispose(): void }[] = [];
  private disposed = false;
  private cladding: RawTexture;
  private mats: { ground: PBRMaterial; build: PBRMaterial; props: PBRMaterial };
  private zN = Number.NaN;
  plan: ExteriorPlan | null = null;
  /** ms from construction until the baked cube replaced the sky (null: pending). */
  bakeMs: number | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly lighting: Lighting,
    /** Centre of the office floor plate (x, z): the park is laid out around it. */
    private center: Vector3,
  ) {
    this.cladding = claddingTexture(scene);
    this.mats = {
      ground: unlit(scene, "exterior:groundMat", null),
      build: unlit(scene, "exterior:buildMat", this.cladding),
      props: unlit(scene, "exterior:propsMat", null),
    };
    this.owned.push(
      this.cladding,
      this.mats.ground,
      this.mats.build,
      this.mats.props,
    );
    this.mats.ground.backFaceCulling = false;
    this.buildNear();
    void this.bakeFar(performance.now());
  }

  /** Office plate centre moved (more bays): re-place the near park. */
  setCenter(center: Vector3): void {
    this.center = center;
    if (this.footprint().zN !== this.zN) this.buildNear();
  }

  private footprint(): Footprint {
    const zS = -LAYOUT.LOBBY_D;
    const controlEnd = 2 * this.center.z - zS;
    return {
      halfW: FACTORY.OUTER_X,
      zS,
      zN: controlEnd + FACTORY.DOCK_D,
    };
  }

  /** Near park: real geometry (parallax), merged into 3 draws. */
  private buildNear(): void {
    for (const m of this.near) m.dispose(false, false);
    this.near = [];
    const fp = this.footprint();
    this.zN = fp.zN;
    const plan = planExterior(fp);
    this.plan = plan;
    const ground = newBuf();
    const build = newBuf();
    const props = newBuf();
    const gy = GROUND_Y - 0.06; // under the factory floor (y = GROUND_Y)

    // Grass base with a little patchwork (16 m cells).
    const r = rng(2024);
    const half = 256;
    const cz = (fp.zS + fp.zN) / 2;
    const step = 16;
    for (let x = -half; x < half; x += step)
      for (
        let z = Math.floor((cz - half) / step) * step;
        z < cz + half;
        z += step
      )
        flat(
          ground,
          { x0: x, x1: x + step, z0: z, z1: z + step },
          gy,
          mul(GRASS, 0.9 + r() * 0.2),
        );
    // Paved + planted layers (stacked a few cm apart, all below the factory floor).
    for (const s of plan.strips) flat(ground, s, gy + 0.02, LAWN);
    for (const a of plan.asphalt) flat(ground, a, gy + 0.03, ASPHALT);
    for (const c of plan.concrete) flat(ground, c, gy + 0.04, CONCRETE);
    for (const s of plan.sheds)
      flat(
        ground,
        {
          x0: s.x - s.w / 2 - 3,
          x1: s.x + s.w / 2 + 3,
          z0: s.z - s.d / 2 - 3,
          z1: s.z + s.d / 2 + 3,
        },
        gy + 0.03,
        CONCRETE,
      );
    for (const p of plan.paint) flat(ground, p, gy + 0.06, PAINT);

    // Factory outer cladding on the long walls (the lobby glazing and the
    // dock doors stay open to the yard).
    const zc = (fp.zS + fp.zN) / 2;
    for (const s of [-1, 1])
      box(
        build,
        s * (fp.halfW + 0.2),
        zc,
        GROUND_Y,
        FACTORY.ROOF_Y + 0.4,
        0.2,
        (fp.zN - fp.zS) / 2,
        [0.86, 0.88, 0.9],
        { facade: true, skip: s > 0 ? "XzZ" : "xzZ", top: false },
      );

    // Neighbouring sheds.
    for (const s of plan.sheds) {
      const tint = SHED_TINTS[s.tint % SHED_TINTS.length];
      box(build, s.x, s.z, GROUND_Y, GROUND_Y + s.h, s.w / 2, s.d / 2, tint, {
        facade: true,
      });
      if (s.kind !== 2)
        box(
          props,
          s.x + s.w * 0.18,
          s.z - s.d * 0.12,
          GROUND_Y + s.h,
          GROUND_Y + s.h + 1.6 + s.ridge,
          s.w * 0.12,
          s.d * 0.14,
          [0.55, 0.56, 0.58],
        );
    }

    // Cars (body + cabin), merged.
    for (const c of plan.cars) {
      const col = CAR_COLORS[c.color % CAR_COLORS.length];
      const len = c.van ? 5.0 : 4.3;
      box(
        props,
        c.x,
        c.z,
        GROUND_Y + 0.25,
        GROUND_Y + 0.85,
        0.9,
        len / 2,
        col,
        {
          yaw: c.yaw,
        },
      );
      box(
        props,
        c.x,
        c.z - (c.van ? 0 : 0.25),
        GROUND_Y + 0.85,
        GROUND_Y + (c.van ? 1.95 : 1.4),
        0.82,
        c.van ? len / 2 - 0.1 : len / 4,
        c.van ? col : mul(col, 0.55),
        { yaw: c.yaw },
      );
    }

    // Trees.
    for (const t of plan.trees) {
      const g = GROUND_Y;
      box(props, t.x, t.z, g, g + t.h * 0.4, 0.18, 0.18, [0.35, 0.26, 0.18]);
      const k = 0.85 + ((t.x * 7 + t.z * 3) % 10) * 0.02;
      box(
        props,
        t.x,
        t.z,
        g + t.h * 0.3,
        g + t.h * 0.75,
        t.h * 0.3,
        t.h * 0.3,
        mul(LAWN, k * 0.9),
        { yaw: 0.4 },
      );
      box(
        props,
        t.x,
        t.z,
        g + t.h * 0.6,
        g + t.h,
        t.h * 0.2,
        t.h * 0.2,
        mul(LAWN, k),
        { yaw: 0.9 },
      );
    }

    // Perimeter fence: posts + two rails, skipping the gates.
    const f = plan.fence;
    const FC: RGB = [0.5, 0.52, 0.55];
    const inGate = (x: number, z: number) =>
      plan.gates.some((g) => x > g.x0 && x < g.x1 && z > g.z0 && z < g.z1);
    const run = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.ceil(len / 6);
      const yaw = Math.atan2(bz - az, bx - ax);
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const mx = ax + (bx - ax) * ((t0 + t1) / 2);
        const mz = az + (bz - az) * ((t0 + t1) / 2);
        if (inGate(mx, mz)) continue;
        const sx = ax + (bx - ax) * t0;
        const sz = az + (bz - az) * t0;
        box(props, sx, sz, GROUND_Y, GROUND_Y + 2.4, 0.07, 0.07, FC);
        // Mesh panel as a thin box along the run.
        box(
          props,
          mx,
          mz,
          GROUND_Y + 0.3,
          GROUND_Y + 2.2,
          len / n / 2,
          0.02,
          mul(FC, 1.15),
          {
            yaw,
          },
        );
      }
    };
    run(f.x0, f.z0, f.x1, f.z0);
    run(f.x1, f.z0, f.x1, f.z1);
    run(f.x1, f.z1, f.x0, f.z1);
    run(f.x0, f.z1, f.x0, f.z0);

    // Light poles along the car park and the apron.
    const pole = (x: number, z: number) => {
      box(props, x, z, GROUND_Y, GROUND_Y + 8, 0.12, 0.12, [0.4, 0.42, 0.45]);
      box(
        props,
        x,
        z,
        GROUND_Y + 8,
        GROUND_Y + 8.25,
        0.6,
        0.25,
        [0.9, 0.9, 0.8],
        { top: true },
      );
    };
    for (let x = -28; x <= 28; x += 28) pole(x, fp.zS - 17.2);
    for (let x = -28; x <= 28; x += 28) pole(x, fp.zN + 20);

    this.near.push(
      toMesh(this.scene, "exterior:ground", ground, this.mats.ground),
      toMesh(this.scene, "exterior:buildings", build, this.mats.build),
      toMesh(this.scene, "exterior:props", props, this.mats.props),
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

    // Low sheds out to ~2 km (industrial estate), denser near the park.
    for (let i = 0; i < 700; i++) {
      const dist = 240 + Math.pow(r(), 1.4) * 1900;
      const a = r() * Math.PI * 2;
      const w = 20 + r() * 60;
      const d = 20 + r() * 50;
      const h = 6 + r() * 9;
      const tint = mul(SHED_TINTS[Math.floor(r() * 6)], 0.7 + r() * 0.2);
      box(
        facade,
        c.x + Math.sin(a) * dist,
        c.z + Math.cos(a) * dist,
        g,
        g + h,
        w / 2,
        d / 2,
        tint,
        { top: false },
      );
      box(
        roofs,
        c.x + Math.sin(a) * dist,
        c.z + Math.cos(a) * dist,
        g + h,
        g + h + 0.1,
        w / 2,
        d / 2,
        mul(tint, 0.9),
        { skip: "xXzZ" },
      );
    }
    // A distant low skyline (a town, 4-6 km to the north-east).
    for (let i = 0; i < 160; i++) {
      const a = 0.5 + (r() - 0.5) * 0.9;
      const dist = 4200 + r() * 1600;
      const h = 25 + Math.pow(r(), 2.2) * 170;
      const w = 25 + r() * 40;
      const tint = mul(SHED_TINTS[Math.floor(r() * 6)], 0.6 + r() * 0.2);
      box(
        facade,
        c.x + Math.sin(a) * dist + (r() - 0.5) * 900,
        c.z + Math.cos(a) * dist + (r() - 0.5) * 900,
        g,
        g + h,
        w / 2,
        w / 2,
        tint,
      );
    }
    // Hills: a noisy ring, 2.6-5 km out.
    const hills = newBuf();
    const SEG = 120;
    const RINGS = 5;
    const phase = [r() * 6, r() * 6, r() * 6];
    const height = (a: number, k: number) => {
      const env = Math.sin((k / (RINGS - 1)) * Math.PI);
      const n =
        0.5 +
        0.28 * Math.sin(a * 5 + phase[0]) +
        0.14 * Math.sin(a * 11 + phase[1]) +
        0.08 * Math.sin(a * 23 + phase[2]);
      return (k === 0 || k === RINGS - 1 ? 0 : 1) * env * n * 230;
    };
    for (let k = 0; k < RINGS; k++)
      for (let s = 0; s <= SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        const dist = 2600 + (k / (RINGS - 1)) * 2400;
        const h = height(a, k);
        hills.pos.push(
          c.x + Math.sin(a) * dist,
          g + h,
          c.z + Math.cos(a) * dist,
        );
        const t = Math.min(1, h / 200);
        hills.col.push(0.3 + 0.12 * t, 0.42 - 0.04 * t, 0.28 + 0.06 * t, 1);
        hills.uv.push(0, 0);
        if (k > 0 && s > 0) {
          const i = k * (SEG + 1) + s;
          const j = i - (SEG + 1);
          hills.idx.push(j - 1, i, j, j - 1, i - 1, i);
        }
      }
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
    ];
    const cleanup = () => {
      for (const m of meshes) m.dispose(false, false);
      for (const o of [gtex, fmat, rmat, hmat, gmat]) o.dispose();
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
      scene.fogDensity = 0.00034;
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
      this.lighting.setSkyTexture(rtt);
      cleanup();
      this.bakeMs = performance.now() - t0;
      (globalThis as { __exteriorBakeMs?: number }).__exteriorBakeMs =
        this.bakeMs;
      console.info(`[exterior] bake ${Math.round(this.bakeMs)} ms`);
    });
    this.probe = probe;
  }

  get meshes(): Mesh[] {
    return this.near;
  }

  dispose(): void {
    this.disposed = true;
    for (const m of this.near) m.dispose(false, false);
    for (const o of this.owned) o.dispose();
    this.probe?.dispose();
    this.probe = null;
  }
}
