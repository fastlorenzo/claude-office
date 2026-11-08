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
  canSavePose,
  clearPose,
  isFallen,
  loadPose,
  POSE_RETRY_MS,
  POSE_SAVE_INTERVAL_MS,
  savePose,
  type SavedPose,
} from "@/engine/player/poseMemory";
import { Colliders, isStaticCollider } from "@/engine/physics/Colliders";
import type { PlayerAvatar } from "@/engine/player/Avatar";
import { FlyController, resolveLanding } from "@/engine/player/FlyCamera";

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
  /** No simulation until the world's colliders exist (see `markReady`). */
  private waiting = true;
  private spawnPose: { feet: Vector3; yaw: number } | null = null;
  /** Further safe spots for the fall net (reception, control room). */
  private fallbacks: { feet: Vector3; yaw: number }[] = [];
  /** Fell with no floored spawn anywhere: hold until one has a floor. */
  private stranded = false;
  private airborneOutside = 0;
  /** Free-fly / noclip camera (body frozen, never saved to the pose memory). */
  private readonly fly = new FlyController();
  private flyOn = false;

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

  get flying(): boolean {
    return this.flyOn;
  }

  /** Where the view is: the fly camera while flying, else the camera. */
  get flyPosition(): Vector3 {
    return this.camera.position;
  }

  /** Gate for fly-mode keys (false while a text field / modal / panel owns them). */
  setFlyKeyGate(fn: () => boolean): void {
    this.fly.enabled = fn;
  }

  /** Start flying from the current eye pose; the body stays put. */
  enterFly(): void {
    if (this.flyOn) return;
    this.flyOn = true;
    const p = this.camera.position;
    this.fly.start({ x: p.x, y: p.y, z: p.z }, this.yaw, this.pitch);
    this.avatar?.setVisible(true);
  }

  /**
   * Stop flying. `land` drops the body at the camera's x/z onto the nearest
   * floor below; with no (walkable) floor it falls back to returning to the
   * body. Returns whether the body was moved.
   */
  exitFly(land: boolean): boolean {
    if (!this.flyOn) return false;
    this.flyOn = false;
    const cam = { ...this.fly.pos };
    const yaw = this.fly.yaw;
    const pitch = this.fly.pitch;
    this.fly.stop();
    this.avatar?.setVisible(this.mode === "tp");
    this.boom = 0.6;
    if (land) {
      const spot = resolveLanding(cam, PLAYER.eyeHeight, {
        floorBelow: (x, y, z, reach) => {
          this.tmpRay.origin.set(x, y, z);
          this.tmpRay.direction.copyFrom(DOWN);
          this.tmpRay.length = reach;
          const hit = this.scene.pickWithRay(this.tmpRay, (m) =>
            isStaticCollider(m.metadata),
          );
          return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : null;
        },
        walkable: (p) => this.zoneOk?.(p) ?? true,
      });
      if (spot) {
        this.teleport(new Vector3(spot.x, spot.y, spot.z), yaw);
        this.pitch = pitch;
        this.placeCamera(0);
        return true;
      }
    }
    this.placeCamera(0);
    return false;
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
    this.spawnPose = { feet: spawn.feet.clone(), yaw: spawn.yaw };
    this.zoneOk = zoneOk;
    const saved = loadPose();
    if (!saved || this.frozen) return;
    if (this.applySaved(saved)) return;
    this.pending = saved;
    this.pendingUntil = performance.now() + POSE_RETRY_MS;
    this.pendingOrigin.copyFrom(this.feet);
  }

  /**
   * Move the spawn (e.g. once the entrance floor exists). The player follows
   * when still standing at the old spawn (no remembered pose applied).
   */
  setSpawn(spawn: { feet: Vector3; yaw: number }): void {
    const old = this.spawnPose;
    this.spawnPose = { feet: spawn.feet.clone(), yaw: spawn.yaw };
    if (this.frozen || !old) return;
    if (Vector3.DistanceSquared(this.feet, old.feet) < 0.04)
      this.teleport(spawn.feet, spawn.yaw);
  }

  /** Extra respawn spots the fall net tries (in order) after the spawn. */
  setFallbacks(list: { feet: Vector3; yaw: number }[]): void {
    this.fallbacks = list.map((f) => ({ feet: f.feet.clone(), yaw: f.yaw }));
  }

  /** First of spawn + fallbacks with floor support under it, or null. */
  private safeSpawn(): { feet: Vector3; yaw: number } | null {
    const all = [
      ...(this.spawnPose ? [this.spawnPose] : []),
      ...this.fallbacks,
    ];
    for (const c of all) {
      const fy = this.floorBelow(c.feet.x, c.feet.y, c.feet.z);
      if (fy !== null && Math.abs(fy - c.feet.y) < 0.6)
        return { feet: new Vector3(c.feet.x, fy + 0.05, c.feet.z), yaw: c.yaw };
    }
    return null;
  }

  /**
   * The world's colliders are built: start simulating. A pending saved pose
   * gets a fresh retry window now (the build may have taken longer than it).
   */
  markReady(): void {
    this.waiting = false;
    if (this.pending) {
      this.pendingUntil = performance.now() + POSE_RETRY_MS;
      this.pendingOrigin.copyFrom(this.feet);
      if (this.applySaved(this.pending)) this.pending = null;
    }
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
    if (this.flyOn || this.pending || this.frozen || this.waiting) return;
    if (!canSavePose({ grounded: this.grounded, y: this.feet.y })) return;
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
    this.avatar?.setVisible(mode === "tp" || this.flyOn);
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
    if (this.flyOn) {
      this.updateFly(dt, input);
      return;
    }
    if (input) {
      const look = input.consumeLook();
      this.yaw += look.dx;
      this.pitch = Math.max(
        -PLAYER.pitchLimit,
        Math.min(PLAYER.pitchLimit, this.pitch + look.dy),
      );
    }
    if (!this.frozen && !this.waiting && !this.stranded) {
      const move = input ? input.moveAxis() : { x: 0, y: 0 };
      const sprint = input?.sprint ?? false;
      const jump = input?.consumeJump() ?? false;
      const sp = sprint ? PLAYER.sprint : PLAYER.walk;
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      // fwd (sin, 0, cos) * move.y + right (cos, 0, -sin) * move.x
      const desired = this.sDesired.set(
        (sy * move.y + cy * move.x) * sp,
        0,
        (cy * move.y - sy * move.x) * sp,
      );
      if (this.cc) this.stepPhysics(dt, desired, jump);
      else this.stepFallback(dt, desired, jump);
      this.speed = Math.hypot(this.vel.x, this.vel.z);
      this.checkFall(dt);
    } else {
      this.speed = 0;
    }
    if (this.stranded) {
      const sp = this.safeSpawn();
      if (sp) {
        this.stranded = false;
        this.teleport(sp.feet, sp.yaw);
      }
    }
    if (!this.waiting) this.stepPending();
    if (!this.frozen && !this.waiting && this.speed > 0.05) {
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

  private updateFly(dt: number, input: InputController | null): void {
    if (input) {
      const look = input.consumeLook();
      this.fly.look(look.dx, look.dy);
      input.consumeJump();
    }
    if (!this.frozen) this.fly.update(dt);
    this.speed = 0;
    if (this.avatar) {
      this.avatar.root.position.copyFrom(this.feet);
      this.avatar.root.rotation.y = this.yaw;
      this.avatar.setMoving(0);
      this.avatar.update(dt);
    }
    this.camera.rotation.set(this.fly.pitch, this.fly.yaw, 0);
    this.camera.position.set(this.fly.pos.x, this.fly.pos.y, this.fly.pos.z);
  }

  /** Safety net: below the world, or airborne over "outside" too long. */
  private checkFall(dt: number): void {
    const outside =
      !this.grounded &&
      !!this.zoneOk &&
      !this.zoneOk({
        x: this.feet.x,
        y: this.feet.y + PLAYER.eyeHeight,
        z: this.feet.z,
      });
    this.airborneOutside = outside ? this.airborneOutside + dt : 0;
    if (!isFallen({ y: this.feet.y, airborneOutsideS: this.airborneOutside }))
      return;
    this.airborneOutside = 0;
    this.pending = null;
    clearPose();
    // Only respawn onto a spot with a floor under it (never loop into a void).
    const sp = this.safeSpawn();
    if (sp) {
      this.teleport(sp.feet, sp.yaw);
      return;
    }
    this.stranded = true;
    const f = this.spawnPose ?? this.fallbacks[0];
    this.teleport(f ? f.feet : new Vector3(0, 0.2, -8), f?.yaw ?? 0);
  }

  private stepPhysics(dt: number, desired: Vector3, jump: boolean): void {
    const cc = this.cc!;
    const support: CharacterSurfaceInfo = cc.checkSupport(dt, DOWN);
    const current = cc.getVelocity();
    const supported =
      support.supportedState === CharacterSupportedState.SUPPORTED;
    let out: Vector3;
    if (supported) {
      const fwd = this.sFwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
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
      if (into < 0) out.subtractInPlace(n.scaleToRef(into, this.sTmp));
      out.addInPlace(support.averageSurfaceVelocity);
      if (jump) out.y = PLAYER.jump;
    } else {
      // Light air control: steer horizontal velocity, keep vertical + gravity.
      const k = Math.min(1, PLAYER.airControl * dt * 10);
      const hx = current.x + (desired.x - current.x) * k;
      const hz = current.z + (desired.z - current.z) * k;
      out = this.sOut.set(hx, current.y + GRAVITY.y * dt, hz);
    }
    cc.setVelocity(out);
    cc.integrate(dt, support, GRAVITY);
    const p = cc.getPosition();
    this.feet.set(p.x, p.y - PLAYER.capsuleHeight / 2, p.z);
    this.vel.copyFrom(out);
    this.grounded = supported;
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
    body.moveWithCollisions(this.vel.scaleToRef(dt, this.sTmp));
    this.feet.set(
      body.position.x,
      body.position.y - PLAYER.capsuleHeight / 2,
      body.position.z,
    );
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
    // Third person boom (scratch vectors: no per-frame allocation).
    const pivot = this.sPivot.set(this.feet.x, this.feet.y + 1.55, this.feet.z);
    const cp = Math.cos(this.pitch);
    const offset = this.sOffset.set(
      -Math.sin(this.yaw) * cp * PLAYER.boomLength,
      Math.sin(this.pitch) * PLAYER.boomLength + PLAYER.boomUp,
      -Math.cos(this.yaw) * cp * PLAYER.boomLength,
    );
    const len = offset.length();
    const ray = this.boomRay;
    ray.origin.copyFrom(pivot);
    offset.scaleToRef(1 / Math.max(1e-6, len), ray.direction);
    ray.length = len;
    const dist = this.boomHit(ray);
    const maxLen = dist !== null ? Math.max(0.3, dist - 0.25) : len;
    // Shorten instantly, extend smoothly.
    if (maxLen < this.boom) this.boom = maxLen;
    else this.boom += (maxLen - this.boom) * Math.min(1, dt * 4);
    cam.position.set(
      pivot.x + ray.direction.x * this.boom,
      pivot.y + ray.direction.y * this.boom,
      pivot.z + ray.direction.z * this.boom,
    );
  }

  // Scratch for update / stepPhysics / placeCamera.
  private readonly sDesired = new Vector3();
  private readonly sFwd = new Vector3();
  private readonly sTmp = new Vector3();
  private readonly sOut = new Vector3();
  private readonly sPivot = new Vector3();
  private readonly sOffset = new Vector3();
  private readonly boomRay = new Ray(Vector3.Zero(), Vector3.Forward(), 1);
  private boomList: readonly AbstractMesh[] = [];
  private boomListN = -1;

  /**
   * Nearest opaque-collider hit along the third-person boom: intersects the
   * collider registry's occluder list (`Colliders.of(scene).occluders()`, as
   * Interaction does) instead of picking every mesh in the scene. Without a
   * registry, a cached filter of the scene's static colliders.
   */
  private boomHit(ray: Ray): number | null {
    const reg = Colliders.of(this.scene);
    if (reg) this.boomList = reg.occluders();
    else {
      const n = this.scene.meshes.length;
      if (n !== this.boomListN) {
        this.boomListN = n;
        this.boomList = this.scene.meshes.filter((m) =>
          isStaticCollider(m.metadata),
        );
      }
    }
    let best: number | null = null;
    for (const m of this.boomList) {
      if (m.isDisposed()) {
        this.boomListN = -1; // replaced collider: rebuild next frame
        continue;
      }
      const h = m.intersects(ray, false);
      if (h.hit && (best === null || h.distance < best)) best = h.distance;
    }
    return best;
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.flush);
      document.removeEventListener("visibilitychange", this.flush);
    }
    this.fly.stop();
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
