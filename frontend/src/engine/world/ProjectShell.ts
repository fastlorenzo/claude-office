/**
 * Thin-instanced prefabs of the project team rooms. Each prefab is built ONCE
 * per scene and drawn for every placement with thin instances (one draw call
 * per material for all rooms together, whatever the number of projects):
 *
 *   entry    entry bay: glazed front with the door, a solid graphite pier
 *            (info screen) + bulkhead over the door (LED panel) — no glass
 *            above the door —, oak circulation strip, carpet, ceiling,
 *            downlights, lounge corner (sofa, chairs, table, lamp, rug),
 *            coffee point, coat rail
 *   podBay   one bay of room architecture: glazed front, floor, ceiling,
 *            linear pendants over the bench and the lead desk
 *   endWall  plaster partition across the room depth at the room ends
 *   divider  acoustic felt screen between pod bays (tinted per project)
 *   pod      a session pod: 8 bench desks + chairs, the lead's desk + chair,
 *            nameplate post, mobile whiteboard stand, zone rug
 *
 * Frames: bay prefabs use the bay frame (origin on the glass line at the bay
 * centre, +x into the room, z along the hall); the pod prefab uses the pod
 * frame (origin on the circulation spine, +z into the room) — see
 * layout/buildingLayout.ts. Scanned plants stay AssetLibrary thin instances
 * (`plants`, placed per room).
 */
import { Matrix, Mesh, type Scene, type Vector3 } from "@/engine/babylon";
import { LAYOUT } from "@/engine/contracts";
import { emitProp, type PropRole } from "@/engine/assets/proceduralProps";
import { ArtBatcher } from "@/engine/art/geometry";
import { FixturePoint, type Lighting } from "@/engine/fx/Lighting";
import type { Materials } from "@/engine/materials/Materials";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  DOOR_H,
  downlight,
  glassPartition,
  linearPendant,
} from "@/engine/world/architecture";
import {
  BULKHEAD_D,
  ENTRY,
  GLASS_FLOOR_W,
  POD,
} from "@/engine/layout/buildingLayout";
import { PLANTER_SOIL_Y } from "@/engine/assets/proceduralProps";

/** Linear mean albedo of the felt texture (Fabric030) — instance tint base. */
const FELT_MEAN = 0.142;

export interface LocalPlacement {
  role: PropRole;
  x: number;
  z: number;
  yaw: number;
  y?: number;
  scale?: number;
}

export type ShellKind = "entry" | "podBay" | "endWall" | "divider" | "pod";

/** Roles that get a collider box. */
const SOLID: ReadonlySet<PropRole> = new Set<PropRole>([
  "execDesk",
  "workDesk",
  "taskChair",
  "sofa",
  "chair",
  "loungeTable",
  "sideTable",
  "coffeeCart",
]);

interface Inst {
  matrix: Matrix;
  tint: [number, number, number];
}

interface Built {
  arch: ArtBatcher;
  furn: ArtBatcher | null;
  fixtures: FixturePoint[];
  plants: LocalPlacement[];
  props: LocalPlacement[];
  /** Material whose instances get the per-placement tint (felt). */
  tinted: boolean;
}

const D = () => LAYOUT.ROOM_D;
const B = () => LAYOUT.ROOM_W;

/** Floor, ceiling and the glazed front shared by entry + pod bays. */
function bayArchitecture(b: ArtBatcher, door: boolean): FixturePoint[] {
  const H = LAYOUT.WALL_H;
  const C = LAYOUT.CORRIDOR_W;
  const d = D();
  const w = B();
  const gf = GLASS_FLOOR_W;
  b.box("floorOak", v3(C / 2, -0.05, 0), v3(C, 0.1, w));
  b.box(
    "floorRoom",
    v3(C + (d - gf - C) / 2, -0.05, 0),
    v3(d - gf - C, 0.1, w),
  );
  b.box("blackMetal", v3(C, 0.001, 0), v3(0.012, 0.003, w));
  // Structural glass strip along the outer glazing (the factory floor shows
  // through it later): no opaque slab here, just the glass + a steel edge.
  b.box("glass", v3(d - gf / 2, -0.02, 0), v3(gf, 0.04, w));
  b.box("blackMetal", v3(d - gf, -0.01, 0), v3(0.03, 0.02, w));
  b.box("ceiling", v3(d / 2, H + 0.05, 0), v3(d, 0.1, w));
  b.box("shadowGap", v3(d - 0.012, H - 0.003, 0), v3(0.024, 0.006, w));
  const fx: FixturePoint[] = [];
  for (const z of [-1.2, 1.2]) fx.push(downlight(b, C / 2, z, H, 0.7));
  if (!door) {
    glassPartition(b, null, "roomShell", "z", 0, -w / 2, w / 2, H, null, {
      pitch: 1.2,
      frostBand: true,
    });
    return fx;
  }
  const dz = ENTRY.doorZ;
  const half = LAYOUT.DOOR_W / 2;
  glassPartition(
    b,
    null,
    "roomShell",
    "z",
    0,
    -w / 2,
    w / 2,
    H,
    { a0: dz - half, a1: dz + half, h: DOOR_H },
    {
      pitch: 1.2,
      frostBand: true,
      solid: [{ a0: ENTRY.pierZ0, a1: ENTRY.pierZ1, y0: 0, y1: H }],
      transom: "solid",
      bulkhead: {
        mat: "wallFeature",
        depth: BULKHEAD_D,
        a0: ENTRY.pierZ1 - 0.01,
        a1: dz + half + 0.05,
      },
    },
  );
  // Graphite pier (info screen side), full height, same depth as the bulkhead.
  const pz = (ENTRY.pierZ0 + ENTRY.pierZ1) / 2;
  b.rbox(
    "wallFeature",
    v3(0, H / 2, pz),
    v3(BULKHEAD_D, H, ENTRY.pierZ1 - ENTRY.pierZ0),
    { r: 0.008 },
  );
  // Black recess framing the LED line on the fascia (hall side).
  const ledZ = (ENTRY.pierZ0 + dz + half) / 2;
  b.rbox(
    "blackMetal",
    v3(-BULKHEAD_D / 2 - 0.001, 2.82, ledZ),
    v3(0.006, ENTRY.ledH + 0.06, ENTRY.ledW + 0.06),
    { r: 0.004 },
  );
  // Info screen bracket shadow + fascia skirting (hall side).
  b.box(
    "shadowGap",
    v3(-BULKHEAD_D / 2 - 0.001, ENTRY.infoY, pz),
    v3(0.004, ENTRY.infoH + 0.12, ENTRY.infoW + 0.12),
  );
  b.box(
    "skirting",
    v3(-BULKHEAD_D / 2 - 0.004, 0.035, pz),
    v3(0.008, 0.07, ENTRY.pierZ1 - ENTRY.pierZ0),
  );
  return fx;
}

function buildEntry(scene: Scene, materials: Materials): Built {
  const H = LAYOUT.WALL_H;
  const arch = new ArtBatcher(scene, materials, "projEntry", 11);
  const fixtures = bayArchitecture(arch, true);
  arch.rbox("rug", v3(7.7, 0.006, 0), v3(3.0, 0.012, 3.1), { r: 0.004 });
  fixtures.push(...linearPendant(arch, 7.7, 0, H, 1.8, "z", 0.75));
  fixtures.push(downlight(arch, 2.4, -1.25, H, 0.9));
  const props: LocalPlacement[] = [
    { role: "sofa", x: 8.78, z: 0, yaw: -Math.PI / 2, scale: 0.92 },
    { role: "loungeTable", x: 7.7, z: 0, yaw: 0 },
    { role: "chair", x: 6.65, z: 0.85, yaw: Math.PI / 2 - 0.35 },
    { role: "chair", x: 6.65, z: -0.85, yaw: Math.PI / 2 + 0.35 },
    { role: "coffeeCart", x: 2.3, z: -1.25, yaw: Math.PI / 2 },
    {
      role: "coatHooks",
      x: BULKHEAD_D / 2 + 0.012,
      z: -1.0,
      yaw: -Math.PI / 2,
    },
    { role: "planterTall", x: 2.35, z: 1.85, yaw: 0 },
    { role: "planter", x: 9.12, z: -2.05, yaw: 0 },
  ];
  const plants: LocalPlacement[] = [
    {
      role: "plantTall",
      x: 2.35,
      z: 1.85,
      yaw: 1.1,
      y: PLANTER_SOIL_Y.planterTall,
    },
    {
      role: "plant",
      x: 9.12,
      z: -2.05,
      yaw: 0.4,
      y: PLANTER_SOIL_Y.planter,
      scale: 0.9,
    },
  ];
  return { arch, furn: null, fixtures, plants, props, tinted: false };
}

function buildPodBay(scene: Scene, materials: Materials): Built {
  const H = LAYOUT.WALL_H;
  const C = LAYOUT.CORRIDOR_W;
  const arch = new ArtBatcher(scene, materials, "projBay", 13);
  const fixtures = bayArchitecture(arch, false);
  const b0 = C / 2 + POD.benchZ0;
  const b1 = C / 2 + POD.benchZ1;
  fixtures.push(
    ...linearPendant(arch, (b0 + b1) / 2, 0, H, b1 - b0 - 0.6, "x", 0.6),
  );
  fixtures.push(
    ...linearPendant(arch, C / 2 + POD.bossZ + 0.1, 0, H, 1.5, "z", 0.65),
  );
  return { arch, furn: null, fixtures, plants: [], props: [], tinted: false };
}

function buildEndWall(scene: Scene, materials: Materials): Built {
  const H = LAYOUT.WALL_H;
  const d = D();
  const arch = new ArtBatcher(scene, materials, "projEnd", 17);
  arch.box("wall", v3(d / 2, H / 2, 0), v3(d, H, 0.1));
  for (const s of [-1, 1])
    arch.box("skirting", v3(d / 2, 0.035, s * 0.055), v3(d, 0.07, 0.01));
  // Graphite pier facing the hall.
  arch.rbox("wallFeature", v3(-0.03, H / 2, 0), v3(0.14, H, 0.16), {
    r: 0.006,
  });
  return {
    arch,
    furn: null,
    fixtures: [],
    plants: [],
    props: [],
    tinted: false,
  };
}

function buildDivider(scene: Scene, materials: Materials): Built {
  const C = LAYOUT.CORRIDOR_W;
  const arch = new ArtBatcher(scene, materials, "projDivider", 19);
  const felt = materials.get("wallFelt");
  const x0 = C / 2 + POD.dividerZ0;
  const x1 = C / 2 + POD.dividerZ1;
  const h = POD.dividerH;
  arch.rbox(
    felt,
    v3((x0 + x1) / 2, 0.06 + (h - 0.06) / 2, 0),
    v3(x1 - x0, h - 0.06, 0.05),
    {
      r: 0.02,
      seg: 2,
    },
  );
  arch.rbox(
    "blackMetal",
    v3((x0 + x1) / 2, h + 0.004, 0),
    v3(x1 - x0 + 0.01, 0.012, 0.056),
    {
      r: 0.003,
    },
  );
  for (const x of [x0 + 0.25, (x0 + x1) / 2, x1 - 0.25])
    arch.rbox("blackMetal", v3(x, 0.03, 0), v3(0.05, 0.06, 0.42), { r: 0.006 });
  return {
    arch,
    furn: null,
    fixtures: [],
    plants: [],
    props: [],
    tinted: true,
  };
}

function buildPod(scene: Scene, materials: Materials): Built {
  const arch = new ArtBatcher(scene, materials, "podZone", 23);
  // Zone rug under the bench.
  arch.rbox(
    "rug",
    v3(0, 0.005, (POD.benchZ0 + POD.benchZ1) / 2),
    v3(3.0, 0.01, POD.benchZ1 - POD.benchZ0 + 0.9),
    { r: 0.004 },
  );
  // Nameplate post (screen comes from DoorSign) + base plate.
  const postH = POD.signY - POD.signH / 2;
  arch.rbox(
    "blackMetal",
    v3(0, postH / 2, POD.signZ + 0.03),
    v3(0.05, postH, 0.03),
    {
      r: 0.006,
    },
  );
  arch.rbox(
    "blackMetal",
    v3(0, 0.008, POD.signZ + 0.03),
    v3(0.36, 0.016, 0.24),
    {
      r: 0.006,
    },
  );
  // Mobile whiteboard stand (board comes from WhiteboardScreen).
  const legH = POD.boardY + POD.boardH / 2 + 0.06;
  for (const s of [-1, 1]) {
    const x = POD.boardX + s * (POD.boardW / 2 + 0.04);
    arch.rbox(
      "aluminium",
      v3(x, legH / 2, POD.boardZ + 0.02),
      v3(0.03, legH, 0.03),
      {
        r: 0.004,
      },
    );
    arch.rbox(
      "aluminium",
      v3(x, 0.05, POD.boardZ + 0.02),
      v3(0.04, 0.03, 0.55),
      {
        r: 0.006,
      },
    );
  }
  const props: LocalPlacement[] = [];
  const plants: LocalPlacement[] = [];
  for (let i = 0; i < 8; i++) {
    const k = i >> 1;
    const side = i & 1 ? -1 : 1;
    const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const x = side * POD.benchX;
    const z = POD.benchZ[k];
    props.push({ role: "workDesk", x, z, yaw });
    props.push({
      role: "taskChair",
      x: side * (POD.benchX + 0.55),
      z,
      yaw: yaw + (((i * 37) % 7) - 3) * 0.05,
    });
    if (i === 2 || i === 7)
      plants.push({
        role: "plantSmall",
        x: side * 0.22,
        z: z + 0.56 * side,
        yaw: i,
        y: 0.74,
      });
  }
  props.push({ role: "execDesk", x: 0, z: POD.bossZ, yaw: Math.PI });
  props.push({ role: "taskChair", x: 0, z: POD.bossZ + 0.55, yaw: Math.PI });
  plants.push({
    role: "plantSmall",
    x: 0.78,
    z: POD.bossZ - 0.2,
    yaw: 0,
    y: 0.75,
  });
  // Furniture merges with the zone parts per material (fewer draws).
  return { arch, furn: null, fixtures: [], plants, props, tinted: false };
}

const BUILDERS: Record<ShellKind, (s: Scene, m: Materials) => Built> = {
  entry: buildEntry,
  podBay: buildPodBay,
  endWall: buildEndWall,
  divider: buildDivider,
  pod: buildPod,
};

const modules = new WeakMap<Scene, Map<ShellKind, ShellModule>>();

export class ShellModule {
  readonly parts: Mesh[];
  /** Fixtures in prefab-local coordinates. */
  readonly localFixtures: FixturePoint[];
  /** Collider boxes (prefab-local): centre x/z, size, yaw. */
  readonly colliders: { x: number; z: number; size: Vector3; yaw: number }[] =
    [];
  /** Scanned plants to place per instance via the AssetLibrary. */
  readonly plants: LocalPlacement[];
  private readonly tintPart: Mesh | null;
  private readonly instances = new Map<number, Inst>();
  private nextId = 1;

  static get(
    scene: Scene,
    materials: Materials,
    lighting: Lighting,
    kind: ShellKind,
  ): ShellModule {
    let byKind = modules.get(scene);
    if (!byKind) {
      byKind = new Map();
      modules.set(scene, byKind);
    }
    let m = byKind.get(kind);
    if (!m || m.parts.some((p) => p.isDisposed())) {
      m = new ShellModule(scene, materials, lighting, kind);
      byKind.set(kind, m);
      if (kind === "pod") {
        const mod = m;
        (
          globalThis as { __claudeOfficeExportRoom?: () => string }
        ).__claudeOfficeExportRoom = () => exportModuleJson(mod);
      }
    }
    return m;
  }

  private constructor(
    scene: Scene,
    materials: Materials,
    private readonly lighting: Lighting,
    readonly kind: ShellKind,
  ) {
    const built = BUILDERS[kind](scene, materials);
    const fb = built.furn ?? built.arch;
    built.props.forEach((pl, i) => {
      const size = emitProp(fb, scene, materials, pl.role, pl, 101 + i * 7);
      if (SOLID.has(pl.role))
        this.colliders.push({ x: pl.x, z: pl.z, size, yaw: pl.yaw });
    });
    this.plants = built.plants;
    this.localFixtures = built.fixtures;
    const arch = built.arch.build({ receiveShadows: true });
    const furn = built.furn ? built.furn.build({ receiveShadows: true }) : [];
    for (const p of furn)
      p.metadata = { ...(p.metadata ?? {}), staticCaster: true };
    this.parts = [...arch, ...furn];
    const felt = materials.get("wallFelt");
    this.tintPart = built.tinted
      ? (arch.find((p) => p.material === felt) ?? null)
      : null;
    for (const p of this.parts) {
      p.metadata = { ...(p.metadata ?? {}), probe: true };
      p.isVisible = false;
      p.doNotSyncBoundingInfo = false;
      if (p.material?.needAlphaBlending()) p.alphaIndex = 10;
    }
    // Everything here is static: the render-once daylight map only (the
    // per-frame cascades are kept for things that move).
    lighting.addStaticCasters([
      ...arch.filter((p) => !p.material?.needAlphaBlending()),
      ...furn,
    ]);
  }

  /** Register a placement (world matrix, optional felt tint). */
  add(matrix: Matrix, tintHex = "#8C8A86"): () => void {
    const id = this.nextId++;
    const c = hexToLinear(tintHex);
    this.instances.set(id, {
      matrix: matrix.clone(),
      tint: [c[0] / FELT_MEAN, c[1] / FELT_MEAN, c[2] / FELT_MEAN],
    });
    this.dirty = true;
    queueFlush(this);
    return () => {
      if (this.instances.delete(id)) {
        this.dirty = true;
        queueFlush(this);
      }
    };
  }

  private dirty = false;

  /** Upload the instance buffers (batched: once per microtask). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.instances.size;
    const mats = new Float32Array(Math.max(1, n) * 16);
    const cols = new Float32Array(Math.max(1, n) * 4);
    let i = 0;
    for (const inst of this.instances.values()) {
      inst.matrix.copyToArray(mats, i * 16);
      cols.set([...inst.tint, 1], i * 4);
      i += 1;
    }
    for (const p of this.parts) {
      if (p.isDisposed()) continue;
      if (n === 0) {
        p.isVisible = false;
        p.thinInstanceSetBuffer("matrix", null);
        continue;
      }
      p.thinInstanceSetBuffer("matrix", mats, 16, true);
      if (p === this.tintPart) p.thinInstanceSetBuffer("color", cols, 4, true);
      p.thinInstanceRefreshBoundingInfo(false);
      p.isVisible = true;
    }
    this.lighting.invalidateStaticShadows();
    this.lighting.refreshProbes();
  }
}

const pending = new Set<ShellModule>();
function queueFlush(m: ShellModule): void {
  if (pending.has(m)) return;
  pending.add(m);
  if (pending.size === 1)
    queueMicrotask(() => {
      const list = [...pending];
      pending.clear();
      for (const x of list) x.flush();
    });
}

/** Prefab-local → world transform of a placement frame. */
export function frameMatrix(f: {
  ox: number;
  oz: number;
  yaw: number;
}): Matrix {
  return Matrix.RotationY(f.yaw).multiply(Matrix.Translation(f.ox, 0, f.oz));
}

/**
 * Lightmap tooling hook (tools/lightmaps): serialise the pod prefab's merged
 * parts (local space) as JSON. Exposed on `globalThis.__claudeOfficeExportRoom()`.
 */
export function exportModuleJson(m: ShellModule): string {
  const parts = m.parts.map((p) => ({
    name: p.name,
    material: p.material?.name ?? "",
    emissive:
      (p.material as { disableLighting?: boolean } | null)?.disableLighting ??
      false,
    transparent: p.material?.needAlphaBlending() ?? false,
    positions: Array.from(p.getVerticesData("position") ?? []),
    normals: Array.from(p.getVerticesData("normal") ?? []),
    indices: Array.from(p.getIndices() ?? []),
  }));
  return JSON.stringify({ module: m.kind, version: 2, parts });
}

function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
