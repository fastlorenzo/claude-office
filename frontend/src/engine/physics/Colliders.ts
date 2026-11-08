/**
 * Static collider proxies.
 *
 * Every wall / floor / glass pane / furniture piece gets an invisible box or
 * cylinder mesh tagged `metadata.staticCollider = true`. With Havok, each proxy
 * gets a STATIC `PhysicsBody` whose shape is shared per distinct size; without
 * Havok the proxies use `checkCollisions` for the `moveWithCollisions`
 * fallback. The same proxies serve the third-person camera boom ray and the
 * interaction occlusion test.
 */
import {
  CreateBox,
  CreateCylinder,
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShape,
  PhysicsShapeBox,
  PhysicsShapeCylinder,
  Quaternion,
  Scene,
  Vector3,
} from "@/engine/babylon";

export interface ColliderMeta {
  staticCollider: true;
  /** Glass: blocks movement but not sight (interaction ray). */
  seeThrough?: boolean;
}

/** Anything that accepts collider boxes (Colliders, or a local-frame adaptor). */
export interface ColliderSink {
  addBox(
    group: string,
    center: Vector3,
    size: Vector3,
    yaw?: number,
    opts?: ColliderBoxOpts,
  ): unknown;
}

export interface ColliderBoxOpts {
  seeThrough?: boolean;
  /** Tilt about the box's local X axis after yaw (ramps): + lowers its +Z end. */
  pitch?: number;
}

/** Wraps a sink so boxes are given in a local frame (origin + yaw). */
export function framedSink(
  sink: ColliderSink,
  origin: Vector3,
  frameYaw: number,
): ColliderSink {
  const c = Math.cos(frameYaw);
  const s = Math.sin(frameYaw);
  return {
    addBox: (group, center, size, yaw = 0, opts) =>
      sink.addBox(
        group,
        new Vector3(
          origin.x + center.x * c + center.z * s,
          origin.y + center.y,
          origin.z - center.x * s + center.z * c,
        ),
        size,
        frameYaw + yaw,
        opts,
      ),
  };
}

/** The registry of each scene (one per World), for code without a handle. */
const registries = new WeakMap<Scene, Colliders>();

export class Colliders implements ColliderSink {
  private readonly groups = new Map<
    string,
    { meshes: Mesh[]; bodies: PhysicsBody[] }
  >();
  private readonly shapes = new Map<string, PhysicsShape>();
  private physics = false;
  /** Opaque proxies (sight blockers), rebuilt lazily after any change. */
  private occluderCache: Mesh[] | null = null;

  constructor(private readonly scene: Scene) {
    registries.set(scene, this);
  }

  /** The scene's collider registry (null before the World made one). */
  static of(scene: Scene): Colliders | null {
    return registries.get(scene) ?? null;
  }

  /**
   * Every opaque (not see-through) proxy: the list an occlusion ray tests
   * instead of `scene.pick` walking every mesh of the scene (P10).
   */
  occluders(): readonly Mesh[] {
    if (!this.occluderCache) {
      const out: Mesh[] = [];
      for (const g of this.groups.values())
        for (const m of g.meshes)
          if (!(m.metadata as ColliderMeta).seeThrough) out.push(m);
      this.occluderCache = out;
    }
    return this.occluderCache;
  }

  /** Switch to Havok bodies (call before adding colliders). */
  enablePhysics(on: boolean): void {
    this.physics = on;
  }

  get physicsEnabled(): boolean {
    return this.physics;
  }

  addBox(
    group: string,
    center: Vector3,
    size: Vector3,
    yaw = 0,
    opts: ColliderBoxOpts = {},
  ): Mesh {
    const sx = Math.max(0.02, size.x);
    const sy = Math.max(0.02, size.y);
    const sz = Math.max(0.02, size.z);
    const mesh = CreateBox(
      `col:${group}`,
      { width: sx, height: sy, depth: sz },
      this.scene,
    );
    mesh.position.copyFrom(center);
    mesh.rotation.y = yaw;
    mesh.rotation.x = opts.pitch ?? 0;
    this.finish(group, mesh, opts, () => {
      const key = `b:${sx.toFixed(3)}:${sy.toFixed(3)}:${sz.toFixed(3)}`;
      let shape = this.shapes.get(key);
      if (!shape) {
        shape = new PhysicsShapeBox(
          Vector3.Zero(),
          Quaternion.Identity(),
          new Vector3(sx, sy, sz),
          this.scene,
        );
        this.shapes.set(key, shape);
      }
      return shape;
    });
    return mesh;
  }

  addCylinder(
    group: string,
    center: Vector3,
    radius: number,
    height: number,
  ): Mesh {
    const r = Math.max(0.05, radius);
    const h = Math.max(0.05, height);
    const mesh = CreateCylinder(
      `col:${group}`,
      { diameter: r * 2, height: h, tessellation: 12 },
      this.scene,
    );
    mesh.position.copyFrom(center);
    this.finish(group, mesh, {}, () => {
      const key = `c:${r.toFixed(3)}:${h.toFixed(3)}`;
      let shape = this.shapes.get(key);
      if (!shape) {
        shape = new PhysicsShapeCylinder(
          new Vector3(0, -h / 2, 0),
          new Vector3(0, h / 2, 0),
          r,
          this.scene,
        );
        this.shapes.set(key, shape);
      }
      return shape;
    });
    return mesh;
  }

  private finish(
    group: string,
    mesh: Mesh,
    opts: { seeThrough?: boolean },
    shape: () => PhysicsShape,
  ): void {
    mesh.isVisible = false;
    mesh.isPickable = false;
    const meta: ColliderMeta = {
      staticCollider: true,
      seeThrough: opts.seeThrough,
    };
    mesh.metadata = meta;
    // Bounds synced once with the final matrix, then never again (static;
    // P10): the per-frame active-mesh pass skips the bounding update.
    mesh.doNotSyncBoundingInfo = false;
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    this.occluderCache = null;
    let g = this.groups.get(group);
    if (!g) {
      g = { meshes: [], bodies: [] };
      this.groups.set(group, g);
    }
    g.meshes.push(mesh);
    if (this.physics) {
      const body = new PhysicsBody(
        mesh,
        PhysicsMotionType.STATIC,
        false,
        this.scene,
      );
      body.shape = shape();
      g.bodies.push(body);
    } else {
      mesh.checkCollisions = true;
    }
  }

  disposeGroup(group: string): void {
    const g = this.groups.get(group);
    if (!g) return;
    this.occluderCache = null;
    for (const b of g.bodies) b.dispose();
    for (const m of g.meshes) m.dispose();
    this.groups.delete(group);
  }

  dispose(): void {
    for (const k of [...this.groups.keys()]) this.disposeGroup(k);
    for (const s of this.shapes.values()) s.dispose();
    this.shapes.clear();
    if (registries.get(this.scene) === this) registries.delete(this.scene);
  }
}

export function isStaticCollider(meta: unknown): meta is ColliderMeta {
  return (
    !!meta &&
    typeof meta === "object" &&
    (meta as ColliderMeta).staticCollider === true
  );
}
