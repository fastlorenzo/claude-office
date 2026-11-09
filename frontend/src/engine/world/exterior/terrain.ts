/**
 * Distant terrain: a pure, deterministic heightfield (domain-warped ridged
 * fBm on value noise) used once at bake time to build the far hills ring that
 * ends up in the sky cube. Coordinates are metres relative to the park centre.
 */

export const TERRAIN_R0 = 1400;
export const TERRAIN_R1 = 7000;

function hash(i: number, j: number, seed: number): number {
  let n = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Quintic-smoothed value noise in [0, 1]. */
export function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const sz = tz * tz * tz * (tz * (tz * 6 - 15) + 10);
  const a = hash(x0, z0, seed);
  const b = hash(x0 + 1, z0, seed);
  const c = hash(x0, z0 + 1, seed);
  const d = hash(x0 + 1, z0 + 1, seed);
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sz;
}

function fbm(x: number, z: number, seed: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * valueNoise(x * f + o * 17.3, z * f - o * 9.1, seed + o);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

function ridged(x: number, z: number, seed: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let norm = 0;
  let w = 1;
  for (let o = 0; o < oct; o++) {
    // Soft crease (no razor ridges on the skyline).
    const t =
      valueNoise(x * f + o * 5.7, z * f + o * 3.3, seed + o * 3) * 2 - 1;
    let r = Math.max(0, (1 - Math.sqrt(t * t + 0.03)) / (1 - Math.sqrt(0.03)));
    r *= r;
    r *= w;
    w = Math.min(1, r * 1.6);
    s += a * r;
    norm += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Terrain height above the ground plane at (dx, dz) metres from the park
 * centre. Zero inside TERRAIN_R0 (the flat industrial estate), rising into
 * rolling hills and finally ridged mountains, easing back to 0 at TERRAIN_R1.
 */
export function terrainHeight(dx: number, dz: number, seed = 5): number {
  const r = Math.hypot(dx, dz);
  if (r <= TERRAIN_R0 * 0.6) return 0;
  const k = 1 / 2600;
  // Domain warp.
  const wx = (fbm(dx * k * 1.7, dz * k * 1.7, seed + 100, 3) - 0.5) * 1.6;
  const wz =
    (fbm(dx * k * 1.7 + 40, dz * k * 1.7 - 25, seed + 200, 3) - 0.5) * 1.6;
  const px = dx * k + wx;
  const pz = dz * k + wz;
  const ridge = ridged(px * 1.3, pz * 1.3, seed, 4);
  const rolling = fbm(px * 2.2, pz * 2.2, seed + 300, 5);
  // Large-scale mask: some bearings stay low plains, others are mountainous.
  const mask = smooth(
    0.3,
    0.68,
    fbm(dx * k * 0.55, dz * k * 0.55, seed + 400, 3),
  );
  const rise = smooth(TERRAIN_R0 * 0.6, 3600, r);
  const mount = smooth(2800, 5600, r);
  const amp = 70 + 330 * mount;
  const shape =
    0.35 * rolling + (0.25 + 0.75 * mask) * ridge * (0.5 + 0.8 * mount);
  const taper = 1 - smooth(6400, TERRAIN_R1, r);
  return Math.max(0, amp * shape * (0.25 + 0.75 * mask) * rise * taper);
}
