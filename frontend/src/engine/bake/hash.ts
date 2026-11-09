/**
 * Geometry hash shared by the lightmap exporter (tools/lightmaps) and the
 * runtime consumer: a baked lightmap is only valid for the exact vertex
 * layout it was baked on.
 *
 *   sha1( int32LE(round(x·1e4)), int32LE(round(y·1e4)), int32LE(round(z·1e4))
 *         per vertex, in vertex order, positions minus `origin`,
 *         then uint32LE(index) per index )
 *
 * Positions are quantised to 0.1 mm so last-bit float differences between
 * JS engines (JSC in the bun exporter, V8 in the browser) do not matter.
 * Colours, UVs and normals are deliberately left out (vertex-colour jitter
 * and world UVs do not change the light).
 */

export const HASH_QUANTUM = 1e4;

/** Quantised geometry bytes (see the module comment). */
export function geometryBytes(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): Uint8Array {
  const nv = Math.floor(positions.length / 3);
  const buf = new ArrayBuffer(nv * 12 + indices.length * 4);
  const dv = new DataView(buf);
  let o = 0;
  const q = (v: number) => {
    const r = Math.round(v * HASH_QUANTUM);
    // -0 and 0 must hash the same.
    return r === 0 ? 0 : r;
  };
  for (let i = 0; i < nv; i++) {
    dv.setInt32(o, q(positions[i * 3] - origin.x), true);
    dv.setInt32(o + 4, q(positions[i * 3 + 1] - origin.y), true);
    dv.setInt32(o + 8, q(positions[i * 3 + 2] - origin.z), true);
    o += 12;
  }
  for (let i = 0; i < indices.length; i++) {
    dv.setUint32(o, indices[i] >>> 0, true);
    o += 4;
  }
  return new Uint8Array(buf);
}

/** Hex SHA-1 of the quantised geometry (synchronous; no WebCrypto). */
export function geometryHash(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  origin?: { x: number; y: number; z: number },
): string {
  return sha1Hex(geometryBytes(positions, indices, origin));
}

/** Plain synchronous SHA-1 (FIPS 180-1), hex digest. */
export function sha1Hex(data: Uint8Array): string {
  const ml = data.length;
  const withPad = ((ml + 9 + 63) >> 6) << 6;
  const msg = new Uint8Array(withPad);
  msg.set(data);
  msg[ml] = 0x80;
  const dv = new DataView(msg.buffer);
  // Message length in bits (64-bit big endian; the high word covers > 512 MB).
  dv.setUint32(withPad - 8, Math.floor(ml / 0x20000000), false);
  dv.setUint32(withPad - 4, (ml << 3) >>> 0, false);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((h) => (h >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Manifest part hash (lightmap contract): positions = the merged mesh's
 * `getVerticesData("position")` (batcher frame), indices = `getIndices()`,
 * minus the set origin. Same as `geometryHash`.
 */
export function partHash(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  origin?: { x: number; y: number; z: number },
): string {
  return geometryHash(positions, indices, origin);
}

/**
 * Translation-robust check for sets whose vertex data is world space but
 * moves with the layout (control room: it sits at the end of the hall).
 * World-space float32 positions differ by up to 1 ulp (≈4e-6 m at 40-60 m)
 * between layouts, which flips 0.1 mm quantisation on some vertices, so the
 * position hash cannot be layout-stable there. This hashes the topology:
 * uint32LE(vertexCount) then uint32LE(index) per index.
 */
export function topologyHash(
  vertexCount: number,
  indices: ArrayLike<number>,
): string {
  const dv = new DataView(new ArrayBuffer(4 + indices.length * 4));
  dv.setUint32(0, vertexCount >>> 0, true);
  for (let i = 0; i < indices.length; i++)
    dv.setUint32(4 + i * 4, indices[i] >>> 0, true);
  return sha1Hex(new Uint8Array(dv.buffer));
}
