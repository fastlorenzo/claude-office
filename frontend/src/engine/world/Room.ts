/**
 * A session POD inside its project team room (Room = one session).
 *
 * Static furniture is the shared thin-instanced pod prefab (ProjectShell
 * "pod": bench of 8 desks + chairs, the lead's desk, nameplate post,
 * whiteboard stand, zone rug); colliders + desk plants are per pod. Live:
 * the lead's and subagents' monitors, the mobile whiteboard (todos), the pod
 * nameplate monitor (session name, summary, phase) and the characters. Live
 * state (label, status, monitor lines, todos, boss, agents) is cached so the
 * pod can be rebuilt.
 *
 * Pod frame (contracts): origin on the room's circulation spine at the pod
 * centre, +Z into the room, X along the hall.
 */
import {
  Mesh,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
} from "@/engine/babylon";
import type { CampusSession, RoomLayout, RoomStatus } from "@/engine/contracts";
import type { Agent, TodoItem } from "@/types";
import type { Boss1 as Boss } from "@/types/generated";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { CharacterActor } from "@/engine/characters/CharacterActor";
import type { Lod } from "@/engine/characters/types";
import type { Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { AgentMonitor, BossMonitor } from "@/engine/screens/Monitor";
import { DoorSign } from "@/engine/screens/DoorSign";
import type { LabelLayer } from "@/engine/screens/LabelLayer";
import { WhiteboardScreen } from "@/engine/screens/Whiteboard";
import { agentScreenText } from "@/engine/logic/monitorText";
import {
  formatElapsed,
  sessionPhase,
  sessionSummary,
} from "@/engine/logic/sessionInfo";
import { toWorld } from "@/engine/layout/buildingLayout";
import { frameMatrix, ShellModule } from "@/engine/world/ProjectShell";

export interface RoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
  labels: LabelLayer;
}

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
  private sign: DoorSign | null = null;
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

  private build(): void {
    const { scene, materials, assets, colliders, lighting } = this.ctx;
    const L = this.layout;
    const f = { ox: L.origin.x, oz: L.origin.z, yaw: L.yaw };
    // Static furniture: one shared thin-instanced prefab for all pods.
    const shell = ShellModule.get(scene, materials, lighting, "pod");
    this.releaseShell = shell.add(frameMatrix(f));
    this.statics.push(...shell.parts);
    for (const c of shell.colliders) {
      const w = toWorld(f, c.x, 0, c.z);
      colliders.addBox(
        this.group,
        new Vector3(w.x, c.size.y / 2, w.z),
        new Vector3(c.size.x * 0.9, c.size.y, c.size.z * 0.9),
        f.yaw + c.yaw,
      );
    }
    for (const pl of shell.plants) {
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

    // Pod nameplate monitor at the head of the bench (session name, summary, phase).
    this.sign = new DoorSign(scene, {
      position: L.sign.position,
      yaw: L.sign.yaw,
      width: L.sign.width,
      height: L.sign.height,
      sessionId: this.sessionId,
      roomLabel: this.label,
    });
    if (this.ctx.fx)
      for (const g of this.sign.getGlowMeshes()) this.ctx.fx.addGlow(g as Mesh);

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

  /** Campus data for the pod nameplate (name / summary / phase). */
  setCampus(cs: CampusSession): void {
    this.campus = cs;
    this.refreshSigns();
  }

  // -------------------------------------------------------------------------
  // Live state
  // -------------------------------------------------------------------------

  setLabel(label: string): void {
    if (label === this.label) return;
    this.label = label;
    this.refreshSigns();
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
    this.refreshSigns();
  }

  /** Pod nameplate (redraws only when its strings change). */
  private refreshSigns(): void {
    const cs = this.campus;
    const phase = cs ? sessionPhase(cs) : null;
    const elapsed = phase ? formatElapsed(phase.since, Date.now()) : null;
    const done = cs?.todos.filter((t) => t.status === "completed").length ?? 0;
    this.sign?.update({
      label: cs?.sessionName?.trim() || this.label,
      status: this.status,
      objective: cs ? sessionSummary(cs) : null,
      focus: phase
        ? [phase.label, phase.detail, elapsed].filter(Boolean).join(" · ")
        : null,
      todoDone: done,
      todoTotal: cs?.todos.length ?? 0,
      gitBranch: cs?.gitBranch ?? null,
      costUsd: cs?.telemetry?.costUsd ?? null,
      tokens: cs?.telemetry?.contextTokens ?? null,
    });
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
      this.sign?.setLod(lod);
      // The nameplate reads only up close; hide it beyond (3 draws per pod).
      for (const m of this.sign?.getMeshes() ?? [])
        m.setEnabled(lod === "near");
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
    if (this.sign) out.push(...this.sign.getMeshes());
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
    this.sign?.dispose();
    this.root.dispose();
  }
}
