/**
 * Security-camera feeds for the control room: one FreeCamera + 320×180
 * RenderTargetTexture per session room, rendered round-robin (one feed per
 * update) with REFRESHRATE_RENDER_ONCE. While inactive the RTTs are removed
 * from scene.customRenderTargets so they cost nothing; the last frame stays.
 */

import {
  AbstractMesh,
  FreeCamera,
  Observable,
  RenderTargetTexture,
  Scene,
  Vector3,
  Color4,
  Texture,
} from "../babylon";
import type { Vec3 } from "../contracts";

export const FEED_W = 320;
export const FEED_H = 180;

interface Feed {
  sessionId: string;
  camera: FreeCamera;
  rtt: RenderTargetTexture;
  getRenderList: () => AbstractMesh[];
  rendered: boolean;
}

export class FeedScheduler {
  /** Fires when a feed is added or removed (sessionId). */
  readonly onChanged = new Observable<string>();
  private readonly scene: Scene;
  private readonly feeds = new Map<string, Feed>();
  private order: string[] = [];
  private cursor = 0;
  private active = false;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get isActive(): boolean {
    return this.active;
  }

  addFeed(
    sessionId: string,
    cam: { position: Vec3; target: Vec3 },
    getRenderList: () => AbstractMesh[],
  ): RenderTargetTexture {
    const existing = this.feeds.get(sessionId);
    if (existing) {
      existing.camera.position.set(
        cam.position.x,
        cam.position.y,
        cam.position.z,
      );
      existing.camera.setTarget(
        new Vector3(cam.target.x, cam.target.y, cam.target.z),
      );
      existing.getRenderList = getRenderList;
      return existing.rtt;
    }
    const camera = new FreeCamera(
      `feedCam_${sessionId}`,
      new Vector3(cam.position.x, cam.position.y, cam.position.z),
      this.scene,
      false,
    );
    camera.setTarget(new Vector3(cam.target.x, cam.target.y, cam.target.z));
    camera.fov = 1.2;
    camera.minZ = 0.05;
    camera.maxZ = 40;
    camera.inputs.clear();

    const rtt = new RenderTargetTexture(
      `feed_${sessionId}`,
      { width: FEED_W, height: FEED_H },
      this.scene,
      {
        generateMipMaps: false,
        doNotChangeAspectRatio: true,
      },
    );
    rtt.activeCamera = camera;
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    rtt.clearColor = new Color4(0.03, 0.035, 0.045, 1);
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE;
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE;
    rtt.renderList = [];
    const feed: Feed = {
      sessionId,
      camera,
      rtt,
      getRenderList,
      rendered: false,
    };
    // Refresh the render list lazily, right before this feed renders.
    rtt.onBeforeRenderObservable.add(() => {
      rtt.renderList = feed.getRenderList().filter((m) => !m.isDisposed());
      feed.rendered = true;
    });
    this.feeds.set(sessionId, feed);
    this.order.push(sessionId);
    if (this.active) this.scene.customRenderTargets.push(rtt);
    this.onChanged.notifyObservers(sessionId);
    return rtt;
  }

  getTexture(sessionId: string): RenderTargetTexture | null {
    return this.feeds.get(sessionId)?.rtt ?? null;
  }

  removeFeed(sessionId: string): void {
    const f = this.feeds.get(sessionId);
    if (!f) return;
    this.detach(f.rtt);
    f.rtt.dispose();
    f.camera.dispose();
    this.feeds.delete(sessionId);
    this.order = this.order.filter((id) => id !== sessionId);
    this.onChanged.notifyObservers(sessionId);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    for (const f of this.feeds.values()) {
      if (active) {
        if (!this.scene.customRenderTargets.includes(f.rtt))
          this.scene.customRenderTargets.push(f.rtt);
      } else {
        this.detach(f.rtt);
      }
    }
  }

  /** Call once per frame: re-arms one feed (never-rendered feeds first). */
  update(): void {
    if (!this.active || this.disposed || this.order.length === 0) return;
    const fresh = this.order.find((id) => !this.feeds.get(id)?.rendered);
    let id = fresh;
    if (!id) {
      this.cursor = (this.cursor + 1) % this.order.length;
      id = this.order[this.cursor];
    }
    this.feeds.get(id)?.rtt.resetRefreshCounter();
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.feeds.keys()]) this.removeFeed(id);
    this.onChanged.clear();
    this.disposed = true;
  }

  private detach(rtt: RenderTargetTexture): void {
    const list = this.scene.customRenderTargets;
    const i = list.indexOf(rtt);
    if (i >= 0) list.splice(i, 1);
  }
}
