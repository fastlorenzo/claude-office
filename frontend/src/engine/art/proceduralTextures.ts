/**
 * Procedural textures generated once at startup (no downloads):
 *
 *  - `createDetailMap` — a 512² tileable PBR detail map (R albedo, G normal-y,
 *    B roughness, A normal-x) of large, soft cloudy variation. Applied at a
 *    long period (≈ 5–7 m) on top of the tiled ambientCG maps it breaks the
 *    visible repetition and gives floors believable roughness "wear" (wax
 *    patches, scuffs), which is what makes reflections look real.
 *  - `createMossTextures` — preserved-moss wall (albedo + normal).
 *
 * Everything is tileable and seeded (deterministic).
 */
import { RawTexture, Texture, type Scene } from "@/engine/babylon";
import { rng } from "@/engine/art/random";

// ---------------------------------------------------------------------------
// Tileable value noise
// ---------------------------------------------------------------------------

class TileNoise {
  private readonly grid: Float32Array;
  constructor(
    private readonly period: number,
    seed: number,
  ) {
    const r = rng(seed);
    this.grid = new Float32Array(period * period);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = r();
  }
  /** x, y in [0, 1) texture space. Smooth, periodic. */
  at(x: number, y: number): number {
    const p = this.period;
    const fx = x * p;
    const fy = y * p;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const g = (i: number, j: number) =>
      this.grid[(((j % p) + p) % p) * p + (((i % p) + p) % p)];
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  }
}

function fbm(layers: TileNoise[], x: number, y: number, gain = 0.5): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (const l of layers) {
    sum += l.at(x, y) * amp;
    norm += amp;
    amp *= gain;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Detail map
// ---------------------------------------------------------------------------

/**
 * Detail map (Babylon convention): R = albedo (0.5 neutral), G = normal Y,
 * B = roughness (0.5 neutral), A = normal X.
 */
export function createDetailMap(
  scene: Scene,
  seed = 7,
  size = 512,
): RawTexture {
  const cloud = [4, 8, 16, 32].map((p, i) => new TileNoise(p, seed + i));
  const fine = [64, 128].map((p, i) => new TileNoise(p, seed + 10 + i));
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const c = fbm(cloud, u, v, 0.55);
      const f = fbm(fine, u, v, 0.6);
      h[y * size + x] = c * 0.8 + f * 0.2;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const c = h[i];
      // Albedo: ±6 % cloudy, roughness: ±18 % (wax / wear patches).
      const alb = 0.5 + (c - 0.5) * 0.35;
      const rough = 0.5 + (c - 0.5) * 0.9;
      const hx =
        h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const hy =
        h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      const nx = 0.5 - hx * 2.2;
      const ny = 0.5 - hy * 2.2;
      data[i * 4] = clamp255(alb);
      data[i * 4 + 1] = clamp255(ny);
      data[i * 4 + 2] = clamp255(rough);
      data[i * 4 + 3] = clamp255(nx);
    }
  }
  const tex = RawTexture.CreateRGBATexture(
    data,
    size,
    size,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  tex.name = "detail:cloud";
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.gammaSpace = false;
  return tex;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// ---------------------------------------------------------------------------
// Moss wall
// ---------------------------------------------------------------------------

/** Preserved moss panel: clumpy greens with a lumpy normal map. 1 repeat ≈ 1.2 m. */
export function createMossTextures(
  scene: Scene,
  seed = 31,
  size = 512,
): { albedo: RawTexture; normal: RawTexture } {
  const clumps = [6, 12, 24].map((p, i) => new TileNoise(p, seed + i));
  const fine = [48, 96, 192].map((p, i) => new TileNoise(p, seed + 5 + i));
  const hue = [3, 6].map((p, i) => new TileNoise(p, seed + 20 + i));
  const H = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const c = fbm(clumps, u, v, 0.6);
      const f = fbm(fine, u, v, 0.65);
      // Ball-moss: bright domes, dark crevices.
      const dome = Math.pow(Math.max(0, Math.sin(c * Math.PI * 3.2)), 0.7);
      const height = dome * 0.65 + f * 0.35;
      H[y * size + x] = height;
      const k = fbm(hue, u, v);
      // Two greens (reindeer moss / sheet moss) mixed by a low-freq field.
      const g1 = [0.24, 0.36, 0.12];
      const g2 = [0.36, 0.42, 0.16];
      const g3 = [0.12, 0.2, 0.08];
      const t = Math.min(1, Math.max(0, (k - 0.35) * 2.2));
      const lit = 0.35 + height * 0.85;
      for (let ch = 0; ch < 3; ch++) {
        const base = g1[ch] * (1 - t) + g2[ch] * t;
        const col =
          base * lit * (1 - (1 - height) * 0.5) + g3[ch] * (1 - height) * 0.4;
        alb[(y * size + x) * 4 + ch] = clamp255(Math.pow(col, 1 / 1.25));
      }
      alb[(y * size + x) * 4 + 3] = 255;
    }
  const nor = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const hx =
        H[y * size + ((x + 1) % size)] - H[y * size + ((x - 1 + size) % size)];
      const hy =
        H[((y + 1) % size) * size + x] - H[((y - 1 + size) % size) * size + x];
      let nx = -hx * 6;
      let ny = -hy * 6;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * size + x) * 4;
      nor[i] = clamp255(nx * 0.5 + 0.5);
      nor[i + 1] = clamp255(ny * 0.5 + 0.5);
      nor[i + 2] = clamp255(nz * 0.5 + 0.5);
      nor[i + 3] = 255;
    }
  const mk = (d: Uint8Array, name: string, srgb: boolean) => {
    const t = RawTexture.CreateRGBATexture(
      d,
      size,
      size,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.name = name;
    t.gammaSpace = srgb;
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    return t;
  };
  return {
    albedo: mk(alb, "moss:albedo", true),
    normal: mk(nor, "moss:normal", false),
  };
}
