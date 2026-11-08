/**
 * GraphicsController — maps GraphicsSettings onto the renderer subsystems and
 * applies changes live (no reload).
 *
 *   settings ──► resolveEffective (auto → governor tier) ──► planFx (pure)
 *            ──► diffPlan ──► PostFx stages / Lighting / Materials / Player /
 *                Input / engine scaling / detail fan-out
 *
 * Subsystem APIs owned by other agents (Lighting.setShadowQuality, ...) are
 * feature-detected; the fallbacks keep the existing behaviour.
 */
import type {
  AbstractEngine,
  AbstractMesh,
  Scene,
  Camera,
} from "@/engine/babylon";
import { Vector3, type Mesh } from "@/engine/babylon";
import type { Lighting } from "@/engine/fx/Lighting";
import type { Materials } from "@/engine/materials/Materials";
import type { PostFx } from "@/engine/fx/PostFx";
import type { InputController } from "@/engine/input/Input";
import type { Player } from "@/engine/player/Player";
import {
  SHADOW_MAP_SIZE,
  activeStages,
  autoStartTier,
  diffPlan,
  gbufferReach,
  planFx,
  resolveEffective,
  type ConcretePreset,
  type FxPlan,
} from "@/engine/fx/fxPlan";
import { QualityGovernor } from "@/engine/fx/Quality";
import {
  nearestPreset,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";

export interface DetailSettings {
  characterDetail: GraphicsSettings["characterDetail"];
  characterCast: GraphicsSettings["characterCast"];
  liveScreens: GraphicsSettings["liveScreens"];
  securityFeeds: GraphicsSettings["securityFeeds"];
}

export interface GfxTargets {
  engine: AbstractEngine;
  scene: Scene;
  lighting: Lighting;
  materials: Materials;
  input: InputController;
  getFx(): PostFx | null;
  getPlayer(): Player | null;
  /** Fan-out to the characters / screens subsystems (feature-detected there). */
  setDetail(d: DetailSettings): void;
}

/** Optional APIs added by the art agent (feature-detected). */
interface LightingExt {
  setShadowQuality?(q: GraphicsSettings["shadows"]): void;
  setAreaLights?(on: boolean): void;
  setReflectionProbes?(on: boolean): void;
  setMaxDynamicLights?(n: number): void;
}
interface MaterialsExt {
  setAnisotropy?(n: number): void;
  setTextureQuality?(q: GraphicsSettings["textureQuality"]): void;
}

/** Base-geometry AABB of a thin-instanced mesh (instance-local), cached. */
const geomBounds = new WeakMap<
  Mesh,
  {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    z0: number;
    z1: number;
    r: number;
    n: number;
  }
>();
/** Instances entirely this far above / below the eye (another storey) are skipped. */
const STOREY_M = 2.5;
/**
 * G-buffer range for thin-instanced furniture / room prefabs (m, from the eye
 * to the instance's box): their AO and reflections are close-up detail; a
 * team room seen through its glass front from the lobby does not need them.
 */
const THIN_RANGE_M = 6;

/**
 * Thin-instanced meshes (furniture parts, room prefabs, factory pools) carry
 * bounds spanning every instance in the building, so the sphere test above
 * would keep all of them in the G-buffer from anywhere. Test the instances
 * instead: is any instance's box (base geometry, in its own frame) within
 * reach of the eye and on the eye's storey?
 */
function thinNear(m: Mesh, eye: Vector3, range: number): boolean {
  const st = (
    m as unknown as {
      _thinInstanceDataStorage?: {
        matrixData: Float32Array | null;
        instancesCount: number;
      };
    }
  )._thinInstanceDataStorage;
  const data = st?.matrixData;
  const count = Math.min(st?.instancesCount ?? 0, m.thinInstanceCount);
  if (!data || count <= 0) return true;
  const pos = m.geometry?.getVerticesData("position");
  if (!pos) return true;
  let g = geomBounds.get(m);
  if (!g || g.n !== pos.length) {
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      x0 = Math.min(x0, pos[i]);
      x1 = Math.max(x1, pos[i]);
      y0 = Math.min(y0, pos[i + 1]);
      y1 = Math.max(y1, pos[i + 1]);
      z0 = Math.min(z0, pos[i + 2]);
      z1 = Math.max(z1, pos[i + 2]);
    }
    const r = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
    g = { x0, x1, y0, y1, z0, z1, r, n: pos.length };
    geomBounds.set(m, g);
  }
  const reach = Math.min(gbufferReach(g.r, range), THIN_RANGE_M);
  const w = m.getWorldMatrix().m;
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    // Instance → world: instance matrix, then the mesh's world matrix.
    const tx = data[o + 12];
    const ty = data[o + 13];
    const tz = data[o + 14];
    const px = tx * w[0] + ty * w[4] + tz * w[8] + w[12];
    const py = tx * w[1] + ty * w[5] + tz * w[9] + w[13];
    const pz = tx * w[2] + ty * w[6] + tz * w[10] + w[14];
    const dx = eye.x - px;
    const dy = eye.y - py;
    const dz = eye.z - pz;
    // Eye in the instance frame (rotation + scale; mesh world assumed
    // translation-only, as for every pool / prefab / furniture part).
    const ax = data[o],
      ay = data[o + 1],
      az = data[o + 2];
    const bx = data[o + 4],
      by = data[o + 5],
      bz = data[o + 6];
    const cx = data[o + 8],
      cy = data[o + 9],
      cz = data[o + 10];
    const sa = ax * ax + ay * ay + az * az || 1;
    const sb = bx * bx + by * by + bz * bz || 1;
    const sc = cx * cx + cy * cy + cz * cz || 1;
    const lx = (dx * ax + dy * ay + dz * az) / sa;
    const ly = (dx * bx + dy * by + dz * bz) / sb;
    const lz = (dx * cx + dy * cy + dz * cz) / sc;
    const s = Math.sqrt(Math.max(sa, sb, sc));
    // Another storey (room furniture seen from the factory floor, factory
    // pools seen from the offices): its AO / reflections never show.
    const oy = Math.max(0, g.y0 - ly, ly - g.y1) * Math.sqrt(sb);
    if (oy > STOREY_M) continue;
    const ox = Math.max(0, g.x0 - lx, lx - g.x1);
    const oz = Math.max(0, g.z0 - lz, lz - g.z1);
    const d = Math.hypot(ox, oy / Math.sqrt(sb), oz) * s;
    if (d < reach) return true;
  }
  return false;
}

const INSPECT_IN = 7; // 1/s exponential rates
const INSPECT_OUT = 9;

export class GraphicsController {
  private requested: GraphicsSettings;
  private plan: FxPlan | null = null;
  private applied: FxPlan | null = null;
  private readonly governor: QualityGovernor;
  private started = false;
  private lastRenderAt = 0;
  private inspecting = false;
  private inspectFocusM = 2;
  private dofStrength = 0;
  private iblNoted = false;
  private gbufHooked: unknown = null;
  private readonly gbufList: AbstractMesh[] = [];

  constructor(
    private readonly t: GfxTargets,
    initial: GraphicsSettings,
    lowEnd: boolean,
  ) {
    this.requested = initial;
    this.governor = new QualityGovernor(initial.preset === "auto", lowEnd, () =>
      this.refresh(),
    );
    this.plan = planFx(resolveEffective(initial, this.governor.tier));
  }

  get settings(): GraphicsSettings {
    return this.requested;
  }

  /** Concrete tier currently in effect (the governor's tier under "auto"). */
  get effective(): ConcretePreset {
    const p = this.requested.preset;
    if (p === "auto") return this.governor.tier;
    return p === "custom" ? nearestPreset(this.requested) : p;
  }

  get currentPlan(): FxPlan | null {
    return this.plan;
  }

  get dynamicLights(): boolean {
    return (this.plan?.maxDynamicLights ?? 0) > 0;
  }

  /** Active post-process names (diagnostics / report). */
  get activeStages(): string[] {
    return this.plan
      ? activeStages(this.plan, this.t.getFx()?.dofActive ?? false)
      : [];
  }

  /** Apply everything once the world is built. */
  start(): void {
    this.started = true;
    this.refresh();
  }

  set(settings: GraphicsSettings): void {
    this.requested = settings;
    this.governor.setAuto(settings.preset === "auto");
    this.refresh();
  }

  sampleFrame(frameMs: number, nowMs: number): void {
    this.governor.sample(frameMs, nowMs);
  }

  /**
   * FPS cap gate, call once per animation frame. Returns the time (ms) since
   * the last rendered frame, or -1 when this frame should be skipped.
   */
  beginFrame(now: number, fallbackDtMs: number): number {
    const cap = this.plan?.fpsCap ?? 0;
    const last = this.lastRenderAt;
    if (cap > 0 && last && now - last < (1000 / cap) * 0.92) return -1;
    this.lastRenderAt = now;
    return last ? Math.min(now - last, 100) : fallbackDtMs;
  }

  // ---- depth of field / inspect ----

  beginInspect(distanceM: number): void {
    this.inspecting = true;
    this.inspectFocusM = Math.max(0.4, distanceM);
  }

  endInspect(): void {
    this.inspecting = false;
  }

  /** Per-frame: animate DoF focus in/out. */
  update(dtMs: number): void {
    this.updateGBufferList();
    const fx = this.t.getFx();
    const mode = this.plan?.dofMode ?? "off";
    if (!fx || mode === "off") return;
    const target = mode === "always" ? 1 : this.inspecting ? 1 : 0;
    if (
      Math.abs(target - this.dofStrength) < 0.002 &&
      target === this.dofStrength
    )
      return;
    const rate = target > this.dofStrength ? INSPECT_IN : INSPECT_OUT;
    const k = 1 - Math.exp(-rate * (dtMs / 1000));
    this.dofStrength += (target - this.dofStrength) * k;
    if (Math.abs(target - this.dofStrength) < 0.01) this.dofStrength = target;
    const focus = mode === "always" ? this.alwaysFocus() : this.inspectFocusM;
    fx.setDof(this.dofStrength, focus);
  }

  /**
   * SSAO/SSR re-render every active mesh into the geometry buffer (a second
   * full scene pass). Hook the G-buffer's render-list callback so it only
   * draws active (frustum-culled) meshes that are still near enough to matter
   * (see gbufferReach); the callback reads the live plan each frame.
   */
  private updateGBufferList(): void {
    const mrt = this.t.scene.geometryBufferRenderer?.getGBuffer();
    if (!mrt || mrt === this.gbufHooked) return;
    this.gbufHooked = mrt;
    const scene = this.t.scene;
    const out = this.gbufList;
    mrt.getCustomRenderList = (_i, list, len) => {
      const range = this.plan?.gbufferRangeM ?? 0;
      const cam = scene.activeCamera;
      if (range <= 0 || !cam || !list) return null;
      const eye = cam.globalPosition;
      out.length = 0;
      for (let i = 0; i < len; i++) {
        const m = list[i];
        // Unlit (emissive screens, LED panels, sky) neither receive AO nor
        // reflect: the surface behind them stands in for their depth.
        const mat = m.material as {
          disableLighting?: boolean;
          unlit?: boolean;
        } | null;
        if (mat && (mat.disableLighting || mat.unlit)) continue;
        if ((m as Mesh).hasThinInstances) {
          if (thinNear(m as Mesh, eye, range)) out.push(m);
          continue;
        }
        const bs = m.getBoundingInfo().boundingSphere;
        const c = bs.centerWorld;
        const r = bs.radiusWorld;
        const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
        if (d - r < gbufferReach(r, range)) out.push(m);
      }
      return out;
    };
  }

  private alwaysFocus(): number {
    return this.inspecting ? this.inspectFocusM : 5;
  }

  // ---- apply ----

  private refresh(): void {
    const eff = resolveEffective(this.requested, this.governor.tier);
    this.plan = planFx(eff);
    if (!this.started) return;
    this.applyPlan(this.plan);
  }

  private applyPlan(plan: FxPlan): void {
    const prev = this.applied;
    const d = diffPlan(prev, plan);
    this.applied = plan;
    const { engine, lighting, materials } = this.t;
    const L = lighting as unknown as LightingExt;
    const M = materials as unknown as MaterialsExt;

    if (d.has("renderScale") || d.has("maxPixelRatio") || d.has("fsr")) {
      const dpr =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      engine.setHardwareScalingLevel(
        1 / (Math.min(dpr, plan.maxPixelRatio) * plan.renderScale),
      );
    }

    // Post-processing (structural stages rebuilt inside PostFx).
    const fx = this.t.getFx();
    if (fx) {
      const postKeys: (keyof FxPlan)[] = [
        "fsr",
        "msaa",
        "fxaa",
        "taa",
        "ssao",
        "ssr",
        "bloom",
        "chromaticAberration",
        "grain",
        "motionBlur",
        "sharpenOn",
        "dofMode",
        "glow",
        "sharpen",
        "vignette",
        "colorGrading",
      ];
      if (!prev || postKeys.some((k) => d.has(k))) fx.apply(plan);
    }

    // Shadows / lights / materials (art agent APIs feature-detected).
    if (d.has("shadows")) {
      if (typeof L.setShadowQuality === "function")
        L.setShadowQuality(plan.shadows);
      else if (plan.shadows === "off") lighting.disableShadows();
      else lighting.enableShadows(SHADOW_MAP_SIZE[plan.shadows]);
    }
    if (d.has("areaLights") && typeof L.setAreaLights === "function")
      L.setAreaLights(plan.areaLights);
    if (
      d.has("reflectionProbes") &&
      typeof L.setReflectionProbes === "function"
    )
      L.setReflectionProbes(plan.reflectionProbes);
    if (d.has("maxDynamicLights")) {
      if (typeof L.setMaxDynamicLights === "function")
        L.setMaxDynamicLights(plan.maxDynamicLights);
      lighting.setPoolIntensity(plan.maxDynamicLights > 0 ? 1 : 0);
      if (plan.maxDynamicLights === 0) lighting.update(1, Vector3.Zero());
    }
    if (d.has("anisotropy")) {
      if (typeof M.setAnisotropy === "function")
        M.setAnisotropy(plan.anisotropy);
    }
    if (d.has("textureQuality") && typeof M.setTextureQuality === "function")
      M.setTextureQuality(plan.textureQuality);

    if (d.has("iblShadows") && plan.iblShadows && !this.iblNoted) {
      this.iblNoted = true;
      console.info(
        "[gfx] iblShadows: IBLShadowsRenderPipeline is not wired up (needs a voxelised scene and prepass materials); setting is a no-op.",
      );
    }

    // World detail (characters / screens / feeds).
    if (
      d.has("characterDetail") ||
      d.has("characterCast") ||
      d.has("liveScreens") ||
      d.has("securityFeeds")
    )
      this.t.setDetail({
        characterDetail: plan.characterDetail,
        characterCast: plan.characterCast,
        liveScreens: plan.liveScreens,
        securityFeeds: plan.securityFeeds,
      });

    // Display & camera.
    const player = this.t.getPlayer();
    if (player) this.applyPlayer(player.camera, plan, player);
    this.t.input.setLook(plan.mouseSensitivity, plan.invertY);
  }

  private applyPlayer(cam: Camera, plan: FxPlan, player: Player): void {
    cam.fov = (plan.fovDeg * Math.PI) / 180;
    player.headBob = plan.headBob;
  }

  /** Re-apply the player-bound settings (call after the player is created). */
  syncPlayer(): void {
    const player = this.t.getPlayer();
    if (player && this.plan) this.applyPlayer(player.camera, this.plan, player);
  }

  /** Tier the governor would start from on this device (for tests/diagnostics). */
  static startTier(lowEnd: boolean): ConcretePreset {
    return autoStartTier(lowEnd);
  }
}
