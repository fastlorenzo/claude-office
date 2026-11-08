/**
 * Security-camera feeds for the control room: one FreeCamera + 320×180
 * RenderTargetTexture per project room (sessions alias to it), rendered round-robin (one feed per
 * update) with REFRESHRATE_RENDER_ONCE. Only the feed scheduled for a frame
 * is attached to scene.customRenderTargets; the others keep their last frame.
 */

import {
  AbstractMesh,
  FreeCamera,
  Observable,
  RenderTargetTexture,
  Scene,
  Vector3,
  Color4,
  Constants,
  ImageProcessingConfiguration,
  ImageProcessingPostProcess,
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
  tone: ImageProcessingPostProcess;
}

export class FeedScheduler {
  /** Fires when a feed is added or removed (sessionId). */
  readonly onChanged = new Observable<string>();
  private readonly scene: Scene;
  private readonly feeds = new Map<string, Feed>();
  private order: string[] = [];
  private cursor = 0;
  private active = false;
  private wantActive = false;
  private mode: "off" | "low" | "high" = "high";
  private tick = 0;
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
    // Materials skip tone mapping when the scene applies it as a post
    // process, so a bare RTT comes out linear / un-toned (orange). Give every
    // feed the same ACES + exposure + contrast as the main view (no vignette).
    const scene = this.scene;
    const main = scene.imageProcessingConfiguration;
    const cfg = new ImageProcessingConfiguration();
    cfg.toneMappingEnabled = true;
    cfg.toneMappingType = main.toneMappingEnabled
      ? main.toneMappingType
      : ImageProcessingConfiguration.TONEMAPPING_ACES;
    cfg.exposure = main.toneMappingEnabled ? main.exposure : 1.05;
    cfg.contrast = main.toneMappingEnabled ? main.contrast : 1.12;
    cfg.vignetteEnabled = false;
    const tone = new ImageProcessingPostProcess(
      `feedTone_${sessionId}`,
      1,
      null,
      Texture.BILINEAR_SAMPLINGMODE,
      scene.getEngine(),
      false,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      cfg,
    );
    rtt.addPostProcess(tone);
    const feed: Feed = {
      sessionId,
      camera,
      rtt,
      getRenderList,
      rendered: false,
      tone,
    };
    // Refresh the render list lazily, right before this feed renders.
    rtt.onBeforeRenderObservable.add(() => {
      rtt.renderList = feed.getRenderList().filter((m) => !m.isDisposed());
      feed.rendered = true;
    });
    this.feeds.set(sessionId, feed);
    this.order.push(sessionId);
    this.onChanged.notifyObservers(sessionId);
    return rtt;
  }

  /**
   * Feed of a room id — feeds are keyed by PROJECT room; a session id
   * resolves to its project's feed through `setAliases`.
   */
  getTexture(id: string): RenderTargetTexture | null {
    const f = this.feeds.get(id) ?? this.feeds.get(this.aliases.get(id) ?? "");
    return f?.rtt ?? null;
  }

  private aliases = new Map<string, string>();

  /** sessionId → feed (project) id. Notifies `onChanged` when it changes. */
  setAliases(map: ReadonlyMap<string, string>): void {
    const key = (m: ReadonlyMap<string, string>) =>
      [...m]
        .map(([a, b]) => `${a}>${b}`)
        .sort()
        .join("|");
    if (key(map) === key(this.aliases)) return;
    this.aliases = new Map(map);
    this.onChanged.notifyObservers("");
  }

  removeFeed(sessionId: string): void {
    const f = this.feeds.get(sessionId);
    if (!f) return;
    this.detach(f.rtt);
    f.tone.dispose();
    f.rtt.dispose();
    f.camera.dispose();
    this.feeds.delete(sessionId);
    this.order = this.order.filter((id) => id !== sessionId);
    this.onChanged.notifyObservers(sessionId);
  }

  /** Graphics setting "securityFeeds": off = never render, low = half rate. */
  setDetail(d: { securityFeeds: "off" | "low" | "high" }): void {
    if (d.securityFeeds === this.mode) return;
    this.mode = d.securityFeeds;
    this.applyActive(this.wantActive);
  }

  setActive(active: boolean): void {
    this.wantActive = active;
    this.applyActive(active);
  }

  private applyActive(wanted: boolean): void {
    const active = wanted && this.mode !== "off";
    if (active === this.active) return;
    this.active = active;
    // Feeds join scene.customRenderTargets only for the frame they render
    // (see update); leaving the room detaches whatever is attached.
    if (!active) for (const f of this.feeds.values()) this.detach(f.rtt);
  }

  /**
   * Call once per frame: renders at most ONE feed this frame (never-rendered
   * feeds first, then round-robin every 3rd frame at "high", every 6th at
   * "low" — CCTV rate; each feed render redraws its whole room). Only the
   * scheduled feed is attached to scene.customRenderTargets, so nothing else
   * (render-once bookkeeping, readiness retries) can render several feeds in
   * one frame.
   */
  update(): void {
    if (!this.active || this.disposed || this.order.length === 0) return;
    for (const f of this.feeds.values()) this.detach(f.rtt);
    const fresh = this.order.find((id) => !this.feeds.get(id)?.rendered);
    const every = this.mode === "low" ? 6 : 3;
    if (!fresh && this.tick++ % every !== 0) return;
    let id = fresh;
    if (!id) {
      this.cursor = (this.cursor + 1) % this.order.length;
      id = this.order[this.cursor];
    }
    const rtt = this.feeds.get(id)?.rtt;
    if (!rtt) return;
    rtt.resetRefreshCounter();
    this.scene.customRenderTargets.push(rtt);
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
