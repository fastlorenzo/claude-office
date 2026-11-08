/**
 * Keyboard + mouse (pointer lock with drag-to-look fallback) + virtual touch
 * input. Game keys are ignored while a DOM text field is focused, while a
 * modal dialog is open, or while input is disabled (HUD panel open).
 */
import {
  BINDINGS,
  LOBBY_HOLD_MS,
  MOUSE_SENSITIVITY,
  PRESS_ACTIONS,
  TOUCH_SENSITIVITY,
  type GameAction,
  type HoldAction,
  type PressAction,
} from "@/engine/input/bindings";

/** A failed pointer-lock request blocks new ones for this long. */
const LOCK_RETRY_MS = 1200;

export type InputEvent = PressAction | "lobby";

function domWantsKeys(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    )
      return true;
  }
  return !!document.querySelector('[aria-modal="true"]');
}

export class InputController {
  private readonly held = new Set<HoldAction>();
  private jumpQueued = false;
  private lookX = 0; // radians
  private lookY = 0;
  private virtual = { x: 0, y: 0 };
  private lobbyHeldMs = 0;
  private lobbyFired = false;
  private enabled = true;
  private lookScale = 1;
  private lookSign = 1;
  private locked = false;
  private dragging = false;
  /** Browsers refuse re-lock for ~1 s after Esc; retry once this has passed. */
  private lockRetryAt = 0;
  private readonly listeners: (() => void)[] = [];
  private eventCb: (e: InputEvent) => void = () => {};
  private lockCb: (locked: boolean) => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly isMobile: boolean,
  ) {
    type AnyEvents = WindowEventMap & DocumentEventMap;
    const on = <K extends keyof AnyEvents>(
      target: Window | Document | HTMLElement,
      type: K,
      fn: (e: AnyEvents[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push(() =>
        target.removeEventListener(type, fn as EventListener, opts),
      );
    };
    on(window, "keydown", (e) => this.onKey(e, true));
    on(window, "keyup", (e) => this.onKey(e, false));
    on(window, "blur", () => this.clearHeld());
    on(document, "pointerlockchange", () => this.onLockChange());
    on(document, "pointerlockerror", () => this.noteLockFailed());
    on(canvas, "click", () => this.requestLock());
    on(canvas, "mousedown", (e) => {
      if (!this.locked && e.button === 0) this.dragging = true;
    });
    on(window, "mouseup", () => {
      this.dragging = false;
    });
    on(window, "mousemove", (e) => this.onMouseMove(e));
  }

  /** Mouse/touch look multiplier (1 = default) and vertical inversion. */
  setLook(sensitivity: number, invertY: boolean): void {
    this.lookScale = Math.min(3, Math.max(0.2, sensitivity));
    this.lookSign = invertY ? -1 : 1;
  }

  onEvent(cb: (e: InputEvent) => void): void {
    this.eventCb = cb;
  }

  onPointerLock(cb: (locked: boolean) => void): void {
    this.lockCb = cb;
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.clearHeld();
      this.virtual = { x: 0, y: 0 };
      this.dragging = false;
      if (this.locked && document.pointerLockElement === this.canvas)
        document.exitPointerLock();
    }
  }

  private requestLock(): void {
    if (
      !this.enabled ||
      this.isMobile ||
      this.locked ||
      performance.now() < this.lockRetryAt
    )
      return;
    const c = this.canvas as HTMLCanvasElement & {
      requestPointerLock(opts?: {
        unadjustedMovement?: boolean;
      }): Promise<void> | void;
    };
    try {
      const r = c.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {
          try {
            const r2 = c.requestPointerLock();
            if (r2 && typeof (r2 as Promise<void>).catch === "function")
              (r2 as Promise<void>).catch(() => {
                this.noteLockFailed();
              });
          } catch {
            this.noteLockFailed();
          }
        });
      }
    } catch {
      this.noteLockFailed();
    }
  }

  private noteLockFailed(): void {
    this.lockRetryAt = performance.now() + LOCK_RETRY_MS;
  }

  private onLockChange(): void {
    const locked = document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    if (!locked) this.clearHeld();
    this.lockCb(locked);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.enabled) return;
    if (this.locked || this.dragging) {
      this.lookX += e.movementX * MOUSE_SENSITIVITY * this.lookScale;
      this.lookY +=
        e.movementY * MOUSE_SENSITIVITY * this.lookScale * this.lookSign;
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const action: GameAction | undefined = BINDINGS[e.code];
    if (!action) return;
    if (down && (!this.enabled || domWantsKeys())) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (PRESS_ACTIONS.has(action)) {
      if (down && !e.repeat) {
        e.preventDefault();
        this.eventCb(action as PressAction);
      }
      return;
    }
    const hold = action as HoldAction;
    if (down) {
      if (hold === "jump" && !e.repeat) this.jumpQueued = true;
      this.held.add(hold);
      if (hold === "jump" || e.code.startsWith("Arrow")) e.preventDefault();
    } else {
      this.held.delete(hold);
      if (hold === "lobby") {
        this.lobbyHeldMs = 0;
        this.lobbyFired = false;
      }
    }
  }

  private clearHeld(): void {
    this.held.clear();
    this.lobbyHeldMs = 0;
    this.lobbyFired = false;
  }

  /** Movement intent: x = right, y = forward, length ≤ 1. */
  moveAxis(): { x: number; y: number } {
    let x = this.virtual.x;
    let y = this.virtual.y;
    if (this.held.has("forward")) y += 1;
    if (this.held.has("back")) y -= 1;
    if (this.held.has("right")) x += 1;
    if (this.held.has("left")) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  get sprint(): boolean {
    return this.held.has("sprint");
  }

  consumeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j && this.enabled;
  }

  /** Accumulated look in radians since the last call. */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  setVirtualMove(x: number, y: number): void {
    if (!this.enabled) return;
    this.virtual = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }

  /** Touch look in CSS pixels. */
  addLook(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.lookX += dx * TOUCH_SENSITIVITY * this.lookScale;
    this.lookY += dy * TOUCH_SENSITIVITY * this.lookScale * this.lookSign;
  }

  update(dtMs: number): void {
    if (this.held.has("lobby") && !this.lobbyFired) {
      this.lobbyHeldMs += dtMs;
      if (this.lobbyHeldMs >= LOBBY_HOLD_MS) {
        this.lobbyFired = true;
        this.eventCb("lobby");
      }
    }
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    if (
      typeof document !== "undefined" &&
      document.pointerLockElement === this.canvas
    )
      document.exitPointerLock();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
