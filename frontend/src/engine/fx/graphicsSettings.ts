/**
 * Graphics settings — the single contract between the in-app Graphics menu
 * (React) and the renderer (engine/fx). Plain data, no Babylon imports, so it
 * is testable in node and safe to import from UI code.
 *
 * Model (like PC games): the user picks a preset, which fills every field;
 * touching any individual field turns the preset into "custom". "auto" lets
 * the frame-time governor move between low…high at runtime.
 */

export type GraphicsPreset =
  "auto" | "low" | "medium" | "high" | "ultra" | "custom";

export type AntiAliasing =
  "off" | "fxaa" | "msaa2" | "msaa4" | "taa" | "taa+fxaa";
export type ShadowQuality = "off" | "low" | "medium" | "high" | "ultra";
export type EffectQuality = "off" | "low" | "medium" | "high";
export type Upscaler = "none" | "fsr1";

export const GRAPHICS_PRESETS = [
  "auto",
  "low",
  "medium",
  "high",
  "ultra",
  "custom",
] as const satisfies readonly GraphicsPreset[];
export const ANTI_ALIASING_VALUES = [
  "off",
  "fxaa",
  "msaa2",
  "msaa4",
  "taa",
  "taa+fxaa",
] as const satisfies readonly AntiAliasing[];
export const SHADOW_QUALITY_VALUES = [
  "off",
  "low",
  "medium",
  "high",
  "ultra",
] as const satisfies readonly ShadowQuality[];
export const EFFECT_QUALITY_VALUES = [
  "off",
  "low",
  "medium",
  "high",
] as const satisfies readonly EffectQuality[];
export const UPSCALER_VALUES = [
  "none",
  "fsr1",
] as const satisfies readonly Upscaler[];
export const ANISOTROPY_VALUES = [1, 2, 4, 8, 16] as const;
export const TEXTURE_QUALITY_VALUES = ["low", "medium", "high"] as const;
export const DEPTH_OF_FIELD_VALUES = ["off", "inspectOnly", "always"] as const;
export const CHARACTER_DETAIL_VALUES = ["low", "medium", "high"] as const;
/**
 * Character cast: "mixed" = Rocketbox boss (close-up hero) + MPFB subagents,
 * "custom" = the user's own pack in public/assets/characters-custom/.
 */
export const CHARACTER_CAST_VALUES = [
  "mixed",
  "rocketbox",
  "mpfb",
  "custom",
] as const;
export type CharacterCast = (typeof CHARACTER_CAST_VALUES)[number];
export const LIVE_SCREENS_VALUES = ["off", "near", "all"] as const;
export const SECURITY_FEEDS_VALUES = ["off", "low", "high"] as const;
export const FPS_CAP_VALUES = [0, 30, 60, 120, 144] as const;

export interface GraphicsSettings {
  preset: GraphicsPreset;

  // ---- Image quality ----
  antiAliasing: AntiAliasing;
  /** Internal render resolution as a fraction of native (0.5–1). */
  renderScale: number;
  /** Upscaler used when renderScale < 1. */
  upscaler: Upscaler;
  /** Cap on devicePixelRatio used for rendering (1–2). */
  maxPixelRatio: number;
  sharpen: number; // 0–1
  anisotropy: 1 | 2 | 4 | 8 | 16;
  textureQuality: "low" | "medium" | "high"; // max texture size 512 / 1024 / 2048

  // ---- Lighting & shadows ----
  shadows: ShadowQuality; // off / 1024 / 2048 / 2048 PCSS-ish / 4096
  ambientOcclusion: EffectQuality; // SSAO2 sample count / resolution
  areaLights: boolean; // RectAreaLight ceiling panels vs emissive + point lights
  maxDynamicLights: number; // point/spot lights near the player (0–8)
  iblShadows: boolean; // experimental voxel-traced environment shadows
  skinScattering: boolean; // character skin subsurface scattering (prepass)

  // ---- Reflections ----
  screenSpaceReflections: EffectQuality;
  reflectionProbes: boolean; // per-room box-projected probes

  // ---- Post-processing ----
  bloom: boolean;
  glow: boolean; // emissive screens/lamps glow layer
  depthOfField: "off" | "inspectOnly" | "always";
  colorGrading: boolean; // LUT
  filmGrain: boolean;
  vignette: boolean;
  chromaticAberration: boolean;
  motionBlur: boolean;

  // ---- World detail ----
  characterDetail: "low" | "medium" | "high"; // LOD bias, animation rate, max skinned characters
  characterCast: CharacterCast; // which character pack(s) to use (personal, not preset-controlled)
  liveScreens: "off" | "near" | "all"; // GUI monitor/whiteboard textures
  securityFeeds: "off" | "low" | "high"; // control-room RTT resolution / refresh

  // ---- Display & camera ----
  fov: number; // vertical FOV, degrees (60–100)
  fpsCap: 0 | 30 | 60 | 120 | 144; // 0 = uncapped
  headBob: boolean;
  mouseSensitivity: number; // 0.2–3 (1 = default)
  invertY: boolean;
  showFps: boolean;
}

/** Fields that are display/controls preferences — never changed by presets. */
export const PERSONAL_KEYS = [
  "fov",
  "fpsCap",
  "headBob",
  "mouseSensitivity",
  "invertY",
  "showFps",
  "maxPixelRatio",
  "characterCast",
] as const satisfies readonly (keyof GraphicsSettings)[];

type PresetFields = Omit<
  GraphicsSettings,
  "preset" | (typeof PERSONAL_KEYS)[number]
>;

export const PRESETS: Record<
  Exclude<GraphicsPreset, "auto" | "custom">,
  PresetFields
> = {
  low: {
    antiAliasing: "fxaa",
    renderScale: 0.75,
    upscaler: "fsr1",
    sharpen: 0.3,
    anisotropy: 4,
    textureQuality: "low",
    shadows: "off",
    ambientOcclusion: "off",
    areaLights: false,
    maxDynamicLights: 0,
    iblShadows: false,
    skinScattering: false,
    screenSpaceReflections: "off",
    reflectionProbes: false,
    bloom: true,
    glow: false,
    depthOfField: "off",
    colorGrading: false,
    filmGrain: false,
    // Free (part of the image-processing pass) and keeps low's framing /
    // luminance with the other tiers (spawn: +7 % mean without it).
    vignette: true,
    chromaticAberration: false,
    motionBlur: false,
    characterDetail: "low",
    liveScreens: "near",
    securityFeeds: "low",
  },
  // A real mid tier: no geometry-buffer pass (no SSAO / SSR), no glow layer
  // (bloom stays), 1024² cascades with a 2-character shadow budget, MSAA
  // rather than TAA: ≥ 25 % fewer draws than high and ≤ 6 post-processes.
  medium: {
    antiAliasing: "msaa2",
    renderScale: 1,
    upscaler: "none",
    sharpen: 0.2,
    anisotropy: 8,
    textureQuality: "medium",
    shadows: "low",
    ambientOcclusion: "off",
    areaLights: false,
    maxDynamicLights: 2,
    iblShadows: false,
    skinScattering: false,
    screenSpaceReflections: "off",
    reflectionProbes: true,
    bloom: true,
    glow: false,
    depthOfField: "inspectOnly",
    colorGrading: true,
    filmGrain: false,
    vignette: true,
    chromaticAberration: false,
    motionBlur: false,
    characterDetail: "medium",
    liveScreens: "near",
    securityFeeds: "low",
  },
  high: {
    antiAliasing: "taa",
    renderScale: 1,
    upscaler: "none",
    sharpen: 0.25,
    anisotropy: 16,
    textureQuality: "high",
    shadows: "high",
    ambientOcclusion: "medium",
    areaLights: true,
    maxDynamicLights: 4,
    iblShadows: false,
    skinScattering: false,
    // Off (WS5b): SSR only traces surfaces with reflectivity > 0.25, i.e.
    // metals, and the zone probes already reflect the room in them; the
    // pass changed < 0.1 % of the pixels by > 8 levels (dock A/B) and was
    // the 13th post-process (budget 12).
    screenSpaceReflections: "off",
    reflectionProbes: true,
    bloom: true,
    glow: true,
    depthOfField: "inspectOnly",
    colorGrading: true,
    filmGrain: false,
    vignette: true,
    chromaticAberration: false,
    motionBlur: false,
    characterDetail: "high",
    liveScreens: "all",
    securityFeeds: "high",
  },
  ultra: {
    antiAliasing: "taa+fxaa",
    renderScale: 1,
    upscaler: "none",
    sharpen: 0.2,
    anisotropy: 16,
    textureQuality: "high",
    shadows: "ultra",
    ambientOcclusion: "high",
    areaLights: true,
    maxDynamicLights: 8,
    iblShadows: true,
    // Screen-space skin scattering: a prepass (MRT) for the whole scene, so
    // ultra only.
    skinScattering: true,
    screenSpaceReflections: "high",
    reflectionProbes: true,
    bloom: true,
    glow: true,
    depthOfField: "inspectOnly",
    colorGrading: true,
    filmGrain: true,
    vignette: true,
    chromaticAberration: false,
    motionBlur: false,
    characterDetail: "high",
    liveScreens: "all",
    securityFeeds: "high",
  },
};

export const DEFAULT_PERSONAL: Pick<
  GraphicsSettings,
  (typeof PERSONAL_KEYS)[number]
> = {
  fov: 75,
  fpsCap: 0,
  headBob: true,
  mouseSensitivity: 1,
  invertY: false,
  showFps: true,
  maxPixelRatio: 2,
  characterCast: "mixed",
};

/** Ordered tiers the auto governor steps through (index 0 = best). */
export const AUTO_LADDER: readonly Exclude<
  GraphicsPreset,
  "auto" | "custom"
>[] = ["high", "medium", "low"];

export function applyPreset(
  preset: Exclude<GraphicsPreset, "custom">,
  current: GraphicsSettings = defaultGraphicsSettings(),
): GraphicsSettings {
  const base = preset === "auto" ? PRESETS.high : PRESETS[preset];
  const personal = Object.fromEntries(
    PERSONAL_KEYS.map((k) => [k, current[k]]),
  ) as Pick<GraphicsSettings, (typeof PERSONAL_KEYS)[number]>;
  return { ...base, ...personal, preset };
}

/** Estimated relative GPU cost of a preset, 1 (light) – 4 (heavy). */
export const PRESET_COST: Record<Exclude<GraphicsPreset, "custom">, number> = {
  auto: 2,
  low: 1,
  medium: 2,
  high: 3,
  ultra: 4,
};

/** True when no preset-controlled field differs from `preset`'s values. */
export function matchesPreset(
  s: GraphicsSettings,
  preset: Exclude<GraphicsPreset, "auto" | "custom">,
): boolean {
  const base = PRESETS[preset];
  return (Object.keys(base) as (keyof PresetFields)[]).every(
    (k) => s[k] === base[k],
  );
}

/** The concrete preset whose values share the most fields with `s` (ties → higher). */
export function nearestPreset(
  s: GraphicsSettings,
): Exclude<GraphicsPreset, "auto" | "custom"> {
  let best: Exclude<GraphicsPreset, "auto" | "custom"> = "high";
  let bestScore = -1;
  for (const name of ["low", "medium", "high", "ultra"] as const) {
    const base = PRESETS[name];
    const score = (Object.keys(base) as (keyof PresetFields)[]).filter(
      (k) => s[k] === base[k],
    ).length;
    if (score >= bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

export function defaultGraphicsSettings(isMobile = false): GraphicsSettings {
  const personal = { ...DEFAULT_PERSONAL, maxPixelRatio: isMobile ? 1.5 : 2 };
  return {
    ...(isMobile ? PRESETS.low : PRESETS.high),
    ...personal,
    preset: isMobile ? "low" : "auto",
  };
}

/**
 * Change one field. Preset-controlled fields flip the preset to "custom";
 * personal fields keep the preset.
 */
export function updateSetting<K extends keyof GraphicsSettings>(
  s: GraphicsSettings,
  key: K,
  value: GraphicsSettings[K],
): GraphicsSettings {
  if (key === "preset")
    return applyPreset(value as Exclude<GraphicsPreset, "custom">, s);
  const personal = (PERSONAL_KEYS as readonly string[]).includes(key as string);
  return { ...s, [key]: value, preset: personal ? s.preset : "custom" };
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : d;

/** Parse a persisted JSON string defensively (unknown keys dropped, bad values defaulted). */
export function parseGraphicsSettings(
  raw: string | null | undefined,
  isMobile = false,
): GraphicsSettings {
  const d = defaultGraphicsSettings(isMobile);
  if (!raw) return d;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return d;
    obj = parsed as Record<string, unknown>;
  } catch {
    return d;
  }
  const out: GraphicsSettings = { ...d };
  const o = out as unknown as Record<string, unknown>;
  const enums: Partial<Record<keyof GraphicsSettings, readonly unknown[]>> = {
    preset: GRAPHICS_PRESETS,
    antiAliasing: ANTI_ALIASING_VALUES,
    upscaler: UPSCALER_VALUES,
    anisotropy: ANISOTROPY_VALUES,
    textureQuality: TEXTURE_QUALITY_VALUES,
    shadows: SHADOW_QUALITY_VALUES,
    ambientOcclusion: EFFECT_QUALITY_VALUES,
    screenSpaceReflections: EFFECT_QUALITY_VALUES,
    depthOfField: DEPTH_OF_FIELD_VALUES,
    characterDetail: CHARACTER_DETAIL_VALUES,
    characterCast: CHARACTER_CAST_VALUES,
    liveScreens: LIVE_SCREENS_VALUES,
    securityFeeds: SECURITY_FEEDS_VALUES,
    fpsCap: FPS_CAP_VALUES,
  };
  const bounds: Partial<Record<keyof GraphicsSettings, [number, number]>> = {
    renderScale: [0.5, 1],
    maxPixelRatio: [1, 2],
    sharpen: [0, 1],
    maxDynamicLights: [0, 8],
    fov: [60, 100],
    mouseSensitivity: [0.2, 3],
  };
  for (const key of Object.keys(d) as (keyof GraphicsSettings)[]) {
    const v = obj[key];
    if (v === undefined) continue;
    const allowed = enums[key];
    const b = bounds[key];
    if (allowed) {
      if (allowed.includes(v)) o[key] = v;
    } else if (b) {
      o[key] = clamp(v, b[0], b[1], d[key] as number);
    } else if (typeof d[key] === "boolean") {
      if (typeof v === "boolean") o[key] = v;
    }
  }
  if (
    out.preset !== "auto" &&
    out.preset !== "custom" &&
    !matchesPreset(out, out.preset)
  )
    out.preset = "custom";
  return out;
}

export function serializeGraphicsSettings(s: GraphicsSettings): string {
  return JSON.stringify(s);
}
