/**
 * A session room: glass-fronted office off the hall.
 *
 * Static shell (built in the room's local frame, merged per material):
 * warm plank floor, plaster ceiling with recessed light panels, a full-height
 * glazed front with aluminium mullions, a frosted privacy band and a door
 * gap, a graphite pier carrying the digital door sign, an LED panel over the
 * door (project + status in words), a per-room accent wall,
 * skirting. Furniture comes from the AssetLibrary (thin instances), screens
 * and characters from the actors agent's classes. Live state (label, status,
 * monitor lines, todos, boss, agents) is cached so the room can be rebuilt.
 *
 * Room local frame (contracts): X across the hall (door wall at -X), Z along
 * the hall, origin at the room centre on the floor.
 */
import {
  Mesh,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type DynamicTexture,
} from "@/engine/babylon";
import type {
  CampusSession,
  InteractionTarget,
  RoomLayout,
  RoomStatus,
  Vec3,
} from "@/engine/contracts";
import { LAYOUT } from "@/engine/contracts";
import type { Agent, TodoItem } from "@/types";
import type { Boss1 as Boss } from "@/types/generated";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { CharacterActor } from "@/engine/characters/CharacterActor";
import type { Lod } from "@/engine/characters/types";
import { FixturePoint, type Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import { framedSink, type Colliders } from "@/engine/physics/Colliders";
import { AgentMonitor, BossMonitor } from "@/engine/screens/Monitor";
import type { LabelLayer } from "@/engine/screens/LabelLayer";
import { WhiteboardScreen } from "@/engine/screens/Whiteboard";
import { agentScreenText } from "@/engine/logic/monitorText";
import {
  DOOR_BAND,
  DOOR_BAND_FACE,
  DOOR_H,
  FONT_STACK,
  makeTexture,
  partitionColliders,
  texturedPlane,
} from "@/engine/world/architecture";
import { RoomShellModule, ROOM_PIER } from "@/engine/world/RoomShell";
import {
  ledContent,
  roomSignData,
  type RoomSignData,
} from "@/engine/world/RoomSign";
import { LedPanel } from "@/engine/world/LedPanel";

export interface RoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
  labels: LabelLayer;
}

/** Muted felt colours (one per room, cycling): sage, clay, slate, sand, … */
const ACCENTS = [
  "#7F927F",
  "#A87E66",
  "#6C7C90",
  "#B3A07E",
  "#8C7D72",
  "#5F7470",
  "#9A7A7A",
  "#6F8A8E",
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
  private led: LedPanel | null = null;
  private doorTarget: InteractionTarget | null = null;
  private plaque: Mesh | null = null;
  private plaqueTex: DynamicTexture | null = null;
  private releaseShell: (() => void) | null = null;
  private campus: CampusSession | null = null;
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
    // Static architecture: one shared thin-instanced module for all rooms.
    const shell = RoomShellModule.get(scene, materials, this.ctx.lighting, L);
    const accent = ACCENTS[L.slot.index % ACCENTS.length];
    this.releaseShell = shell.add(this.root.computeWorldMatrix(true), accent);
    for (const p of shell.localFixtures) {
      const wp = this.w(p.x, p.y, p.z);
      const spec = { ...p.spec };
      if (spec.size)
        spec.size = { ...spec.size, yaw: (spec.size.yaw ?? 0) + L.yaw };
      this.fixtures.push(new FixturePoint(wp.x, wp.y, wp.z, spec));
    }
    this.statics.push(...shell.parts);
    const { z0: pierZ0, z1: pierZ1 } = ROOM_PIER;
    const pz = (pierZ0 + pierZ1) / 2;
    // Colliders (per room): floor, glazed front, pier.
    cols.addBox(
      this.group,
      new Vector3(0, -0.1, 0),
      new Vector3(hx * 2, 0.2, hz * 2),
    );
    partitionColliders(
      cols,
      this.group,
      "z",
      -hx,
      -hz,
      hz,
      H,
      {
        a0: -doorHalf,
        a1: doorHalf,
        h: DOOR_H,
      },
      [{ a0: pierZ0, a1: pierZ1 }],
    );
    cols.addBox(
      this.group,
      new Vector3(-hx, H / 2, pz),
      new Vector3(0.18, H, pierZ1 - pierZ0),
    );
    const doorTarget: InteractionTarget = {
      kind: "door",
      sessionId: this.sessionId,
      roomLabel: this.label,
    };
    this.doorTarget = doorTarget;
    // Digital LED panel recessed in the door header band (hall side): THE
    // room sign — project + status in words, summary ticker.
    this.led = new LedPanel(scene, {
      name: this.group,
      parent: this.root,
      x: -hx - DOOR_BAND_FACE - 0.004,
      y: DOOR_H + DOOR_BAND / 2,
      z: 0,
      yaw: Math.PI / 2,
      width: LAYOUT.DOOR_W - 0.2,
      height: DOOR_BAND - 0.07,
      interact: doorTarget,
    });
    this.ctx.fx?.addGlow(this.led.mesh);

    // Discreet room-number plaque at eye height on the pier.
    this.plaqueTex = makeTexture(
      scene,
      `${this.group}:plaque`,
      256,
      256,
      (c, w, h) => drawPlaque(c, w, h, L.slot.index + 1),
    );
    const plaque = texturedPlane(
      scene,
      `${this.group}:plaque`,
      this.plaqueTex,
      0.15,
      0.15,
      {
        lit: true,
        roughness: 0.4,
      },
    );
    plaque.parent = this.root;
    plaque.position.set(-hx - 0.105, 1.5, pz);
    plaque.rotation.y = Math.PI / 2;
    plaque.isPickable = true;
    plaque.metadata = { interact: doorTarget };
    this.plaque = plaque;

    // ---- Furniture: merged into the shell module; colliders + plants per room.
    for (const c of shell.colliders)
      cols.addBox(
        this.group,
        new Vector3(c.x, c.size.y / 2, c.z),
        new Vector3(c.size.x * 0.9, c.size.y, c.size.z * 0.9),
        c.yaw,
      );
    for (const pl of shell.plants)
      assets.instantiate(
        pl.role,
        this.root,
        {
          position: { x: pl.x, y: pl.y ?? 0, z: pl.z },
          yaw: pl.yaw,
          scale: pl.scale,
        },
        { group: this.group, collider: "none" },
      );

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

  /** Campus data for the door sign (summary / refs / phase / project). */
  setCampus(cs: CampusSession): void {
    this.campus = cs;
    this.refreshSigns();
  }

  private signData(): RoomSignData {
    return roomSignData(
      this.campus,
      this.label,
      this.layout.slot.index + 1,
      this.status,
      this.selected,
    );
  }

  // -------------------------------------------------------------------------
  // Live state
  // -------------------------------------------------------------------------

  setLabel(label: string): void {
    if (label === this.label) return;
    this.label = label;
    this.refreshSigns();
    if (this.doorTarget) this.doorTarget.roomLabel = label;
  }

  setStatus(status: RoomStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.applyStatus();
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
    this.refreshSigns();
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
    this.led?.setPulse(this.status === "needs_you");
    this.refreshSigns();
  }

  /** Door sign + LED panel (each redraws only when its strings change). */
  private refreshSigns(): void {
    const data = this.signData();
    this.led?.set(ledContent(data));
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
      this.led?.setLod(lod);
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
    this.led?.update(dt);
    this.boss?.update(dt, lod);
    for (const a of this.agents.values()) a.actor.update(dt, lod);
    for (const a of this.departing) a.update(dt, lod);
  }

  getFixtures(): Vector3[] {
    return this.fixtures;
  }

  /** Meshes for this room's control-room feed camera. */
  getRenderList(): AbstractMesh[] {
    const out: AbstractMesh[] = [...this.statics];
    if (this.led) out.push(this.led.mesh);
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
    // Statics are the shared shell module: release this room's instance only.
    this.releaseShell?.();
    this.releaseShell = null;
    this.led?.dispose();
    this.plaque?.material?.dispose();
    this.plaque?.dispose();
    this.plaqueTex?.dispose();
    this.root.dispose();
  }
}

/** Room-number plaque: brushed-dark plate, light numerals. */
function drawPlaque(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
): void {
  ctx.fillStyle = "#1A1B1E";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#EDE7DC";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `300 ${Math.round(h * 0.5)}px ${FONT_STACK}`;
  ctx.fillText(String(n).padStart(2, "0"), w / 2, h * 0.53);
  ctx.fillStyle = "#D97757";
  ctx.fillRect(w * 0.38, h * 0.84, w * 0.24, h * 0.025);
}
