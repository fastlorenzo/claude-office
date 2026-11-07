/**
 * Thin-instance batching for desk monitors, shared by every room.
 *
 *  - bodies   (bezel + back + stand, one merged mesh per distinct monitor size
 *              class): all monitors of a class are ONE draw call.
 *  - statics  (a unit plane with a shared dim emissive material, "off" or
 *              "idle"): what a monitor shows while it is not live (far / not
 *              visible). Live monitors keep their own textured plane.
 *
 * Instances are keyed by an opaque id; adding / removing / toggling only marks
 * the set dirty, and the GPU buffer is rebuilt once per `flush()`.
 */

import {
  CreatePlane,
  Matrix,
  Mesh,
  Scene,
  type StandardMaterial,
} from "../babylon";
import { buildMonitorBody, sharedScreenMaterial } from "./canvasKit";

export type StaticKind = "off" | "idle";

export interface MonitorPlacement {
  position: { x: number; y: number; z: number };
  yaw: number;
  width: number;
  height: number;
  /** Distance from the screen's bottom edge to the desk top. */
  drop: number;
}

/** A growable set of thin instances of one mesh. */
class InstanceSet {
  private readonly items = new Map<number, Float32Array>();
  private dirty = false;
  private cap = 0;
  private buf = new Float32Array(0);

  constructor(readonly mesh: Mesh) {
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.setEnabled(false);
    mesh.thinInstanceSetBuffer("matrix", this.buf, 16, false);
  }

  set(id: number, m: Float32Array): void {
    this.items.set(id, m);
    this.dirty = true;
  }

  remove(id: number): void {
    if (this.items.delete(id)) this.dirty = true;
  }

  has(id: number): boolean {
    return this.items.has(id);
  }

  get size(): number {
    return this.items.size;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.items.size;
    if (n > this.cap) {
      this.cap = Math.max(16, n * 2);
      this.buf = new Float32Array(this.cap * 16);
    }
    let i = 0;
    for (const m of this.items.values()) this.buf.set(m, 16 * i++);
    this.mesh.thinInstanceSetBuffer("matrix", this.buf, 16, false);
    this.mesh.thinInstanceCount = n;
    this.mesh.setEnabled(n > 0);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}

const batches = new WeakMap<Scene, MonitorBatch>();

export class MonitorBatch {
  private readonly bodies = new Map<string, InstanceSet>();
  private readonly statics: Record<StaticKind, InstanceSet>;
  private nextId = 1;
  private readonly body = new Map<number, { key: string; m: Float32Array }>();
  private readonly screen = new Map<
    number,
    { kind: StaticKind; m: Float32Array }
  >();

  static get(scene: Scene): MonitorBatch {
    let b = batches.get(scene);
    if (!b) {
      b = new MonitorBatch(scene);
      batches.set(scene, b);
      scene.onDisposeObservable.addOnce(() => batches.delete(scene));
    }
    return b;
  }

  private constructor(private readonly scene: Scene) {
    const mk = (kind: StaticKind): InstanceSet => {
      const plane = CreatePlane(
        `monStatic_${kind}`,
        { width: 1, height: 1 },
        scene,
      );
      plane.material = sharedScreenMaterial(
        scene,
        kind === "idle" ? "screenIdle" : "screenOff",
      ) as StandardMaterial;
      return new InstanceSet(plane);
    };
    this.statics = { off: mk("off"), idle: mk("idle") };
  }

  /** Register a monitor; returns its id. Nothing is drawn until `showBody`. */
  register(p: MonitorPlacement): number {
    const id = this.nextId++;
    const R = Matrix.RotationY(p.yaw);
    const T = Matrix.Translation(p.position.x, p.position.y, p.position.z);
    // Screen plane: faces +Z in monitor space, 0.6 mm in front of the bezel.
    const screen = Matrix.Scaling(p.width, p.height, 1)
      .multiply(Matrix.RotationY(Math.PI))
      .multiply(Matrix.Translation(0, 0, 0.0006))
      .multiply(R)
      .multiply(T);
    this.screen.set(id, {
      kind: "off",
      m: Float32Array.from(screen.asArray()),
    });
    const key = `${p.width.toFixed(3)}|${p.height.toFixed(3)}|${p.drop.toFixed(3)}`;
    let set = this.bodies.get(key);
    if (!set) {
      set = new InstanceSet(
        buildMonitorBody(
          `monBody_${key}`,
          this.scene,
          p.width,
          p.height,
          p.drop,
        ),
      );
      this.bodies.set(key, set);
    }
    this.body.set(id, {
      key,
      m: Float32Array.from(R.multiply(T).asArray()),
    });
    return id;
  }

  unregister(id: number): void {
    const b = this.body.get(id);
    if (b) this.bodies.get(b.key)?.remove(id);
    this.body.delete(id);
    for (const s of Object.values(this.statics)) s.remove(id);
    this.screen.delete(id);
  }

  showBody(id: number, on: boolean): void {
    const b = this.body.get(id);
    if (!b) return;
    const set = this.bodies.get(b.key);
    if (!set) return;
    if (on) {
      if (!set.has(id)) set.set(id, b.m);
    } else set.remove(id);
  }

  /** Show the monitor's static (non-live) screen: "off", "idle" or none. */
  showStatic(id: number, kind: StaticKind | null): void {
    const s = this.screen.get(id);
    if (!s) return;
    for (const k of ["off", "idle"] as const) {
      if (k === kind) {
        if (!this.statics[k].has(id)) this.statics[k].set(id, s.m);
      } else this.statics[k].remove(id);
    }
  }

  flush(): void {
    for (const s of this.bodies.values()) s.flush();
    for (const s of Object.values(this.statics)) s.flush();
  }

  /** Meshes to add to feed-camera render lists. */
  meshes(): Mesh[] {
    return [
      ...[...this.bodies.values()].map((s) => s.mesh),
      this.statics.off.mesh,
      this.statics.idle.mesh,
    ];
  }

  /** Draw-call accounting for debugging. */
  stats(): { bodies: number; statics: number } {
    let bodies = 0;
    for (const s of this.bodies.values()) if (s.size > 0) bodies++;
    return {
      bodies,
      statics:
        (this.statics.off.size > 0 ? 1 : 0) +
        (this.statics.idle.size > 0 ? 1 : 0),
    };
  }

  /** Materials are shared / owned by canvasKit; only meshes are disposed. */
  dispose(): void {
    for (const s of this.bodies.values()) s.dispose();
    for (const s of Object.values(this.statics)) s.dispose();
    this.bodies.clear();
    batches.delete(this.scene);
  }
}
