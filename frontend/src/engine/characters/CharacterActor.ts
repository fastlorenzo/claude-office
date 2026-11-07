/**
 * A character living in a session room: owns a rig, walks scripted paths
 * (door → desk, desk → boss → desk, desk → door → outside), sits, mirrors the
 * backend state as a pose, and keeps its nameplate / bubble up to date.
 */

import {
  AbstractMesh,
  CreateCylinder,
  Scene,
  TransformNode,
  type Vector3,
} from "../babylon";
import type { CharacterPose, RoomLayout, Vec3 } from "../contracts";
import type { Agent, AgentState, BossState, BubbleContent } from "@/types";
import type { Boss1 as Boss } from "@/types/generated";
import { agentLocomotion, agentPose, bossPose } from "../logic/status";
import {
  buildPath,
  dampAngle,
  PathFollower,
  type PathPoint,
} from "../logic/motion";
import type { LabelLayer } from "../screens/LabelLayer";
import { ActorHub, type HubActor } from "./ActorHub";
import type { ActorTier } from "./lod";
import { MannequinRig } from "./MannequinRig";
import { tryCreateGltfRig } from "./GltfRig";
import { agentStateLabel, bossStateLabel } from "./identity";
import { isSeatedPose, smoothstep } from "./poses";
import type { CharacterRig, Lod } from "./types";

export interface ActorContext {
  scene: Scene;
  room: RoomLayout;
  /** Desk slot (0-based); boss: null → boss desk. */
  deskIndex: number | null;
  addShadowCaster(mesh: AbstractMesh): void;
  labels: LabelLayer;
}

export interface ActorOptions {
  id: string;
  kind: "boss" | "agent";
  color: string;
  name: string;
  sessionId: string;
  roomLabel: string;
}

const WALK_SPEED = 1.35;
const SIT_SEC = 0.95;
const RISE_SEC = 0.75;
const BOSS_VISIT_SEC = 2.6;
const FADE_SEC = 0.5;

type Phase =
  | { k: "idle" } // standing still at loc (or seated if loc is the own seat)
  | { k: "walk"; follower: PathFollower; to: PathPoint }
  | { k: "sit"; t: number; from: Vec3; to: Vec3; yaw: number }
  | { k: "rise"; t: number; from: Vec3; to: Vec3; then: () => void }
  | { k: "visit"; t: number }
  | { k: "fade"; t: number; then: () => void };

const samePoint = (a: PathPoint, b: PathPoint): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.desk === b.desk;

export class CharacterActor implements HubActor {
  readonly root: TransformNode;
  private readonly ctx: ActorContext;
  private readonly opts: ActorOptions;
  private readonly rig: CharacterRig;
  private readonly labelId: string;
  private readonly pickProxy: AbstractMesh;
  private readonly floorY: number;
  private desk: number; // own desk index (agents)
  private loc: PathPoint = "outside";
  private goal: PathPoint;
  private seated = false;
  private phase: Phase = { k: "idle" };
  private yaw = 0;
  private seatedPose: CharacterPose = "sitting";
  private standingPose: CharacterPose = "idle";
  private bossVisitDone = false;
  private departing: (() => void) | null = null;
  private gone = false;
  private lod: Lod | null = null;
  private tier: ActorTier = "near";
  private vis = 1;
  private readonly hub: ActorHub;
  private bubbleKey = "";
  private stateLabel = "";
  private color: string;
  private disposed = false;
  private fadeIn = 1;
  private yawTarget: number | null = null;

  constructor(ctx: ActorContext, opts: ActorOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.color = opts.color;
    this.labelId = `${opts.sessionId}/${opts.id}`;
    this.floorY = ctx.room.origin.y;
    this.desk = clampDesk(ctx.deskIndex ?? 0);
    this.goal = this.isBoss ? "boss" : { desk: this.desk };

    const rigOpts = {
      id: `${opts.sessionId}_${opts.id}`,
      boss: this.isBoss,
      color: opts.color,
    };
    this.rig =
      tryCreateGltfRig(ctx.scene, rigOpts) ??
      new MannequinRig(ctx.scene, rigOpts);
    this.root = this.rig.root;

    const interact = {
      kind: "character" as const,
      sessionId: opts.sessionId,
      agentId: this.isBoss ? "boss" : opts.id,
      roomLabel: opts.roomLabel,
    };
    const register = (meshes: AbstractMesh[]) => {
      for (const m of meshes) {
        m.metadata = { ...(m.metadata ?? {}), interact };
        m.isPickable = true;
        ctx.addShadowCaster(m);
      }
    };
    register(this.rig.getMeshes());
    // glTF rigs swap from the fallback mannequin to the avatar once loaded.
    const swappable = this.rig as CharacterRig & {
      meshesChanged?: ((m: AbstractMesh[]) => void) | null;
    };
    if ("meshesChanged" in swappable) {
      swappable.meshesChanged = (meshes) => {
        register(meshes);
        this.setVisibility(this.gone ? 0 : this.fadeIn);
      };
    }
    // Cheap, pose-independent pick volume (skinned meshes pick in rest pose).
    this.pickProxy = CreateCylinder(
      `charPick_${this.labelId}`,
      { height: 1.7, diameter: 0.62, tessellation: 8 },
      ctx.scene,
    );
    this.pickProxy.parent = this.root;
    this.pickProxy.position.set(0, 0.85, 0.1);
    this.pickProxy.isVisible = false;
    this.pickProxy.isPickable = true;
    this.pickProxy.metadata = { interact };

    ctx.labels.attach(this.labelId, this.rig.headAnchor, {
      title: opts.name,
      subtitle: "",
      color: this.isBoss ? "#D97757" : opts.color,
    });
    this.hub = ActorHub.get(ctx.scene);
    this.hub.add(this);
  }

  // --- HubActor -----------------------------------------------------------

  get sessionId(): string {
    return this.opts.sessionId;
  }

  get feet(): Vector3 {
    return this.root.position;
  }

  get tintHex(): string {
    return this.isBoss ? "#D97757" : this.color;
  }

  get seatedNow(): boolean {
    return this.seated || this.phase.k === "sit";
  }

  get presence(): number {
    return this.vis;
  }

  get isGone(): boolean {
    return this.gone || this.disposed;
  }

  shadowMeshes(): AbstractMesh[] {
    return this.rig.getMeshes();
  }

  /** LOD tier from the ActorHub: enable / disable the skinned mesh. */
  applyTier(tier: ActorTier): void {
    if (this.disposed) return;
    this.tier = tier;
    const show = tier === "near" || tier === "mid";
    this.root.setEnabled(show);
    this.rig.setDetail?.(tier === "near");
    this.ctx.labels.setVisible(this.labelId, tier === "near" && !this.gone);
  }

  private get isBoss(): boolean {
    return this.opts.kind === "boss";
  }

  /** Place the character: "door" walks in from the hall, "seat" starts seated. */
  spawn(at: "door" | "seat"): void {
    if (at === "seat" || this.isBoss) {
      this.placeSeated();
      return;
    }
    this.seated = false;
    this.loc = "outside";
    const p = this.ctx.room.doorOutside;
    this.setRootPos(p);
    this.yaw = yawTo(p, this.ctx.room.door);
    this.root.rotation.y = this.yaw;
    this.rig.setPose("idle", 0);
    this.setVisibility(0);
    this.fadeIn = 0;
    this.phase = { k: "idle" };
    this.evaluate();
  }

  setAgent(agent: Agent): void {
    if (this.disposed || this.isBoss) return;
    if (agent.color && agent.color !== this.color) {
      this.color = agent.color;
      this.rig.setTint(agent.color);
      this.ctx.labels.update(this.labelId, { color: agent.color });
    }
    if (agent.name && agent.name !== this.opts.name) {
      this.opts.name = agent.name;
      this.ctx.labels.update(this.labelId, { title: agent.name });
    }
    this.setStateLabel(agentStateLabel(agent.state));
    this.setBubble(agent.bubble ?? null);

    const pose = agentPose(agent.state);
    this.seatedPose = isSeatedPose(pose) ? pose : "sitting";
    this.standingPose =
      agent.state === "waiting_permission" ? "raiseHand" : "idle";

    const deskFromAgent =
      typeof agent.desk === "number" && agent.desk >= 1
        ? clampDesk(agent.desk - 1)
        : this.desk;
    if (deskFromAgent !== this.desk) {
      this.desk = deskFromAgent;
    }
    if (!this.departing) this.goal = this.goalFor(agent.state);
    this.applyRestPose();
    this.evaluate();
  }

  setBoss(boss: Boss): void {
    if (this.disposed) return;
    this.setStateLabel(bossStateLabel(boss.state as BossState));
    this.setBubble(boss.bubble ?? null);
    this.seatedPose = bossPose(boss.state as BossState);
    if (!isSeatedPose(this.seatedPose)) this.seatedPose = "sitting";
    this.applyRestPose();
  }

  /** Walk out through the door, fade, then call onDone. */
  depart(onDone: () => void): void {
    if (this.disposed || this.gone) {
      onDone();
      return;
    }
    this.departing = onDone;
    this.goal = "outside";
    this.ctx.labels.setBubble(this.labelId, null);
    this.evaluate();
  }

  update(dt: number, lod: Lod): void {
    if (this.disposed) return;
    // The ActorHub owns the tier (distance to the eye); the room LOD is only a
    // fallback until the hub has assigned one.
    void lod;
    const eff: Lod =
      this.tier === "near" ? "near" : this.tier === "mid" ? "mid" : "far";
    this.lod = eff;
    this.step(Math.max(0, Math.min(dt, 0.25)));
    this.rig.update(dt, eff);
  }

  getHeadAnchor(): TransformNode {
    return this.rig.headAnchor;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.remove(this);
    this.ctx.labels.detach(this.labelId);
    this.pickProxy.dispose();
    this.rig.dispose();
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  private goalFor(state: AgentState): PathPoint {
    const loco = agentLocomotion(state);
    if (loco !== "toBoss") this.bossVisitDone = false;
    switch (loco) {
      case "toBoss":
        return this.bossVisitDone ? { desk: this.desk } : "boss";
      case "toDoor":
      case "atDoor":
        return "door";
      default:
        return { desk: this.desk };
    }
  }

  private ownSeat(): { seat: Vec3; approach: Vec3; yaw: number } {
    const d = this.isBoss
      ? this.ctx.room.bossDesk
      : this.ctx.room.desks[this.desk];
    return { seat: d.seat, approach: d.approach, yaw: d.yaw };
  }

  private placeSeated(): void {
    const s = this.ownSeat();
    this.setRootPos(s.seat);
    this.yaw = s.yaw;
    this.root.rotation.y = s.yaw;
    this.seated = true;
    this.loc = this.isBoss ? "boss" : { desk: this.desk };
    this.phase = { k: "idle" };
    this.rig.setMoving(0);
    this.rig.setPose(this.seatedPose, 0);
    this.setVisibility(1);
  }

  private applyRestPose(): void {
    if (this.phase.k !== "idle" && this.phase.k !== "visit") return;
    this.rig.setPose(this.seated ? this.seatedPose : this.standingPose, 0.4);
  }

  /** Start the next leg of the journey if idle and not at the goal. */
  private evaluate(): void {
    if (this.disposed || this.gone || this.isBoss) return;
    if (this.phase.k !== "idle") return;
    const atOwnDesk =
      typeof this.loc !== "string" && this.loc.desk === this.desk;
    if (samePoint(this.loc, this.goal)) {
      if (typeof this.goal !== "string" && atOwnDesk && !this.seated)
        this.beginSit();
      else if (this.goal === "outside" && this.departing) this.beginFadeOut();
      return;
    }
    if (this.seated) {
      const s = this.ownSeatFor(this.loc);
      this.seated = false;
      this.rig.setPose("idle", RISE_SEC * 0.9);
      this.phase = {
        k: "rise",
        t: 0,
        from: s.seat,
        to: s.approach,
        then: () => this.beginWalk(),
      };
      return;
    }
    this.beginWalk();
  }

  private ownSeatFor(p: PathPoint): { seat: Vec3; approach: Vec3 } {
    if (typeof p !== "string") {
      const d = this.ctx.room.desks[p.desk];
      return { seat: d.seat, approach: d.approach };
    }
    const b = this.ctx.room.bossDesk;
    return { seat: b.seat, approach: b.approach };
  }

  private beginWalk(): void {
    let path = buildPath(this.ctx.room, this.loc, this.goal);
    // Seat points are handled by the sit / rise transitions.
    if (typeof this.loc !== "string") path = path.slice(1);
    if (typeof this.goal !== "string") path = path.slice(0, -1);
    path = path.map((p) => ({ x: p.x, y: this.floorY, z: p.z }));
    const here = this.root.position;
    if (
      path.length === 0 ||
      Math.hypot(path[0].x - here.x, path[0].z - here.z) > 0.05
    ) {
      path.unshift({ x: here.x, y: this.floorY, z: here.z });
    }
    this.phase = {
      k: "walk",
      follower: new PathFollower(path, WALK_SPEED),
      to: this.goal,
    };
    this.rig.setPose("walking", 0.3);
    this.rig.setMoving(WALK_SPEED);
  }

  private beginSit(): void {
    const s = this.ownSeat();
    const from = {
      x: this.root.position.x,
      y: this.floorY,
      z: this.root.position.z,
    };
    this.phase = { k: "sit", t: 0, from, to: s.seat, yaw: s.yaw };
    this.rig.setMoving(0);
    this.rig.setPose(this.seatedPose, SIT_SEC * 0.9);
  }

  private beginFadeOut(): void {
    this.rig.setMoving(0);
    this.rig.setPose("idle", 0.3);
    this.phase = {
      k: "fade",
      t: 0,
      then: () => {
        this.gone = true;
        this.vis = 0;
        this.ctx.labels.setVisible(this.labelId, false);
        const cb = this.departing;
        this.departing = null;
        cb?.();
      },
    };
  }

  private arrive(to: PathPoint): void {
    this.loc = to;
    this.rig.setMoving(0);
    this.phase = { k: "idle" };
    if (to === "boss") {
      // Face the boss and report for a moment.
      const b = this.ctx.room.bossDesk;
      this.yawTarget = yawTo(this.root.position, b.seat);
      this.rig.setPose("idle", 0.35);
      this.phase = { k: "visit", t: 0 };
      return;
    }
    if (typeof to === "string") {
      this.rig.setPose(this.standingPose, 0.35);
      if (to === "door")
        this.yawTarget = yawTo(this.ctx.room.door, this.ctx.room.origin);
    }
    this.evaluate();
  }

  private step(dt: number): void {
    const ph = this.phase;
    switch (ph.k) {
      case "walk": {
        const r = ph.follower.update(dt);
        this.setRootPos(r.position);
        this.yaw = dampAngle(this.yaw, r.yaw, 10, dt);
        this.yawTarget = null;
        if (r.done) this.arrive(ph.to);
        break;
      }
      case "sit": {
        ph.t += dt;
        const k = smoothstep(ph.t / SIT_SEC);
        this.setRootPos(lerpV(ph.from, ph.to, k));
        this.yaw = dampAngle(this.yaw, ph.yaw, 9, dt);
        if (ph.t >= SIT_SEC) {
          this.seated = true;
          this.yaw = ph.yaw;
          this.phase = { k: "idle" };
          this.evaluate();
        }
        break;
      }
      case "rise": {
        ph.t += dt;
        const k = smoothstep(ph.t / RISE_SEC);
        this.setRootPos(lerpV(ph.from, ph.to, k));
        if (ph.t >= RISE_SEC) {
          this.phase = { k: "idle" };
          ph.then();
        }
        break;
      }
      case "visit": {
        ph.t += dt;
        if (ph.t >= BOSS_VISIT_SEC) {
          this.phase = { k: "idle" };
          if (this.goal === "boss") {
            this.bossVisitDone = true;
            this.goal = { desk: this.desk };
          }
          this.evaluate();
        }
        break;
      }
      case "fade": {
        ph.t += dt;
        const k = Math.min(1, ph.t / FADE_SEC);
        this.setVisibility(1 - k);
        if (k >= 1) {
          this.phase = { k: "idle" };
          ph.then();
        }
        break;
      }
      case "idle":
        break;
    }
    if (this.fadeIn < 1 && this.phase.k !== "fade") {
      this.fadeIn = Math.min(1, this.fadeIn + dt / FADE_SEC);
      this.setVisibility(this.fadeIn);
    }
    if (this.yawTarget !== null)
      this.yaw = dampAngle(this.yaw, this.yawTarget, 6, dt);
    this.root.rotation.y = this.yaw;
  }

  private setRootPos(p: Vec3): void {
    this.root.position.set(p.x, this.floorY, p.z);
  }

  private setVisibility(v: number): void {
    this.vis = v;
    for (const m of this.rig.getMeshes()) {
      m.visibility = v;
      m.isVisible = v > 0.001;
    }
  }

  private setStateLabel(label: string): void {
    if (label === this.stateLabel) return;
    this.stateLabel = label;
    this.ctx.labels.update(this.labelId, { subtitle: label });
  }

  private setBubble(b: BubbleContent | null): void {
    const key = b
      ? `${b.type}|${b.icon ?? ""}|${b.text}|${b.persistent ? 1 : 0}`
      : "";
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    if (!this.departing) this.ctx.labels.setBubble(this.labelId, b);
  }
}

function clampDesk(i: number): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.floor(i) % 8;
}

function yawTo(
  from: { x: number; z: number },
  to: { x: number; z: number },
): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function lerpV(a: Vec3, b: Vec3, k: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
  };
}
