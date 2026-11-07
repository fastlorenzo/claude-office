/**
 * Procedural textures for the exterior (no downloads, deterministic, built once):
 *  - ground atlas 2x2 (grass · asphalt · concrete · gravel), 256 px tiles
 *  - cladding atlas (12 m x 16 m): office/glazed variant + warehouse variant
 *  - tree-card atlas (broadleaf · columnar · shrub · canopy top), alpha-tested
 */
import { RawTexture, Texture, type Scene } from "@/engine/babylon";
import { rng } from "@/engine/art/random";

export type RGB = [number, number, number];

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Tileable value noise on an n x n lattice. */
function noise(n: number, seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (i: number, j: number) =>
    g[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
  return (x, y) => {
    const fx = x * n;
    const fy = y * n;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/** Cheap per-pixel hash in [0,1). */
const hash = (x: number, y: number, s = 0): number => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

function tex(
  scene: Scene,
  name: string,
  w: number,
  h: number,
  data: Uint8Array,
): RawTexture {
  const t = RawTexture.CreateRGBATexture(
    data,
    w,
    h,
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

const put = (d: Uint8Array, i: number, c: RGB, a = 1) => {
  d[i] = Math.round(clamp(c[0]) * 255);
  d[i + 1] = Math.round(clamp(c[1]) * 255);
  d[i + 2] = Math.round(clamp(c[2]) * 255);
  d[i + 3] = Math.round(a * 255);
};

// ---------------------------------------------------------------------------
// Ground atlas
// ---------------------------------------------------------------------------

export const GROUND_TILE_M = [8, 4, 4, 4] as const;
export const TILE_GRASS = 0;
export const TILE_ASPHALT = 1;
export const TILE_CONCRETE = 2;
export const TILE_GRAVEL = 3;
const GT = 256;

export function groundAtlas(scene: Scene): RawTexture {
  const W = GT * 2;
  const data = new Uint8Array(W * W * 4);
  const n4 = noise(4, 11);
  const n8 = noise(8, 12);
  const n16 = noise(16, 13);
  const n32 = noise(32, 14);
  const a4 = noise(4, 21);
  const a8 = noise(8, 22);
  const c4 = noise(4, 31);
  const c8 = noise(8, 32);

  // Asphalt cracks: wrapped random walks, drawn once.
  const crack = new Float32Array(GT * GT);
  const r = rng(77);
  for (let k = 0; k < 5; k++) {
    let x = r() * GT;
    let y = r() * GT;
    let a = r() * Math.PI * 2;
    for (let s = 0; s < 120; s++) {
      a += (r() - 0.5) * 0.7;
      x += Math.cos(a) * 1.6;
      y += Math.sin(a) * 1.6;
      const px = ((Math.floor(x) % GT) + GT) % GT;
      const py = ((Math.floor(y) % GT) + GT) % GT;
      crack[py * GT + px] = 1;
      if (r() < 0.2) crack[py * GT + ((px + 1) % GT)] = 0.6;
    }
  }

  for (let y = 0; y < GT; y++)
    for (let x = 0; x < GT; x++) {
      const u = x / GT;
      const v = y / GT;
      // Grass: clumpy, with yellowed patches and fine blade speckle.
      {
        const m = n4(u, v) * 0.5 + n8(u, v) * 0.3 + n16(u, v) * 0.2;
        const blade = hash(x, y, 1) * 0.5 + hash(x >> 1, y >> 1, 2) * 0.5;
        const dry = clamp((n8(u + 0.3, v + 0.1) - 0.55) * 3);
        const l =
          0.62 + 0.3 * m + 0.2 * (blade - 0.5) + 0.12 * (n32(u, v) - 0.5);
        const c: RGB = [
          l * (0.95 + 0.25 * dry),
          l * (1 - 0.06 * dry),
          l * (0.86 - 0.28 * dry),
        ];
        put(data, (y * W + x) * 4, c);
      }
      // Asphalt: aggregate speckle, patch repairs, hairline cracks.
      {
        const m = a4(u, v) * 0.6 + a8(u, v) * 0.4;
        const sp = hash(x, y, 3);
        let l = 0.78 + 0.22 * (m - 0.5) + 0.2 * (sp - 0.5);
        if (sp > 0.985) l += 0.25; // pale stones
        const patch = n8(u + 0.5, v + 0.2) > 0.72 ? 0.9 : 1;
        l *= patch;
        l *= 1 - 0.45 * crack[y * GT + x];
        const c: RGB = [l, l * 1.0, l * 1.03];
        put(data, (y * W + (x + GT)) * 4, c);
      }
      // Concrete: 4 m slab with joints, soft stains, fine grain.
      {
        const m = c4(u, v) * 0.6 + c8(u, v) * 0.4;
        let l = 0.9 + 0.12 * (m - 0.5) + 0.07 * (hash(x, y, 4) - 0.5);
        const e = Math.min(x, y, GT - 1 - x, GT - 1 - y);
        if (e < 2) l *= 0.62;
        else if (e < 4) l *= 0.9;
        // Mid-slab control joint.
        if (Math.abs(x - GT / 2) < 1) l *= 0.82;
        put(data, ((y + GT) * W + x) * 4, [l, l, l * 0.97]);
      }
      // Gravel / dry ground.
      {
        const s = hash(x, y, 5);
        const s2 = hash(x >> 2, y >> 2, 6);
        const l = 0.62 + 0.3 * (s2 - 0.5) + 0.25 * (s - 0.5);
        put(data, ((y + GT) * W + (x + GT)) * 4, [
          l * 1.02,
          l * 0.96,
          l * 0.86,
        ]);
      }
    }
  const t = tex(scene, "exterior:groundAtlas", W, W, data);
  t.anisotropicFilteringLevel = 8;
  return t;
}

/** UV inside atlas tile `i` for tile-local (u, v) in 0..1. */
export function tileUV(i: number, u: number, v: number): [number, number] {
  const col = i & 1;
  const row = i >> 1;
  const e = 0.004;
  return [(col + e + u * (1 - 2 * e)) / 2, (row + e + v * (1 - 2 * e)) / 2];
}

// ---------------------------------------------------------------------------
// Cladding atlas: 12 m (u) x 16 m (v). u 0-6 glazed office, 6-12 warehouse.
// ---------------------------------------------------------------------------

export const CLAD_W_M = 12;
export const CLAD_H_M = 16;

export function claddingAtlas(scene: Scene): RawTexture {
  const W = 512;
  const H = 512;
  const data = new Uint8Array(W * H * 4);
  const pxU = W / CLAD_W_M; // 42.7 px/m
  const pxV = H / CLAD_H_M; // 32 px/m
  const stain = noise(16, 41);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const m = y / pxV; // metres above ground
      const wu = x / pxU; // metres along
      const warehouse = x >= W / 2;
      const lu = warehouse ? wu - 6 : wu; // 0-6 within variant
      const grain = (hash(x, y, 7) - 0.5) * 0.04;
      let c: RGB;
      if (!warehouse) {
        if (m < 0.9) {
          const l = 0.6 + grain * 2 + 0.05 * (hash(x >> 3, y >> 3, 8) - 0.5);
          c = [l, l, l * 0.97];
          if (m > 0.84) c = [l * 0.7, l * 0.7, l * 0.7];
        } else if ((m >= 3.0 && m < 4.2) || (m >= 11 && m < 12.2)) {
          const bm = m >= 11 ? m - 11 : m - 3.0;
          const mull = lu % 3 < 0.09;
          const sill = bm < 0.06 || bm > 1.14;
          if (mull || sill) c = [0.28, 0.3, 0.33];
          else {
            const k = bm / 1.2;
            // Sky reflection fading to a darker interior, with a diagonal streak.
            const streak =
              Math.max(0, 1 - Math.abs(((lu * 1.1 + bm * 0.9) % 3) - 1.5) * 5) *
              0.14;
            c = [
              0.2 + 0.4 * k + streak,
              0.28 + 0.42 * k + streak,
              0.36 + 0.42 * k + streak,
            ];
          }
        } else {
          // Vertical standing-seam panels, 0.19 m pitch, with horizontal joints.
          const ph = (lu / 0.19) % 1;
          let l = 0.9 + grain + 0.06 * Math.sin(ph * Math.PI * 2);
          if (ph < 0.06) l *= 0.82;
          if (Math.abs((m % 1.6) - 0) < 0.025) l *= 0.8;
          l *=
            1 - 0.1 * clamp((m - 5) / 8) * (stain(lu / 6, 0.5) > 0.5 ? 1 : 0.5);
          c = [l * 0.97, l, l * 1.02];
        }
      } else {
        const wx = lu / 6;
        const st = stain(wx * 1.0, 0.25);
        if (m < 1.15) {
          // Concrete plinth with a painted kick-strip.
          const l = 0.58 + grain * 2 + 0.08 * (hash(x >> 2, y >> 2, 9) - 0.5);
          c = [l, l, l * 0.97];
          if (m > 1.05) c = [l * 0.72, l * 0.72, l * 0.72];
        } else if (m >= 4.4 && m < 5.2) {
          // Translucent polycarbonate ribbon with mullions.
          const mull = lu % 1.5 < 0.06;
          const bm = (m - 4.4) / 0.8;
          if (mull || bm < 0.05 || bm > 0.95) c = [0.5, 0.52, 0.54];
          else c = [0.7 + 0.12 * bm, 0.78 + 0.1 * bm, 0.82 + 0.08 * bm];
        } else {
          // Trapezoidal profile: 0.3 m pitch.
          const ph = (lu / 0.3) % 1;
          const prof =
            ph < 0.25 ? 0.82 : ph < 0.5 ? 1.0 : ph < 0.75 ? 0.96 : 0.86;
          let l = 0.86 * prof + grain;
          if (Math.abs((m % 3.2) - 0) < 0.03) l *= 0.78;
          // Weathering: vertical run-off streaks darker toward the ground.
          const streak = hash(Math.floor(lu / 0.3), 0, 10) < 0.18 ? 0.9 : 1;
          l *= streak * (1 - 0.14 * (st - 0.5));
          c = [l * 0.98, l, l * 1.02];
        }
      }
      put(data, (y * W + x) * 4, c);
    }
  const t = tex(scene, "exterior:claddingAtlas", W, H, data);
  t.uScale = 1 / CLAD_W_M;
  t.vScale = 1 / CLAD_H_M;
  t.anisotropicFilteringLevel = 8;
  return t;
}

// ---------------------------------------------------------------------------
// Tree cards: 2x2 atlas of 256 px alpha-tested impostors.
// ---------------------------------------------------------------------------

export const TREE_BROADLEAF = 0;
export const TREE_COLUMNAR = 1;
export const TREE_SHRUB = 2;
export const TREE_TOP = 3;
const TS = 256;

interface Blob {
  x: number;
  y: number;
  r: number;
  c: RGB;
}

function drawBlobs(
  px: Float32Array,
  blobs: Blob[],
  yMin: number,
  yMax: number,
  seed: number,
): void {
  blobs.sort((a, b) => a.y - b.y);
  for (const b of blobs) {
    const phi = hash(Math.round(b.x), Math.round(b.y), seed) * 6.28;
    const x0 = Math.max(0, Math.floor(b.x - b.r * 1.3));
    const x1 = Math.min(TS - 1, Math.ceil(b.x + b.r * 1.3));
    const y0 = Math.max(0, Math.floor(b.y - b.r * 1.3));
    const y1 = Math.min(TS - 1, Math.ceil(b.y + b.r * 1.3));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - b.x;
        const dy = y - b.y;
        const ang = Math.atan2(dy, dx);
        const rr =
          b.r *
          (0.82 +
            0.22 * Math.sin(ang * 5 + phi) +
            0.1 * Math.sin(ang * 11 + phi * 2));
        const d = Math.hypot(dx, dy);
        if (d > rr) continue;
        // v grows upward: sun-facing top bright, underside dark; edge rim dark.
        const lx = dx / rr;
        const ly = dy / rr;
        const lit = 0.78 + 0.5 * (ly * 0.7 - lx * 0.25) + 0.12 * (1 - d / rr);
        const height = (b.y - yMin) / Math.max(1, yMax - yMin);
        const k = clamp(
          lit * (0.75 + 0.45 * height) + (hash(x, y, seed) - 0.5) * 0.1,
        );
        const i = (y * TS + x) * 4;
        px[i] = b.c[0] * k;
        px[i + 1] = b.c[1] * k;
        px[i + 2] = b.c[2] * k;
        px[i + 3] = 1;
      }
  }
}

function foliage(
  r: () => number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  count: number,
  rMin: number,
  rMax: number,
  hue: RGB,
): Blob[] {
  const out: Blob[] = [];
  for (let i = 0; i < count; i++) {
    // Uniform in ellipse, biased toward the rim so the silhouette is lumpy.
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.92 + 0.08 * r();
    const jit = 0.82 + r() * 0.3;
    const g = 0.86 + r() * 0.3;
    out.push({
      x: cx + Math.cos(a) * rx * d,
      y: cy + Math.sin(a) * ry * d,
      r: rMin + r() * (rMax - rMin),
      c: [hue[0] * jit, hue[1] * g, hue[2] * jit * 0.9],
    });
  }
  return out;
}

export function treeAtlas(scene: Scene): RawTexture {
  const W = TS * 2;
  const data = new Uint8Array(W * W * 4);
  const r = rng(5150);
  const tiles: Float32Array[] = [];
  for (let t = 0; t < 4; t++) tiles.push(new Float32Array(TS * TS * 4));

  const trunk = (px: Float32Array, cx: number, top: number, w: number) => {
    for (let y = 0; y < top; y++) {
      const ww = w * (1 + 0.5 * (1 - y / top)) * 0.5;
      for (let x = Math.floor(cx - ww); x <= Math.ceil(cx + ww); x++) {
        const k =
          0.7 + 0.3 * hash(x, y, 12) - 0.25 * ((x - cx) / ww > 0.2 ? 1 : 0);
        const i = (y * TS + x) * 4;
        px[i] = 0.3 * k;
        px[i + 1] = 0.22 * k;
        px[i + 2] = 0.15 * k;
        px[i + 3] = 1;
      }
    }
  };

  // Broadleaf: a wide lumpy crown on a visible trunk.
  trunk(tiles[TREE_BROADLEAF], 128, 110, 7);
  drawBlobs(
    tiles[TREE_BROADLEAF],
    [
      ...foliage(r, 128, 165, 104, 74, 260, 11, 22, [0.34, 0.5, 0.2]),
      ...foliage(r, 128, 150, 70, 44, 80, 12, 20, [0.3, 0.46, 0.18]),
    ],
    90,
    240,
    1,
  );
  // Columnar (poplar/cypress): narrow tall crown.
  trunk(tiles[TREE_COLUMNAR], 128, 40, 6);
  drawBlobs(
    tiles[TREE_COLUMNAR],
    foliage(r, 128, 145, 40, 108, 230, 9, 17, [0.26, 0.42, 0.18]),
    35,
    250,
    2,
  );
  // Shrub: low dense mound, no trunk.
  drawBlobs(
    tiles[TREE_SHRUB],
    foliage(r, 128, 85, 108, 70, 200, 10, 20, [0.36, 0.52, 0.2]),
    10,
    160,
    3,
  );
  // Canopy seen from above: a dense disc with a few gaps.
  {
    const bl = foliage(r, 128, 128, 108, 108, 300, 11, 20, [0.36, 0.53, 0.2]);
    drawBlobs(tiles[TREE_TOP], bl, 20, 236, 4);
  }

  for (let t = 0; t < 4; t++) {
    const col = t & 1;
    const row = t >> 1;
    const px = tiles[t];
    for (let y = 0; y < TS; y++)
      for (let x = 0; x < TS; x++) {
        const s = (y * TS + x) * 4;
        const d = ((row * TS + y) * W + (col * TS + x)) * 4;
        const a = px[s + 3];
        put(
          data,
          d,
          a > 0 ? [px[s], px[s + 1], px[s + 2]] : [0.1, 0.18, 0.08],
          a,
        );
      }
  }
  const tt = tex(scene, "exterior:treeAtlas", W, W, data);
  tt.hasAlpha = true;
  tt.anisotropicFilteringLevel = 4;
  return tt;
}
