/**
 * Tiny, allocation-light 4×4 matrix helpers for the factory thin-instance
 * pools. Pure (no Babylon import) so the instance packing is unit-testable in
 * Node, but laid out EXACTLY like Babylon's `Matrix` (row-major, row-vector
 * convention: `p' = p · M`, translation in elements 12..14), so a buffer
 * written here can go straight into `thinInstanceSetBuffer("matrix", …)`.
 *
 * Composition order follows Babylon: `mul(a, b)` = "apply a, then b".
 */

export type Mat4 = Float32Array;

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Same values as `Matrix.RotationX`. */
export function rotX(a: number): Mat4 {
  const s = Math.sin(a);
  const c = Math.cos(a);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

/** Same values as `Matrix.RotationY`. */
export function rotY(a: number): Mat4 {
  const s = Math.sin(a);
  const c = Math.cos(a);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** Same values as `Matrix.RotationZ`. */
export function rotZ(a: number): Mat4 {
  const s = Math.sin(a);
  const c = Math.cos(a);
  const m = identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** `a · b` (apply a, then b). `out` may alias neither input. */
export function mul(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let r = 0; r < 4; r++) {
    const a0 = a[r * 4];
    const a1 = a[r * 4 + 1];
    const a2 = a[r * 4 + 2];
    const a3 = a[r * 4 + 3];
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a0 * b[c] + a1 * b[4 + c] + a2 * b[8 + c] + a3 * b[12 + c];
    }
  }
  return out;
}

/** Chain left to right: `chain(a, b, c)` = apply a, then b, then c. */
export function chain(...ms: Mat4[]): Mat4 {
  let acc = ms[0] ?? identity();
  for (let i = 1; i < ms.length; i++) acc = mul(acc, ms[i]);
  return acc;
}

/**
 * Scale → yaw (about +Y) → translate, written straight into `out` at
 * `offset` (in floats). This is the hot path for the box pools.
 */
export function writeTRS(
  out: Float32Array,
  offset: number,
  tx: number,
  ty: number,
  tz: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  out[offset] = sx * c;
  out[offset + 1] = 0;
  out[offset + 2] = -sx * s;
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = sy;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = sz * s;
  out[offset + 9] = 0;
  out[offset + 10] = sz * c;
  out[offset + 11] = 0;
  out[offset + 12] = tx;
  out[offset + 13] = ty;
  out[offset + 14] = tz;
  out[offset + 15] = 1;
}

export function transformPoint(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

/** Yaw that turns local +X onto the horizontal direction (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/** "#rrggbb" (sRGB) → linear RGB, same curve as `Color3.toLinearSpace`. */
export function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6),
    16,
  );
  const f = (v: number) => Math.pow(v / 255, 2.2);
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
