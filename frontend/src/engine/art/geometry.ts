/**
 * Art-grade procedural geometry.
 *
 *  - `roundedBoxData` — a box whose edges are rounded with radius `r` and
 *    smooth normals. Sharp 90° CG edges are the biggest "fake" tell; even a
 *    3 mm radius catches a highlight line the eye reads as "manufactured".
 *  - `arcSlabData` — a ring-sector solid (curved desks, NOC console).
 *  - `ArtBatcher` — a MeshBatcher that gives every piece a subtle, seeded
 *    albedo jitter (vertex colour) and a random texture offset, so repeated
 *    boards / panels / desks never look copy-pasted. Merging still yields
 *    one draw call per material.
 */
import {
  Mesh,
  Vector3,
  VertexData,
  VertexBuffer,
  type Material,
  type Scene,
} from "@/engine/babylon";
import {
  applyWorldUVs,
  type Materials,
  type SurfaceKey,
} from "@/engine/materials/Materials";
import { MeshBatcher, type BoxOpts, type V3 } from "@/engine/util/MeshBatcher";
import { hashString, rng } from "@/engine/art/random";

export { hashString, rng };

// ---------------------------------------------------------------------------
// Rounded box
// ---------------------------------------------------------------------------

/** Coordinates along one face axis: flat span plus `seg` band steps at each end. */
function bandCoords(h: number, r: number, seg: number): number[] {
  const out: number[] = [];
  const push = (v: number) => {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-6)
      out.push(v);
  };
  // Uniform angles over the half-arc this face owns (45° → 0°).
  for (let k = 0; k <= seg; k++) {
    const th = (Math.PI / 4) * (1 - k / seg);
    push(-h + r - r * Math.tan(th));
  }
  for (let k = seg; k >= 0; k--) {
    const th = (Math.PI / 4) * (1 - k / seg);
    push(h - r + r * Math.tan(th));
  }
  return out;
}

/**
 * Box `w × h × d` centred on the origin with every edge rounded by `r`
 * (clamped to half the smallest side). `seg` = quads per half-arc per face:
 * 1 is a crisp bevel (cheap), 3 reads as a soft cushion.
 */
export function roundedBoxData(
  w: number,
  h: number,
  d: number,
  r: number,
  seg = 1,
): VertexData {
  const half = [w / 2, h / 2, d / 2];
  const rr = Math.max(0, Math.min(r, ...half.map((x) => x * 0.999)));
  const inner = half.map((x) => x - rr);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // face: normal axis, sign, in-plane axes u, v
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 1],
    [0, -1, 2, 1],
    [1, 1, 0, 2],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 0, 1],
  ];
  const p = [0, 0, 0];
  for (const [na, sign, ua, va] of faces) {
    const us = bandCoords(half[ua], rr, seg);
    const vs = bandCoords(half[va], rr, seg);
    const base = positions.length / 3;
    for (let j = 0; j < vs.length; j++) {
      for (let i = 0; i < us.length; i++) {
        p[na] = sign * half[na];
        p[ua] = us[i];
        p[va] = vs[j];
        const c = [0, 1, 2].map((k) =>
          Math.max(-inner[k], Math.min(inner[k], p[k])),
        );
        let dx = p[0] - c[0];
        let dy = p[1] - c[1];
        let dz = p[2] - c[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
        positions.push(c[0] + dx * rr, c[1] + dy * rr, c[2] + dz * rr);
        normals.push(dx, dy, dz);
        uvs.push(
          (us[i] + half[ua]) / (2 * half[ua] || 1),
          (vs[j] + half[va]) / (2 * half[va] || 1),
        );
      }
    }
    const nu = us.length;
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a = base + j * nu + i;
        const b = a + 1;
        const c = a + nu + 1;
        const e = a + nu;
        pushQuad(positions, normals, indices, a, b, c, e);
      }
    }
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  return vd;
}

/** Push two triangles with Babylon's winding (cross(b-a, c-a) opposes the normal). */
function pushQuad(
  pos: number[],
  nor: number[],
  idx: number[],
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  const ax = pos[a * 3];
  const ay = pos[a * 3 + 1];
  const az = pos[a * 3 + 2];
  const e1 = [pos[b * 3] - ax, pos[b * 3 + 1] - ay, pos[b * 3 + 2] - az];
  const e2 = [pos[c * 3] - ax, pos[c * 3 + 1] - ay, pos[c * 3 + 2] - az];
  const cx = e1[1] * e2[2] - e1[2] * e2[1];
  const cy = e1[2] * e2[0] - e1[0] * e2[2];
  const cz = e1[0] * e2[1] - e1[1] * e2[0];
  const n = [
    nor[a * 3] + nor[c * 3],
    nor[a * 3 + 1] + nor[c * 3 + 1],
    nor[a * 3 + 2] + nor[c * 3 + 2],
  ];
  const dot = cx * n[0] + cy * n[1] + cz * n[2];
  if (dot > 0) idx.push(a, c, b, a, d, c);
  else idx.push(a, b, c, a, c, d);
}

// ---------------------------------------------------------------------------
// Arc slab (ring sector solid)
// ---------------------------------------------------------------------------

/**
 * Ring sector between radii r0 < r1, angles a0 → a1 (radians, measured from
 * +Z towards +X, i.e. yaw), heights y0 → y1, centred on the origin.
 */
export function arcSlabData(
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  segments = 24,
): VertexData {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const add = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uvs.push(0, 0);
    return pos.length / 3 - 1;
  };
  const ang = (i: number) => a0 + ((a1 - a0) * i) / segments;
  // Top / bottom
  for (const [y, ny] of [
    [y1, 1],
    [y0, -1],
  ] as const) {
    const base = pos.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = ang(i);
      const s = Math.sin(a);
      const c = Math.cos(a);
      add(s * r0, y, c * r0, 0, ny, 0);
      add(s * r1, y, c * r1, 0, ny, 0);
    }
    for (let i = 0; i < segments; i++) {
      const q = base + i * 2;
      pushQuad(pos, nor, idx, q, q + 1, q + 3, q + 2);
    }
  }
  // Inner / outer walls
  for (const [r, sgn] of [
    [r0, -1],
    [r1, 1],
  ] as const) {
    const base = pos.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = ang(i);
      const s = Math.sin(a);
      const c = Math.cos(a);
      add(s * r, y0, c * r, s * sgn, 0, c * sgn);
      add(s * r, y1, c * r, s * sgn, 0, c * sgn);
    }
    for (let i = 0; i < segments; i++) {
      const q = base + i * 2;
      pushQuad(pos, nor, idx, q, q + 1, q + 3, q + 2);
    }
  }
  // End caps
  for (const [a, sgn] of [
    [a0, -1],
    [a1, 1],
  ] as const) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    // Tangent direction of increasing angle: (cos a, 0, -sin a)
    const nx = c * sgn;
    const nz = -s * sgn;
    const q = pos.length / 3;
    add(s * r0, y0, c * r0, nx, 0, nz);
    add(s * r1, y0, c * r1, nx, 0, nz);
    add(s * r1, y1, c * r1, nx, 0, nz);
    add(s * r0, y1, c * r0, nx, 0, nz);
    pushQuad(pos, nor, idx, q, q + 1, q + 2, q + 3);
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = uvs;
  vd.indices = idx;
  return vd;
}

// ---------------------------------------------------------------------------
// ArtBatcher
// ---------------------------------------------------------------------------

export interface ArtOpts extends BoxOpts {
  /** Edge radius (metres). */
  r?: number;
  /** Quads per half-arc (1 bevel, 2–3 soft). */
  seg?: number;
}

/** sRGB hex → linear multipliers for `ArtBatcher.paint`. */
export function paintOf(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/** Walkable floor levels (office slab, factory / ground floor). */
const FLOOR_LEVELS = [0, -6];
const AO_REACH = 0.25;
const scratchP = new Vector3();
const scratchN = new Vector3();

/**
 * Per-vertex ambient occlusion for a positioned piece (no GI, no SSAO on low
 * tiers): side faces of a furniture-sized piece standing on a floor darken
 * toward the
 * contact (0.8 at the floor → 1 at 0.25 m), faces looking down get 0.9.
 * Null when nothing is occluded. Pure function of the mesh (exported for
 * tests).
 */
export function vertexAO(mesh: Mesh): Float32Array | null {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nor) return null;
  const wm = mesh.computeWorldMatrix(true);
  const n = pos.length / 3;
  const wy = new Float32Array(n);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      pos[i * 3],
      pos[i * 3 + 1],
      pos[i * 3 + 2],
      wm,
      scratchP,
    );
    wy[i] = scratchP.y;
    if (scratchP.y < minY) minY = scratchP.y;
    if (scratchP.y > maxY) maxY = scratchP.y;
  }
  // Furniture-sized pieces only: a 3 m wall has vertices only at its foot
  // and head, so its AO would smear over the whole height.
  const onFloor =
    maxY - minY < 1.6 && FLOOR_LEVELS.some((f) => Math.abs(minY - f) < 0.03);
  const out = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    Vector3.TransformNormalFromFloatsToRef(
      nor[i * 3],
      nor[i * 3 + 1],
      nor[i * 3 + 2],
      wm,
      scratchN,
    );
    const ny = scratchN.y / (scratchN.length() || 1);
    let k = 1;
    if (ny < -0.7) k = 0.9;
    else if (onFloor && ny < 0.7) {
      const h = wy[i] - minY;
      if (h < AO_REACH) k = 0.8 + (0.2 * h) / AO_REACH;
    }
    out[i] = k;
    if (k < 1) any = true;
  }
  return any ? out : null;
}

export class ArtBatcher extends MeshBatcher {
  private readonly sc: Scene;
  private readonly rand: () => number;
  private n = 0;
  /** Albedo jitter amplitude (0.04 = ±4 % luminance) for the next pieces. */
  jitter = 0.035;
  /** Hue drift amplitude (warm ↔ cool) relative to `jitter`. */
  hue = 0.35;
  /** Random world-UV offset per piece (boards, panels). */
  uvJitter = true;
  /**
   * Explicit vertex colour (linear multipliers) for the next pieces, used
   * with the white "paint" materials (books, mugs): many colours, one draw.
   * Null → random jitter.
   */
  paint: [number, number, number] | null = null;

  constructor(scene: Scene, materials: Materials, name: string, seed = 1) {
    super(scene, materials, name);
    this.sc = scene;
    this.rand = rng(seed ^ hashString(name));
  }

  override add(m: SurfaceKey | Material, mesh: Mesh, keepUVs = false): Mesh {
    mesh.computeWorldMatrix(true);
    if (!keepUVs) applyWorldUVs(mesh, this.uvJitter ? this.rand() * 7.3 : 0);
    const nv = mesh.getTotalVertices();
    const l = (this.rand() * 2 - 1) * this.jitter;
    const hshift = (this.rand() * 2 - 1) * this.jitter * this.hue;
    const p = this.paint;
    const r = p ? p[0] * (1 + l) : 1 + l + hshift;
    const g = p ? p[1] * (1 + l) : 1 + l;
    const b = p ? p[2] * (1 + l) : 1 + l - hshift;
    const cols = new Float32Array(nv * 4);
    const ao = this.vertexAO ? vertexAO(mesh) : null;
    for (let i = 0; i < nv; i++) {
      const k = ao ? ao[i] : 1;
      cols[i * 4] = r * k;
      cols[i * 4 + 1] = g * k;
      cols[i * 4 + 2] = b * k;
      cols[i * 4 + 3] = 1;
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, cols, false);
    return super.add(m, mesh, true);
  }

  /** Bake contact / underside occlusion into the vertex colours. */
  vertexAO = true;

  /** Cylinders get world-metre UVs too (true texture scale on round tops). */
  override cylinder(
    m: SurfaceKey | Material,
    c: V3,
    height: number,
    diameterTop: number,
    diameterBottom = diameterTop,
    tessellation = 20,
    opts: BoxOpts = {},
  ): Mesh {
    return super.cylinder(
      m,
      c,
      height,
      diameterTop,
      diameterBottom,
      tessellation,
      {
        ...opts,
        keepUVs: opts.keepUVs ?? false,
      },
    );
  }

  /** Add a prepared mesh as-is (keeps its UVs and vertex colours). */
  addRaw(m: SurfaceKey | Material, mesh: Mesh): Mesh {
    return super.add(m, mesh, true);
  }

  /** Rounded box (centre, size, edge radius). */
  rbox(m: SurfaceKey | Material, c: V3, s: V3, opts: ArtOpts = {}): Mesh {
    const r = opts.r ?? 0.006;
    if (r <= 0) return this.box(m, c, s, opts);
    const mesh = new Mesh(`${this.n++}:rb`, this.sc);
    roundedBoxData(s.x, s.y, s.z, r, opts.seg ?? 1).applyToMesh(mesh);
    mesh.position.set(c.x, c.y, c.z);
    mesh.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, opts.roll ?? 0);
    return this.add(m, mesh, opts.keepUVs);
  }

  /** Ring-sector slab centred at `c` (see arcSlabData). */
  arc(
    m: SurfaceKey | Material,
    c: V3,
    r0: number,
    r1: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
    segments = 24,
    opts: BoxOpts = {},
  ): Mesh {
    const mesh = new Mesh(`${this.n++}:arc`, this.sc);
    arcSlabData(r0, r1, a0, a1, y0, y1, segments).applyToMesh(mesh);
    mesh.position.set(c.x, c.y, c.z);
    mesh.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, opts.roll ?? 0);
    return this.add(m, mesh, opts.keepUVs);
  }

  /**
   * A run of slats (boards) along `axis`, each `bw` wide with `gap` between,
   * covering [a0, a1]. `place(a, len)` maps the along-axis centre to a box.
   */
  slats(
    m: SurfaceKey | Material,
    a0: number,
    a1: number,
    bw: number,
    gap: number,
    put: (a: number) => { c: V3; s: V3 },
    r = 0.003,
  ): number {
    const pitch = bw + gap;
    const n = Math.max(1, Math.floor((a1 - a0 + gap) / pitch));
    const start = a0 + (a1 - a0 - (n * pitch - gap)) / 2 + bw / 2;
    for (let i = 0; i < n; i++) {
      const { c, s } = put(start + i * pitch);
      this.rbox(m, c, s, { r });
    }
    return n;
  }
}
