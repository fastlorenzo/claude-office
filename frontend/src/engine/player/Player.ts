/**
 * The player: Havok `PhysicsCharacterController` (capsule 1.8 × 0.3) or a
 * `moveWithCollisions` fallback, one UniversalCamera with its inputs cleared,
 * first-person (eye 1.65 m, subtle head bob) and third-person (3 m boom,
 * 0.5 m up, shortened against static colliders) modes.
 */
import {
  CharacterSupportedState,
  CreateCapsule,
  Mesh,
  PhysicsCharacterController,
  Ray,
  Scene,
  UniversalCamera,
  Vector3,
  type AbstractMesh,
  type CharacterSurfaceInfo,
} from "@/engine/babylon";
import type { CameraMode } from "@/engine/contracts";
import type { InputController } from "@/engine/input/Input";
import {
  loadPose,
  POSE_RETRY_MS,
  POSE_SAVE_INTERVAL_MS,
  savePose,
  type SavedPose,
} from "@/engine/player/poseMemory";
import { isStaticCollider } from "@/engine/physics/Colliders";
import type { PlayerAvatar } from "@/engine/player/Avatar";

export const PLAYER = {
  capsuleHeight: 1.8,
  capsuleRadius: 0.3,
  eyeHeight: 1.65,
  walk: 2.6,
  sprint: 4.8,
  jump: 4.2,
  airControl: 0.2,
  accel: 14,
  fov: 1.2,
  pitchLimit: (85 * Math.PI) / 180,
  boomLength: 3,
  boomUp: 0.5,
} as const;

const GRAVITY = new Vector3(0, -9.81, 0);
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

export interface PlayerOptions {
  physics: boolean;
  spawn: Vector3;
  yaw: number;
  mode: CameraMode;
  headBob?: boolean;
}

export class Player {
  readonly camera: UniversalCamera;
  yaw: number;
  pitch = 0;
  mode: CameraMode;
  headBob: boolean;
  /** Freeze simulation (screenshot camera `?cam=`). */
  frozen = false;
  /** Horizontal speed this frame (m/s). */
  speed = 0;

  private cc: PhysicsCharacterController | null = null;
  private body: Mesh | null = null;
  private feet: Vector3;
  private vel = Vector3.Zero();
  private grounded = true;
  private bobPhase = 0;
  private bobAmount = 0;
  private boom: number = PLAYER.boomLength;
  private avatar: PlayerAvatar | null = null;
  private readonly tmpRay = new Ray(Vector3.Zero(), Vector3.Forward(), 1);
  /** Saved pose still waiting for a valid layout (applied at most once). */
  private pending: SavedPose | null = null;
  private pendingUntil = 0;
  private pendingOrigin = Vector3.Zero();
  private zoneOk: ((p: { x: number; y: number; z: number }) => boolean) | null =
    null;
  private lastSave = 0;
  private readonly flush = (): void => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    )
      return;
    this.savePoseNow();
  };

  constructor(
    private readonly scene: Scene,
    opts: PlayerOptions,
  ) {
    this.feet = opts.spawn.clone();
    this.yaw = opts.yaw;
    this.mode = opts.mode;
    this.headBob = opts.headBob ?? true;
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.flush);
      document.addEventListener("visibilitychange", this.flush);
    }

    const cam = new UniversalCamera(
      "player",
      this.feet.add(new Vector3(0, PLAYER.eyeHeight, 0)),
      scene,
    );
    cam.inputs.clear();
    cam.fov = PLAYER.fov;
    cam.minZ = 0.05;
    cam.maxZ = 220;
    cam.rotation.set(0, this.yaw, 0);
    this.camera = cam;
    scene.activeCamera = cam;

    if (opts.physics) {
      this.cc = new PhysicsCharacterController(
        this.feet.add(new Vector3(0, PLAYER.capsuleHeight / 2, 0)),
        {
          capsuleHeight: PLAYER.capsuleHeight,
          capsuleRadius: PLAYER.capsuleRadius,
        },
        scene,
      );
      this.cc.maxSlopeCosine = Math.cos((50 * Math.PI) / 180);
      this.cc.keepDistance = 0.05;
    } else {
      const body = CreateCapsule(
        "playerBody",
        { height: PLAYER.capsuleHeight, radius: PLAYER.capsuleRadius },
        scene,
      );
      body.isVisible = false;
      body.isPickable = false;
      body.checkCollisions = false;
      body.ellipsoid = new Vector3(
        PLAYER.capsuleRadius,
        PLAYER.capsuleHeight / 2,
        PLAYER.capsuleRadius,
      );
      body.position
        .copyFrom(this.feet)
        .addInPlace(new Vector3(0, PLAYER.capsuleHeight / 2, 0));
      this.body = body;
      scene.collisionsEnabled = true;
    }
  }

  setAvatar(avatar: PlayerAvatar | null): void {
    this.avatar?.dispose();
    this.avatar = avatar;
    this.avatar?.setVisible(this.mode === "tp");
  }

  get position(): Vector3 {
    return this.feet;
  }

  get avatarMeshes(): AbstractMesh[] {
    return this.avatar?.getMeshes() ?? [];
  }

  /**
   * Start from the remembered pose when it is fresh, on a walkable zone
   * (`zoneOk`) and has floor support; otherwise from `spawn`. If the layout
   * may still grow, an invalid pose is retried (once) for a few seconds
   * until the player moves.
   */
  restoreOr(
    spawn: { feet: Vector3; yaw: number },
    zoneOk: (p: { x: number; y: number; z: number }) => boolean,
  ): void {
    this.teleport(spawn.feet, spawn.yaw);
    const saved = loadPose();
    if (!saved || this.frozen) return;
    this.zoneOk = zoneOk;
    if (this.applySaved(saved)) return;
    this.pending = saved;
    this.pendingUntil = performance.now() + POSE_RETRY_MS;
    this.pendingOrigin.copyFrom(this.feet);
  }

  private applySaved(s: SavedPose): boolean {
    if (!this.zoneOk) return false;
    const floorY = this.floorBelow(s.x, s.y, s.z);
    if (floorY === null || Math.abs(floorY - s.y) > 0.6) return false;
    if (!this.zoneOk({ x: s.x, y: floorY + PLAYER.eyeHeight, z: s.z }))
      return false;
    this.teleport(new Vector3(s.x, floorY + 0.05, s.z), s.yaw);
    this.pitch = Math.max(
      -PLAYER.pitchLimit,
      Math.min(PLAYER.pitchLimit, s.pitch),
    );
    this.placeCamera(0);
    return true;
  }

  /** Static-collider floor under (x,z), searched from just above `y`. */
  private floorBelow(x: number, y: number, z: number): number | null {
    this.tmpRay.origin.set(x, y + 1, z);
    this.tmpRay.direction.copyFrom(DOWN);
    this.tmpRay.length = 3;
    const hit = this.scene.pickWithRay(this.tmpRay, (m) =>
      isStaticCollider(m.metadata),
    );
    return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : null;
  }

  private stepPending(): void {
    const s = this.pending;
    if (!s) return;
    const moved =
      Vector3.DistanceSquared(this.feet, this.pendingOrigin) > 0.04 ||
      this.speed > 0.1;
    if (moved || performance.now() > this.pendingUntil) {
      this.pending = null;
      return;
    }
    if (this.applySaved(s)) this.pending = null;
  }

  private savePoseNow(): void {
    if (this.pending || this.frozen) return;
    savePose({
      x: this.feet.x,
      y: this.feet.y,
      z: this.feet.z,
      yaw: this.yaw,
      pitch: this.pitch,
      mode: this.mode,
    });
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.avatar?.setVisible(mode === "tp");
    this.boom = 0.6;
  }

  teleport(feet: Vector3, yaw?: number): void {
    this.feet.copyFrom(feet);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = 0;
    this.vel.setAll(0);
    const centre = feet.add(new Vector3(0, PLAYER.capsuleHeight / 2, 0));
    if (this.cc) {
      this.cc.setPosition(centre);
      this.cc.setVelocity(Vector3.Zero());
    }
    if (this.body) this.body.position.copyFrom(centre);
    this.placeCamera(0);
  }

  /** Screenshot / debug placement: camera at an exact eye pose, simulation frozen. */
  setDebugCamera(eye: Vector3, yaw: number, pitch: number): void {
    this.frozen = true;
    this.yaw = yaw;
    this.pitch = pitch;
    this.feet.set(eye.x, eye.y - PLAYER.eyeHeight, eye.z);
    if (this.cc)
      this.cc.setPosition(
        this.feet.add(new Vector3(0, PLAYER.capsuleHeight / 2, 0)),
      );
    this.placeCamera(0);
  }

  update(dt: number, input: InputController | null): void {
    if (input) {
      const look = input.consumeLook();
      this.yaw += look.dx;
      this.pitch = Math.max(
        -PLAYER.pitchLimit,
        Math.min(PLAYER.pitchLimit, this.pitch + look.dy),
      );
    }
    if (!this.frozen) {
      const move = input ? input.moveAxis() : { x: 0, y: 0 };
      const sprint = input?.sprint ?? false;
      const jump = input?.consumeJump() ?? false;
      const sp = sprint ? PLAYER.sprint : PLAYER.walk;
      const fwd = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const desired = fwd
        .scale(move.y * sp)
        .addInPlace(right.scale(move.x * sp));
      if (this.cc) this.stepPhysics(dt, desired, jump);
      else this.stepFallback(dt, desired, jump);
      this.speed = Math.hypot(this.vel.x, this.vel.z);
    } else {
      this.speed = 0;
    }
    this.stepPending();
    if (!this.frozen && this.speed > 0.05) {
      const now = performance.now();
      if (now - this.lastSave >= POSE_SAVE_INTERVAL_MS) {
        this.lastSave = now;
        this.savePoseNow();
      }
    }
    if (this.avatar) {
      this.avatar.root.position.copyFrom(this.feet);
      this.avatar.root.rotation.y = this.yaw;
      this.avatar.setMoving(this.speed);
      if (this.mode === "tp") this.avatar.update(dt);
    }
    this.placeCamera(dt);
  }

  private stepPhysics(dt: number, desired: Vector3, jump: boolean): void {
    const cc = this.cc!;
    const support: CharacterSurfaceInfo = cc.checkSupport(dt, DOWN);
    const current = cc.getVelocity();
    const supported =
      support.supportedState === CharacterSupportedState.SUPPORTED;
    let out: Vector3;
    if (supported) {
      const fwd = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      out = cc.calculateMovement(
        dt,
        fwd,
        support.averageSurfaceNormal,
        current,
        support.averageSurfaceVelocity,
        desired,
        UP,
      );
      // Remove the component into the surface; keep us glued to the floor.
      out.subtractInPlace(support.averageSurfaceVelocity);
      const n = support.averageSurfaceNormal;
      const into = out.dot(n);
      if (into < 0) out.subtractInPlace(n.scale(into));
      out.addInPlace(support.averageSurfaceVelocity);
      if (jump) out.y = PLAYER.jump;
    } else {
      // Light air control: steer horizontal velocity, keep vertical + gravity.
      const h = new Vector3(current.x, 0, current.z);
      const target = desired.scale(1);
      h.addInPlace(
        target.subtract(h).scale(Math.min(1, PLAYER.airControl * dt * 10)),
      );
      out = new Vector3(h.x, current.y + GRAVITY.y * dt, h.z);
    }
    cc.setVelocity(out);
    cc.integrate(dt, support, GRAVITY);
    const p = cc.getPosition();
    this.feet.set(p.x, p.y - PLAYER.capsuleHeight / 2, p.z);
    this.vel.copyFrom(out);
    this.grounded = supported;
    // Safety net: fell out of the world.
    if (this.feet.y < -20) this.teleport(new Vector3(0, 0.2, -8), 0);
  }

  private stepFallback(dt: number, desired: Vector3, jump: boolean): void {
    const body = this.body!;
    const k =
      1 -
      Math.exp(
        -(this.grounded ? PLAYER.accel : PLAYER.accel * PLAYER.airControl) * dt,
      );
    this.vel.x += (desired.x - this.vel.x) * k;
    this.vel.z += (desired.z - this.vel.z) * k;
    // Ground probe against colliders.
    this.tmpRay.origin.copyFrom(body.position);
    this.tmpRay.direction.copyFrom(DOWN);
    this.tmpRay.length = PLAYER.capsuleHeight / 2 + 0.08;
    const hit = this.scene.pickWithRay(this.tmpRay, (m) =>
      isStaticCollider(m.metadata),
    );
    this.grounded = !!hit?.hit && this.vel.y <= 0.01;
    if (this.grounded) {
      this.vel.y = jump ? PLAYER.jump : 0;
    } else {
      this.vel.y += GRAVITY.y * dt;
    }
    body.moveWithCollisions(this.vel.scale(dt));
    this.feet.set(
      body.position.x,
      body.position.y - PLAYER.capsuleHeight / 2,
      body.position.z,
    );
    if (this.feet.y < -20) this.teleport(new Vector3(0, 0.2, -8), 0);
  }

  private placeCamera(dt: number): void {
    const cam = this.camera;
    cam.rotation.set(this.pitch, this.yaw, 0);
    if (this.mode === "fp") {
      const moving = this.grounded && this.speed > 0.3 && !this.frozen;
      this.bobAmount +=
        ((moving && this.headBob ? 1 : 0) - this.bobAmount) *
        Math.min(1, dt * 6);
      this.bobPhase += dt * (this.speed * 2.4);
      const bob = Math.sin(this.bobPhase * 2) * 0.022 * this.bobAmount;
      const sway = Math.cos(this.bobPhase) * 0.012 * this.bobAmount;
      cam.position.set(
        this.feet.x + Math.cos(this.yaw) * sway,
        this.feet.y + PLAYER.eyeHeight + bob,
        this.feet.z - Math.sin(this.yaw) * sway,
      );
      return;
    }
    // Third person boom.
    const pivot = this.feet.add(new Vector3(0, 1.55, 0));
    const dir = new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const back = dir.scale(-1);
    const offset = back
      .scale(PLAYER.boomLength)
      .addInPlace(new Vector3(0, PLAYER.boomUp, 0));
    const len = offset.length();
    const ray = new Ray(pivot, offset.normalizeToNew(), len);
    const hit = this.scene.pickWithRay(ray, (m) =>
      isStaticCollider(m.metadata),
    );
    const maxLen = hit?.hit ? Math.max(0.3, hit.distance - 0.25) : len;
    // Shorten instantly, extend smoothly.
    if (maxLen < this.boom) this.boom = maxLen;
    else this.boom += (maxLen - this.boom) * Math.min(1, dt * 4);
    const p = pivot.add(offset.normalizeToNew().scale(this.boom));
    cam.position.copyFrom(p);
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.flush);
      document.removeEventListener("visibilitychange", this.flush);
    }
    this.avatar?.dispose();
    this.avatar = null;
    this.body?.dispose();
    this.camera.dispose();
    // PhysicsCharacterController has no dispose in all versions; drop the ref.
    const cc = this.cc as unknown as { dispose?: () => void } | null;
    cc?.dispose?.();
    this.cc = null;
  }
}
