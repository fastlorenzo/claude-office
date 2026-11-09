/**
 * Sky cube storage: the far bake renders once into a half-float cube (8
 * B/px, 6 faces) which is then re-stored as RGBD (RGBA8: gamma-encoded
 * colour + a range divisor in alpha) at its own face size. Babylon's PBR
 * reflection sampler decodes RGBD natively (`texture.isRGBD`), so the
 * skybox and the glass reflections keep their HDR range at a quarter of the
 * memory. Pure helpers here; Exterior.ts owns the GPU plumbing.
 */

/** Babylon's `rgbdMaxRange` (shaders/helperFunctions). */
const RGBD_MAX_RANGE = 255;
/** Babylon's `LinearEncodePowerApprox` (RGBD uses the 2.2 approximation). */
const GAMMA = 1 / 2.2;

/**
 * Bytes of a cube of `size` px faces stored RGBA8 without mips, in MB
 * (what the budget test and the report use).
 */
export function rgbdCubeMB(size: number): number {
  return (size * size * 6 * 4) / 1048576;
}

/**
 * Area-average resample of a square RGBA float face (`n` px) to `m` px.
 * Box footprint of n/m source texels per output texel (exact area weights),
 * so a 1.5x reduction stays smooth instead of aliasing like a point sample.
 */
export function resampleFace(
  src: Float32Array,
  n: number,
  m: number,
): Float32Array {
  if (n === m) return src;
  const out = new Float32Array(m * m * 4);
  const tmp = new Float32Array(m * n * 4); // horizontal pass: m wide, n tall
  const r = n / m;
  // Contribution table (source index range + weights) per output index.
  const taps: { i0: number; w: number[] }[] = [];
  for (let o = 0; o < m; o++) {
    const a = o * r;
    const b = (o + 1) * r;
    const i0 = Math.floor(a);
    const i1 = Math.min(n - 1, Math.ceil(b) - 1);
    const w: number[] = [];
    let sum = 0;
    for (let i = i0; i <= i1; i++) {
      const wi = Math.min(b, i + 1) - Math.max(a, i);
      w.push(wi);
      sum += wi;
    }
    taps.push({ i0, w: w.map((x) => x / sum) });
  }
  for (let y = 0; y < n; y++)
    for (let ox = 0; ox < m; ox++) {
      const { i0, w } = taps[ox];
      let r0 = 0,
        g0 = 0,
        b0 = 0,
        a0 = 0;
      for (let k = 0; k < w.length; k++) {
        const p = (y * n + i0 + k) * 4;
        r0 += src[p] * w[k];
        g0 += src[p + 1] * w[k];
        b0 += src[p + 2] * w[k];
        a0 += src[p + 3] * w[k];
      }
      const q = (y * m + ox) * 4;
      tmp[q] = r0;
      tmp[q + 1] = g0;
      tmp[q + 2] = b0;
      tmp[q + 3] = a0;
    }
  for (let oy = 0; oy < m; oy++) {
    const { i0, w } = taps[oy];
    for (let x = 0; x < m; x++) {
      let r0 = 0,
        g0 = 0,
        b0 = 0,
        a0 = 0;
      for (let k = 0; k < w.length; k++) {
        const p = ((i0 + k) * m + x) * 4;
        r0 += tmp[p] * w[k];
        g0 += tmp[p + 1] * w[k];
        b0 += tmp[p + 2] * w[k];
        a0 += tmp[p + 3] * w[k];
      }
      const q = (oy * m + x) * 4;
      out[q] = r0;
      out[q + 1] = g0;
      out[q + 2] = b0;
      out[q + 3] = a0;
    }
  }
  return out;
}

/**
 * Encode linear float RGBA to RGBD bytes (Babylon `toRGBD`). A one-LSB
 * triangular dither (`dither` 0..1, deterministic) hides the 8-bit steps in
 * smooth sky gradients.
 */
export function encodeRGBD(src: Float32Array, dither = 1): Uint8Array {
  const out = new Uint8Array(src.length);
  let seed = 0x9e3779b9;
  const noise = (): number => {
    // xorshift32 -> two uniforms -> triangular in (-1, 1)
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const a = (seed >>> 0) / 4294967296;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return a - (seed >>> 0) / 4294967296;
  };
  for (let p = 0; p < src.length; p += 4) {
    const r = Math.max(0, src[p]);
    const g = Math.max(0, src[p + 1]);
    const b = Math.max(0, src[p + 2]);
    const maxRGB = Math.max(1e-7, r, g, b);
    let d = Math.max(RGBD_MAX_RANGE / maxRGB, 1);
    d = Math.min(1, Math.floor(d) / 255);
    const d255 = Math.round(d * 255);
    out[p] = quant(r * d, noise() * dither);
    out[p + 1] = quant(g * d, noise() * dither);
    out[p + 2] = quant(b * d, noise() * dither);
    out[p + 3] = d255;
  }
  return out;
}

function quant(v: number, n: number): number {
  const e = Math.min(1, Math.pow(Math.min(1, v), GAMMA));
  return Math.max(0, Math.min(255, Math.round(e * 255 + n)));
}

/** Decode one RGBD texel back to linear (shader `fromRGBD`); for tests. */
export function decodeRGBD(
  bytes: Uint8Array,
  p: number,
): [number, number, number] {
  const a = bytes[p + 3] / 255;
  return [
    Math.pow(bytes[p] / 255, 2.2) / a,
    Math.pow(bytes[p + 1] / 255, 2.2) / a,
    Math.pow(bytes[p + 2] / 255, 2.2) / a,
  ];
}

/** Fraction of RGB samples above 1.0 and the maximum (HDR headroom probe). */
export function hdrStats(src: Float32Array): { over1: number; max: number } {
  let over = 0;
  let max = 0;
  const n = src.length / 4;
  for (let p = 0; p < src.length; p += 4) {
    const m = Math.max(src[p], src[p + 1], src[p + 2]);
    if (m > 1) over++;
    if (m > max) max = m;
  }
  return { over1: over / n, max };
}
