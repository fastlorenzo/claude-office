/**
 * Free-fly / noclip camera. Pure helpers (speed modifiers, velocity
 * integration, "land here" resolution) plus a small stateful controller that
 * tracks its own keys (Ctrl / Alt are fly modifiers, so the shared Input
 * controller, which ignores chords, is not used for movement here).
 *
 * Keys (by `KeyboardEvent.code`): WASD / arrows move along the view
 * direction (pitch included), Space / E up, Ctrl / Q down, Shift x4,
 * Alt x0.25, wheel adjusts the base speed.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const FLY = {
  baseSpeed: 8,
  minSpeed: 0.5,
  maxSpeed: 80,
  fast: 4,
  slow: 0.25,
  /** Exponential smoothing rate (1/s) toward the wish velocity. */
  response: 9,
  /** Wheel notch (deltaY 100) scales the base speed by this factor. */
  wheelStep: 1.15,
  /** Longest "land here" ray (m). */
  landReach: 300,
  /** Interaction range while flying (m). */
  interactRange: 15,
  pitchLimit: (89 * Math.PI) / 180,
} as const;

export interface FlyAxes {
  /** +1 forward, -1 back. */
  fwd: number;
  /** +1 right, -1 left. */
  right: number;
  /** +1 up, -1 down (world axis). */
  up: number;
}

export interface FlyMods {
  shift: boolean;
  alt: boolean;
}

/** Shift = fast, Alt = slow; both cancel out. */
export function speedMultiplier(m: FlyMods): number {
  let k = 1;
  if (m.shift) k *= FLY.fast;
  if (m.alt) k *= FLY.slow;
  return k;
}

/** Wheel up (negative deltaY) speeds up, down slows; clamped. */
export function adjustBaseSpeed(base: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return base;
  const notches = Math.max(-5, Math.min(5, deltaY / 100));
  const next = base * Math.pow(FLY.wheelStep, -notches);
  return Math.min(FLY.maxSpeed, Math.max(FLY.minSpeed, next));
}

/** Unit view direction (yaw about +Y, positive pitch looks down, as Babylon). */
export function viewForward(yaw: number, pitch: number): V3 {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

/** Desired velocity: fly where you look, strafe on the horizontal. */
export function wishVelocity(
  axes: FlyAxes,
  yaw: number,
  pitch: number,
  speed: number,
): V3 {
  const f = viewForward(yaw, pitch);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let x = f.x * axes.fwd + rx * axes.right;
  let y = f.y * axes.fwd + axes.up;
  let z = f.z * axes.fwd + rz * axes.right;
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return { x: 0, y: 0, z: 0 };
  // Unit intent in the key-press sense: clamp to 1, never boost diagonals.
  const k = (len > 1 ? 1 / len : 1) * speed;
  x *= k;
  y *= k;
  z *= k;
  return { x, y, z };
}

/** Framerate independent smoothing of `vel` toward `wish` (accel and damping). */
export function stepVelocity(vel: V3, wish: V3, dt: number): V3 {
  const k = 1 - Math.exp(-FLY.response * Math.max(0, dt));
  return {
    x: vel.x + (wish.x - vel.x) * k,
    y: vel.y + (wish.y - vel.y) * k,
    z: vel.z + (wish.z - vel.z) * k,
  };
}

export interface LandProbe {
  /** Highest static floor at or below (x, y, z) within `reach`, or null. */
  floorBelow(x: number, y: number, z: number, reach: number): number | null;
  /** Is a player allowed to stand at this eye position? */
  walkable(p: V3): boolean;
}

/**
 * "Land here": the feet position under the camera, or null when there is no
 * floor below (or it is not a walkable zone), in which case the caller returns
 * to the body. Never lands in the void.
 */
export function resolveLanding(
  cam: V3,
  eyeHeight: number,
  probe: LandProbe,
): V3 | null {
  if (![cam.x, cam.y, cam.z].every(Number.isFinite)) return null;
  const floor = probe.floorBelow(cam.x, cam.y, cam.z, FLY.landReach);
  if (floor === null || !Number.isFinite(floor)) return null;
  if (!probe.walkable({ x: cam.x, y: floor + eyeHeight, z: cam.z }))
    return null;
  return { x: cam.x, y: floor + 0.05, z: cam.z };
}

/** Stateful controller: key tracking + smoothed position. */
export class FlyController {
  pos: V3 = { x: 0, y: 0, z: 0 };
  vel: V3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  base: number = FLY.baseSpeed;
  private readonly keys = new Set<string>();
  private attached: (() => void) | null = null;
  /** Gate for key input (false while a DOM field / modal / panel owns keys). */
  enabled: () => boolean = () => true;

  start(pos: V3, yaw: number, pitch: number): void {
    this.pos = { ...pos };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = yaw;
    this.pitch = pitch;
    this.keys.clear();
    this.attach();
  }

  stop(): void {
    this.attached?.();
    this.attached = null;
    this.keys.clear();
  }

  look(dx: number, dy: number): void {
    this.yaw += dx;
    this.pitch = Math.max(
      -FLY.pitchLimit,
      Math.min(FLY.pitchLimit, this.pitch + dy),
    );
  }

  update(dt: number): void {
    const on = this.enabled();
    const h = (c: string): boolean => on && this.keys.has(c);
    const axes: FlyAxes = {
      fwd:
        (h("KeyW") || h("ArrowUp") ? 1 : 0) -
        (h("KeyS") || h("ArrowDown") ? 1 : 0),
      right:
        (h("KeyD") || h("ArrowRight") ? 1 : 0) -
        (h("KeyA") || h("ArrowLeft") ? 1 : 0),
      up:
        (h("Space") || h("KeyE") ? 1 : 0) -
        (h("ControlLeft") || h("ControlRight") || h("KeyQ") ? 1 : 0),
    };
    const mult = speedMultiplier({
      shift: h("ShiftLeft") || h("ShiftRight"),
      alt: h("AltLeft") || h("AltRight"),
    });
    const wish = wishVelocity(axes, this.yaw, this.pitch, this.base * mult);
    this.vel = stepVelocity(this.vel, wish, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }

  private attach(): void {
    if (this.attached || typeof window === "undefined") return;
    const down = (e: KeyboardEvent): void => {
      if (!this.enabled()) return;
      this.keys.add(e.code);
      if (e.code === "Space" || e.code === "AltLeft" || e.code === "AltRight")
        e.preventDefault();
    };
    const up = (e: KeyboardEvent): void => {
      this.keys.delete(e.code);
    };
    const wheel = (e: WheelEvent): void => {
      if (!this.enabled()) return;
      this.base = adjustBaseSpeed(this.base, e.deltaY);
    };
    const blur = (): void => this.keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("blur", blur);
    this.attached = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", blur);
    };
  }
}
