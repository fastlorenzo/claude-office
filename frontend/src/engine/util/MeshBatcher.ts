/**
 * Collects primitive meshes per material and merges them into one mesh per
 * material on `build()` — the main draw-call reducer for static architecture
 * and procedural props. UVs are projected in world metres before merging so
 * tiled PBR textures keep a uniform scale.
 */
import {
  CreateBox,
  CreateCylinder,
  CreateSphere,
  Mesh,
  Scene,
  TransformNode,
  Vector3,
  type Material,
} from "@/engine/babylon";
import {
  applyWorldUVs,
  type Materials,
  type SurfaceKey,
} from "@/engine/materials/Materials";

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface BoxOpts {
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** Skip world UV projection (keeps builder UVs). */
  keepUVs?: boolean;
}

export class MeshBatcher {
  private readonly buckets = new Map<Material, Mesh[]>();
  private count = 0;

  constructor(
    private readonly scene: Scene,
    readonly materials: Materials,
    private readonly name: string,
  ) {}

  private mat(m: SurfaceKey | Material): Material {
    return typeof m === "string" ? this.materials.get(m) : m;
  }

  add(m: SurfaceKey | Material, mesh: Mesh, keepUVs = false): Mesh {
    const material = this.mat(m);
    mesh.computeWorldMatrix(true);
    if (!keepUVs) applyWorldUVs(mesh);
    mesh.material = material;
    let list = this.buckets.get(material);
    if (!list) {
      list = [];
      this.buckets.set(material, list);
    }
    list.push(mesh);
    this.count += 1;
    return mesh;
  }

  /** Axis-aligned (optionally rotated) box centred at `c` with size `s`. */
  box(m: SurfaceKey | Material, c: V3, s: V3, opts: BoxOpts = {}): Mesh {
    const mesh = CreateBox(
      `${this.name}:b${this.count}`,
      { width: s.x, height: s.y, depth: s.z },
      this.scene,
    );
    mesh.position.set(c.x, c.y, c.z);
    mesh.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, opts.roll ?? 0);
    return this.add(m, mesh, opts.keepUVs);
  }

  /** Box from min/max corners (axis aligned). */
  boxMinMax(m: SurfaceKey | Material, min: V3, max: V3): Mesh {
    return this.box(
      m,
      {
        x: (min.x + max.x) / 2,
        y: (min.y + max.y) / 2,
        z: (min.z + max.z) / 2,
      },
      { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    );
  }

  cylinder(
    m: SurfaceKey | Material,
    c: V3,
    height: number,
    diameterTop: number,
    diameterBottom = diameterTop,
    tessellation = 20,
    opts: BoxOpts = {},
  ): Mesh {
    const mesh = CreateCylinder(
      `${this.name}:c${this.count}`,
      { height, diameterTop, diameterBottom, tessellation },
      this.scene,
    );
    mesh.position.set(c.x, c.y, c.z);
    mesh.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, opts.roll ?? 0);
    return this.add(m, mesh, opts.keepUVs ?? true);
  }

  sphere(
    m: SurfaceKey | Material,
    c: V3,
    diameter: number,
    scale: V3 = { x: 1, y: 1, z: 1 },
    segments = 10,
  ): Mesh {
    const mesh = CreateSphere(
      `${this.name}:s${this.count}`,
      { diameter, segments },
      this.scene,
    );
    mesh.position.set(c.x, c.y, c.z);
    mesh.scaling.set(scale.x, scale.y, scale.z);
    mesh.bakeCurrentTransformIntoVertices();
    return this.add(m, mesh, true);
  }

  get size(): number {
    return this.count;
  }

  /**
   * Merge per material. Returns the merged meshes (world matrices frozen).
   * `parent` (optional) re-parents the result; positions are already world/model space.
   */
  build(
    opts: {
      parent?: TransformNode | null;
      receiveShadows?: boolean;
      pickable?: boolean;
    } = {},
  ): Mesh[] {
    const out: Mesh[] = [];
    for (const [material, list] of this.buckets) {
      for (const mesh of list) mesh.bakeCurrentTransformIntoVertices();
      const merged =
        list.length === 1 ? list[0] : Mesh.MergeMeshes(list, true, true);
      if (!merged) continue;
      merged.name = `${this.name}:${material.name}`;
      merged.material = material;
      merged.isPickable = opts.pickable ?? false;
      merged.receiveShadows = opts.receiveShadows ?? true;
      if (opts.parent) merged.parent = opts.parent;
      merged.computeWorldMatrix(true);
      merged.freezeWorldMatrix();
      merged.doNotSyncBoundingInfo = true;
      out.push(merged);
    }
    this.buckets.clear();
    this.count = 0;
    return out;
  }
}

export function v3(x: number, y: number, z: number): V3 {
  return { x, y, z };
}

export function toVector3(p: V3): Vector3 {
  return new Vector3(p.x, p.y, p.z);
}
