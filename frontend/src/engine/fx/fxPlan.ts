/**
 * Pure mapping GraphicsSettings → render plan. No Babylon imports so it is
 * unit-testable in node. `GraphicsController` applies the plan to the
 * subsystems and uses `diffPlan` to touch only what changed.
 */
import {
  AUTO_LADDER,
  applyPreset,
  type GraphicsPreset,
  type GraphicsSettings,
  type ShadowQuality,
} from "@/engine/fx/graphicsSettings";

export type ConcretePreset = Exclude<GraphicsPreset, "auto" | "custom">;

export interface SsaoPlan {
  ratio: number;
  blurRatio: number;
  samples: number;
  expensiveBlur: boolean;
}

export interface SsrPlan {
  maxSteps: number;
  step: number;
  thickness: number;
  strength: number;
  roughnessFactor: number;
  /** 0 = full resolution, 1 = half (needs blur, so blur is on whenever > 0). */
  downsample: number;
  blur: number;
}

export interface FxPlan {
  // ---- structural: changing any of these rebuilds the affected pipeline stage
  fsr: { scaleFactor: number } | null;
  /** Scene MSAA samples (1 = off). Always 1 with TAA. */
  msaa: 1 | 2 | 4;
  fxaa: boolean;
  taa: { samples: number } | null;
  ssao: SsaoPlan | null;
  ssr: SsrPlan | null;
  /**
   * G-buffer (SSAO/SSR) draw range in metres: only active meshes whose bounds
   * come within this distance of the eye are rendered into the geometry
   * buffer (the pass re-draws everything otherwise). 0 = no G-buffer / no cap.
   */
  gbufferRangeM: number;
  bloom: boolean;
  chromaticAberration: boolean;
  grain: boolean;
  motionBlur: boolean;
  sharpenOn: boolean;
  /** DoF pipeline stage present (runtime-driven for inspectOnly). */
  dofMode: "off" | "inspectOnly" | "always";
  glow: boolean;
  // ---- parameters: applied in place
  sharpen: number;
  vignette: boolean;
  colorGrading: boolean;
  /** Divisor applied on top of the device pixel ratio when not using FSR. */
  renderScale: number;
  maxPixelRatio: number;
  // ---- world
  shadows: ShadowQuality;
  areaLights: boolean;
  reflectionProbes: boolean;
  maxDynamicLights: number;
  anisotropy: number;
  textureQuality: "low" | "medium" | "high";
  iblShadows: boolean;
  characterDetail: GraphicsSettings["characterDetail"];
  characterCast: GraphicsSettings["characterCast"];
  liveScreens: GraphicsSettings["liveScreens"];
  securityFeeds: GraphicsSettings["securityFeeds"];
  // ---- display & camera
  fovDeg: number;
  fpsCap: number;
  headBob: boolean;
  mouseSensitivity: number;
  invertY: boolean;
}

export const SHADOW_MAP_SIZE: Record<ShadowQuality, number> = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: 2048,
  ultra: 4096,
};

export const SSAO_BY_QUALITY: Record<
  Exclude<GraphicsSettings["ambientOcclusion"], "off">,
  SsaoPlan
> = {
  low: { ratio: 0.5, blurRatio: 0.5, samples: 8, expensiveBlur: false },
  // High preset: half-res AO with the cheap blur (TAA resolves the noise).
  medium: { ratio: 0.5, blurRatio: 0.5, samples: 16, expensiveBlur: false },
  high: { ratio: 0.75, blurRatio: 0.75, samples: 24, expensiveBlur: true },
};

/**
 * G-buffer draw range per AO quality (AO radius is < 1 m, SSR is subtle far
 * away). "medium" is the high preset: 10 m covers a room and a hall bay.
 */
export const GBUFFER_RANGE_M = { low: 8, medium: 10, high: 16 } as const;

/**
 * How far from the eye a mesh of bounding radius `r` must still be drawn into
 * the G-buffer: small props only matter for AO / SSR close up, big architecture
 * (floors, walls, merged shells) out to the full `range`.
 */
export function gbufferReach(r: number, range: number): number {
  return Math.min(range, 1 + 4 * r);
}

export function gbufferRange(s: GraphicsSettings): number {
  if (s.ambientOcclusion !== "off") return GBUFFER_RANGE_M[s.ambientOcclusion];
  if (s.screenSpaceReflections !== "off") return GBUFFER_RANGE_M.medium;
  return 0;
}

export const SSR_BY_QUALITY: Record<
  Exclude<GraphicsSettings["screenSpaceReflections"], "off">,
  SsrPlan
> = {
  low: {
    maxSteps: 48,
    step: 3,
    thickness: 0.6,
    strength: 0.7,
    roughnessFactor: 0.2,
    downsample: 1,
    blur: 0.4,
  },
  // High preset: one full-resolution pass, no blur/combiner (3 fewer passes);
  // TAA resolves the roughness jitter while the camera rests.
  medium: {
    maxSteps: 96,
    step: 2,
    thickness: 0.45,
    strength: 0.7,
    roughnessFactor: 0.2,
    downsample: 0,
    blur: 0,
  },
  high: {
    maxSteps: 180,
    step: 1,
    thickness: 0.3,
    strength: 0.75,
    roughnessFactor: 0.2,
    downsample: 0,
    blur: 0,
  },
};

export function aaParts(aa: GraphicsSettings["antiAliasing"]): {
  msaa: 1 | 2 | 4;
  fxaa: boolean;
  taa: boolean;
} {
  switch (aa) {
    case "fxaa":
      return { msaa: 1, fxaa: true, taa: false };
    case "msaa2":
      return { msaa: 2, fxaa: false, taa: false };
    case "msaa4":
      return { msaa: 4, fxaa: false, taa: false };
    case "taa":
      return { msaa: 1, fxaa: false, taa: true };
    case "taa+fxaa":
      return { msaa: 1, fxaa: true, taa: true };
    default:
      return { msaa: 1, fxaa: false, taa: false };
  }
}

export function planFx(s: GraphicsSettings): FxPlan {
  const aa = aaParts(s.antiAliasing);
  const scale = Math.min(1, Math.max(0.5, s.renderScale));
  const fsrOn = s.upscaler === "fsr1" && scale < 0.999;
  return {
    fsr: fsrOn ? { scaleFactor: Math.round((1 / scale) * 100) / 100 } : null,
    msaa: aa.msaa,
    fxaa: aa.fxaa,
    taa: aa.taa ? { samples: s.antiAliasing === "taa+fxaa" ? 16 : 8 } : null,
    ssao:
      s.ambientOcclusion === "off" ? null : SSAO_BY_QUALITY[s.ambientOcclusion],
    ssr:
      s.screenSpaceReflections === "off"
        ? null
        : SSR_BY_QUALITY[s.screenSpaceReflections],
    gbufferRangeM: gbufferRange(s),
    bloom: s.bloom,
    chromaticAberration: s.chromaticAberration,
    grain: s.filmGrain,
    motionBlur: s.motionBlur,
    // FSR has its own sharpening; TAA output is already crisp when static.
    sharpenOn: s.sharpen > 0.001 && !fsrOn && !aa.taa,
    dofMode: s.depthOfField,
    glow: s.glow,
    sharpen: s.sharpen,
    vignette: s.vignette,
    colorGrading: s.colorGrading,
    renderScale: fsrOn ? 1 : scale,
    maxPixelRatio: s.maxPixelRatio,
    shadows: s.shadows,
    areaLights: s.areaLights,
    reflectionProbes: s.reflectionProbes,
    maxDynamicLights: s.maxDynamicLights,
    anisotropy: s.anisotropy,
    textureQuality: s.textureQuality,
    iblShadows: s.iblShadows,
    characterDetail: s.characterDetail,
    characterCast: s.characterCast,
    liveScreens: s.liveScreens,
    securityFeeds: s.securityFeeds,
    fovDeg: s.fov,
    fpsCap: s.fpsCap,
    headBob: s.headBob,
    mouseSensitivity: s.mouseSensitivity,
    invertY: s.invertY,
  };
}

/** Pipeline stages in camera post-process order (FSR must be first: it sets the scene RT size). */
export const STAGES = [
  "fsr",
  "ssao",
  "ssr",
  "taa",
  "motionBlur",
  "default",
] as const;
export type StageName = (typeof STAGES)[number];

/** Structural key of one stage: when it changes, that stage and every later one is rebuilt. */
export function stageKey(p: FxPlan, stage: StageName, dofLive = false): string {
  switch (stage) {
    case "fsr":
      return p.fsr ? `fsr:${p.fsr.scaleFactor}:${p.msaa}` : "";
    case "ssao":
      return p.ssao ? JSON.stringify(p.ssao) : "";
    case "ssr":
      return p.ssr
        ? `${p.ssr.downsample}:${p.ssr.blur > 0 ? 1 : 0}:${p.msaa}`
        : "";
    case "taa":
      return p.taa ? `taa:${p.taa.samples}` : "";
    case "motionBlur":
      return p.motionBlur ? "mb" : "";
    case "default":
      return [
        // With FSR, the scene RT (and MSAA) belong to the FSR stage.
        p.fsr ? 1 : p.msaa,
        +p.fxaa,
        +p.bloom,
        +p.chromaticAberration,
        +p.grain,
        +p.sharpenOn,
        +dofLive,
      ].join(":");
  }
}

export function structuralKeys(
  p: FxPlan,
  dofLive = false,
): Record<StageName, string> {
  const out = {} as Record<StageName, string>;
  for (const st of STAGES) out[st] = stageKey(p, st, dofLive);
  return out;
}

/** Index of the first stage whose structural key changed, or -1. */
export function firstChangedStage(
  prev: Record<StageName, string> | null,
  next: Record<StageName, string>,
): number {
  if (!prev) return 0;
  return STAGES.findIndex((st) => prev[st] !== next[st]);
}

/** Names of the plan fields that differ (used to touch only what changed). */
export function diffPlan(prev: FxPlan | null, next: FxPlan): Set<keyof FxPlan> {
  const out = new Set<keyof FxPlan>();
  for (const k of Object.keys(next) as (keyof FxPlan)[]) {
    if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(next[k]))
      out.add(k);
  }
  return out;
}

/** Concrete settings for the active tier: "auto" resolves to the governor tier. */
export function resolveEffective(
  s: GraphicsSettings,
  autoTier: ConcretePreset,
): GraphicsSettings {
  if (s.preset !== "auto") return s;
  return { ...applyPreset(autoTier, s), preset: "auto" };
}

export function autoStartTier(lowEnd: boolean): ConcretePreset {
  return lowEnd ? AUTO_LADDER[AUTO_LADDER.length - 1] : AUTO_LADDER[0];
}

/** Active post-process names for diagnostics / the report. */
export function activeStages(p: FxPlan, dofLive: boolean): string[] {
  const out: string[] = [];
  if (p.fsr) out.push("fsr1");
  if (p.ssao) out.push("ssao2");
  if (p.ssr) out.push("ssr");
  if (p.taa) out.push("taa");
  if (p.motionBlur) out.push("motionBlur");
  out.push("imageProcessing");
  if (p.msaa > 1) out.push(`msaa${p.msaa}`);
  if (p.fxaa) out.push("fxaa");
  if (p.bloom) out.push("bloom");
  if (p.sharpenOn) out.push("sharpen");
  if (p.chromaticAberration) out.push("chromaticAberration");
  if (p.grain) out.push("grain");
  if (dofLive) out.push("dof");
  if (p.glow) out.push("glowLayer");
  return out;
}
