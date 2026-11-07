/**
 * Per-scene registry of desk monitors. Decides, at ~5 Hz, which monitors are
 * LIVE (own textured plane, one draw each: close to the camera, room visible)
 * and which fall back to the shared thin-instanced static screens
 * (MonitorBatch). Also hides the monitors of rooms the Visibility pass culled.
 */

import { Scene, Vector3 } from "../babylon";
import { MonitorBatch } from "./MonitorBatch";

export type RoomDetail = "full" | "impostor" | "hidden";

/** Monitors closer than this (m) to the eye are live; hysteresis on exit. */
export const LIVE_IN = 8;
export const LIVE_OUT = 9.5;

/** Pure: next live state from the distance and the previous state. */
export function nextLive(prev: boolean, dist: number, scale = 1): boolean {
  return dist <= (prev ? LIVE_OUT : LIVE_IN) * scale;
}

/** Live-range multiplier from the "liveScreens" graphics setting. */
export function liveScale(mode: "off" | "near" | "all"): number {
  return mode === "off" ? 0 : mode === "near" ? 0.6 : 1;
}

export interface HubScreen {
  readonly sessionId: string;
  /** World position of the screen centre. */
  readonly worldPos: Vector3;
  applyHub(
    show: boolean,
    dist: number,
    feedMode: boolean,
    liveScale: number,
  ): void;
}

const hubs = new WeakMap<Scene, ScreenHub>();

export class ScreenHub {
  private readonly screens = new Set<HubScreen>();
  private readonly detail = new Map<string, RoomDetail>();
  private feedMode = false;
  private scale = 1;
  /** Debug: every monitor live (no static fallback). */
  bypass = false;
  private dirty = true;
  private readonly batch: MonitorBatch;

  static get(scene: Scene): ScreenHub {
    let h = hubs.get(scene);
    if (!h) {
      h = new ScreenHub(scene);
      hubs.set(scene, h);
      scene.onDisposeObservable.addOnce(() => hubs.delete(scene));
    }
    return h;
  }

  private constructor(scene: Scene) {
    this.batch = MonitorBatch.get(scene);
  }

  add(s: HubScreen): void {
    this.screens.add(s);
    this.dirty = true;
  }

  remove(s: HubScreen): void {
    this.screens.delete(s);
  }

  setRoomDetail(sessionId: string, d: RoomDetail): void {
    if ((this.detail.get(sessionId) ?? "full") === d) return;
    this.detail.set(sessionId, d);
    this.dirty = true;
  }

  setDetail(mode: "off" | "near" | "all"): void {
    const k = liveScale(mode);
    if (k === this.scale) return;
    this.scale = k;
    this.dirty = true;
  }

  /** Ask for a re-evaluation on the next frame (state of a screen changed). */
  touch(): void {
    this.dirty = true;
  }

  forgetRoom(sessionId: string): void {
    this.detail.delete(sessionId);
  }

  setFeedMode(on: boolean): void {
    if (on === this.feedMode) return;
    this.feedMode = on;
    this.dirty = true;
  }

  /** True when the next `update` has pending work regardless of the timer. */
  get needsUpdate(): boolean {
    return this.dirty;
  }

  update(eye: Vector3): void {
    this.dirty = false;
    for (const s of this.screens) {
      const show = (this.detail.get(s.sessionId) ?? "full") !== "hidden";
      s.applyHub(
        show,
        Vector3.Distance(eye, s.worldPos),
        this.feedMode,
        this.bypass ? 1e6 : this.scale,
      );
    }
    this.batch.flush();
  }
}
