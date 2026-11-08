/**
 * Test helpers for collider geometry: a recording ColliderSink, the top
 * surface height under a point (vertical ray against the oriented boxes, the
 * same yaw → pitch order Colliders.addBox uses), and a capsule clearance test
 * on a plan grid (flood fills).
 */
import { Matrix, Quaternion, Vector3 } from "@/engine/babylon";
import type { ColliderBoxOpts, ColliderSink } from "@/engine/physics/Colliders";

export interface RecBox {
  group: string;
  c: Vector3;
  s: Vector3;
  yaw: number;
  pitch: number;
  see: boolean;
  inv: Matrix;
}

export function recorder(): { sink: ColliderSink; boxes: RecBox[] } {
  const boxes: RecBox[] = [];
  const sink: ColliderSink = {
    addBox: (group, c, s, yaw = 0, o?: ColliderBoxOpts) => {
      const pitch = o?.pitch ?? 0;
      const m = Matrix.Compose(
        new Vector3(s.x, s.y, s.z),
        Quaternion.RotationYawPitchRoll(yaw, pitch, 0),
        c.clone(),
      );
      boxes.push({
        group,
        c: c.clone(),
        s: s.clone(),
        yaw,
        pitch,
        see: !!o?.seeThrough,
        inv: Matrix.Invert(m),
      });
      return undefined;
    },
  };
  return { sink, boxes };
}

/** Entry distance of a ray (local unit-box space) into [-0.5, 0.5]³, or null. */
function slab(o: Vector3, d: Vector3): number | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < -0.5 || o[k] > 0.5) return null;
      continue;
    }
    let a = (-0.5 - o[k]) / d[k];
    let b = (0.5 - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : Math.max(0, t0);
}

/** Highest collider surface at (x, z) below `fromY` (null: nothing below). */
export function surfaceY(
  boxes: readonly RecBox[],
  x: number,
  z: number,
  fromY = 50,
): number | null {
  let best: number | null = null;
  const o = new Vector3(x, fromY, z);
  const d = new Vector3(0, -1, 0);
  for (const b of boxes) {
    const lo = Vector3.TransformCoordinates(o, b.inv);
    const ld = Vector3.TransformNormal(d, b.inv);
    const t = slab(lo, ld);
    if (t === null) continue;
    // Local t is in the same units as the world ray (direction transformed
    // by the inverse matrix, not normalised).
    const y = fromY - t;
    if (best === null || y > best) best = y;
  }
  return best;
}

/**
 * Can a standing capsule (radius r) occupy (x, z) on a floor at `floorY`?
 * Obstacles are boxes reaching into [floorY + step, floorY + head] whose
 * plan footprint (yawed rectangle; pitched boxes use their AABB) lies within
 * `r` of the point.
 */
export function blocked(
  boxes: readonly RecBox[],
  x: number,
  z: number,
  floorY: number,
  r = 0.35,
  step = 0.3,
  head = 1.75,
): boolean {
  for (const b of boxes) {
    if (b.pitch !== 0) {
      // Conservative: the AABB of the tilted box.
      const hy =
        (Math.abs(Math.cos(b.pitch)) * b.s.y) / 2 +
        (Math.abs(Math.sin(b.pitch)) * b.s.z) / 2;
      const hz =
        (Math.abs(Math.sin(b.pitch)) * b.s.y) / 2 +
        (Math.abs(Math.cos(b.pitch)) * b.s.z) / 2;
      if (b.c.y + hy < floorY + step || b.c.y - hy > floorY + head) continue;
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      const hx2 = Math.abs(c) * (b.s.x / 2) + Math.abs(s) * hz;
      const hz2 = Math.abs(s) * (b.s.x / 2) + Math.abs(c) * hz;
      const dx = Math.max(0, Math.abs(x - b.c.x) - hx2);
      const dz = Math.max(0, Math.abs(z - b.c.z) - hz2);
      if (dx * dx + dz * dz < r * r) return true;
      continue;
    }
    if (b.c.y + b.s.y / 2 < floorY + step) continue;
    if (b.c.y - b.s.y / 2 > floorY + head) continue;
    // Into the box frame (yaw turns local +Z to (sin, cos)).
    const px = x - b.c.x;
    const pz = z - b.c.z;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const lx = px * c - pz * s;
    const lz = px * s + pz * c;
    const dx = Math.max(0, Math.abs(lx) - b.s.x / 2);
    const dz = Math.max(0, Math.abs(lz) - b.s.z / 2);
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
