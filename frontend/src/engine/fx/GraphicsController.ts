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
import type { AbstractEngine, Scene, Camera } from "@/engine/babylon";
import { Vector3 } from "@/engine/babylon";
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
      d.has("liveScreens") ||
      d.has("securityFeeds")
    )
      this.t.setDetail({
        characterDetail: plan.characterDetail,
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
