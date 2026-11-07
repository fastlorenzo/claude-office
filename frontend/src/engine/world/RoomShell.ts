/**
 * RoomShellModule — the static architecture of a session room, built ONCE
 * and drawn for every room with thin instances (one draw call per material
 * for all rooms together, whatever the number of sessions).
 *
 * Every room is the same module (LAYOUT.ROOM_D × ROOM_W × WALL_H) in its
 * local frame (door wall at -X, see contracts), so geometry, UVs and the
 * per-piece variation are identical — only the instance matrix and the felt
 * feature-wall colour differ (thin-instance colour on the felt part only).
 *
 * Contents: oak entry strip + carpet tiles, rug, plaster ceiling with a
 * perimeter shadow gap, linear pendants + downlights, glazed front with black
 * mullions / manifestation band / recessed door frame, graphite pier with
 * sign housings, felt feature wall, shadow-gap skirting — and the whole
 * furniture prefab (desks, chairs, lounge, shelving, coffee point, planters)
 * merged per material into a second set of parts that casts shadows. The
 * scanned glTF plants stay AssetLibrary thin instances (see `plants`).
 */

export interface LocalPlacement {
  role: PropRole;
  x: number;
  z: number;
  yaw: number;
  y?: number;
  scale?: number;
}

/** Furniture of a room in room-local coordinates (same for every room). */
export function roomFurniture(L: RoomLayout): {
  props: LocalPlacement[];
  plants: LocalPlacement[];
} {
  const hx = L.size.d / 2;
  const hz = L.size.w / 2;
  const toLocal = (p: Vec3) => {
    const c = Math.cos(L.yaw);
    const s = Math.sin(L.yaw);
    const dx = p.x - L.origin.x;
    const dz = p.z - L.origin.z;
    return { x: dx * c - dz * s, z: dx * s + dz * c };
  };
  const props: LocalPlacement[] = [];
  const plants: LocalPlacement[] = [];
  const bd = toLocal(L.bossDesk.position);
  const bossYaw = L.bossDesk.yaw - L.yaw;
  props.push({ role: "execDesk", x: bd.x, z: bd.z, yaw: bossYaw });
  const bs = toLocal(L.bossDesk.seat);
  props.push({ role: "taskChair", x: bs.x, z: bs.z, yaw: bossYaw });
  const r = { x: Math.cos(bossYaw), z: -Math.sin(bossYaw) };
  const f = { x: Math.sin(bossYaw), z: Math.cos(bossYaw) };
  props.push({
    role: "laptop",
    x: bd.x + r.x * 0.62 - f.x * 0.08,
    z: bd.z + r.z * 0.62 - f.z * 0.08,
    yaw: bossYaw - 0.35,
    y: 0.75,
  });
  plants.push({
    role: "plantSmall",
    x: bd.x - r.x * 0.78 + f.x * 0.22,
    z: bd.z - r.z * 0.78 + f.z * 0.22,
    yaw: 0,
    y: 0.75,
  });
  L.desks.forEach((d, i) => {
    const p = toLocal(d.position);
    const yaw = d.yaw - L.yaw;
    props.push({ role: "workDesk", x: p.x, z: p.z, yaw });
    const st = toLocal(d.seat);
    props.push({
      role: "taskChair",
      x: st.x,
      z: st.z,
      yaw: yaw + (((i * 37) % 7) - 3) * 0.05,
    });
    const dr = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const df = { x: Math.sin(yaw), z: Math.cos(yaw) };
    if (i % 3 === 0)
      plants.push({
        role: "plantSmall",
        x: p.x + dr.x * 0.56 + df.x * 0.18,
        z: p.z + dr.z * 0.56 + df.z * 0.18,
        yaw: i,
        y: 0.74,
      });
  });
  const pz1 = ROOM_PIER.z1;
  props.push(
    { role: "sofa", x: -hx + 0.55, z: hz - 1.5, yaw: Math.PI / 2, scale: 0.92 },
    { role: "loungeTable", x: -hx + 1.55, z: hz - 1.5, yaw: 0 },
    { role: "floorLamp", x: -hx + 0.35, z: hz - 0.35, yaw: 0 },
    { role: "sideTable", x: -hx + 0.42, z: hz - 2.75, yaw: 0 },
    { role: "planterTall", x: hx - 0.45, z: hz - 0.45, yaw: 0 },
    { role: "planter", x: -hx + 0.45, z: pz1 + 0.45, yaw: 0 },
    { role: "coatHooks", x: -hx + 0.62, z: -hz, yaw: Math.PI },
    { role: "shelves", x: -1.35, z: -hz + 0.22, yaw: Math.PI },
    { role: "coffeeCart", x: hx - 1.05, z: -hz + 0.27, yaw: Math.PI },
    { role: "artPrint", x: hx - 1.05, z: -hz + 0.035, yaw: Math.PI, y: 1.95 },
  );
  plants.push(
    { role: "plantTall", x: hx - 0.45, z: hz - 0.45, yaw: 1.1, y: 0.14 },
    {
      role: "plant",
      x: -hx + 0.45,
      z: pz1 + 0.45,
      yaw: 0.4,
      scale: 0.9,
      y: 0.02,
    },
  );
  return { props, plants };
}

/** Roles that get a collider box in rooms. */
const SOLID: ReadonlySet<PropRole> = new Set<PropRole>([
  "execDesk",
  "workDesk",
  "taskChair",
  "sofa",
  "loungeTable",
  "sideTable",
  "planterTall",
  "planter",
  "shelves",
  "coffeeCart",
]);
import { Matrix, Mesh, type Scene, type Vector3 } from "@/engine/babylon";
import { LAYOUT, type RoomLayout, type Vec3 } from "@/engine/contracts";
import { emitProp, type PropRole } from "@/engine/assets/proceduralProps";
import { ArtBatcher } from "@/engine/art/geometry";
import { FixturePoint, type Lighting } from "@/engine/fx/Lighting";
import type { Materials } from "@/engine/materials/Materials";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  downlight,
  glassPartition,
  linearPendant,
} from "@/engine/world/architecture";

/** Linear mean albedo of the felt texture (Fabric030) — instance tint base. */
const FELT_MEAN = 0.142;

export const ROOM_OAK_W = 1.5;
export const ROOM_PIER = (() => {
  const z0 = LAYOUT.DOOR_W / 2 + 0.2;
  return { z0, z1: z0 + 1.1 };
})();

interface Inst {
  matrix: Matrix;
  felt: [number, number, number];
}

const modules = new WeakMap<Scene, RoomShellModule>();

export class RoomShellModule {
  readonly parts: Mesh[];
  /** Fixtures in room-local coordinates. */
  readonly localFixtures: FixturePoint[];
  /** Collider boxes (room-local): centre x/z, size, yaw. */
  readonly colliders: { x: number; z: number; size: Vector3; yaw: number }[] =
    [];
  /** Scanned plants to place per room via the AssetLibrary. */
  readonly plants: LocalPlacement[];
  private readonly feltPart: Mesh | null;
  private readonly instances = new Map<number, Inst>();
  private nextId = 1;

  static get(
    scene: Scene,
    materials: Materials,
    lighting: Lighting,
    template: RoomLayout,
  ): RoomShellModule {
    let m = modules.get(scene);
    if (!m || m.parts.some((p) => p.isDisposed())) {
      m = new RoomShellModule(scene, materials, lighting, template);
      const mod = m;
      (
        globalThis as { __claudeOfficeExportRoom?: () => string }
      ).__claudeOfficeExportRoom = () => exportModuleJson(mod);
      modules.set(scene, m);
    }
    return m;
  }

  private constructor(
    scene: Scene,
    materials: Materials,
    private readonly lighting: Lighting,
    template: RoomLayout,
  ) {
    const hx = LAYOUT.ROOM_D / 2;
    const hz = LAYOUT.ROOM_W / 2;
    const H = LAYOUT.WALL_H;
    const doorHalf = LAYOUT.DOOR_W / 2;
    const b = new ArtBatcher(scene, materials, "roomShell", 11);
    const felt = materials.get("wallFelt");

    // Floor: oak entry / lounge strip along the glass, carpet tiles beyond.
    const oakW = ROOM_OAK_W;
    b.box("floorOak", v3(-hx + oakW / 2, -0.05, 0), v3(oakW, 0.1, hz * 2));
    b.box("floorRoom", v3(oakW / 2, -0.05, 0), v3(hx * 2 - oakW, 0.1, hz * 2));
    b.box("blackMetal", v3(-hx + oakW, 0.001, 0), v3(0.012, 0.003, hz * 2));
    b.rbox("rug", v3(-hx + 1.2, 0.006, hz - 1.5), v3(1.9, 0.012, 2.5), {
      r: 0.004,
    });

    // Ceiling: smooth plaster, perimeter shadow gap.
    b.box("ceiling", v3(0, H + 0.05, 0), v3(hx * 2, 0.1, hz * 2));
    b.box("shadowGap", v3(0, H - 0.003, -hz + 0.012), v3(hx * 2, 0.006, 0.024));
    b.box("shadowGap", v3(0, H - 0.003, hz - 0.012), v3(hx * 2, 0.006, 0.024));
    b.box("shadowGap", v3(hx - 0.012, H - 0.003, 0), v3(0.024, 0.006, hz * 2));

    // Luminaires: pendants over the benches + boss desk, downlights over the entry.
    const fx: FixturePoint[] = [];
    for (const cx of [-0.8, 1.2])
      for (const cz of [-2.65, 2.65])
        fx.push(...linearPendant(b, cx, cz, H, 2.6, "z", 0.6));
    fx.push(...linearPendant(b, hx - 0.95, 0, H, 1.5, "z", 0.65));
    for (const z of [-3.3, -1.1, 1.1, 3.3])
      fx.push(downlight(b, -hx + 0.75, z, H, 0.7));
    this.localFixtures = fx;

    // Glazed front (door wall at -X) with the solid pier for the signs.
    const { z0: pierZ0, z1: pierZ1 } = ROOM_PIER;
    glassPartition(
      b,
      null,
      "roomShell",
      "z",
      -hx,
      -hz,
      hz,
      H,
      { a0: -doorHalf, a1: doorHalf, h: 2.4 },
      {
        pitch: 1.5,
        frostBand: true,
        solid: [{ a0: pierZ0, a1: pierZ1, y0: 0, y1: H }],
      },
    );
    const pz = (pierZ0 + pierZ1) / 2;
    b.rbox("wallFeature", v3(-hx, H / 2, pz), v3(0.18, H, pierZ1 - pierZ0), {
      r: 0.01,
    });
    b.rbox("blackMetal", v3(-hx - 0.1, 1.45, pz), v3(0.02, 0.52, 0.88), {
      r: 0.006,
    });
    b.rbox("blackMetal", v3(-hx - 0.1, 2.25, pz), v3(0.02, 0.26, 0.88), {
      r: 0.006,
    });

    // Feature wall (+Z): acoustic felt panels (tinted per room).
    b.box(
      "shadowGap",
      v3(0, H / 2, hz - 0.006),
      v3(hx * 2 - 0.4, H - 0.2, 0.012),
    );
    b.slats(
      felt,
      -hx + 0.2,
      hx - 0.2,
      0.6,
      0.014,
      (a) => ({ c: v3(a, H / 2, hz - 0.024), s: v3(0.6, H - 0.24, 0.024) }),
      0.006,
    );
    // Recessed shadow-gap skirting on the plaster walls.
    b.box("skirting", v3(0, 0.035, -hz + 0.005), v3(hx * 2, 0.07, 0.01));
    b.box("skirting", v3(hx - 0.005, 0.035, 0), v3(0.01, 0.07, hz * 2));

    const arch = b.build({ receiveShadows: true });

    // Furniture prefab, merged per material (casts dynamic shadows).
    const fb = new ArtBatcher(scene, materials, "roomFurn", 17);
    const { props, plants } = roomFurniture(template);
    props.forEach((pl, i) => {
      const size = emitProp(fb, scene, materials, pl.role, pl, 101 + i * 7);
      if (SOLID.has(pl.role))
        this.colliders.push({ x: pl.x, z: pl.z, size, yaw: pl.yaw });
    });
    this.plants = plants;
    const furn = fb.build({ receiveShadows: true });
    for (const p of furn)
      p.metadata = { ...(p.metadata ?? {}), staticCaster: true };

    this.parts = [...arch, ...furn];
    this.feltPart = arch.find((p) => p.material === felt) ?? null;
    for (const p of this.parts) {
      p.metadata = { ...(p.metadata ?? {}), probe: true };
      p.isVisible = false;
      p.doNotSyncBoundingInfo = false;
      if (p.material?.needAlphaBlending()) p.alphaIndex = 10;
    }
    lighting.addStaticCasters(
      arch.filter((p) => !p.material?.needAlphaBlending()),
    );
    for (const p of furn) lighting.addShadowCaster(p);
  }

  /** Register a room instance (world matrix of its root, felt colour). */
  add(matrix: Matrix, feltHex: string): () => void {
    const id = this.nextId++;
    const c = hexToLinear(feltHex);
    this.instances.set(id, {
      matrix: matrix.clone(),
      felt: [c[0] / FELT_MEAN, c[1] / FELT_MEAN, c[2] / FELT_MEAN],
    });
    this.flush();
    return () => {
      if (this.instances.delete(id)) this.flush();
    };
  }

  private flush(): void {
    const n = this.instances.size;
    const mats = new Float32Array(Math.max(1, n) * 16);
    const cols = new Float32Array(Math.max(1, n) * 4);
    let i = 0;
    for (const inst of this.instances.values()) {
      inst.matrix.copyToArray(mats, i * 16);
      cols.set([...inst.felt, 1], i * 4);
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
      if (p === this.feltPart) p.thinInstanceSetBuffer("color", cols, 4, true);
      p.thinInstanceRefreshBoundingInfo(false);
      p.isVisible = true;
    }
    this.lighting.invalidateStaticShadows();
    this.lighting.refreshProbes();
  }
}

/**
 * Lightmap tooling hook (tools/lightmaps): serialise the room module's
 * merged parts (local space) as JSON for the Blender bake. Exposed on
 * `globalThis.__claudeOfficeExportRoom()` so it can be pulled from devtools.
 */
export function exportModuleJson(m: RoomShellModule): string {
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
  return JSON.stringify({ module: "room", version: 1, parts });
}

function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
