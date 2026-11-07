/**
 * Skyline — the office is a high floor (~45th, ≈170 m up) of a skyscraper.
 *
 * Two layers, both cheap:
 *  - FAR CITY (≈2 300 towers out to 3.6 km + a street-grid ground) is built
 *    once as two merged unlit meshes, rendered ONCE with the pure-sky HDRI
 *    and exponential aerial-perspective fog into a cube map from the floor's
 *    centre, then disposed. That cube becomes the skybox: the city spreads
 *    below eye level to a hazy horizon at zero per-frame cost (1 draw), and
 *    at these distances the missing parallax is invisible.
 *  - NEAR TOWERS (a dozen neighbours 90–190 m away, some rising above our
 *    floor) are real geometry — two merged meshes (curtain-wall facades,
 *    roofs) — so they parallax against the window mullions as you walk.
 *
 * Shading is baked into vertex colours (sun side / shade side / sky-lit
 * roofs) on unlit PBR materials, so none of it touches the light budget.
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

/** Street level relative to our floor (y = 0). */
export const GROUND_Y = -172;
const HAZE = new Color3(0.86, 0.92, 1.0);
const SUN = new Vector3(-0.5, -0.62, 0.6).normalize();

interface Buf {
  pos: number[];
  col: number[];
  uv: number[];
  idx: number[];
}

const newBuf = (): Buf => ({ pos: [], col: [], uv: [], idx: [] });

/** Unlit shade for a face normal (sun side bright, shade side cool/dark). */
function shade(nx: number, ny: number, nz: number): number {
  if (ny > 0.5) return 0.78; // roofs: gravel / plant, not white
  const sun = Math.max(
    0,
    -(nx * SUN.x + nz * SUN.z) / Math.hypot(SUN.x, SUN.z),
  );
  return 0.52 + 0.43 * sun;
}

/**
 * Axis-aligned tower box (no bottom face) into facade / roof buffers.
 * UVs on facades are metres (u along the face, v height) for the window grid.
 */
function towerBox(
  facade: Buf,
  roof: Buf,
  cx: number,
  cz: number,
  w: number,
  d: number,
  y0: number,
  y1: number,
  tint: [number, number, number],
  haze: number,
): void {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const mix = (c: number, h: number, s: number) =>
    c * s * (1 - haze) + h * haze;
  const face = (
    b: Buf,
    pts: number[][],
    n: [number, number, number],
    uvs: number[][],
  ) => {
    const base = b.pos.length / 3;
    const s = shade(n[0], n[1], n[2]);
    for (let i = 0; i < 4; i++) {
      b.pos.push(pts[i][0], pts[i][1], pts[i][2]);
      b.col.push(
        mix(tint[0], HAZE.r, s),
        mix(tint[1], HAZE.g, s),
        mix(tint[2], HAZE.b, s),
        1,
      );
      b.uv.push(uvs[i][0], uvs[i][1]);
    }
    // Babylon front faces are clockwise seen from outside.
    b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const h = y1 - y0;
  // +Z
  face(
    facade,
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [0, 0, 1],
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
  );
  // -Z
  face(
    facade,
    [
      [x1, y0, z0],
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
    ],
    [0, 0, -1],
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
  );
  // +X
  face(
    facade,
    [
      [x1, y0, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
    ],
    [1, 0, 0],
    [
      [0, 0],
      [d, 0],
      [d, h],
      [0, h],
    ],
  );
  // -X
  face(
    facade,
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [-1, 0, 0],
    [
      [0, 0],
      [d, 0],
      [d, h],
      [0, h],
    ],
  );
  // Roof
  face(
    roof,
    [
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [0, 1, 0],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  );
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

/** Curtain wall: glass panels with mullions and slab bands, 1 repeat = 6 m × 4 m. */
function facadeTexture(scene: Scene): RawTexture {
  const W = 128;
  const H = 128;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const slab = y < 10; // spandrel band once per 4 m floor
      const mull = x % 32 < 2; // mullion every 1.5 m
      // Glass reflects the sky: brighter towards the top of each pane,
      // slight per-pane variation.
      const pane = (x >> 5) % 4;
      const sky = 0.46 + 0.16 * (y / H) + pane * 0.025;
      const v = slab ? 0.36 : mull ? 0.3 : sky;
      data[i] = Math.round(v * 214);
      data[i + 1] = Math.round(v * 232);
      data[i + 2] = Math.round(v * 255);
      data[i + 3] = 255;
    }
  const t = RawTexture.CreateRGBATexture(
    data,
    W,
    H,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  t.name = "skyline:facade";
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.uScale = 1 / 6;
  t.vScale = 1 / 4;
  t.anisotropicFilteringLevel = 4;
  return t;
}

/** Street grid seen from 170 m: asphalt, pavements, blocks, a few parks. */
function groundTexture(scene: Scene, seed: number): RawTexture {
  const S = 256;
  const r = rng(seed);
  const data = new Uint8Array(S * S * 4);
  const block = 64; // 1 tile = 4 blocks of 90 m
  const parks = new Set<number>();
  for (let k = 0; k < 16; k++) if (r() < 0.18) parks.add(k);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const bx = x % block;
      const by = y % block;
      const road = bx < 7 || by < 7;
      const walk = !road && (bx < 9 || by < 9);
      const id = Math.floor(x / block) + Math.floor(y / block) * 4;
      let c: [number, number, number];
      if (road) c = [0.3, 0.31, 0.33];
      else if (walk) c = [0.62, 0.61, 0.58];
      else if (parks.has(id)) c = [0.3, 0.42, 0.26];
      else {
        const n = 0.48 + 0.1 * Math.sin(x * 0.7) * Math.sin(y * 0.9);
        c = [n, n * 0.98, n * 0.95];
      }
      data[i] = Math.round(c[0] * 255);
      data[i + 1] = Math.round(c[1] * 255);
      data[i + 2] = Math.round(c[2] * 255);
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
  t.name = "skyline:ground";
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

const PALETTE: [number, number, number][] = [
  [0.62, 0.68, 0.76], // blue glass
  [0.7, 0.72, 0.74], // silver glass
  [0.74, 0.7, 0.64], // stone
  [0.55, 0.6, 0.64], // dark glass
  [0.8, 0.78, 0.74], // white concrete
  [0.66, 0.62, 0.58], // brick-ish
];

export class Skyline {
  private readonly near: Mesh[] = [];
  private probe: ReflectionProbe | null = null;
  private readonly owned: { dispose(): void }[] = [];
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly lighting: Lighting,
    /** Centre of our floor plate (x, z) — the city is laid out around it. */
    private readonly center: Vector3,
  ) {
    this.buildNear();
    void this.bakeFar();
  }

  /** Near towers: real geometry (parallax), merged into 2 draws. */
  private buildNear(): void {
    const r = rng(4242);
    const facade = newBuf();
    const roof = newBuf();
    const c = this.center;
    // Our own tower below the floor slab (seen when looking down the facade).
    towerBox(
      facade,
      roof,
      c.x,
      c.z,
      30,
      58,
      GROUND_Y,
      -0.35,
      [0.58, 0.63, 0.7],
      0,
    );
    const n = 13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.35;
      const dist = 95 + r() * 85;
      const w = 26 + r() * 22;
      const d = 26 + r() * 22;
      // Mostly below us (rooftops), a few rise above for parallax.
      const top = r() < 0.3 ? 15 + r() * 70 : -105 + r() * 90;
      const tint = PALETTE[Math.floor(r() * PALETTE.length)];
      const x = c.x + Math.sin(a) * dist;
      const z = c.z + Math.cos(a) * dist;
      const haze = Math.min(0.25, dist / 900);
      towerBox(facade, roof, x, z, w, d, GROUND_Y, top, tint, haze);
      // Setback crown
      if (r() < 0.6)
        towerBox(
          facade,
          roof,
          x,
          z,
          w * 0.7,
          d * 0.7,
          top,
          top + 6 + r() * 14,
          tint,
          haze,
        );
      // Roof plant room
      towerBox(
        roof,
        roof,
        x + w * 0.15,
        z - d * 0.1,
        w * 0.3,
        d * 0.25,
        top,
        top + 3.5,
        [0.5, 0.5, 0.5],
        haze,
      );
    }
    const ftex = facadeTexture(this.scene);
    const fmat = unlit(this.scene, "skyline:facadeMat", ftex);
    const rmat = unlit(this.scene, "skyline:roofMat", null);
    this.owned.push(ftex, fmat, rmat);
    this.near.push(
      toMesh(this.scene, "skyline:near", facade, fmat),
      toMesh(this.scene, "skyline:roofs", roof, rmat),
    );
  }

  /** Far city: build, render once into the skybox cube, dispose. */
  private async bakeFar(): Promise<void> {
    const scene = this.scene;
    const r = rng(777);
    const facade = newBuf();
    const roof = newBuf();
    const c = this.center;
    const count = 3200;
    for (let i = 0; i < count; i++) {
      // Denser and taller near the centre (CBD), low sprawl outside.
      const t = Math.pow(r(), 0.75);
      const dist = 230 + t * 3400;
      const a = r() * Math.PI * 2;
      const x = c.x + Math.sin(a) * dist;
      const z = c.z + Math.cos(a) * dist;
      const cbd = Math.exp(-dist / 900);
      const tall = r() < 0.05 + 0.25 * cbd;
      const h = tall ? 120 + r() * 160 : 18 + r() * (40 + 110 * cbd);
      const w = 18 + r() * 34;
      const d = 18 + r() * 34;
      const base = PALETTE[Math.floor(r() * PALETTE.length)];
      const k = 0.62 + r() * 0.22; // darker than the sky: reads at distance
      const tint: [number, number, number] = [
        base[0] * k,
        base[1] * k,
        base[2] * k,
      ];
      towerBox(facade, roof, x, z, w, d, GROUND_Y, GROUND_Y + h, tint, 0);
    }
    // Ground disc (fan) under everything.
    const ground = newBuf();
    const R = 6000;
    const seg = 48;
    ground.pos.push(c.x, GROUND_Y, c.z);
    ground.col.push(1, 1, 1, 1);
    ground.uv.push(c.x / 360, c.z / 360);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const x = c.x + Math.sin(a) * R;
      const z = c.z + Math.cos(a) * R;
      ground.pos.push(x, GROUND_Y, z);
      ground.col.push(1, 1, 1, 1);
      ground.uv.push(x / 360, z / 360);
      if (k > 0) ground.idx.push(0, k + 1, k);
    }
    const gtex = groundTexture(scene, 99);
    const fmat = unlit(scene, "skyline:farFacade", null);
    const rmat = unlit(scene, "skyline:farRoof", null);
    const gmat = unlit(scene, "skyline:groundMat", gtex);
    gmat.backFaceCulling = false;
    const meshes: AbstractMesh[] = [
      toMesh(scene, "skyline:far", facade, fmat),
      toMesh(scene, "skyline:farRoofs", roof, rmat),
      toMesh(scene, "skyline:ground", ground, gmat),
    ];
    // Visible in the main pass too until the bake lands (they sit beyond the
    // camera far plane, so this costs ~3 draws for a few frames).
    const cleanup = () => {
      for (const m of meshes) m.dispose(false, false);
      for (const o of [gtex, fmat, rmat, gmat]) o.dispose();
    };

    const sky = this.lighting.sky;
    if (!sky || this.disposed) {
      cleanup();
      return;
    }
    // Wait until the sky and the city materials can render.
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
      "skyline:bake",
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
    // Render it as a custom render target (between the scene hooks below)
    // instead of in the per-camera probe stage.
    const pi = scene.reflectionProbes.indexOf(probe);
    if (pi >= 0) scene.reflectionProbes.splice(pi, 1);
    scene.customRenderTargets.push(rtt);
    // Fog / far plane only around the render-target pass that bakes the cube
    // (the interior never sees fog). Scene-level hooks are robust whatever the
    // RTT bind order is for cube faces.
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
        cam.maxZ = 9000;
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
      // Done: the cube becomes the skybox; the city geometry goes away.
      const ci = scene.customRenderTargets.indexOf(rtt);
      if (ci >= 0) scene.customRenderTargets.splice(ci, 1);
      if (this.disposed) return;
      this.lighting.setSkyTexture(rtt);
      cleanup();
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
