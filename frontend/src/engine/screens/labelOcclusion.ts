/**
 * Line-of-sight test for floating labels (U10): every opaque collider proxy
 * in the registry (walls, slabs, furniture; glass is `seeThrough`) blocks, so
 * a label never shows through a wall or a desk. Run at a low rate by
 * LabelLayer (OCCLUSION_PERIOD).
 */

import { Ray, Vector3, type AbstractMesh, type Scene } from "../babylon";
import { Colliders } from "../physics/Colliders";

export const TALL_M = 2.2;
const REFRESH_MS = 1500;

interface ColliderMeta {
  staticCollider?: boolean;
  seeThrough?: boolean;
}

/** Pure: does the segment (a -> b) cross the AABB (slab test)? */
export function segmentHitsBox(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes = ["x", "y", "z"] as const;
  for (const k of axes) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < min[k] || a[k] > max[k]) return false;
      continue;
    }
    let tn = (min[k] - a[k]) / d;
    let tf = (max[k] - a[k]) / d;
    if (tn > tf) [tn, tf] = [tf, tn];
    t0 = Math.max(t0, tn);
    t1 = Math.min(t1, tf);
    if (t0 > t1) return false;
  }
  return true;
}

function inBox(
  p: Vector3,
  bb: { minimumWorld: Vector3; maximumWorld: Vector3 },
): boolean {
  const lo = bb.minimumWorld;
  const hi = bb.maximumWorld;
  return (
    p.x > lo.x &&
    p.x < hi.x &&
    p.y > lo.y &&
    p.y < hi.y &&
    p.z > lo.z &&
    p.z < hi.z
  );
}

export class StaticOccluders {
  private list: readonly AbstractMesh[] = [];
  private lastRefresh = -Infinity;
  private lastCount = -1;
  private readonly ray = new Ray(Vector3.Zero(), Vector3.Forward(), 1);
  private readonly dir = new Vector3();

  constructor(private readonly scene: Scene) {}

  /**
   * The collider registry's opaque list (`Colliders.of(scene).occluders()`,
   * walls, slabs, furniture; glass excluded), cached by the registry itself.
   * Without a registry (tests), a throttled filter of tall static colliders.
   */
  private refresh(): void {
    const reg = Colliders.of(this.scene);
    if (reg) {
      this.list = reg.occluders();
      return;
    }
    const now = performance.now();
    const n = this.scene.meshes.length;
    if (now - this.lastRefresh < REFRESH_MS && n === this.lastCount) return;
    this.lastRefresh = now;
    this.lastCount = n;
    this.list = this.scene.meshes.filter((m) => {
      const meta = m.metadata as ColliderMeta | null;
      if (!meta || meta.staticCollider !== true || meta.seeThrough)
        return false;
      const bb = m.getBoundingInfo().boundingBox;
      return bb.maximumWorld.y - bb.minimumWorld.y >= TALL_M;
    });
  }

  /** True when solid architecture blocks the segment from -> to. */
  blocked(from: Vector3, to: Vector3): boolean {
    this.refresh();
    to.subtractToRef(from, this.dir);
    const len = this.dir.length();
    if (len < 0.3) return false;
    this.ray.origin.copyFrom(from);
    this.ray.direction.copyFrom(this.dir).scaleInPlace(1 / len);
    this.ray.length = len - 0.15;
    for (const m of this.list) {
      if (m.isDisposed() || !m.isEnabled(false)) continue;
      const bb = m.getBoundingInfo().boundingBox;
      if (!segmentHitsBox(from, to, bb.minimumWorld, bb.maximumWorld)) continue;
      // An endpoint inside the proxy (a label anchored in a desk's volume)
      // is not blocked by it.
      if (inBox(from, bb) || inBox(to, bb)) continue;
      const hit = this.ray.intersectsMesh(m, true);
      if (hit.hit && hit.distance < len - 0.15) return true;
    }
    return false;
  }
}
