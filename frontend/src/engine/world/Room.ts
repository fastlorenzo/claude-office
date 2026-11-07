/**
 * A session room: glass-fronted office off the hall.
 *
 * Static shell (built in the room's local frame, merged per material):
 * warm plank floor, plaster ceiling with recessed light panels, a full-height
 * glazed front with aluminium mullions, a frosted privacy band and a door
 * gap, a charcoal pier carrying the nameplate, a per-room accent wall,
 * skirting. Furniture comes from the AssetLibrary (thin instances), screens
 * and characters from the actors agent's classes. Live state (label, status,
 * monitor lines, todos, boss, agents) is cached so the room can be rebuilt.
 *
 * Room local frame (contracts): X across the hall (door wall at -X), Z along
 * the hall, origin at the room centre on the floor.
 */
import {
  CreateCylinder,
  Mesh,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type DynamicTexture,
} from "@/engine/babylon";
import type {
  InteractionTarget,
  RoomLayout,
  RoomStatus,
  Vec3,
} from "@/engine/contracts";
import { LAYOUT, STATUS_COLORS } from "@/engine/contracts";
import type { Agent, TodoItem } from "@/types";
import type { Boss1 as Boss } from "@/types/generated";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { CharacterActor } from "@/engine/characters/CharacterActor";
import type { Lod } from "@/engine/characters/types";
import type { Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import {
  lin,
  type Materials,
  type SurfaceKey,
} from "@/engine/materials/Materials";
import { framedSink, type Colliders } from "@/engine/physics/Colliders";
import { AgentMonitor, BossMonitor } from "@/engine/screens/Monitor";
import type { LabelLayer } from "@/engine/screens/LabelLayer";
import { WhiteboardScreen } from "@/engine/screens/Whiteboard";
import { agentScreenText } from "@/engine/logic/monitorText";
import { MeshBatcher, v3 } from "@/engine/util/MeshBatcher";
import {
  ceilingPanels,
  drawNameplate,
  glassPartition,
  makeTexture,
  texturedPlane,
} from "@/engine/world/architecture";

export interface RoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
  labels: LabelLayer;
}

const ACCENTS = [
  "#8FA392",
  "#C79A7E",
  "#7D8FA6",
  "#CDB68E",
  "#A3907F",
  "#8E9C8A",
  "#B48C8C",
  "#7F9C9E",
];

const BOSS_COLOR = "#D97757";
const NEAR = 12;
const MID = 24;

export class Room {
  readonly sessionId: string;
  readonly root: TransformNode;
  private readonly ctx: RoomContext;
  private layout: RoomLayout;
  private label: string;
  private status: RoomStatus = "working";
  private selected = false;
  private readonly group: string;
  private readonly statics: Mesh[] = [];
  private readonly lampMat: PBRMaterial;
  private readonly lampMeshes: Mesh[] = [];
  private nameplateTex: DynamicTexture | null = null;
  private nameplate: Mesh | null = null;
  private bossMonitor: BossMonitor | null = null;
  private readonly agentMonitors: AgentMonitor[] = [];
  private whiteboard: WhiteboardScreen | null = null;
  private boss: CharacterActor | null = null;
  private readonly agents = new Map<
    string,
    { actor: CharacterActor; desk: number; data: Agent }
  >();
  private readonly departing = new Set<CharacterActor>();
  private lod: Lod | null = null;
  private pulse = 0;
  private readonly fixtures: Vector3[] = [];
  private lastLines: string[] = [];
  private lastTodos: TodoItem[] = [];
  private lastBoss: Boss | null = null;
  /** Character meshes; they cast shadows only while the room is NEAR. */
  private readonly casters = new Set<AbstractMesh>();

  constructor(ctx: RoomContext, layout: RoomLayout, label: string) {
    this.ctx = ctx;
    this.layout = layout;
    this.sessionId = layout.sessionId;
    this.label = label;
    this.group = `room:${layout.sessionId}`;
    this.root = new TransformNode(`room:${layout.sessionId}`, ctx.scene);
    this.root.position.set(layout.origin.x, layout.origin.y, layout.origin.z);
    this.root.rotation.y = layout.yaw;
    this.root.computeWorldMatrix(true);
    this.lampMat = ctx.materials.createEmissive(
      `lamp:${layout.sessionId}`,
      STATUS_COLORS.working,
      2.2,
    );
    this.build();
  }

  get roomLayout(): RoomLayout {
    return this.layout;
  }

  /** Local → world point. */
  private w(lx: number, y: number, lz: number): Vec3 {
    const c = Math.cos(this.layout.yaw);
    const s = Math.sin(this.layout.yaw);
    const o = this.layout.origin;
    return { x: o.x + lx * c + lz * s, y: o.y + y, z: o.z - lx * s + lz * c };
  }

  private build(): void {
    const { scene, materials, assets, colliders } = this.ctx;
    const L = this.layout;
    const hx = L.size.d / 2;
    const hz = L.size.w / 2;
    const H = L.size.h;
    const doorHalf = LAYOUT.DOOR_W / 2;
    const cols = framedSink(
      colliders,
      new Vector3(L.origin.x, L.origin.y, L.origin.z),
      L.yaw,
    );
    const b = new MeshBatcher(scene, materials, this.group);

    // Floor + ceiling
    b.box("floorRoom", v3(0, -0.05, 0), v3(hx * 2, 0.1, hz * 2));
    cols.addBox(
      this.group,
      new Vector3(0, -0.1, 0),
      new Vector3(hx * 2, 0.2, hz * 2),
    );
    b.box("ceiling", v3(0, H + 0.05, 0), v3(hx * 2, 0.1, hz * 2));
    const panels = ceilingPanels(
      b,
      -hx + 0.6,
      hx - 0.4,
      -hz + 0.6,
      hz - 0.6,
      H,
      { w: 0.6, d: 1.2 },
      { x: 3, z: 4 },
    );
    for (const p of panels) {
      const wp = this.w(p.x, p.y, p.z);
      this.fixtures.push(new Vector3(wp.x, wp.y, wp.z));
    }
    // Shadow-gap cove where ceiling meets the glass front.
    b.box("ceiling", v3(-hx + 0.2, H - 0.1, 0), v3(0.4, 0.2, hz * 2));

    // Glazed front (door wall at -X) with a solid pier for the nameplate.
    const pierZ0 = doorHalf + 0.25;
    const pierZ1 = pierZ0 + 1.0;
    glassPartition(
      b,
      cols,
      this.group,
      "z",
      -hx,
      -hz,
      hz,
      H - 0.2,
      { a0: -doorHalf, a1: doorHalf, h: 2.3 },
      {
        pitch: 1.3,
        frostBand: true,
        solid: [{ a0: pierZ0, a1: pierZ1, y0: 0, y1: H }],
      },
    );
    b.box(
      "charcoal",
      v3(-hx, (H - 0.2) / 2, (pierZ0 + pierZ1) / 2),
      v3(0.16, H - 0.2, pierZ1 - pierZ0),
    );
    cols.addBox(
      this.group,
      new Vector3(-hx, H / 2, (pierZ0 + pierZ1) / 2),
      new Vector3(0.16, H, pierZ1 - pierZ0),
    );
    // Header above the glazing (hall side bulkhead hides the ceiling edge).
    b.box("wall", v3(-hx, H - 0.1, 0), v3(0.16, 0.2, hz * 2));

    // Status: emissive bar over the door + round lamp (hall side).
    b.box(
      this.lampMat,
      v3(-hx - 0.085, 2.42, 0),
      v3(0.02, 0.035, LAYOUT.DOOR_W - 0.1),
      { keepUVs: true },
    );

    // Accent wall (+Z side) and skirting.
    const accent = ACCENTS[L.slot.index % ACCENTS.length];
    b.box(
      materials.color(accent, 0.85),
      v3(0.15, H / 2, hz - 0.012),
      v3(hx * 2 - 0.3, H, 0.024),
    );
    const sk: SurfaceKey = "charcoal";
    b.box(sk, v3(0.15, 0.04, hz - 0.03), v3(hx * 2 - 0.3, 0.08, 0.016));
    b.box(sk, v3(0.15, 0.04, -hz + 0.008), v3(hx * 2 - 0.3, 0.08, 0.016));
    b.box(sk, v3(hx - 0.008, 0.04, 0), v3(0.016, 0.08, hz * 2));

    const meshes = b.build({ parent: this.root, receiveShadows: true });
    for (const m of meshes)
      (m.material === this.lampMat ? this.lampMeshes : this.statics).push(m);

    // Lamp disc above the door (separate mesh so it can glow).
    const lamp = CreateCylinder(
      `${this.group}:lamp`,
      { height: 0.04, diameter: 0.16, tessellation: 24 },
      scene,
    );
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(-hx - 0.1, H - 0.48, 0);
    lamp.parent = this.root;
    lamp.material = this.lampMat;
    lamp.isPickable = false;
    this.lampMeshes.push(lamp);
    for (const m of this.lampMeshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
      this.ctx.fx?.addGlow(m);
    }

    // Nameplate on the pier (hall side) — also the "door" interactable.
    this.nameplateTex = makeTexture(
      scene,
      `${this.group}:np`,
      768,
      256,
      () => {},
    );
    const np = texturedPlane(
      scene,
      `${this.group}:nameplate`,
      this.nameplateTex,
      0.9,
      0.3,
      { emissive: 0.9 },
    );
    np.parent = this.root;
    np.position.set(-hx - 0.085, 2.05, (pierZ0 + pierZ1) / 2);
    np.rotation.y = Math.PI / 2; // face -X (hall)
    np.isPickable = true;
    const doorTarget: InteractionTarget = {
      kind: "door",
      sessionId: this.sessionId,
      roomLabel: this.label,
    };
    np.metadata = { interact: doorTarget };
    this.nameplate = np;
    this.redrawNameplate();

    // Furniture
    const place = (
      role: Parameters<AssetLibrary["instantiate"]>[0],
      lx: number,
      lz: number,
      localYaw: number,
      scale?: number | Vec3,
      y = 0,
    ) =>
      assets.instantiate(
        role,
        this.root,
        { position: { x: lx, y, z: lz }, yaw: localYaw, scale },
        { group: this.group },
      );
    const toLocal = (p: Vec3) => {
      const c = Math.cos(L.yaw);
      const s = Math.sin(L.yaw);
      const dx = p.x - L.origin.x;
      const dz = p.z - L.origin.z;
      return { x: dx * c - dz * s, z: dx * s + dz * c };
    };
    const bd = toLocal(L.bossDesk.position);
    const bossYaw = L.bossDesk.yaw - L.yaw;
    place("execDesk", bd.x, bd.z, bossYaw);
    const bs = toLocal(L.bossDesk.seat);
    place("taskChair", bs.x, bs.z, bossYaw);
    // Laptop + notes on the boss desk (to the boss's right).
    const r = { x: Math.cos(bossYaw), z: -Math.sin(bossYaw) };
    const f = { x: Math.sin(bossYaw), z: Math.cos(bossYaw) };
    place(
      "laptop",
      bd.x + r.x * 0.6 - f.x * 0.05,
      bd.z + r.z * 0.6 - f.z * 0.05,
      bossYaw - 0.35,
      undefined,
      0.75,
    );
    place(
      "plantSmall",
      bd.x - r.x * 0.75 + f.x * 0.2,
      bd.z - r.z * 0.75 + f.z * 0.2,
      0,
      undefined,
      0.75,
    );

    L.desks.forEach((d, i) => {
      const p = toLocal(d.position);
      const yaw = d.yaw - L.yaw;
      place("workDesk", p.x, p.z, yaw);
      const s = toLocal(d.seat);
      place("taskChair", s.x, s.z, yaw + (((i * 37) % 7) - 3) * 0.04);
      const dr = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const df = { x: Math.sin(yaw), z: Math.cos(yaw) };
      if (i % 3 === 0)
        place(
          "plantSmall",
          p.x + dr.x * 0.55 + df.x * 0.15,
          p.z + dr.z * 0.55 + df.z * 0.15,
          i,
          undefined,
          0.75,
        );
    });

    // Lounge by the glass front (+Z end), coffee point + shelves at the -Z end.
    place("sofa", -hx + 0.55, hz - 1.35, Math.PI / 2, 0.85);
    place("plant", -hx + 0.45, pierZ1 + 0.45, 0.4);
    place("shelves", -hx + 1.15, -hz + 0.3, Math.PI);
    place("coffeeCart", -hx + 0.42, -hz + 1.9, Math.PI / 2, 0.75);
    place("plantTall", hx - 0.45, hz - 0.45, 1.1);
    // Framed print beside the whiteboard.
    place("artPrint", 2.55, -hz + 0.04, Math.PI, undefined, 1.0);
    place("plant", hx - 0.45, -hz + 0.45, 2.3);

    // Screens (actors agent)
    const common = { sessionId: this.sessionId, roomLabel: this.label };
    this.bossMonitor = new BossMonitor(scene, {
      position: L.bossDesk.monitor.position,
      yaw: L.bossDesk.monitor.yaw,
      width: 0.62,
      height: 0.36,
      ...common,
    });
    for (const d of L.desks) {
      const m = new AgentMonitor(scene, {
        position: d.monitor.position,
        yaw: d.monitor.yaw,
        width: 0.52,
        height: 0.3,
        ...common,
      });
      m.setActive(false);
      this.agentMonitors.push(m);
    }
    if (this.ctx.fx) {
      for (const m of [this.bossMonitor, ...this.agentMonitors])
        for (const g of m.getGlowMeshes()) this.ctx.fx.addGlow(g);
    }
    this.whiteboard = new WhiteboardScreen(scene, {
      position: L.whiteboard.position,
      yaw: L.whiteboard.yaw,
      width: L.whiteboard.width,
      height: L.whiteboard.height,
      ...common,
    });
    this.applyStatus();
  }

  // -------------------------------------------------------------------------
  // Live state
  // -------------------------------------------------------------------------

  setLabel(label: string): void {
    if (label === this.label) return;
    this.label = label;
    this.redrawNameplate();
    if (this.nameplate) {
      const meta = this.nameplate.metadata as { interact: InteractionTarget };
      meta.interact = { ...meta.interact, roomLabel: label };
    }
  }

  setStatus(status: RoomStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.applyStatus();
    this.redrawNameplate();
  }

  get currentStatus(): RoomStatus {
    return this.status;
  }

  get currentLabel(): string {
    return this.label;
  }

  setSelected(sel: boolean): void {
    if (sel === this.selected) return;
    this.selected = sel;
    this.redrawNameplate();
  }

  setMonitorLines(lines: string[]): void {
    this.lastLines = lines;
    this.bossMonitor?.setLines(lines);
  }

  setTodos(todos: TodoItem[]): void {
    this.lastTodos = todos;
    this.whiteboard?.setTodos(todos);
  }

  setBoss(boss: Boss, atSeat = true): void {
    this.lastBoss = boss;
    if (!this.boss) {
      this.boss = new CharacterActor(this.actorCtx(null), {
        id: "boss",
        kind: "boss",
        color: BOSS_COLOR,
        name: "Claude",
        sessionId: this.sessionId,
        roomLabel: this.label,
      });
      this.boss.spawn(atSeat ? "seat" : "door");
      if (this.lod === "far") this.boss.root.setEnabled(false);
    }
    this.boss.setBoss(boss);
  }

  spawnAgent(agent: Agent, atSeat: boolean): void {
    if (this.agents.has(agent.id)) {
      this.updateAgent(agent);
      return;
    }
    const desk = this.pickDesk(agent);
    const actor = new CharacterActor(this.actorCtx(desk), {
      id: agent.id,
      kind: "agent",
      color: agent.color || "#6B8FB5",
      name: agent.name || `Agent ${agent.number}`,
      sessionId: this.sessionId,
      roomLabel: this.label,
    });
    actor.spawn(atSeat ? "seat" : "door");
    actor.setAgent(agent);
    if (this.lod === "far") actor.root.setEnabled(false);
    this.agents.set(agent.id, { actor, desk, data: agent });
    this.refreshAgentMonitor(desk, agent);
  }

  updateAgent(agent: Agent): void {
    const e = this.agents.get(agent.id);
    if (!e) {
      this.spawnAgent(agent, false);
      return;
    }
    e.data = agent;
    e.actor.setAgent(agent);
    this.refreshAgentMonitor(e.desk, agent);
  }

  departAgent(agentId: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    this.agents.delete(agentId);
    this.agentMonitors[e.desk]?.setActive(false);
    this.departing.add(e.actor);
    // Never let leavers pile up (slow frames / bursty feeds): drop the oldest.
    while (this.departing.size > 3) {
      const oldest = this.departing.values().next().value as CharacterActor;
      this.departing.delete(oldest);
      oldest.dispose();
    }
    e.actor.depart(() => {
      this.departing.delete(e.actor);
      e.actor.dispose();
    });
  }

  private pickDesk(agent: Agent): number {
    const used = new Set([...this.agents.values()].map((a) => a.desk));
    const want = typeof agent.desk === "number" ? agent.desk - 1 : -1;
    if (want >= 0 && want < this.layout.desks.length && !used.has(want))
      return want;
    for (let i = 0; i < this.layout.desks.length; i++)
      if (!used.has(i)) return i;
    return Math.max(0, Math.min(this.layout.desks.length - 1, want));
  }

  private refreshAgentMonitor(desk: number, agent: Agent): void {
    const m = this.agentMonitors[desk];
    if (!m) return;
    m.setActive(true);
    m.setText(agentScreenText(agent), agent.color || "#6B8FB5");
  }

  private actorCtx(deskIndex: number | null) {
    return {
      scene: this.ctx.scene,
      room: this.layout,
      deskIndex,
      addShadowCaster: (m: AbstractMesh) => {
        this.casters.add(m);
        m.onDisposeObservable.addOnce(() => this.casters.delete(m));
        if (this.lod === "near") this.ctx.lighting.addShadowCaster(m);
      },
      labels: this.ctx.labels,
    };
  }

  private applyStatus(): void {
    this.lampMat.emissiveColor = lin(STATUS_COLORS[this.status]);
    this.lampMat.emissiveIntensity = this.status === "ended" ? 0.4 : 2.2;
  }

  private redrawNameplate(): void {
    const tex = this.nameplateTex;
    if (!tex) return;
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    drawNameplate(
      ctx,
      768,
      256,
      this.label,
      this.layout.slot.index,
      STATUS_COLORS[this.status],
      this.selected,
    );
    tex.update(true);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Distance from a point to the room's footprint (0 inside). */
  distanceTo(p: Vector3): number {
    const b = this.layout.bounds;
    const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
    const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
    return Math.hypot(dx, dz);
  }

  update(dt: number, eye: Vector3): void {
    const d = this.distanceTo(eye);
    const lod: Lod = d < NEAR ? "near" : d < MID ? "mid" : "far";
    if (lod !== this.lod) {
      this.lod = lod;
      this.bossMonitor?.setLod(lod);
      for (const m of this.agentMonitors) m.setLod(lod);
      this.whiteboard?.setLod(lod);
      // Far rooms: hide screens entirely; only near rooms cast character shadows.
      const show = lod !== "far";
      const screens = [
        this.bossMonitor?.screenMesh,
        ...this.agentMonitors.map((m) => m.screenMesh),
        this.whiteboard?.mesh,
      ];
      for (const m of screens)
        if (m) ((m.parent as TransformNode | null) ?? m).setEnabled(show);
      for (const c of this.casters) {
        if (lod === "near") this.ctx.lighting.addShadowCaster(c);
        else this.ctx.lighting.removeShadowCaster(c);
      }
    }
    if (this.status === "needs_you") {
      this.pulse += dt;
      this.lampMat.emissiveIntensity = 1.4 + Math.sin(this.pulse * 5) * 1.1;
    }
    this.boss?.update(dt, lod);
    for (const a of this.agents.values()) a.actor.update(dt, lod);
    for (const a of this.departing) a.update(dt, lod);
  }

  getFixtures(): Vector3[] {
    return this.fixtures;
  }

  /** Meshes for this room's control-room feed camera. */
  getRenderList(): AbstractMesh[] {
    const out: AbstractMesh[] = [...this.statics, ...this.lampMeshes];
    out.push(...this.ctx.assets.allParts());
    if (this.bossMonitor) out.push(this.bossMonitor.screenMesh);
    for (const m of this.agentMonitors) out.push(m.screenMesh);
    if (this.whiteboard) out.push(this.whiteboard.mesh);
    const addActor = (a: CharacterActor) =>
      out.push(...a.root.getChildMeshes(false));
    if (this.boss) addActor(this.boss);
    for (const a of this.agents.values()) addActor(a.actor);
    return out;
  }

  /** Cached state, used to rebuild the room when its layout moves. */
  snapshot() {
    return {
      label: this.label,
      status: this.status,
      selected: this.selected,
      lines: this.lastLines,
      todos: this.lastTodos,
      boss: this.lastBoss,
      agents: [...this.agents.values()].map((a) => a.data),
    };
  }

  dispose(): void {
    this.ctx.assets.disposeGroup(this.group);
    this.ctx.colliders.disposeGroup(this.group);
    this.boss?.dispose();
    for (const a of this.agents.values()) a.actor.dispose();
    for (const a of this.departing) a.dispose();
    this.agents.clear();
    this.departing.clear();
    this.bossMonitor?.dispose();
    for (const m of this.agentMonitors) m.dispose();
    this.whiteboard?.dispose();
    for (const m of this.statics) m.dispose(false, false);
    for (const m of this.lampMeshes) m.dispose(false, false);
    this.nameplate?.material?.dispose();
    this.nameplate?.dispose();
    this.nameplateTex?.dispose();
    this.lampMat.dispose();
    this.root.dispose();
  }
}
