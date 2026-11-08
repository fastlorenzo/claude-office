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
  DynamicTexture,
  Engine,
  EngineInstrumentation,
  Logger,
  RenderTargetTexture,
  Scene,
  SceneInstrumentation,
  Vector3,
} from "@/engine/babylon";
import {
  type BrandingOptions,
  type BuildingLayout,
  type CameraMode,
  type InteractionActionId,
  type IWorld,
  type PlayerPose,
  type ProjectSlot,
  type QualitySetting,
  type RoomSlot,
  type SyncInput,
  type SyncOp,
  type TeleportTarget,
  type WorldEvents,
  type WorldOptions,
} from "@/engine/contracts";
import { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { PropRole } from "@/engine/assets/proceduralProps";
import { settingsForQuality } from "@/engine/fx/Quality";
import {
  GraphicsController,
  type DetailSettings,
} from "@/engine/fx/GraphicsController";
import {
  defaultGraphicsSettings,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import {
  estimateTextureMB,
  largestTextures,
  textureMBByGroup,
} from "@/engine/fx/textureMemory";
import { Lighting } from "@/engine/fx/Lighting";
import { PostFx } from "@/engine/fx/PostFx";
import { InputController, type InputEvent } from "@/engine/input/Input";
import { Interaction } from "@/engine/interaction/Interaction";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
  projectOfSession,
} from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  FACTORY_Y,
  zoneAt3,
  type FactoryLayout,
  type Zone3,
} from "@/engine/layout/factoryLayout";
import { groupSessions, type ProjectGroup } from "@/engine/logic/projectGroups";
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
import {
  preloadCharacterPack,
  setCharacterCast,
} from "@/engine/characters/characterPacks";
import { FLY } from "@/engine/player/FlyCamera";
import { Player, PLAYER } from "@/engine/player/Player";
import { FeedScheduler } from "@/engine/screens/FeedScheduler";
import { LabelLayer } from "@/engine/screens/LabelLayer";
import { StaticOccluders } from "@/engine/screens/labelOcclusion";
import { ScreenHub } from "@/engine/screens/ScreenHub";
import { Emitter } from "@/engine/util/Emitter";
import { Building } from "@/engine/world/Building";
import { Factory } from "@/engine/world/factory/Factory";
import { FactoryLines } from "@/engine/world/factory/FactoryLines";
import { cellStairFoot } from "@/engine/world/factory/FactoryHall";
import { DOCK, DOCK_SPAWN } from "@/engine/world/factory/Dock";
import { computeCellVisibility } from "@/engine/world/factoryVisibility";
import { ControlRoom } from "@/engine/world/ControlRoom";
import { ProjectRoom } from "@/engine/world/ProjectRoom";
import { Room, type RoomContext } from "@/engine/world/Room";
import {
  halfFovFor,
  VisibilityController,
  visRoomsOfProjects,
  type VisInput,
  type VisRoomHandle,
} from "@/engine/world/Visibility";

export interface WorldDebugOptions {
  /** Fixed screenshot camera: eye position + yaw/pitch (radians). Freezes the player. */
  camera?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Keep the drawing buffer for screenshots. */
  preserveDrawingBuffer?: boolean;
  /** Disable head bob. */
  headBob?: boolean;
  /**
   * Scripted walk (stair / passage verification): teleport the player to
   * `start`, then steer it through `points` with the real character
   * controller. Progress lands in `__worldStats.walk`.
   */
  walk?: {
    start: { x: number; y: number; z: number; yaw: number };
    points: { x: number; z: number }[];
  };
  /** Demo factory data instead of the feed's projects (`?demoFactory=1`). */
  demoFactory?: boolean;
  /**
   * Per-pass draw-call breakdown in `__worldStats.passes` (`?drawdbg=1`):
   * wraps `RenderTargetTexture.render` so every RTT (shadow maps, G-buffer,
   * glow, feeds, probes) reports its own draws; `main` is the remainder.
   */
  drawBreakdown?: boolean;
}

const POSE_MS = 100;
/**
 * Props big enough for their shadows to matter (each part costs a draw per
 * cascade). Chairs and small tables rely on the static daylight map and the
 * blob/AO contact cues instead.
 */
const SHADOW_ROLES: ReadonlySet<PropRole> = new Set<PropRole>([
  "workDesk",
  "execDesk",
  "sofa",
  "shelves",
  "plant",
  "plantTall",
  "coffeeCart",
]);
const STATS_MS = 1000;

/** Change key of everything the layout geometry depends on. */
function layoutKey(
  slots: ReadonlyMap<string, ProjectSlot>,
  groups: readonly ProjectGroup[],
  pods: ReadonlyMap<string, number>,
): string {
  const sl = [...slots].map(
    ([id, s]) => `${id}:${s.index}:${s.side}:${s.bay}:${s.span}`,
  );
  const gs = groups.map(
    (g) =>
      `${g.id}=${g.name}[${g.sessionIds.map((x) => `${x}@${pods.get(x)}`).join(",")}]`,
  );
  return `${sl.sort().join("|")}#${gs.join("|")}`;
}

/** Project room rebuild key (geometry + which pod bays are occupied). */
function projectKey(p: BuildingLayout["projects"][number]): string {
  const s = p.slot;
  return `${s.index}:${s.side}:${s.bay}:${s.span}:${p.podBays.map((b) => (b.occupied ? 1 : 0)).join("")}`;
}

function defaultDetail(): DetailSettings {
  return {
    characterDetail: "high",
    characterCast: "mixed",
    liveScreens: "all",
    securityFeeds: "high",
  };
}

function zoneKey(z: Zone3): string {
  if (z.kind === "room") return `room:${z.sessionId}`;
  if (z.kind === "cell" || z.kind === "balcony")
    return `${z.kind}:${z.projectId}`;
  if (z.kind === "stair") return `stair:${z.id}`;
  return z.kind;
}

const p3 = (v: { x: number; y: number; z: number }) =>
  `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;

/** Scripted debug walk: sub-steps per frame, step, give-up time. */
const WALK_SUBSTEPS = 4;
const WALK_DT = 0.05;
const WALK_TIMEOUT_S = 40;

/**
 * Screen texture uploads (every `DynamicTexture.update`: canvases, wall,
 * monitors, signs) counted process-wide for `__worldStats.screenUploads`.
 */
const uploads = { n: 0 };
(() => {
  const proto = DynamicTexture.prototype as unknown as {
    update: (...a: unknown[]) => void;
    __counted?: boolean;
  };
  if (proto.__counted || typeof proto.update !== "function") return;
  const orig = proto.update;
  proto.__counted = true;
  proto.update = function (this: unknown, ...a: unknown[]) {
    uploads.n++;
    return orig.apply(this, a);
  };
})();

/**
 * Detail distances (m) of furniture parts per tier (characterDetail): small
 * accessories, and every other AssetLibrary part (high: unlimited).
 */
const SMALL_PART_M = { low: 10, medium: 14, high: 20 } as const;
const PART_M = { low: 18, medium: 24, high: Infinity } as const;

/** Lower tiers drop the control-room interior beyond this (m, to the wall). */
const DEEP_FAR_M = 34;

/** Camera-local forward (left-handed scene). */
const LOCAL_FORWARD = new Vector3(0, 0, 1);

/** Factory visibility tick (matches Visibility's VISIBILITY_HZ). */
const FACTORY_VIS_MS = 200;

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
  /** Software-factory level under the offices (shell + machine pools). */
  private factory: Factory | null = null;
  /** Production lines (pools + motion) fed from the campus projects. */
  private factoryLines: FactoryLines | null = null;
  private factoryLayout: FactoryLayout;
  private lastFactoryVisAt = 0;
  private readonly zonePt = new Vector3();
  private feeds: FeedScheduler | null = null;
  private controlRoom: ControlRoom | null = null;
  private readonly rooms = new Map<string, Room>();
  private readonly projectRooms = new Map<string, ProjectRoom>();
  private readonly projectKeys = new Map<string, string>();
  private slots: Map<string, ProjectSlot> = new Map();
  private pods: Map<string, number> = new Map();
  private podSlots: Map<string, RoomSlot> = new Map();
  private groups: ProjectGroup[] = [];
  private layoutSig = "";
  private layout: BuildingLayout;
  private model = createWorldModel();
  private pending: SyncInput | null = null;
  private lastInput: SyncInput | null = null;
  private ready = false;
  /** ms since navigation start when init finished (startup budget, WS5). */
  private readyMs = 0;
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
  /**
   * `__worldStats` (draws, active kinds, actors, factory, walk) is published
   * only for debug hosts (world-debug passes a debug object); production
   * (WorldCanvas) skips the 2 Hz scene walk.
   */
  private readonly statsOn: boolean;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: WorldOptions,
    debug?: WorldDebugOptions,
  ) {
    this.debug = debug ?? {};
    this.statsOn = debug !== undefined;
    this.cameraMode = opts.cameraMode;
    Logger.LogLevels = Logger.WarningLogLevel | Logger.ErrorLogLevel;
    this.engine = new Engine(
      canvas,
      true,
      {
        stencil: true,
        antialias: true,
        preserveDrawingBuffer: !!debug?.preserveDrawingBuffer,
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
    // Glass partitions and the floor strip reflect the hall (box-projected
    // zone probe) instead of the dim generic IBL.
    this.lighting.attachToProbe("hall", [this.materials.get("glass")]);
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
    this.factoryLayout = buildFactoryLayout(this.layout);
    this.sceneInstr = new SceneInstrumentation(scene);
    this.engineInstr = new EngineInstrumentation(this.engine);
    this.engineInstr.captureGPUFrameTime = false;

    if (this.debug.drawBreakdown) this.hookDrawBreakdown();

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
      const characters = preloadCharacterPack(
        this.scene,
        this.gfx.settings.characterCast,
      ).catch((err) => {
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
      this.player.setFlyKeyGate(() => this.inputEnabled);
      // Debug cameras / scripted walks never resume a remembered pose (a hot
      // reload mid-walk would otherwise restart from it: flaky walk-gate).
      if (
        !this.debug.camera &&
        !this.debug.walk &&
        !this.debug.preserveDrawingBuffer
      )
        this.player.restoreOr(
          {
            feet: new Vector3(spawn.x, spawn.y + 0.05, spawn.z),
            yaw: this.layout.lobby.spawnYaw,
          },
          (p) => zoneAt3(this.factoryLayout, this.layout, p).kind !== "outside",
        );
      // Fall net fallbacks: the reception, then the control room.
      const cs = this.layout.controlRoom.spawn;
      this.player.setFallbacks([
        { feet: new Vector3(0, 0.05, this.layout.bounds.min.z + 2), yaw: 0 },
        { feet: new Vector3(cs.x, cs.y + 0.05, cs.z), yaw: 0 },
      ]);
      this.lighting.setCamera(this.player.camera);
      this.player.setAvatar(createPlayerAvatar(this.scene));
      for (const m of this.player.avatarMeshes)
        this.lighting.addShadowCaster(m);
      if (this.debug.camera) {
        const c = this.debug.camera;
        this.player.setDebugCamera(new Vector3(c.x, c.y, c.z), c.yaw, c.pitch);
      }
      if (this.debug.walk) {
        const w = this.debug.walk.start;
        this.player.teleport(new Vector3(w.x, w.y + 0.05, w.z), w.yaw);
      }

      this.fx = new PostFx(this.scene, this.player.camera);
      this.interaction = new Interaction(
        this.scene,
        () => this.scene.activeCamera!,
        this.fx,
        this.events,
        () =>
          this.player!.flying
            ? this.player!.flyPosition.clone()
            : this.player!.position.add(new Vector3(0, PLAYER.eyeHeight, 0)),
      );
      // Depth of field follows the inspect action; ends when input returns.
      this.events.on("action", ({ action, target }) => {
        if (action === "inspect")
          this.gfx.beginInspect(this.interaction?.target?.distance ?? 2);
        if (action === "ride" && target.kind === "lift")
          this.building?.entrance?.callLift(target.stop === 1 ? 1 : 0);
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
      if (this.branding) this.building.setBranding(this.branding);
      // New visitors start at the ground-floor entrance doors once its floor
      // exists (returning players keep their remembered pose).
      if (this.building.entrance) {
        const es = this.factoryLayout.entrance;
        this.player.setSpawn({
          feet: new Vector3(es.spawn.x, es.spawn.y + 0.05, es.spawn.z),
          yaw: es.spawnYaw,
        });
      }
      this.factory = new Factory({
        scene: this.scene,
        materials: this.materials,
        colliders: this.colliders,
        lighting: this.lighting,
      });
      this.factory.setLayout(this.factoryLayout, this.layout);
      this.factoryLines = new FactoryLines(
        this.factory,
        {
          scene: this.scene,
          lighting: this.lighting,
          colliders: this.colliders,
        },
        { demo: !!this.debug.demoFactory, branding: this.branding },
      );
      this.feeds = new FeedScheduler(this.scene);
      this.buildControlRoom();
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
      // Colliders (building, factory, entrance) exist: let the player fall/walk.
      this.player.markReady();
      this.engine.runRenderLoop(() => this.frame());
      this.readyMs = Math.round(performance.now());
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
    for (const r of this.projectRooms.values()) r.dispose();
    this.projectRooms.clear();
    this.controlRoom?.dispose();
    this.feeds?.dispose();
    this.factory?.dispose();
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
    const groups = groupSessions(input.campus, input.sessions, input.projects);
    this.groups = groups;
    const nextSlots = allocateSlots(
      this.slots,
      groups.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        sessions: g.sessionIds.length,
      })),
    );
    const nextPods = allocatePods(this.pods, groups);
    const sig = layoutKey(nextSlots, groups, nextPods);
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      this.slots = nextSlots;
      this.pods = nextPods;
      const layout = generateLayout(nextSlots, groups, nextPods);
      const baysChanged = layout.bays !== this.layout.bays;
      this.layout = layout;
      this.podSlots = new Map(layout.rooms.map((r) => [r.sessionId, r.slot]));
      this.building?.build(layout);
      // The factory floor follows the rooms (cells under them); the shell
      // rebuilds only when the set of rooms changes.
      this.factoryLayout = buildFactoryLayout(layout);
      const factoryRebuilt =
        this.factory?.setLayout(this.factoryLayout, layout) ?? false;
      if (baysChanged && this.feeds) this.buildControlRoom();
      else this.controlRoom?.setLayout(layout);
      this.syncProjectRooms();
      if (factoryRebuilt) this.updateFixtures();
      this.events.emit("layout", layout);
    }

    const ops = diffCampus(this.model, input, this.podSlots);
    if (ops.length) {
      this.applyOps(ops);
      applyToModel(this.model, ops);
    }
    // Art: door signs read summary / refs / phase straight from the campus
    // session (RoomSign redraws only when its strings change).
    const byId = new Map(input.campus.map((c) => [c.sessionId, c]));
    for (const cs of input.campus) this.rooms.get(cs.sessionId)?.setCampus(cs);
    const labels = new Map(input.sessions.map((s) => [s.id, s.label]));
    for (const g of groups) {
      const members = g.sessionIds
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .sort(
          (a, b) =>
            (this.pods.get(a.sessionId) ?? 0) -
            (this.pods.get(b.sessionId) ?? 0),
        );
      this.projectRooms.get(g.id)?.setSessions(members, labels, g.name);
    }
    this.building?.setCampus(input.campus, groups.length); // control-room LED panel counts
    this.pushControlRoom();
    // Factory (P2.5): FactoryModel from the projects (prev model for lane
    // stability); pushed to the pools only when its key changed.
    this.factoryLines?.feed(input.projects, input.campus);
  }

  /** Create / rebuild / drop project rooms to match the layout (+ feeds). */
  private syncProjectRooms(): void {
    const want = new Map(this.layout.projects.map((p) => [p.projectId, p]));
    let changed = false;
    for (const [id, room] of this.projectRooms) {
      const p = want.get(id);
      if (p && this.projectKeys.get(id) === projectKey(p)) continue;
      room.dispose();
      this.projectRooms.delete(id);
      this.projectKeys.delete(id);
      this.feeds?.removeFeed(id);
      changed = true;
    }
    for (const [id, p] of want) {
      if (this.projectRooms.has(id)) continue;
      const room = new ProjectRoom(
        {
          scene: this.scene,
          materials: this.materials,
          assets: this.assets,
          colliders: this.colliders,
          lighting: this.lighting,
          fx: this.fx,
        },
        p,
      );
      this.projectRooms.set(id, room);
      this.projectKeys.set(id, projectKey(p));
      this.feeds?.addFeed(id, p.feedCamera, () => {
        // Pod asset groups follow Room's `room:<sessionId>` naming.
        const out = room.getRenderList(
          p.pods.map((pod) => `room:${pod.sessionId}`),
        );
        for (const pod of p.pods)
          out.push(...(this.rooms.get(pod.sessionId)?.getRenderList() ?? []));
        return out;
      });
      changed = true;
    }
    const alias = new Map<string, string>();
    for (const p of this.layout.projects)
      for (const pod of p.pods) alias.set(pod.sessionId, p.projectId);
    this.feeds?.setAliases(alias);
    if (changed) {
      this.updateFixtures();
      this.visibility?.invalidate();
    }
  }

  /** Control-room interior on top of the current shell (rebuilt with it). */
  private buildControlRoom(): void {
    if (!this.building || !this.feeds) return;
    this.controlRoom?.dispose();
    this.controlRoom = new ControlRoom(
      {
        scene: this.scene,
        materials: this.materials,
        assets: this.assets,
        colliders: this.colliders,
        lighting: this.lighting,
        fx: this.fx,
        feeds: this.feeds,
      },
      this.layout,
      this.building.controlShellMeshes,
    );
    this.pushControlRoom();
  }

  private pushControlRoom(): void {
    const input = this.lastInput;
    if (!this.controlRoom || !input) return;
    const labels = new Map<string, string>();
    for (const [id, r] of this.rooms) labels.set(id, r.currentLabel);
    this.controlRoom.setData(
      input.campus,
      input.stats,
      labels,
      input.projects,
      input.locale,
    );
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
          roomsChanged = true;
          wallDirty = true;
          break;
        }
        case "disposeRoom": {
          const room = this.rooms.get(op.sessionId);
          if (room) {
            room.dispose();
            this.rooms.delete(op.sessionId);
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
    if (wallDirty) this.pushControlRoom();
  }

  private firstSyncDone = false;

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
    const pts = [
      ...(this.building?.fixtures ?? []),
      ...(this.factory?.fixtures ?? []),
    ];
    for (const r of this.projectRooms.values()) pts.push(...r.getFixtures());
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

    if (this.debug.walk) {
      // Scripted walk: fixed 50 ms sub-steps, independent of the frame rate.
      for (let i = 0; i < WALK_SUBSTEPS; i++) {
        this.stepWalk(WALK_DT);
        this.input.update(WALK_DT * 1000);
        this.player.update(WALK_DT, this.input);
      }
    } else {
      this.input.update(dtMs);
      this.player.update(dt, this.inputEnabled ? this.input : null);
    }
    const eye = this.player.camera.globalPosition;
    this.assets.flush();
    for (const r of this.rooms.values()) r.update(dt, eye);
    for (const r of this.projectRooms.values()) r.update(dt, eye);
    this.building?.update(dt); // LED panel tickers (art)
    // Entrance: sliding doors + the lift (moves the rider between floors).
    const ride = this.building?.entrance?.update(dt, this.player.position);
    if (ride) this.player.teleport(ride.position, ride.yaw);
    const flying = this.player.flying;
    // Fly camera: the view, not the frozen body, drives zone / lights / pose.
    const focus = flying ? this.player.flyPosition : this.player.position;
    if (this.gfx.dynamicLights) this.lighting.update(dt, focus);
    this.interaction?.update(now);

    // y-aware zone at the player's eye (office, balcony or factory floor).
    const feet = focus;
    this.zonePt.set(feet.x, feet.y + (flying ? 0 : PLAYER.eyeHeight), feet.z);
    const zone = zoneAt3(this.factoryLayout, this.layout, this.zonePt);
    this.factory?.update(dt, eye, zone);
    const nearControl =
      zone.kind === "control" ||
      (feet.y > FACTORY_Y && feet.z > this.layout.hall.length - 6);
    if (this.feeds) {
      // Feeds render only inside the drum: from the hall end they would force
      // every room / actor to full detail in the main view (+1 feed RTT per
      // frame) for screens seen at 10 m through the neck.
      this.feeds.setActive(zone.kind === "control");
      this.feeds.update();
    }
    this.controlRoom?.update(dt, nearControl);

    this.updateLod(now, zone);

    this.scene.render();

    // Pose (10 Hz, on change)
    if (now - this.lastPoseAt >= POSE_MS) {
      this.lastPoseAt = now;
      const p = focus;
      const yaw = flying ? this.player.camera.rotation.y : this.player.yaw;
      const pose: PlayerPose = { x: p.x, z: p.z, yaw, zone };
      const key = `${p.x.toFixed(2)}:${p.z.toFixed(2)}:${yaw.toFixed(2)}:${zoneKey(zone)}`;
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
        tier: this.gfx.effective,
        effective: this.gfx.effective,
        postProcesses: this.fx?.postProcessCount ?? 0,
        drawCalls: this.sceneInstr.drawCallsCounter.current,
      });
      this.lastStatsAt = now;
      this.frames = 0;
      this.frameMsAcc = 0;
    }
  }

  private walkIdx = 0;
  private walkT = 0;
  private walkLogAt = 0;
  private readonly walkLog: string[] = [];
  private walkDone = false;

  /** Debug: steer the player through `debug.walk.points`. */
  private stepWalk(dt: number): void {
    const w = this.debug.walk;
    if (!w || !this.player) return;
    const p = this.player.position;
    this.walkT += dt;
    if (this.walkT - this.walkLogAt >= 0.5 && this.walkLog.length < 120) {
      this.walkLogAt = this.walkT;
      this.walkLog.push(
        `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`,
      );
    }
    if (this.walkIdx >= w.points.length || this.walkT > WALK_TIMEOUT_S) {
      this.input.setVirtualMove(0, 0);
      if (!this.walkDone) {
        this.walkDone = true;
        this.walkLog.push(`end ${p3(p)}`);
        // shot.sh waits for this (screenshot right after the walk).
        // (after the next __worldStats refresh, which runs every 500 ms).
        setTimeout(() => {
          (globalThis as { __worldShotReady?: boolean }).__worldShotReady =
            true;
        }, 800);
      }
      return;
    }
    const t = w.points[this.walkIdx];
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    if (Math.hypot(dx, dz) < 0.25) {
      this.walkIdx += 1;
      return;
    }
    this.player.yaw = Math.atan2(dx, dz);
    this.input.setVirtualMove(0, 1);
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private onInputEvent(e: InputEvent): void {
    if (!this.inputEnabled) return;
    switch (e) {
      case "camera":
        if (this.player?.flying) break;
        this.setCameraMode(this.cameraMode === "fp" ? "tp" : "fp");
        break;
      case "fly":
        // N toggles; Shift+N leaves by landing under the camera.
        this.toggleFly(this.input.sprint);
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

  /** Free-fly / noclip camera: enter at the eye pose, leave by return or landing. */
  toggleFly(land = false): void {
    const p = this.player;
    if (!p) return;
    if (p.flying) p.exitFly(land);
    else p.enterFly();
    if (this.interaction)
      this.interaction.rangeBoost = p.flying ? FLY.interactRange : null;
    this.events.emit("fly", p.flying);
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

  private branding: BrandingOptions | null = null;
  setBranding(opts: BrandingOptions): void {
    this.branding = opts;
    this.building?.setBranding(opts);
    this.factoryLines?.setBranding(opts);
  }

  /** Characters / screens / feeds detail fan-out (each target is feature-detected). */
  private detail: DetailSettings | null = null;
  private setDetail(d: DetailSettings): void {
    this.detail = d;
    type Detailed = { setDetail?(d: DetailSettings): void };
    for (const t of [this.feeds, this.controlRoom, ...this.rooms.values()])
      (t as Detailed | null)?.setDetail?.(d);
    this.actorHub?.setDetail(d.characterDetail);
    if (d.characterCast) setCharacterCast(this.scene, d.characterCast);
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

  /** Draws per render target in the last frame (debug `drawBreakdown`). */
  private passDraws: Record<string, number> = {};
  private passAcc: Record<string, number> = {};

  private hookDrawBreakdown(): void {
    const engine = this.engine as unknown as {
      _drawCalls: { current: number };
    };
    const proto = RenderTargetTexture.prototype as unknown as {
      render: (...a: unknown[]) => void;
      __wrapped?: boolean;
    };
    const acc = () => this.passAcc;
    if (!proto.__wrapped) {
      const orig = proto.render;
      proto.__wrapped = true;
      proto.render = function (this: { name: string }, ...a: unknown[]) {
        const before = engine._drawCalls.current;
        orig.apply(this, a);
        const k = this.name.replace(/[_:.\d]+$/, "");
        const tgt = (
          globalThis as { __passAcc?: () => Record<string, number> }
        ).__passAcc?.();
        if (tgt) tgt[k] = (tgt[k] ?? 0) + engine._drawCalls.current - before;
      };
    }
    (globalThis as { __passAcc?: () => Record<string, number> }).__passAcc =
      acc;
    this.scene.onAfterRenderObservable.add(() => {
      const total = engine._drawCalls.current;
      let rt = 0;
      for (const v of Object.values(this.passAcc)) rt += v;
      this.passDraws = { ...this.passAcc, main: total - rt, total };
      this.passAcc = {};
    });
  }

  private lastUploads = 0;

  /** Debug: highlight occluder kinds accumulated since the last stats tick. */
  private takeOccluderKinds(): Record<string, number> {
    const fx = this.fx;
    if (!fx) return {};
    fx.debugOccluders = true;
    const k = fx.occluderKinds;
    fx.occluderKinds = {};
    return k;
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

  private updateLod(now: number, zone: Zone3): void {
    if (!this.player || !this.visibility || !this.actorHub || !this.screenHub)
      return;
    const off = !!(globalThis as { __lodOff?: boolean }).__lodOff;
    this.actorHub.bypass = off;
    this.screenHub.bypass = off;
    const cam = this.player.camera;
    const eye = cam.globalPosition;
    const feedMode = this.feeds?.isActive ?? false;
    // Inside the sealed control room the rooms are out of sight: the feeds
    // keep rendering them, but characters / screens follow the visibility
    // detail (impostor) instead of being forced to full for the feeds.
    const sealed = zone.kind === "control";
    this.actorHub.setFeedMode(feedMode && !sealed);
    this.screenHub.setFeedMode(feedMode && !sealed);
    cam.getDirectionToRef(LOCAL_FORWARD, this.fwd);
    const dir = this.fwd;
    const yaw =
      Math.hypot(dir.x, dir.z) > 0.2
        ? Math.atan2(dir.x, dir.z)
        : this.player.yaw;
    if (!off) {
      // Reused input object; the room list only changes with the layout.
      if (this.visRoomsOf !== this.layout) {
        this.visRoomsOf = this.layout;
        this.visInput.rooms = visRoomsOfProjects(this.layout.projects);
      }
      const vi = this.visInput;
      vi.eye = eye;
      vi.yaw = yaw;
      vi.halfFov = halfFovFor(cam.fov, this.engine.getAspectRatio(cam));
      vi.zone = zone;
      vi.hallLength = this.layout.hall.length;
      vi.hallHalfWidth = this.layout.hall.width / 2;
      this.visibility.update(now, this.visHandles(), vi, feedMode);
    }
    if (!off && this.factory && now - this.lastFactoryVisAt >= FACTORY_VIS_MS) {
      this.lastFactoryVisAt = now;
      this.factory.applyVisibility(
        computeCellVisibility(
          this.factoryLayout,
          this.layout,
          { x: eye.x, y: eye.y, z: eye.z },
          { x: Math.sin(yaw), z: Math.cos(yaw) },
          zone,
        ),
        now,
      );
    }
    if (this.screenHub.needsUpdate || now - this.lastScreensAt >= 200) {
      this.lastScreensAt = now;
      this.screenHub.update(eye);
      // Furniture parts follow the tier's detail distances (5 Hz).
      const tier = this.detail?.characterDetail ?? "high";
      this.assets.cullParts(
        eye,
        off ? Infinity : SMALL_PART_M[tier],
        off ? Infinity : PART_M[tier],
      );
    }
    this.actorHub.update(eye);
    if (this.controlRoom) {
      const o = this.layout.controlRoom.screenWall.origin;
      const d = Math.hypot(eye.x - o.x, eye.z - o.z);
      const tier = this.detail?.characterDetail ?? "high";
      this.controlRoom.setFar(
        !feedMode && d > 22,
        tier !== "high" && d > DEEP_FAR_M,
      );
    }
    if (this.statsOn && now - this.lastDbgAt >= 500) {
      const dbgDt = now - this.lastDbgAt;
      this.lastDbgAt = now;
      const screenUploads =
        Math.round(((uploads.n - this.lastUploads) * 10000) / dbgDt) / 10;
      this.lastUploads = uploads.n;
      (globalThis as { __worldStats?: unknown }).__worldStats = {
        draws: this.dbgDraws(this.sceneInstr.drawCallsCounter.current),
        active: this.scene.getActiveMeshes().length,
        textures: this.scene.textures.length,
        /** Resident GPU texture memory estimate (WS5 budget: <= 300 at high). */
        textureMB: estimateTextureMB(this.engine),
        readyMs: this.readyMs,
        /** DynamicTexture uploads per second (screens / wall / signs). */
        screenUploads,
        postProcesses: this.fx?.postProcessCount ?? 0,
        tier: this.gfx.effective,
        actors: this.actorHub.stats(),
        zone: zone.kind,
        kinds: this.activeKinds(),
        factory: this.factoryLines?.stats(),
        ...(this.debug.drawBreakdown
          ? {
              passes: this.passDraws,
              texTop: largestTextures(this.engine),
              texBy: textureMBByGroup(this.engine),
              pp: this.fx?.stageNames ?? [],
              hl: this.takeOccluderKinds(),
            }
          : {}),
        ...(this.debug.walk
          ? {
              walk: {
                done: this.walkDone,
                reached: this.walkIdx,
                of: this.debug.walk.points.length,
                t: Math.round(this.walkT * 10) / 10,
                feet: [p3(this.player.position)],
                log: this.walkLog,
              },
            }
          : {}),
      };
    }
  }

  /** Scratch for updateLod (no per-frame allocation). */
  private readonly fwd = new Vector3();
  private visRoomsOf: BuildingLayout | null = null;
  private readonly visInput: VisInput = {
    eye: { x: 0, y: 0, z: 0 },
    yaw: 0,
    halfFov: 1,
    zone: { kind: "outside" } as Zone3,
    rooms: [],
    hallLength: 0,
    hallHalfWidth: 0,
  };

  /** Visibility units: project rooms, their pods follow (screens / actors). */
  private visCache: Map<string, VisRoomHandle> | null = null;
  private visCacheKey = "";

  private visHandles(): Map<string, VisRoomHandle> {
    const key = `${this.layoutSig}|${this.rooms.size}|${this.projectRooms.size}`;
    if (this.visCache && key === this.visCacheKey) return this.visCache;
    this.visCacheKey = key;
    const out = new Map<string, VisRoomHandle>();
    this.visCache = out;
    for (const p of this.layout.projects) {
      const pr = this.projectRooms.get(p.projectId);
      const pods = p.pods
        .map((d) => this.rooms.get(d.sessionId))
        .filter((r): r is Room => !!r);
      out.set(p.projectId, {
        root: {
          setEnabled: (v: boolean) => {
            pr?.root.setEnabled(v);
            for (const r of pods) r.root.setEnabled(v);
          },
        },
        members: p.pods.map((d) => d.sessionId),
        memberBounds: new Map(
          p.pods.map((d) => [
            d.sessionId,
            {
              minX: d.bounds.min.x,
              maxX: d.bounds.max.x,
              minZ: d.bounds.min.z,
              maxZ: d.bounds.max.z,
            },
          ]),
        ),
      });
    }
    return out;
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (enabled) this.gfx.endInspect();
    this.input.setEnabled(enabled);
    if (this.interaction) this.interaction.enabled = enabled;
  }

  teleport(to: TeleportTarget): void {
    if (!this.player) return;
    this.events.emit("teleport", undefined); // HUD fade (worldUiStore.fadeSeq)
    this.player.frozen = false;
    const fl = this.factoryLayout;
    if (to === "floor") {
      // Just inside the entrance building's factory door, facing the plant.
      const z = fl.bounds.min.z + 1.5;
      this.player.teleport(new Vector3(0, fl.floorY + 0.05, z), 0);
      return;
    }
    if (typeof to === "object" && "factoryCell" in to) {
      const c = fl.cells.find((x) => x.projectId === to.factoryCell);
      if (!c) return;
      // Just off the cell stair's last flight, facing out along the lanes.
      const f = cellStairFoot(c.side, c.z0, c.stair.top.z);
      const yaw = c.side === "east" ? Math.PI / 2 : -Math.PI / 2;
      this.player.teleport(new Vector3(f.x, fl.floorY + 0.05, f.z), yaw);
      return;
    }
    if (typeof to === "object" && "factoryDock" in to) {
      // On the loading platform in front of the truck's door, facing +z.
      const d = fl.dock;
      this.player.teleport(
        new Vector3(
          DOCK_SPAWN.x,
          fl.floorY + DOCK.platformH + DOCK_SPAWN.y,
          d.z1 + DOCK_SPAWN.z,
        ),
        0,
      );
      return;
    }
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
    const room =
      "projectId" in to
        ? this.layout.projects.find((p) => p.projectId === to.projectId)
        : projectOfSession(this.layout, to.sessionId);
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
