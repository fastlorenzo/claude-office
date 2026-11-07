/**
 * Centre-screen interaction probe (10 Hz). Picks meshes tagged
 * `metadata.interact`, occluded by opaque static colliders (glass is
 * see-through), within 3.5 m. Emits `interaction` on change, highlights the
 * target, and turns F / Enter (or `trigger()` from touch) into `action` events.
 */
import {
  Matrix,
  Scene,
  Vector3,
  type AbstractMesh,
  type Camera,
  type Mesh,
} from "@/engine/babylon";
import type {
  InteractionActionId,
  InteractionEvent,
  InteractionTarget,
  ScreenPos,
  WorldEvents,
} from "@/engine/contracts";
import { actionsFor, isInteractionTarget } from "@/engine/interaction/actions";
import type { PostFx } from "@/engine/fx/PostFx";
import { isStaticCollider } from "@/engine/physics/Colliders";
import { FocusFrame } from "@/engine/interaction/FocusFrame";
import type { Emitter } from "@/engine/util/Emitter";

export const INTERACT_RANGE = 3.5;
const PERIOD_MS = 100;

function targetOf(mesh: AbstractMesh | null): InteractionTarget | null {
  let n: AbstractMesh | null = mesh;
  // Walk up a few parents: character parts may carry metadata on an ancestor mesh.
  for (let i = 0; n && i < 4; i++) {
    const meta = n.metadata as { interact?: unknown } | null;
    if (meta && isInteractionTarget(meta.interact)) return meta.interact;
    n = n.parent as AbstractMesh | null;
  }
  return null;
}

function sameTarget(
  a: InteractionTarget | null,
  b: InteractionTarget | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.sessionId === b.sessionId &&
    (a.agentId ?? "") === (b.agentId ?? "")
  );
}

export class Interaction {
  private last = 0;
  private current: InteractionEvent | null = null;
  private currentMesh: AbstractMesh | null = null;
  enabled = true;
  private readonly frame: FocusFrame;

  constructor(
    private readonly scene: Scene,
    private readonly getCamera: () => Camera,
    private readonly fx: PostFx | null,
    private readonly events: Emitter<WorldEvents>,
    /** Player eye position (range is measured from here, not from the TP camera). */
    private readonly getEye: () => Vector3,
  ) {
    this.frame = new FocusFrame(scene);
  }

  update(nowMs: number): void {
    if (nowMs - this.last < PERIOD_MS) return;
    this.last = nowMs;
    if (!this.enabled) {
      this.set(null, null);
      return;
    }
    const engine = this.scene.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const cam = this.getCamera();
    const pick = this.scene.pick(
      w / 2,
      h / 2,
      (m) => {
        if (!m.isEnabled()) return false;
        const meta = m.metadata as {
          interact?: unknown;
          staticCollider?: boolean;
          seeThrough?: boolean;
        } | null;
        if (!meta) return false;
        // Interactables may be invisible pick proxies (characters): no visibility check.
        if (meta.interact) return m.isPickable;
        return isStaticCollider(meta) && !meta.seeThrough;
      },
      false,
      cam,
    );
    let target: InteractionTarget | null = null;
    let mesh: AbstractMesh | null = null;
    let distance = Infinity;
    if (pick?.hit && pick.pickedMesh) {
      target = targetOf(pick.pickedMesh);
      mesh = pick.pickedMesh;
      distance = pick.pickedPoint
        ? Vector3.Distance(pick.pickedPoint, this.getEye())
        : pick.distance;
    }
    if (!target || distance > INTERACT_RANGE) {
      this.set(null, null);
      return;
    }
    const screenPos = this.project(mesh!);
    if (sameTarget(target, this.current?.target ?? null)) {
      if (this.current) {
        this.current.screenPos = screenPos;
        this.current.distance = distance;
      }
      return;
    }
    this.set(
      { target, actions: actionsFor(target), screenPos, distance },
      mesh,
    );
  }

  private set(ev: InteractionEvent | null, mesh: AbstractMesh | null): void {
    if (!ev && !this.current) return;
    this.current = ev;
    if (mesh !== this.currentMesh) {
      this.currentMesh = mesh;
      // Characters (opaque, volumetric): subtle outer glow only.
      // Flat screens/boards/nameplates: a thin frame — never touch their material.
      const isCharacter = ev?.target.kind === "character";
      this.fx?.setHighlight(
        mesh && ev && isCharacter ? collectTargetMeshes(mesh, ev.target) : [],
        "#F5C9A8",
      );
      this.frame.show(mesh && ev && !isCharacter ? mesh : null);
      this.fx?.suppressGlow(
        mesh && !isCharacter && mesh.getClassName() === "Mesh"
          ? (mesh as Mesh)
          : null,
      );
    }
    this.events.emit("interaction", ev);
  }

  private project(mesh: AbstractMesh): ScreenPos {
    const engine = this.scene.getEngine();
    const cam = this.getCamera();
    const centre = mesh.getBoundingInfo().boundingSphere.centerWorld;
    const vp = cam.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    const p = Vector3.Project(
      centre,
      Matrix.IdentityReadOnly,
      this.scene.getTransformMatrix(),
      vp,
    );
    const canvas = engine.getRenderingCanvas();
    const sx = canvas ? canvas.clientWidth / engine.getRenderWidth() : 1;
    const sy = canvas ? canvas.clientHeight / engine.getRenderHeight() : 1;
    return { x: p.x * sx, y: p.y * sy };
  }

  get target(): InteractionEvent | null {
    return this.current;
  }

  /** F / Enter / touch button. Returns true when an action was emitted. */
  trigger(id: InteractionActionId | "primary"): boolean {
    const cur = this.current;
    if (!cur) return false;
    const action =
      id === "primary" ? cur.actions[0] : cur.actions.find((a) => a.id === id);
    if (!action) return false;
    this.events.emit("action", {
      action: action.id,
      target: cur.target,
      screenPos: cur.screenPos,
    });
    return true;
  }

  dispose(): void {
    this.fx?.setHighlight([], "#ffffff");
    this.frame.dispose();
    this.current = null;
    this.currentMesh = null;
  }
}

function collectTargetMeshes(
  hit: AbstractMesh,
  target: InteractionTarget,
): AbstractMesh[] {
  if (target.kind !== "character") return [hit];
  // Highlight every sibling part of the character that carries the same target.
  const out: AbstractMesh[] = [];
  const scope = (hit.parent ?? hit) as AbstractMesh;
  const all = [
    hit,
    ...(scope.getChildMeshes ? scope.getChildMeshes(false) : []),
  ];
  for (const m of all) {
    const t = targetOf(m);
    if (t && sameTarget(t, target) && !out.includes(m)) out.push(m);
  }
  return out.length ? out : [hit];
}
