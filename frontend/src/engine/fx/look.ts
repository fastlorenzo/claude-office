/**
 * Global look (exposure, contrast, ambient levels) in one place, with dev
 * overrides for tuning live on any page:
 *
 *   ?exposure=1.2  ?contrast=1.2  ?env=0.35  ?fill=0.2  ?key=0.8
 *   ?warmth=15  ?shadowCool=10   (colour grade densities, 0-100)
 *
 * (lightmap levels: `?bakeGain=` / `?bakeIbl=`, see fx/BakedLighting.ts).
 * Plain data, no Babylon imports.
 */

export interface Look {
  /** Image-processing exposure (ACES tone mapping). */
  exposure: number;
  /** Contrast with / without the colour-grading curves. */
  contrast: number;
  contrastNoGrade: number;
  /** Interior IBL (scene.environmentIntensity). */
  env: number;
  /** Hemispheric bounce and overhead key at the high tier. */
  fill: number;
  key: number;
  /** Colour grade (ColorCurves): global warm filter density (hue 35°). */
  warmth: number;
  /** Cool (hue 215°) density in the shadows. */
  shadowCool: number;
}

/**
 * Photoreal pass (WS-E): the lightmaps carry the bounce and the contact
 * occlusion, so the unoccluded realtime ambient (IBL + hemispheric fill,
 * the flat part of the image) is lower than before, and the exposure is up
 * a little to keep the luminaires and windows bright: a photographic
 * interior exposure (bright sources, darker corners) instead of an evenly
 * lit one. Values chosen against the AI restyle references at the fixed
 * cameras (see the WS-E report).
 */
export const LOOK: Look = {
  exposure: 1.15,
  contrast: 1.28,
  contrastNoGrade: 1.2,
  env: 0.32,
  fill: 0.15,
  key: 0.8,
  warmth: 22,
  shadowCool: 8,
};

const KEYS: Record<keyof Look, string> = {
  exposure: "exposure",
  contrast: "contrast",
  contrastNoGrade: "contrast",
  env: "env",
  fill: "fill",
  key: "key",
  warmth: "warmth",
  shadowCool: "shadowCool",
};

let cached: Partial<Look> | null = null;

function overrides(): Partial<Look> {
  if (cached) return cached;
  cached = {};
  if (typeof location === "undefined") return cached;
  const q = new URLSearchParams(location.search);
  for (const k of Object.keys(KEYS) as (keyof Look)[]) {
    const raw = q.get(KEYS[k]);
    const v = raw === null ? NaN : Number(raw);
    const max = k === "warmth" || k === "shadowCool" ? 100 : 8;
    if (Number.isFinite(v) && v >= 0 && v <= max) cached[k] = v;
  }
  return cached;
}

/** The look value in effect (dev query override, else `LOOK`). */
export function look(k: keyof Look): number {
  return overrides()[k] ?? LOOK[k];
}

/** Tests: forget the parsed query. */
export function resetLookOverrides(): void {
  cached = null;
}
