import type { TranslationKey } from "@/i18n/en";
import {
  ANISOTROPY_VALUES,
  ANTI_ALIASING_VALUES,
  CHARACTER_DETAIL_VALUES,
  DEPTH_OF_FIELD_VALUES,
  EFFECT_QUALITY_VALUES,
  FPS_CAP_VALUES,
  LIVE_SCREENS_VALUES,
  SECURITY_FEEDS_VALUES,
  SHADOW_QUALITY_VALUES,
  TEXTURE_QUALITY_VALUES,
  UPSCALER_VALUES,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";

export type Impact = "low" | "med" | "high";

export interface Option {
  value: string | number;
  /** Literal label (numbers, acronyms) — otherwise `labelKey`. */
  label?: string;
  labelKey?: TranslationKey;
}

interface RowBase {
  key: keyof GraphicsSettings;
  impact: Impact;
}
export type RowDef =
  | (RowBase & { kind: "segmented" | "select"; options: Option[] })
  | (RowBase & { kind: "toggle" })
  | (RowBase & {
      kind: "slider";
      min: number;
      max: number;
      step: number;
      format: "percent" | "degrees" | "times" | "number" | "ratio";
    });

export interface SectionDef {
  id: "image" | "lighting" | "reflections" | "post" | "world" | "display";
  titleKey: TranslationKey;
  rows: RowDef[];
}

const VAL: Record<string, TranslationKey> = {
  off: "gfx.v.off",
  low: "gfx.v.low",
  medium: "gfx.v.medium",
  high: "gfx.v.high",
  ultra: "gfx.v.ultra",
  none: "gfx.v.none",
  fxaa: "gfx.v.fxaa",
  msaa2: "gfx.v.msaa2",
  msaa4: "gfx.v.msaa4",
  taa: "gfx.v.taa",
  "taa+fxaa": "gfx.v.taaFxaa",
  fsr1: "gfx.v.fsr1",
  inspectOnly: "gfx.v.inspectOnly",
  always: "gfx.v.always",
  near: "gfx.v.near",
  all: "gfx.v.all",
};

const opts = (values: readonly (string | number)[]): Option[] =>
  values.map((value) =>
    typeof value === "string"
      ? { value, labelKey: VAL[value] }
      : { value, label: `${value}x` },
  );

export const SECTIONS: SectionDef[] = [
  {
    id: "image",
    titleKey: "gfx.section.image",
    rows: [
      {
        key: "antiAliasing",
        kind: "select",
        impact: "med",
        options: opts(ANTI_ALIASING_VALUES),
      },
      {
        key: "renderScale",
        kind: "slider",
        impact: "high",
        min: 0.5,
        max: 1,
        step: 0.05,
        format: "percent",
      },
      {
        key: "upscaler",
        kind: "segmented",
        impact: "low",
        options: opts(UPSCALER_VALUES),
      },
      {
        key: "sharpen",
        kind: "slider",
        impact: "low",
        min: 0,
        max: 1,
        step: 0.05,
        format: "percent",
      },
      {
        key: "anisotropy",
        kind: "segmented",
        impact: "low",
        options: opts(ANISOTROPY_VALUES),
      },
      {
        key: "textureQuality",
        kind: "segmented",
        impact: "med",
        options: opts(TEXTURE_QUALITY_VALUES),
      },
      {
        key: "maxPixelRatio",
        kind: "slider",
        impact: "high",
        min: 1,
        max: 2,
        step: 0.25,
        format: "ratio",
      },
    ],
  },
  {
    id: "lighting",
    titleKey: "gfx.section.lighting",
    rows: [
      {
        key: "shadows",
        kind: "segmented",
        impact: "high",
        options: opts(SHADOW_QUALITY_VALUES),
      },
      {
        key: "ambientOcclusion",
        kind: "segmented",
        impact: "high",
        options: opts(EFFECT_QUALITY_VALUES),
      },
      { key: "areaLights", kind: "toggle", impact: "med" },
      {
        key: "maxDynamicLights",
        kind: "slider",
        impact: "med",
        min: 0,
        max: 8,
        step: 1,
        format: "number",
      },
      { key: "iblShadows", kind: "toggle", impact: "high" },
    ],
  },
  {
    id: "reflections",
    titleKey: "gfx.section.reflections",
    rows: [
      {
        key: "screenSpaceReflections",
        kind: "segmented",
        impact: "high",
        options: opts(EFFECT_QUALITY_VALUES),
      },
      { key: "reflectionProbes", kind: "toggle", impact: "med" },
    ],
  },
  {
    id: "post",
    titleKey: "gfx.section.post",
    rows: [
      { key: "bloom", kind: "toggle", impact: "med" },
      { key: "glow", kind: "toggle", impact: "low" },
      {
        key: "depthOfField",
        kind: "segmented",
        impact: "med",
        options: opts(DEPTH_OF_FIELD_VALUES),
      },
      { key: "colorGrading", kind: "toggle", impact: "low" },
      { key: "filmGrain", kind: "toggle", impact: "low" },
      { key: "vignette", kind: "toggle", impact: "low" },
      { key: "chromaticAberration", kind: "toggle", impact: "low" },
      { key: "motionBlur", kind: "toggle", impact: "med" },
    ],
  },
  {
    id: "world",
    titleKey: "gfx.section.world",
    rows: [
      {
        key: "characterDetail",
        kind: "segmented",
        impact: "med",
        options: opts(CHARACTER_DETAIL_VALUES),
      },
      {
        key: "liveScreens",
        kind: "segmented",
        impact: "med",
        options: opts(LIVE_SCREENS_VALUES),
      },
      {
        key: "securityFeeds",
        kind: "segmented",
        impact: "high",
        options: opts(SECURITY_FEEDS_VALUES),
      },
    ],
  },
  {
    id: "display",
    titleKey: "gfx.section.display",
    rows: [
      {
        key: "fov",
        kind: "slider",
        impact: "low",
        min: 60,
        max: 100,
        step: 1,
        format: "degrees",
      },
      {
        key: "fpsCap",
        kind: "select",
        impact: "low",
        options: FPS_CAP_VALUES.map((v) =>
          v === 0
            ? { value: v, labelKey: "gfx.v.uncapped" as TranslationKey }
            : { value: v, label: `${v} FPS` },
        ),
      },
      { key: "headBob", kind: "toggle", impact: "low" },
      {
        key: "mouseSensitivity",
        kind: "slider",
        impact: "low",
        min: 0.2,
        max: 3,
        step: 0.1,
        format: "times",
      },
      { key: "invertY", kind: "toggle", impact: "low" },
      { key: "showFps", kind: "toggle", impact: "low" },
    ],
  },
];

export const ALL_ROWS: RowDef[] = SECTIONS.flatMap((s) => s.rows);

export function formatValue(
  v: number,
  format: "percent" | "degrees" | "times" | "number" | "ratio",
): string {
  switch (format) {
    case "percent":
      return `${Math.round(v * 100)}%`;
    case "degrees":
      return `${Math.round(v)}°`;
    case "times":
      return `${v.toFixed(1)}x`;
    case "ratio":
      return `${v.toFixed(2).replace(/\.?0+$/, "")}x`;
    default:
      return String(Math.round(v));
  }
}

export const PRESET_ORDER = [
  "auto",
  "low",
  "medium",
  "high",
  "ultra",
  "custom",
] as const;
