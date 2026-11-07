/**
 * A project team room: the room-level part of a project (the sessions' pods
 * are `Room`s, see Room.ts).
 *
 *  - Architecture: thin-instanced prefabs (ProjectShell.ts) placed per bay —
 *    entry bay, one bay per pod slot, end walls, felt dividers tinted with
 *    the project accent.
 *  - Door signage (hall side): the one-line LED panel on the solid bulkhead
 *    over the door (project · N sessions · status in words) and the info
 *    screen on the pier beside it (one row per session). No duplication.
 *  - Colliders, light fixtures, plants (entry + vacant pod bays + a hall
 *    planter at the room's far end), the control-room feed render list.
 */
import {
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Scene,
} from "@/engine/babylon";
import {
  LAYOUT,
  type CampusSession,
  type InteractionTarget,
  type ProjectRoomLayout,
  type RoomStatus,
} from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { PLANTER_SOIL_Y } from "@/engine/assets/proceduralProps";
import type { Lod } from "@/engine/characters/types";
import { FixturePoint, type Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import {
  bayFrame,
  ENTRY,
  podFrame,
  toWorld,
} from "@/engine/layout/buildingLayout";
import { infoRows } from "@/engine/logic/projectInfo";
import { roomStatus } from "@/engine/logic/status";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { ProjectInfoScreen } from "@/engine/screens/ProjectInfoScreen";
import { DOOR_H, partitionColliders } from "@/engine/world/architecture";
import { LedPanel } from "@/engine/world/LedPanel";
import {
  frameMatrix,
  ShellModule,
  type ShellKind,
} from "@/engine/world/ProjectShell";
import { projectLedContent } from "@/engine/world/RoomSign";

export interface ProjectRoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
}

/** Muted felt colours (one per project, cycling): sage, clay, slate, sand, … */
export const PROJECT_ACCENTS = [
  "#7F927F",
  "#A87E66",
  "#6C7C90",
  "#B3A07E",
  "#8C7D72",
  "#5F7470",
  "#9A7A7A",
  "#6F8A8E",
];

const NEAR = 14;
const MID = 30;

type Frame = { ox: number; oz: number; yaw: number };

export class ProjectRoom {
  readonly projectId: string;
  readonly root: TransformNode;
  readonly layout: ProjectRoomLayout;
  private readonly group: string;
  private readonly releases: (() => void)[] = [];
  private readonly parts: AbstractMesh[] = [];
  private readonly fixtures: Vector3[] = [];
  private readonly led: LedPanel;
  private readonly info: ProjectInfoScreen;
  private readonly doorTarget: InteractionTarget;
  private readonly infoTarget: InteractionTarget;
  private lod: Lod | null = null;
  private name: string;

  constructor(
    private readonly ctx: ProjectRoomContext,
    layout: ProjectRoomLayout,
  ) {
    this.layout = layout;
    this.projectId = layout.projectId;
    this.name = layout.name;
    this.group = `proj:${layout.projectId}`;
    this.root = new TransformNode(this.group, ctx.scene);
    const accent = PROJECT_ACCENTS[layout.slot.index % PROJECT_ACCENTS.length];
    const { side, bay, span } = layout.slot;
    const sx = side === "east" ? 1 : -1;
    const hallHalf = LAYOUT.HALL_W / 2;
    const W = LAYOUT.ROOM_W;
    const z0 = bay * W;
    const z1 = (bay + span) * W;

    // ---- Prefab placements.
    const entry = bayFrame(side, bay);
    this.place("entry", entry);
    for (let k = 0; k < layout.capacity; k++)
      this.place("podBay", bayFrame(side, bay + 1 + k));
    const yaw = layout.yaw;
    this.place("endWall", { ox: sx * hallHalf, oz: z0 + 0.05, yaw });
    this.place("endWall", { ox: sx * hallHalf, oz: z1 - 0.05, yaw });
    for (const d of layout.dividers)
      this.place(
        "divider",
        { ox: d.position.x, oz: d.position.z, yaw: d.yaw },
        accent,
      );

    // ---- Colliders: floor, glazed front (door gap + solid pier/transom).
    const { colliders } = ctx;
    const g = this.group;
    colliders.addBox(
      g,
      new Vector3(layout.origin.x, -0.1, layout.origin.z),
      new Vector3(LAYOUT.ROOM_D, 0.2, z1 - z0),
    );
    const E = (lz: number) => toWorld(entry, 0, 0, lz).z;
    const dz = layout.door.z;
    const half = LAYOUT.DOOR_W / 2;
    const p0 = E(ENTRY.pierZ0);
    const p1 = E(ENTRY.pierZ1);
    partitionColliders(
      colliders,
      g,
      "z",
      sx * hallHalf,
      z0,
      z1,
      LAYOUT.WALL_H,
      { a0: dz - half, a1: dz + half, h: DOOR_H },
      [{ a0: Math.min(p0, p1), a1: Math.max(p0, p1) }],
    );
    colliders.addBox(
      g,
      new Vector3(sx * hallHalf, LAYOUT.WALL_H / 2, (p0 + p1) / 2),
      new Vector3(0.18, LAYOUT.WALL_H, Math.abs(p1 - p0)),
    );

    // ---- Plants: vacant pod bays get a planter pair; a hall planter at the far end.
    const place = (
      role: Parameters<AssetLibrary["instantiate"]>[0],
      x: number,
      y: number,
      z: number,
      yaw2: number,
      scale?: number,
    ) =>
      ctx.assets.instantiate(
        role,
        null,
        { position: { x, y, z }, yaw: yaw2, scale },
        { group: g },
      );
    layout.podBays.forEach((pb, k) => {
      if (pb.occupied) return;
      const f = podFrame(side, bay + 1 + k);
      for (const [lx, lz, tall] of [
        [-1.2, 3.2, true],
        [1.1, 5.6, false],
      ] as const) {
        const p = toWorld(f, lx, 0, lz);
        place(tall ? "planterTall" : "planter", p.x, 0, p.z, 0);
        place(
          tall ? "plantTall" : "plant",
          p.x,
          tall ? PLANTER_SOIL_Y.planterTall : PLANTER_SOIL_Y.planter,
          p.z,
          k * 1.7 + (tall ? 0.4 : 2.1),
        );
      }
    });
    {
      const hx = sx * (hallHalf - 0.55);
      const hz = z1 - 0.6;
      place("planter", hx, 0, hz, 0);
      place("plant", hx, PLANTER_SOIL_Y.planter, hz, bay * 1.3);
    }

    // ---- Door signage (hall side).
    const firstSession = layout.pods[0]?.sessionId ?? "";
    this.doorTarget = {
      kind: "door",
      sessionId: firstSession,
      roomLabel: layout.name,
    };
    this.infoTarget = {
      kind: "screen",
      sessionId: firstSession,
      roomLabel: layout.name,
    };
    const L = layout.led;
    this.led = new LedPanel(ctx.scene, {
      name: g,
      parent: this.root,
      x: L.position.x,
      y: L.position.y,
      z: L.position.z,
      yaw: L.yaw,
      width: L.width,
      height: L.height,
      interact: this.doorTarget,
      rows: 1,
    });
    ctx.fx?.addGlow(this.led.mesh);
    this.info = new ProjectInfoScreen(
      ctx.scene,
      layout.projectId.replace(/[^a-z0-9]+/gi, "_"),
      layout.infoScreen,
      this.infoTarget,
    );
    this.info.pivot.parent = this.root;
    this.led.set(
      projectLedContent(
        layout.name,
        layout.pods.map(() => "working"),
      ),
    );
  }

  /** Thin-instance one prefab at a frame and pick up its fixtures + colliders. */
  private place(kind: ShellKind, f: Frame, tint?: string): void {
    const { scene, materials, lighting, colliders, assets } = this.ctx;
    const mod = ShellModule.get(scene, materials, lighting, kind);
    this.releases.push(mod.add(frameMatrix(f), tint));
    for (const p of mod.parts) if (!this.parts.includes(p)) this.parts.push(p);
    for (const p of mod.localFixtures) {
      const w = toWorld(f, p.x, p.y, p.z);
      const spec = { ...p.spec };
      if (spec.size)
        spec.size = { ...spec.size, yaw: (spec.size.yaw ?? 0) + f.yaw };
      if (spec.dir) {
        const d = toWorld(
          { ox: 0, oz: 0, yaw: f.yaw },
          spec.dir.x,
          spec.dir.y,
          spec.dir.z,
        );
        spec.dir = new Vector3(d.x, d.y, d.z);
      }
      this.fixtures.push(new FixturePoint(w.x, w.y, w.z, spec));
    }
    for (const c of mod.colliders) {
      const w = toWorld(f, c.x, 0, c.z);
      colliders.addBox(
        this.group,
        new Vector3(w.x, c.size.y / 2, w.z),
        new Vector3(c.size.x * 0.9, c.size.y, c.size.z * 0.9),
        f.yaw + c.yaw,
      );
    }
    for (const pl of mod.plants) {
      const w = toWorld(f, pl.x, 0, pl.z);
      assets.instantiate(
        pl.role,
        null,
        {
          position: { x: w.x, y: pl.y ?? 0, z: w.z },
          yaw: f.yaw + pl.yaw,
          scale: pl.scale,
        },
        { group: this.group, collider: "none" },
      );
    }
  }

  /** Live sessions of this project in pod order (LED + info screen + targets). */
  setSessions(
    sessions: readonly CampusSession[],
    labels: ReadonlyMap<string, string>,
    name: string,
  ): void {
    this.name = name;
    const statuses: RoomStatus[] = sessions.map(roomStatus);
    this.led.set(projectLedContent(name, statuses));
    this.led.setPulse(statuses.includes("needs_you"));
    const { rows, more } = infoRows(sessions, labels, Date.now());
    this.info.setRows(rows, more);
    // Door / info screen act on the session that needs the user, else the first.
    const pick =
      sessions.find((s) => roomStatus(s) === "needs_you") ?? sessions[0];
    for (const t of [this.doorTarget, this.infoTarget]) {
      t.sessionId = pick?.sessionId ?? t.sessionId;
      t.roomLabel = name;
    }
  }

  get currentName(): string {
    return this.name;
  }

  distanceTo(p: { x: number; z: number }): number {
    const b = this.layout.bounds;
    const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
    const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
    return Math.hypot(dx, dz);
  }

  update(dt: number, eye: Vector3): void {
    // Signs face the hall: measure from the door, not the footprint.
    const d = Math.hypot(
      eye.x - this.layout.door.x,
      eye.z - this.layout.door.z,
    );
    const lod: Lod = d < NEAR ? "near" : d < MID ? "mid" : "far";
    if (lod !== this.lod) {
      this.lod = lod;
      this.led.setLod(lod);
      this.info.setLod(lod);
      this.info.pivot.setEnabled(lod !== "far");
    }
    this.led.update(dt);
  }

  getFixtures(): Vector3[] {
    return this.fixtures;
  }

  /** Static meshes for this room's control-room feed camera. */
  getRenderList(): AbstractMesh[] {
    return [
      ...this.parts,
      this.led.mesh,
      this.info.mesh,
      ...this.ctx.assets.allParts(),
    ];
  }

  dispose(): void {
    for (const r of this.releases) r();
    this.releases.length = 0;
    this.ctx.assets.disposeGroup(this.group);
    this.ctx.colliders.disposeGroup(this.group);
    this.led.dispose();
    this.info.dispose();
    this.root.dispose();
  }
}
