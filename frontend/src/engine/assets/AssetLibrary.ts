/**
 * AssetLibrary — loads each manifest model once and places copies of it.
 *
 * Batching: instead of one InstancedMesh hierarchy per placement, every model
 * is flattened at load time into "parts" (one mesh per glTF primitive, the
 * glTF node transforms and our normalisation baked into the vertices) and
 * every placement is a *thin instance* matrix on each part. All desks in the
 * building therefore cost one draw call per desk primitive, whatever the
 * number of rooms. Matrices are rebuilt lazily (`flush()` once per frame).
 *
 * Normalisation: the model's bounding box is centred on X/Z, rested on the
 * floor (min Y = 0), rotated by a per-role yaw so that the canonical "user
 * faces +Z" frame holds (see proceduralProps.ts), and optionally scaled to a
 * target size so props match the layout grid.
 *
 * Missing / broken glTF → procedural parts of the right size (same API).
 * Collider proxies (invisible boxes / cylinders) come from `Colliders`.
 */
import {
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
} from "@/engine/babylon";
import {
  ASSET_MANIFEST,
  modelPath,
  type ModelAsset,
  type ModelRole,
} from "@/engine/assets/manifest";
import {
  buildProceduralProp,
  PROCEDURAL_ROLES,
  type PropRole,
  type ProceduralRole,
} from "@/engine/assets/proceduralProps";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import type { Vec3 } from "@/engine/contracts";

interface RoleConfig {
  /** Extra yaw so the loaded model matches the canonical frame (user faces +Z). */
  yawOffset: number;
  /** Uniform scale to fit one axis of the bounding box (metres). */
  fit?: { axis: "x" | "y" | "z" | "maxXZ"; size: number };
  /** Non-uniform fit to an exact box (after yaw). Used for the oversized desk. */
  stretch?: { x: number; y: number; z: number };
}

/**
 * Tuned against the Poly Haven models (Blender front = -Y → Babylon +Z, so
 * props whose user stands in front of them need a half turn).
 */
const ROLE_CONFIG: Record<ModelRole, RoleConfig> = {
  desk: { yawOffset: Math.PI, stretch: { x: 1.4, y: 0.75, z: 0.72 } },
  chair: { yawOffset: 0, fit: { axis: "y", size: 0.98 } },
  sofa: { yawOffset: 0, fit: { axis: "maxXZ", size: 1.9 } },
  shelves: { yawOffset: Math.PI, fit: { axis: "y", size: 1.95 } },
  plant: { yawOffset: 0, fit: { axis: "y", size: 1.3 } },
  plantSmall: { yawOffset: 0, fit: { axis: "y", size: 0.3 } },
  plantTall: { yawOffset: 0, fit: { axis: "y", size: 0.95 } },
  coffeeCart: { yawOffset: Math.PI, fit: { axis: "maxXZ", size: 1.5 } },
  laptop: { yawOffset: Math.PI, fit: { axis: "maxXZ", size: 0.34 } },
  securityCamera: { yawOffset: 0 },
  projectorScreen: { yawOffset: 0 },
  notepads: { yawOffset: 0, fit: { axis: "maxXZ", size: 0.32 } },
  fireAlarm: { yawOffset: 0 },
  wetFloorSign: { yawOffset: 0 },
};

const PROCEDURAL_COLLIDERS: Record<
  ProceduralRole,
  "box" | "cylinder" | "none"
> = {
  workDesk: "box",
  execDesk: "box",
  taskChair: "cylinder",
  artPrint: "none",
  loungeTable: "cylinder",
};

export interface PlacementTransform {
  position: Vec3;
  yaw?: number;
  /** Extra scale on top of normalisation (uniform or per axis, model frame). */
  scale?: number | Vec3;
}

export interface PlaceOptions {
  /** Disposal group (e.g. "room:<sessionId>"). */
  group: string;
  /** Override the manifest collider kind. */
  collider?: "box" | "cylinder" | "none";
}

export interface Placement {
  readonly id: number;
  readonly role: PropRole;
  /** World-space AABB. */
  readonly bounds: { min: Vector3; max: Vector3; size: Vector3 };
  readonly fallback: boolean;
  dispose(): void;
}

interface ModelEntry {
  role: PropRole;
  parts: Mesh[];
  /** Normalised model-space size. */
  size: Vector3;
  fallback: boolean;
  placements: Map<number, { matrix: Matrix; group: string }>;
  dirty: boolean;
}

export class AssetLibrary {
  private readonly entries = new Map<PropRole, ModelEntry>();
  private loading: Promise<void> | null = null;
  private nextId = 1;
  private readonly groupIndex = new Map<
    string,
    Set<{ role: PropRole; id: number }>
  >();
  private readonly shadowCasterCbs: ((
    m: AbstractMesh,
    role: PropRole,
  ) => void)[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly materials: Materials,
    private readonly colliders: Colliders,
    private readonly assetBase: string,
  ) {}

  /** Register a callback that receives every part mesh with its role (shadow casters). */
  onPart(cb: (m: AbstractMesh, role: PropRole) => void): void {
    this.shadowCasterCbs.push(cb);
    for (const e of this.entries.values())
      for (const p of e.parts) cb(p, e.role);
  }

  /** Load every manifest model (tolerates 404s). Idempotent. */
  preload(): Promise<void> {
    if (!this.loading) {
      for (const role of PROCEDURAL_ROLES) {
        this.register(
          role,
          buildProceduralProp(this.scene, this.materials, role),
          { yawOffset: 0 },
          1,
          true,
        );
      }
      this.loading = Promise.all(
        ASSET_MANIFEST.models.map((m) => this.loadOne(m)),
      ).then(() => undefined);
    }
    return this.loading;
  }

  private async loadOne(asset: ModelAsset): Promise<void> {
    let parts: Mesh[] | null = null;
    const url = modelPath(asset.id, this.assetBase);
    const slash = url.lastIndexOf("/");
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) {
        const container = await LoadAssetContainerAsync(
          url.slice(slash + 1),
          this.scene,
          {
            rootUrl: url.slice(0, slash + 1),
          },
        );
        if (this.scene.isDisposed) {
          container.dispose();
          return;
        }
        parts = this.flatten(container.meshes, container.transformNodes, () => {
          container.addAllToScene();
        });
        for (const ag of container.animationGroups) ag.dispose();
        for (const m of container.materials) {
          if (m instanceof PBRMaterial) {
            m.maxSimultaneousLights = 4;
            m.freeze();
          }
        }
      }
    } catch (err) {
      if (this.scene.isDisposed) return;
      console.warn(`[assets] ${asset.id}: falling back to procedural`, err);
      parts = null;
    }
    if (this.scene.isDisposed) return;
    const fallback = !parts || parts.length === 0;
    if (fallback)
      parts = buildProceduralProp(this.scene, this.materials, asset.role);
    const cfg = fallback ? { yawOffset: 0 } : ROLE_CONFIG[asset.role];
    this.register(
      asset.role,
      parts!,
      cfg,
      fallback ? 1 : asset.scale,
      fallback,
    );
  }

  private register(
    role: PropRole,
    parts: Mesh[],
    cfg: RoleConfig,
    baseScale: number,
    fallback: boolean,
  ): void {
    const size = this.normalise(parts, cfg, baseScale);
    const entry: ModelEntry = {
      role,
      parts,
      size,
      fallback,
      placements: new Map(),
      dirty: true,
    };
    for (const p of entry.parts) {
      p.isPickable = false;
      p.receiveShadows = true;
      p.isVisible = false;
      p.alwaysSelectAsActiveMesh = false;
      for (const cb of this.shadowCasterCbs) cb(p, role);
    }
    // Placements requested before load completed are queued in `pending`.
    this.entries.set(role, entry);
    const queued = this.pending.get(role);
    if (queued) {
      for (const q of queued)
        this.commitPlacement(entry, q.id, q.matrix, q.group, q.collider);
      this.pending.delete(role);
    }
  }

  private readonly pending = new Map<
    PropRole,
    {
      id: number;
      matrix: Matrix;
      group: string;
      collider: "box" | "cylinder" | "none";
    }[]
  >();

  /** Bake node transforms into vertices so each primitive is a standalone part. */
  private flatten(
    meshes: AbstractMesh[],
    nodes: TransformNode[],
    addToScene: () => void,
  ): Mesh[] {
    addToScene();
    const parts: Mesh[] = [];
    for (const m of meshes) {
      if (!(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
      const world = m.computeWorldMatrix(true).clone();
      m.makeGeometryUnique();
      m.setParent(null);
      m.position.setAll(0);
      m.rotationQuaternion = null;
      m.rotation.setAll(0);
      m.scaling.setAll(1);
      m.bakeTransformIntoVertices(world);
      parts.push(m);
    }
    for (const m of meshes) if (!parts.includes(m as Mesh)) m.dispose();
    for (const n of nodes) n.dispose();
    return parts;
  }

  /** Centre + floor + yaw + fit, baked into the part vertices. Returns final size. */
  private normalise(
    parts: Mesh[],
    cfg: RoleConfig,
    baseScale: number,
  ): Vector3 {
    const { min, max } = boundsOf(parts);
    const raw = max.subtract(min);
    const rotated = Math.abs(Math.sin(cfg.yawOffset)) > 0.7;
    const size = rotated ? new Vector3(raw.z, raw.y, raw.x) : raw.clone();
    const s = new Vector3(baseScale, baseScale, baseScale);
    if (cfg.stretch) {
      s.set(
        cfg.stretch.x / size.x,
        cfg.stretch.y / size.y,
        cfg.stretch.z / size.z,
      );
    } else if (cfg.fit) {
      const axisSize =
        cfg.fit.axis === "maxXZ"
          ? Math.max(size.x, size.z)
          : size[cfg.fit.axis as "x" | "y" | "z"];
      if (axisSize > 1e-4) s.setAll(cfg.fit.size / axisSize);
    }
    const centre = new Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
    const m = Matrix.Translation(-centre.x, -centre.y, -centre.z)
      .multiply(Matrix.RotationY(cfg.yawOffset))
      .multiply(Matrix.Scaling(s.x, s.y, s.z));
    if (!m.isIdentity()) for (const p of parts) p.bakeTransformIntoVertices(m);
    return size.multiply(s);
  }

  /** Normalised model-space size for a role (fallback size if not loaded yet). */
  sizeOf(role: PropRole): Vector3 | null {
    return this.entries.get(role)?.size.clone() ?? null;
  }

  /**
   * Place a copy of `role`. `parent` (optional) gives the frame `transform`
   * is expressed in; it is sampled once (props are static).
   */
  instantiate(
    role: PropRole,
    parent: TransformNode | null,
    transform: PlacementTransform,
    opts: PlaceOptions,
  ): Placement {
    const id = this.nextId++;
    const yaw = transform.yaw ?? 0;
    const sc = transform.scale ?? 1;
    let matrix = Matrix.Compose(
      typeof sc === "number"
        ? new Vector3(sc, sc, sc)
        : new Vector3(sc.x, sc.y, sc.z),
      Quaternion.RotationYawPitchRoll(yaw, 0, 0),
      new Vector3(
        transform.position.x,
        transform.position.y,
        transform.position.z,
      ),
    );
    if (parent) matrix = matrix.multiply(parent.computeWorldMatrix(true));

    const asset = ASSET_MANIFEST.models.find((m) => m.role === role);
    const collider =
      opts.collider ??
      asset?.collider ??
      PROCEDURAL_COLLIDERS[role as ProceduralRole] ??
      "none";
    const entry = this.entries.get(role);
    if (entry) this.commitPlacement(entry, id, matrix, opts.group, collider);
    else {
      const list = this.pending.get(role) ?? [];
      list.push({ id, matrix, group: opts.group, collider });
      this.pending.set(role, list);
    }
    let g = this.groupIndex.get(opts.group);
    if (!g) {
      g = new Set();
      this.groupIndex.set(opts.group, g);
    }
    const key = { role, id };
    g.add(key);

    const size = entry?.size ?? new Vector3(1, 1, 1);
    const bounds = worldBounds(size, matrix);
    return {
      id,
      role,
      bounds,
      fallback: entry?.fallback ?? true,
      dispose: () => {
        this.removePlacement(role, id);
        g.delete(key);
      },
    };
  }

  private commitPlacement(
    entry: ModelEntry,
    id: number,
    matrix: Matrix,
    group: string,
    collider: "box" | "cylinder" | "none",
  ): void {
    entry.placements.set(id, { matrix, group });
    entry.dirty = true;
    if (collider === "none") return;
    const b = worldBounds(entry.size, matrix);
    const c = b.min.add(b.max).scale(0.5);
    const colGroup = `${group}#asset`;
    if (collider === "cylinder") {
      this.colliders.addCylinder(
        colGroup,
        c,
        Math.min(b.size.x, b.size.z) * 0.45,
        b.size.y,
      );
    } else {
      // Oriented box: use model size + placement yaw rather than the AABB.
      const scale = new Vector3();
      const rot = new Quaternion();
      const pos = new Vector3();
      matrix.decompose(scale, rot, pos);
      const yaw = rot.toEulerAngles().y;
      const s = entry.size.multiply(scale);
      this.colliders.addBox(
        colGroup,
        new Vector3(pos.x, pos.y + s.y / 2, pos.z),
        s,
        yaw,
      );
    }
  }

  private removePlacement(role: PropRole, id: number): void {
    const entry = this.entries.get(role);
    if (entry?.placements.delete(id)) entry.dirty = true;
    const q = this.pending.get(role);
    if (q) {
      const i = q.findIndex((p) => p.id === id);
      if (i >= 0) q.splice(i, 1);
    }
  }

  /** Remove every placement (and its colliders) in a group. */
  disposeGroup(group: string): void {
    const g = this.groupIndex.get(group);
    if (g) {
      for (const k of g) this.removePlacement(k.role, k.id);
      this.groupIndex.delete(group);
    }
    this.colliders.disposeGroup(`${group}#asset`);
  }

  /** Push dirty thin-instance buffers to the GPU (call once per frame). */
  flush(): void {
    for (const e of this.entries.values()) {
      if (!e.dirty) continue;
      e.dirty = false;
      const n = e.placements.size;
      const buf = new Float32Array(Math.max(1, n) * 16);
      let i = 0;
      for (const p of e.placements.values()) {
        p.matrix.copyToArray(buf, i * 16);
        i += 1;
      }
      for (const part of e.parts) {
        if (n === 0) {
          part.isVisible = false;
          part.thinInstanceSetBuffer("matrix", null);
          continue;
        }
        part.thinInstanceSetBuffer("matrix", buf, 16, true);
        part.thinInstanceRefreshBoundingInfo(false);
        part.isVisible = true;
      }
    }
  }

  /** All part meshes (for render lists / shadow casters). */
  allParts(): Mesh[] {
    const out: Mesh[] = [];
    for (const e of this.entries.values()) out.push(...e.parts);
    return out;
  }

  dispose(): void {
    for (const e of this.entries.values())
      for (const p of e.parts) p.dispose(false, false);
    this.entries.clear();
    this.pending.clear();
    this.groupIndex.clear();
  }
}

function boundsOf(meshes: Mesh[]): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.refreshBoundingInfo();
    const bb = m.getBoundingInfo().boundingBox;
    min.minimizeInPlace(bb.minimumWorld);
    max.maximizeInPlace(bb.maximumWorld);
  }
  if (!Number.isFinite(min.x))
    return { min: Vector3.Zero(), max: new Vector3(1, 1, 1) };
  return { min, max };
}

function worldBounds(
  size: Vector3,
  matrix: Matrix,
): { min: Vector3; max: Vector3; size: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const hx = size.x / 2;
  const hz = size.z / 2;
  for (const x of [-hx, hx])
    for (const y of [0, size.y])
      for (const z of [-hz, hz]) {
        const p = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
        min.minimizeInPlace(p);
        max.maximizeInPlace(p);
      }
  return { min, max, size: max.subtract(min) };
}
