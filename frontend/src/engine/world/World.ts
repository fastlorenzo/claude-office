/**
 * World — owns the Babylon engine, scene, render loop and every subsystem,
 * and turns `SyncInput` (campus feed) into rooms, characters and screens.
 *
 *   createWorld(canvas, opts) → IWorld
 *   init()   havok (fallback: moveWithCollisions) + IBL + textures + models + building
 *   sync()   allocateSlots → generateLayout → diffCampus → apply ops → applyToModel
 *
 * Events: ready, error, interaction, action, pose (10 Hz), stats (1 Hz),
 * pointerLock, cameraMode, layout.
 */
import {
  Color4,
  Engine,
  EngineInstrumentation,
  Logger,
  Scene,
  SceneInstrumentation,
  Vector3,
} from "@/engine/babylon";
import {
  LAYOUT,
  type BuildingLayout,
  type CameraMode,
  type InteractionActionId,
  type IWorld,
  type PlayerPose,
  type QualitySetting,
  type RoomSlot,
  type SyncInput,
  type SyncOp,
  type WorldEvents,
  type WorldOptions,
  type Zone,
} from "@/engine/contracts";
import { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { PropRole } from "@/engine/assets/proceduralProps";
import { coarseTier, settingsForQuality } from "@/engine/fx/Quality";
import {
  GraphicsController,
  type DetailSettings,
} from "@/engine/fx/GraphicsController";
import {
  defaultGraphicsSettings,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { Lighting } from "@/engine/fx/Lighting";
import { PostFx } from "@/engine/fx/PostFx";
import { InputController, type InputEvent } from "@/engine/input/Input";
import { Interaction } from "@/engine/interaction/Interaction";
import {
  allocateSlots,
  generateLayout,
  roomAt,
} from "@/engine/layout/buildingLayout";
import {
  applyToModel,
  createWorldModel,
  diffCampus,
} from "@/engine/logic/syncDiff";
import { Materials } from "@/engine/materials/Materials";
import { Colliders } from "@/engine/physics/Colliders";
import { loadHavok } from "@/engine/physics/havok";
import { createPlayerAvatar } from "@/engine/player/Avatar";
import { ActorHub } from "@/engine/characters/ActorHub";
import { preloadCharacterPack } from "@/engine/characters/GltfRig";
import { Player, PLAYER } from "@/engine/player/Player";
import { ControlRoomWall } from "@/engine/screens/ControlRoomWall";
import { FeedScheduler } from "@/engine/screens/FeedScheduler";
import { LabelLayer } from "@/engine/screens/LabelLayer";
import { StaticOccluders } from "@/engine/screens/labelOcclusion";
import { ScreenHub } from "@/engine/screens/ScreenHub";
import { Emitter } from "@/engine/util/Emitter";
import { Building } from "@/engine/world/Building";
import { Room, type RoomContext } from "@/engine/world/Room";
import {
  halfFovFor,
  VisibilityController,
  visRoomsOf,
} from "@/engine/world/Visibility";

export interface WorldDebugOptions {
  /** Fixed screenshot camera: eye position + yaw/pitch (radians). Freezes the player. */
  camera?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Keep the drawing buffer for screenshots. */
  preserveDrawingBuffer?: boolean;
  /** Disable head bob. */
  headBob?: boolean;
}

const POSE_MS = 100;
/** Props big enough for their shadows to matter (each part costs a draw per cascade). */
const SHADOW_ROLES: ReadonlySet<PropRole> = new Set<PropRole>([
  "workDesk",
  "execDesk",
  "taskChair",
  "sofa",
  "shelves",
  "plant",
  "plantTall",
  "coffeeCart",
  "chair",
  "loungeTable",
]);
const STATS_MS = 1000;

function sameSlots(
  a: ReadonlyMap<string, RoomSlot>,
  b: ReadonlyMap<string, RoomSlot>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.index !== v.index) return false;
  }
  return true;
}

function defaultDetail(): DetailSettings {
  return { characterDetail: "high", liveScreens: "all", securityFeeds: "high" };
}

function zoneKey(z: Zone): string {
  return z.kind === "room" ? `room:${z.sessionId}` : z.kind;
}

class World implements IWorld {
  private readonly events = new Emitter<WorldEvents>();
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly materials: Materials;
  private readonly colliders: Colliders;
  private readonly assets: AssetLibrary;
  private readonly lighting: Lighting;
  private readonly input: InputController;
  private readonly labels: LabelLayer;
  private readonly gfx: GraphicsController;
  private player: Player | null = null;
  private fx: PostFx | null = null;
  private interaction: Interaction | null = null;
  private building: Building | null = null;
  private feeds: FeedScheduler | null = null;
  private controlWall: ControlRoomWall | null = null;
  private readonly rooms = new Map<string, Room>();
  private slots: Map<string, RoomSlot> = new Map();
  private layout: BuildingLayout;
  private model = createWorldModel();
  private pending: SyncInput | null = null;
  private lastInput: SyncInput | null = null;
  private ready = false;
  private visibility: VisibilityController | null = null;
  private actorHub: ActorHub | null = null;
  private screenHub: ScreenHub | null = null;
  private lastScreensAt = 0;
  private lastDbgAt = 0;
  private disposed = false;
  private inputEnabled = true;
  private cameraMode: CameraMode;
  private lastPoseAt = 0;
  private lastPoseKey = "";
  private lastStatsAt = 0;
  private frames = 0;
  private frameMsAcc = 0;
  private readonly sceneInstr: SceneInstrumentation;
  private readonly engineInstr: EngineInstrumentation;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly debug: WorldDebugOptions;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: WorldOptions,
    debug: WorldDebugOptions = {},
  ) {
    this.debug = debug;
    this.cameraMode = opts.cameraMode;
    Logger.LogLevels = Logger.WarningLogLevel | Logger.ErrorLogLevel;
    this.engine = new Engine(
      canvas,
      true,
      {
        stencil: true,
        antialias: true,
        preserveDrawingBuffer: !!debug.preserveDrawingBuffer,
        powerPreference: "high-performance",
        doNotHandleContextLost: false,
      },
      true,
    );
    const scene = new Scene(this.engine);
    scene.clearColor = new Color4(0.86, 0.87, 0.88, 1);
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    scene.blockMaterialDirtyMechanism = false;
    this.scene = scene;

    this.materials = new Materials(scene, opts.assetBase);
    this.colliders = new Colliders(scene);
    this.assets = new AssetLibrary(
      scene,
      this.materials,
      this.colliders,
      opts.assetBase,
    );
    this.labels = new LabelLayer(scene);
    this.input = new InputController(canvas, opts.isMobile);
    this.input.onEvent((e) => this.onInputEvent(e));
    this.input.onPointerLock((locked) =>
      this.events.emit("pointerLock", locked),
    );

    this.lighting = new Lighting(scene);
    this.assets.onPart((m, role) => {
      if (SHADOW_ROLES.has(role)) this.lighting.addShadowCaster(m);
    });

    const lowEnd =
      opts.isMobile ||
      (typeof navigator !== "undefined" &&
        (navigator.hardwareConcurrency ?? 8) <= 4);
    this.gfx = new GraphicsController(
      {
        engine: this.engine,
        scene,
        lighting: this.lighting,
        materials: this.materials,
        input: this.input,
        getFx: () => this.fx,
        getPlayer: () => this.player,
        setDetail: (d) => this.setDetail(d),
      },
      opts.graphics ??
        settingsForQuality(
          opts.quality,
          defaultGraphicsSettings(opts.isMobile),
        ),
      lowEnd,
    );

    this.layout = generateLayout(this.slots);
    this.sceneInstr = new SceneInstrumentation(scene);
    this.engineInstr = new EngineInstrumentation(this.engine);
    this.engineInstr.captureGPUFrameTime = false;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      if (canvas.parentElement)
        this.resizeObserver.observe(canvas.parentElement);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Registers the realistic character pack synchronously (actors created
      // from now on use GltfRig) and starts loading the animation libraries.
      const characters = preloadCharacterPack(this.scene).catch((err) => {
        console.warn(
          "[world] character pack unavailable, using mannequins",
          err,
        );
        return false;
      });
      // Physics first: the player and colliders depend on it.
      let physics = false;
      try {
        const plugin = await loadHavok();
        if (this.disposed) return;
        this.scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
        physics = true;
      } catch (err) {
        console.warn(
          "[world] Havok unavailable, falling back to moveWithCollisions",
          err,
        );
      }
      this.colliders.enablePhysics(physics);

      const spawn = this.layout.lobby.spawn;
      this.player = new Player(this.scene, {
        physics,
        spawn: new Vector3(spawn.x, spawn.y + 0.05, spawn.z),
        yaw: this.layout.lobby.spawnYaw,
        mode: this.cameraMode,
        headBob: this.debug.headBob ?? true,
      });
      this.lighting.setCamera(this.player.camera);
      this.player.setAvatar(createPlayerAvatar(this.scene));
      for (const m of this.player.avatarMeshes)
        this.lighting.addShadowCaster(m);
      if (this.debug.camera) {
        const c = this.debug.camera;
        this.player.setDebugCamera(new Vector3(c.x, c.y, c.z), c.yaw, c.pitch);
      }

      this.fx = new PostFx(this.scene, this.player.camera);
      this.interaction = new Interaction(
        this.scene,
        () => this.scene.activeCamera!,
        this.fx,
        this.events,
        () => this.player!.position.add(new Vector3(0, PLAYER.eyeHeight, 0)),
      );
      // Depth of field follows the inspect action; ends when input returns.
      this.events.on("action", ({ action }) => {
        if (action === "inspect")
          this.gfx.beginInspect(this.interaction?.target?.distance ?? 2);
      });

      await Promise.all([
        this.lighting.loadEnvironment(this.opts.assetBase, 256),
        this.materials.loadTextures(),
        this.assets.preload(),
        // Don't hold the world hostage to large avatar downloads.
        Promise.race([characters, new Promise((r) => setTimeout(r, 15000))]),
      ]);
      if (this.disposed) return;

      this.building = new Building({
        scene: this.scene,
        materials: this.materials,
        assets: this.assets,
        colliders: this.colliders,
        lighting: this.lighting,
        fx: this.fx,
      });
      this.building.build(this.layout);
      this.feeds = new FeedScheduler(this.scene);
      this.controlWall = new ControlRoomWall(
        this.scene,
        this.layout.controlRoom,
        this.feeds,
      );
      for (const m of this.controlWall.getGlowMeshes())
        if (/rim/i.test(m.name)) this.fx.addGlow(m);
      this.updateFixtures();
      this.events.emit("layout", this.layout);
      this.setupLod();

      this.gfx.syncPlayer();
      this.gfx.start();
      this.ready = true;
      const pending = this.pending;
      this.pending = null;
      if (pending) this.sync(pending);
      this.materials.freezeAll();

      await new Promise<void>((resolve) =>
        this.scene.executeWhenReady(() => resolve()),
      );
      if (this.disposed) return;
      this.engine.runRenderLoop(() => this.frame());
      this.events.emit("ready", undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[world] init failed", err);
      this.events.emit("error", { message });
      throw err;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this.input.dispose();
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
    this.controlWall?.dispose();
    this.feeds?.dispose();
    this.building?.dispose();
    this.interaction?.dispose();
    this.fx?.dispose();
    this.labels.dispose();
    this.player?.dispose();
    this.lighting.dispose();
    this.assets.dispose();
    this.colliders.dispose();
    this.materials.dispose();
    this.sceneInstr.dispose();
    this.engineInstr.dispose();
    this.scene.dispose();
    this.engine.dispose();
    this.events.clear();
  }

  on<K extends keyof WorldEvents>(
    event: K,
    cb: (payload: WorldEvents[K]) => void,
  ): () => void {
    return this.events.on(event, cb);
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  sync(input: SyncInput): void {
    if (this.disposed) return;
    this.lastInput = input;
    if (!this.ready) {
      this.pending = input;
      return;
    }
    const createdAt = new Map(input.sessions.map((s) => [s.id, s.createdAt]));
    const nextSlots = allocateSlots(
      this.slots,
      input.campus.map((c) => ({
        id: c.sessionId,
        createdAt: createdAt.get(c.sessionId) ?? 0,
      })),
    );
    if (!sameSlots(nextSlots, this.slots)) {
      this.slots = nextSlots;
      const layout = generateLayout(nextSlots);
      const baysChanged = layout.bays !== this.layout.bays;
      this.layout = layout;
      this.building?.build(layout);
      if (baysChanged && this.feeds) {
        this.controlWall?.dispose();
        this.controlWall = new ControlRoomWall(
          this.scene,
          layout.controlRoom,
          this.feeds,
        );
        for (const m of this.controlWall.getGlowMeshes())
          if (/rim/i.test(m.name)) this.fx?.addGlow(m);
      }
      this.events.emit("layout", layout);
    }

    const ops = diffCampus(this.model, input, this.slots);
    if (ops.length) {
      this.applyOps(ops);
      applyToModel(this.model, ops);
    }
    // Art: door signs read summary / refs / phase straight from the campus
    // session (RoomSign redraws only when its strings change).
    for (const cs of input.campus) this.rooms.get(cs.sessionId)?.setCampus(cs);
  }

  private applyOps(ops: SyncOp[]): void {
    const layoutOf = new Map(this.layout.rooms.map((r) => [r.sessionId, r]));
    const createdNow = new Set<string>();
    let roomsChanged = false;
    let wallDirty = false;
    for (const op of ops) {
      switch (op.op) {
        case "createRoom": {
          const rl = layoutOf.get(op.sessionId);
          if (!rl) break;
          this.rooms.get(op.sessionId)?.dispose();
          const room = new Room(this.roomCtx(), rl, op.label);
          this.rooms.set(op.sessionId, room);
          (room as { setDetail?(d: DetailSettings): void }).setDetail?.(
            this.detail ?? defaultDetail(),
          );
          createdNow.add(op.sessionId);
          this.feeds?.addFeed(op.sessionId, rl.feedCamera, () =>
            room.getRenderList(),
          );
          roomsChanged = true;
          wallDirty = true;
          break;
        }
        case "disposeRoom": {
          const room = this.rooms.get(op.sessionId);
          if (room) {
            room.dispose();
            this.rooms.delete(op.sessionId);
            this.feeds?.removeFeed(op.sessionId);
            roomsChanged = true;
            wallDirty = true;
          }
          break;
        }
        case "roomLabel":
          this.rooms.get(op.sessionId)?.setLabel(op.label);
          wallDirty = true;
          break;
        case "roomStatus":
          this.rooms.get(op.sessionId)?.setStatus(op.status);
          wallDirty = true;
          break;
        case "monitor":
          this.rooms.get(op.sessionId)?.setMonitorLines(op.lines);
          break;
        case "todos":
          this.rooms.get(op.sessionId)?.setTodos(op.todos);
          break;
        case "boss":
          this.rooms.get(op.sessionId)?.setBoss(op.boss, true);
          break;
        case "spawnAgent": {
          const fresh = createdNow.has(op.sessionId) || !this.firstSyncDone;
          const walking =
            op.agent.state === "arriving" ||
            op.agent.state === "walking_to_desk";
          this.rooms.get(op.sessionId)?.spawnAgent(op.agent, fresh && !walking);
          break;
        }
        case "updateAgent":
          this.rooms.get(op.sessionId)?.updateAgent(op.agent);
          break;
        case "departAgent":
          this.rooms.get(op.sessionId)?.departAgent(op.agentId);
          break;
        case "select":
          for (const [id, r] of this.rooms) r.setSelected(id === op.sessionId);
          break;
      }
    }
    this.firstSyncDone = true;
    if (roomsChanged) this.updateFixtures();
    if (wallDirty) this.refreshControlWall();
  }

  private firstSyncDone = false;

  private refreshControlWall(): void {
    if (!this.controlWall) return;
    const list = [...this.rooms.values()]
      .sort((a, b) => a.roomLayout.slot.index - b.roomLayout.slot.index)
      .slice(0, LAYOUT.MAX_FEEDS)
      .map((r) => ({
        sessionId: r.sessionId,
        label: r.currentLabel,
        status: r.currentStatus,
      }));
    this.controlWall.setSessions(list);
  }

  private roomCtx(): RoomContext {
    return {
      scene: this.scene,
      materials: this.materials,
      assets: this.assets,
      colliders: this.colliders,
      lighting: this.lighting,
      fx: this.fx,
      labels: this.labels,
    };
  }

  private updateFixtures(): void {
    const pts = [...(this.building?.fixtures ?? [])];
    for (const r of this.rooms.values()) pts.push(...r.getFixtures());
    this.lighting.setFixtures(pts);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private frame(): void {
    if (this.disposed || !this.player) return;
    const now = performance.now();
    const rafMs = this.engine.getDeltaTime();
    this.gfx.sampleFrame(rafMs, now);
    const dtMs = this.gfx.beginFrame(now, Math.min(rafMs, 100)); // fps cap
    if (dtMs < 0) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    this.gfx.update(dtMs);

    this.input.update(dtMs);
    this.player.update(dt, this.inputEnabled ? this.input : null);
    const eye = this.player.camera.globalPosition;
    this.assets.flush();
    for (const r of this.rooms.values()) r.update(dt, eye);
    if (this.gfx.dynamicLights) this.lighting.update(dt, this.player.position);
    this.interaction?.update(now);

    const zone = roomAt(this.layout, this.player.position);
    if (this.feeds) {
      const nearControl =
        zone.kind === "control" ||
        this.player.position.z > this.layout.hall.length - 6;
      this.feeds.setActive(nearControl);
      this.feeds.update();
    }

    this.updateLod(now, zone);

    this.scene.render();

    // Pose (10 Hz, on change)
    if (now - this.lastPoseAt >= POSE_MS) {
      this.lastPoseAt = now;
      const p = this.player.position;
      const pose: PlayerPose = { x: p.x, z: p.z, yaw: this.player.yaw, zone };
      const key = `${p.x.toFixed(2)}:${p.z.toFixed(2)}:${this.player.yaw.toFixed(2)}:${zoneKey(zone)}`;
      if (key !== this.lastPoseKey) {
        this.lastPoseKey = key;
        this.events.emit("pose", pose);
      }
    }

    // Stats (1 Hz) + governor
    const frameMs = rafMs;
    this.frames += 1;
    this.frameMsAcc += frameMs;
    if (now - this.lastStatsAt >= STATS_MS) {
      const elapsed = now - this.lastStatsAt;
      const fps = this.lastStatsAt ? (this.frames * 1000) / elapsed : 0;
      this.events.emit("stats", {
        fps: Math.round(fps),
        frameMs:
          Math.round((this.frameMsAcc / Math.max(1, this.frames)) * 10) / 10,
        tier: coarseTier(this.gfx.effective),
        effective: this.gfx.effective,
        postProcesses: this.fx?.postProcessCount ?? 0,
        drawCalls: this.sceneInstr.drawCallsCounter.current,
      });
      this.lastStatsAt = now;
      this.frames = 0;
      this.frameMsAcc = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private onInputEvent(e: InputEvent): void {
    if (!this.inputEnabled) return;
    switch (e) {
      case "camera":
        this.setCameraMode(this.cameraMode === "fp" ? "tp" : "fp");
        break;
      case "inspect":
        this.interaction?.trigger("primary");
        break;
      case "enter":
        this.interaction?.trigger("enter");
        break;
      case "lobby":
        this.teleport("lobby");
        break;
    }
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    this.player?.setMode(mode);
    this.events.emit("cameraMode", mode);
  }

  setQuality(q: QualitySetting): void {
    this.gfx.set(settingsForQuality(q, this.gfx.settings));
  }

  /** Debug (world-debug ?inspect=1): behave as if the player pressed F on a screen 1.6 m away. */
  debugInspect(): void {
    this.gfx.beginInspect(1.6);
  }

  setGraphics(settings: GraphicsSettings): void {
    this.gfx.set(settings);
  }

  /** Characters / screens / feeds detail fan-out (each target is feature-detected). */
  private detail: DetailSettings | null = null;
  private setDetail(d: DetailSettings): void {
    this.detail = d;
    type Detailed = { setDetail?(d: DetailSettings): void };
    for (const t of [this.feeds, this.controlWall, ...this.rooms.values()])
      (t as Detailed | null)?.setDetail?.(d);
    this.actorHub?.setDetail(d.characterDetail);
    this.screenHub?.setDetail(d.liveScreens);
  }

  // -------------------------------------------------------------------------
  // LOD + visibility (Visibility.ts, ActorHub, ScreenHub, label occlusion)
  // -------------------------------------------------------------------------

  private setupLod(): void {
    this.actorHub = ActorHub.get(this.scene);
    this.screenHub = ScreenHub.get(this.scene);
    this.actorHub.setShadowSink({
      add: (m) => this.lighting.addShadowCaster(m),
      remove: (m) => this.lighting.removeShadowCaster(m),
    });
    if (this.detail) this.setDetail(this.detail);
    this.visibility = new VisibilityController({
      screens: this.screenHub,
      actors: this.actorHub,
    });
    const occluders = new StaticOccluders(this.scene);
    this.labels.setOccluder((a, b) => occluders.blocked(a, b));
  }

  private readonly dbgHist: number[] = [];
  /** Median of the last samples (a single frame can include one-off passes). */
  private dbgDraws(v: number): number {
    this.dbgHist.push(v);
    if (this.dbgHist.length > 5) this.dbgHist.shift();
    const s = [...this.dbgHist].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  private activeKinds(): Record<string, number> {
    const by: Record<string, number> = {};
    const list = this.scene.getActiveMeshes();
    for (let i = 0; i < list.length; i++) {
      const m = list.data[i];
      const k = m.name.replace(/[_:.\d].*$/, "");
      by[k] = (by[k] ?? 0) + (m.subMeshes?.length || 1);
    }
    return Object.fromEntries(
      Object.entries(by)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16),
    );
  }

  private updateLod(now: number, zone: Zone): void {
    if (!this.player || !this.visibility || !this.actorHub || !this.screenHub)
      return;
    const off = !!(globalThis as { __lodOff?: boolean }).__lodOff;
    this.actorHub.bypass = off;
    this.screenHub.bypass = off;
    const cam = this.player.camera;
    const eye = cam.globalPosition;
    const feedMode = this.feeds?.isActive ?? false;
    this.actorHub.setFeedMode(feedMode);
    this.screenHub.setFeedMode(feedMode);
    const dir = cam.getForwardRay(1).direction;
    const yaw =
      Math.hypot(dir.x, dir.z) > 0.2
        ? Math.atan2(dir.x, dir.z)
        : this.player.yaw;
    if (!off)
      this.visibility.update(
        now,
        this.rooms,
        {
          eye,
          yaw,
          halfFov: halfFovFor(cam.fov, this.engine.getAspectRatio(cam)),
          zone,
          rooms: visRoomsOf(this.layout.rooms),
          hallLength: this.layout.hall.length,
          hallHalfWidth: this.layout.hall.width / 2,
        },
        feedMode,
      );
    if (this.screenHub.needsUpdate || now - this.lastScreensAt >= 200) {
      this.lastScreensAt = now;
      this.screenHub.update(eye);
    }
    this.actorHub.update(eye);
    if (this.controlWall) {
      const o = this.layout.controlRoom.screenWall.origin;
      const d = Math.hypot(eye.x - o.x, eye.z - o.z);
      this.controlWall.setFar(!feedMode && d > 22);
    }
    if (now - this.lastDbgAt >= 500) {
      this.lastDbgAt = now;
      (globalThis as { __worldStats?: unknown }).__worldStats = {
        draws: this.dbgDraws(this.sceneInstr.drawCallsCounter.current),
        active: this.scene.getActiveMeshes().length,
        textures: this.scene.textures.length,
        actors: this.actorHub.stats(),
        zone: zone.kind,
        kinds: this.activeKinds(),
      };
    }
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (enabled) this.gfx.endInspect();
    this.input.setEnabled(enabled);
    if (this.interaction) this.interaction.enabled = enabled;
  }

  teleport(to: { sessionId: string } | "lobby" | "control"): void {
    if (!this.player) return;
    this.player.frozen = false;
    if (to === "lobby") {
      const s = this.layout.lobby.spawn;
      this.player.teleport(
        new Vector3(s.x, s.y + 0.05, s.z),
        this.layout.lobby.spawnYaw,
      );
      return;
    }
    if (to === "control") {
      const s = this.layout.controlRoom.spawn;
      this.player.teleport(new Vector3(s.x, s.y + 0.05, s.z), 0);
      return;
    }
    const room = this.layout.rooms.find((r) => r.sessionId === to.sessionId);
    if (!room) return;
    const o = room.doorOutside;
    const d = room.door;
    // Face the door from the hall.
    const yaw = Math.atan2(d.x - o.x, d.z - o.z);
    this.player.teleport(new Vector3(o.x, o.y + 0.05, o.z), yaw);
  }

  setVirtualMove(x: number, y: number): void {
    this.input.setVirtualMove(x, y);
  }

  addLook(dx: number, dy: number): void {
    this.input.addLook(dx, dy);
  }

  triggerAction(id: InteractionActionId): void {
    this.interaction?.trigger(id);
  }

  resize(): void {
    if (this.disposed) return;
    const parent = this.canvas.parentElement;
    if (parent) {
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
    }
    this.engine.resize();
  }

  /** Debug helper: current input snapshot for re-sync after HMR. */
  get lastSyncInput(): SyncInput | null {
    return this.lastInput;
  }
}

/** HMR safety: dispose a world left behind by a hot-replaced module. */
type WorldGlobal = typeof globalThis & { __claudeOfficeWorld?: World | null };

export function createWorld(
  canvas: HTMLCanvasElement,
  opts: WorldOptions,
  debug?: WorldDebugOptions,
): IWorld {
  const g = globalThis as WorldGlobal;
  if (g.__claudeOfficeWorld) {
    try {
      g.__claudeOfficeWorld.dispose();
    } catch {
      /* already gone */
    }
  }
  const world = new World(canvas, opts, debug);
  g.__claudeOfficeWorld = world;
  const dispose = world.dispose.bind(world);
  world.dispose = () => {
    dispose();
    if (g.__claudeOfficeWorld === world) g.__claudeOfficeWorld = null;
  };
  return world;
}
