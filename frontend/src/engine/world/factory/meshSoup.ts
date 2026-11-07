/**
 * Tiny geometry accumulator: boxes / cylinders / quads with per-primitive
 * vertex colours, merged into ONE VertexData (one draw per material).
 */
import { Mesh, Scene, VertexBuffer, VertexData } from "@/engine/babylon";

export type RGBA = readonly [number, number, number, number];

/** "#rrggbb" -> linear RGBA (vertex colours are not gamma-decoded by Babylon). */
export function hexColor(hex: string, a = 1): RGBA {
  const v = hex.replace("#", "");
  const c = (i: number) => Math.pow(parseInt(v.slice(i, i + 2), 16) / 255, 2.2);
  return [c(0), c(2), c(4), a];
}

export class MeshSoup {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  get empty(): boolean {
    return this.indices.length === 0;
  }

  private vert(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: RGBA,
  ): number {
    const i = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.colors.push(c[0], c[1], c[2], c[3]);
    return i;
  }

  /** Quad from 4 corners (CCW seen from the normal side). */
  quad(
    p: readonly [number, number, number][],
    n: readonly [number, number, number],
    c: RGBA,
  ): void {
    const a = p.map((q) => this.vert(q[0], q[1], q[2], n[0], n[1], n[2], c));
    this.indices.push(a[0], a[1], a[2], a[0], a[2], a[3]);
  }

  /** Axis-aligned box by centre + size; optional yaw about the box centre. */
  box(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    c: RGBA,
    yaw = 0,
  ): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const T = (x: number, y: number, z: number): [number, number, number] => [
      cx + x * cs + z * sn,
      cy + y,
      cz - x * sn + z * cs,
    ];
    const N = (x: number, y: number, z: number): [number, number, number] => [
      x * cs + z * sn,
      y,
      -x * sn + z * cs,
    ];
    // +x
    this.quad(
      [T(hx, -hy, hz), T(hx, -hy, -hz), T(hx, hy, -hz), T(hx, hy, hz)],
      N(1, 0, 0),
      c,
    );
    // -x
    this.quad(
      [T(-hx, -hy, -hz), T(-hx, -hy, hz), T(-hx, hy, hz), T(-hx, hy, -hz)],
      N(-1, 0, 0),
      c,
    );
    // +y
    this.quad(
      [T(-hx, hy, hz), T(hx, hy, hz), T(hx, hy, -hz), T(-hx, hy, -hz)],
      N(0, 1, 0),
      c,
    );
    // -y
    this.quad(
      [T(-hx, -hy, -hz), T(hx, -hy, -hz), T(hx, -hy, hz), T(-hx, -hy, hz)],
      N(0, -1, 0),
      c,
    );
    // +z
    this.quad(
      [T(-hx, -hy, hz), T(hx, -hy, hz), T(hx, hy, hz), T(-hx, hy, hz)],
      N(0, 0, 1),
      c,
    );
    // -z
    this.quad(
      [T(hx, -hy, -hz), T(-hx, -hy, -hz), T(-hx, hy, -hz), T(hx, hy, -hz)],
      N(0, 0, -1),
      c,
    );
  }

  /** Box between two floor-space extents (min/max corners). */
  span(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    c: RGBA,
  ): void {
    this.box(
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      (z0 + z1) / 2,
      x1 - x0,
      y1 - y0,
      z1 - z0,
      c,
    );
  }

  /** Triangle whose winding is auto-oriented to face `n`. */
  tri(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    n: readonly [number, number, number],
    col: RGBA,
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const ia = this.vert(a[0], a[1], a[2], n[0], n[1], n[2], col);
    const ib = this.vert(b[0], b[1], b[2], n[0], n[1], n[2], col);
    const ic = this.vert(c[0], c[1], c[2], n[0], n[1], n[2], col);
    if (flip) this.indices.push(ia, ic, ib);
    else this.indices.push(ia, ib, ic);
  }

  /**
   * Extrude a star-shaped (z,y) side profile across x0..x1 (flat shaded):
   * side caps as a centroid fan, one quad per profile edge.
   */
  prismZY(
    profile: readonly (readonly [number, number])[],
    x0: number,
    x1: number,
    col: RGBA,
  ): void {
    const n = profile.length;
    let cz = 0;
    let cy = 0;
    for (const [z, y] of profile) {
      cz += z / n;
      cy += y / n;
    }
    for (const [x, nx] of [
      [x0, -1],
      [x1, 1],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const a = profile[i];
        const b = profile[(i + 1) % n];
        this.tri(
          [x, a[1], a[0]],
          [x, b[1], b[0]],
          [x, cy, cz],
          [nx, 0, 0],
          col,
        );
      }
    }
    for (let i = 0; i < n; i++) {
      const a = profile[i];
      const b = profile[(i + 1) % n];
      const dz = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dz, dy) || 1;
      // Outward normal: away from the centroid.
      let ny = dz / len;
      let nz = -dy / len;
      const mz = (a[0] + b[0]) / 2 - cz;
      const my = (a[1] + b[1]) / 2 - cy;
      if (ny * my + nz * mz < 0) {
        ny = -ny;
        nz = -nz;
      }
      this.quadAuto(
        [
          [x0, a[1], a[0]],
          [x1, a[1], a[0]],
          [x1, b[1], b[0]],
          [x0, b[1], b[0]],
        ],
        [0, ny, nz],
        col,
      );
    }
  }

  /** Quad with winding auto-oriented to face `n`. */
  quadAuto(
    p: readonly [number, number, number][],
    n: readonly [number, number, number],
    c: RGBA,
  ): void {
    this.tri(p[0], p[1], p[2], n, c);
    this.tri(p[0], p[2], p[3], n, c);
  }

  /** Cylinder along an axis ("x" | "y" | "z"), smooth sides + caps. */
  cyl(
    axis: "x" | "y" | "z",
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    c: RGBA,
    seg = 14,
  ): void {
    const map = (u: number, v: number, w: number): [number, number, number] =>
      axis === "y"
        ? [cx + u, cy + w, cz + v]
        : axis === "x"
          ? [cx + w, cy + u, cz + v]
          : [cx + u, cy + v, cz + w];
    const flip = axis === "y";
    const hl = length / 2;
    const ring: number[][] = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const u = Math.cos(a);
      const v = Math.sin(a);
      const p0 = map(u * radius, v * radius, -hl);
      const p1 = map(u * radius, v * radius, hl);
      const n = map(u, v, 0).map((q, i) => q - [cx, cy, cz][i]);
      ring.push([
        this.vert(p0[0], p0[1], p0[2], n[0], n[1], n[2], c),
        this.vert(p1[0], p1[1], p1[2], n[0], n[1], n[2], c),
      ]);
    }
    for (let s = 0; s < seg; s++) {
      const [a0, a1] = ring[s];
      const [b0, b1] = ring[s + 1];
      if (flip) this.indices.push(a0, b1, b0, a0, a1, b1);
      else this.indices.push(a0, b0, b1, a0, b1, a1);
    }
    for (const sign of [-1, 1]) {
      const nn = map(0, 0, sign).map((q, i) => q - [cx, cy, cz][i]);
      const cc = map(0, 0, sign * hl);
      const ci = this.vert(cc[0], cc[1], cc[2], nn[0], nn[1], nn[2], c);
      const rim: number[] = [];
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const p = map(Math.cos(a) * radius, Math.sin(a) * radius, sign * hl);
        rim.push(this.vert(p[0], p[1], p[2], nn[0], nn[1], nn[2], c));
      }
      for (let s = 0; s < seg; s++) {
        const fwd = sign > 0 !== flip;
        if (fwd) this.indices.push(ci, rim[s], rim[s + 1]);
        else this.indices.push(ci, rim[s + 1], rim[s]);
      }
    }
  }

  /** Build a Mesh (no material); null when empty. */
  build(name: string, scene: Scene): Mesh | null {
    if (this.empty) return null;
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.colors = this.colors;
    // Babylon's front face is the opposite winding of the right-hand cross
    // product the primitives above are authored with: flip on build.
    const ix = this.indices.slice();
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
    vd.indices = ix;
    vd.applyToMesh(m);
    m.isPickable = false;
    m.hasVertexAlpha = false;
    void VertexBuffer;
    return m;
  }
}
