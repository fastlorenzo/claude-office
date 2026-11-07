/**
 * Pure helpers for the lobby brand sign: palette + colour parsing, text
 * fitting / layout and logo-size validation. No Babylon, no DOM.
 */
import type { BrandingOptions } from "@/engine/contracts";

export const NEON_PALETTE = {
  orange: "#ff8a1f",
  coral: "#ff6b57",
  cyan: "#19e3ff",
  magenta: "#ff2bd6",
  lime: "#b6ff2e",
  white: "#fff4e0",
} as const;

export type NeonPaletteName = keyof typeof NEON_PALETTE;

/** Warm orange-pink: the default sign colour. */
export const DEFAULT_NEON_COLOR: string = NEON_PALETTE.coral;

export const DEFAULT_BRANDING: BrandingOptions = {
  name: "Claude Office",
  tagline: "",
  logo: null,
  color: DEFAULT_NEON_COLOR,
  flicker: false,
};

export const MAX_NAME_CHARS = 28;
export const MAX_TAGLINE_CHARS = 48;
export const MAX_LOGO_PX = 512;
export const MAX_LOGO_BYTES = 200 * 1024;
/** Source files above this are refused before decoding. */
export const MAX_LOGO_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_LOGO_TYPES = [
  "image/png",
  "image/svg+xml",
  "image/jpeg",
] as const;

// ---------------------------------------------------------------- colours

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** "#rgb" / "#rrggbb" / palette name -> normalised "#rrggbb", else null. */
export function parseNeonColor(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  if (v in NEON_PALETTE) return NEON_PALETTE[v as NeonPaletteName];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  return `#${h}`;
}

export function hexToRgb(hex: string): Rgb {
  const h = parseNeonColor(hex) ?? DEFAULT_NEON_COLOR;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

export function rgbToHex(c: Rgb): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

export interface NeonColors {
  /** Saturated halo / glass colour. */
  halo: string;
  /** Tube body. */
  body: string;
  /** Hot, near-white core. */
  core: string;
}

/** Scale the colour so its brightest channel is full (neon is always vivid). */
export function neonColors(hex: string): NeonColors {
  const c = hexToRgb(hex);
  const mx = Math.max(c.r, c.g, c.b, 1);
  const vivid: Rgb = {
    r: (c.r / mx) * 255,
    g: (c.g / mx) * 255,
    b: (c.b / mx) * 255,
  };
  const white: Rgb = { r: 255, g: 252, b: 245 };
  return {
    halo: rgbToHex(vivid),
    body: rgbToHex(mixRgb(vivid, white, 0.18)),
    core: rgbToHex(mixRgb(vivid, white, 0.88)),
  };
}

// --------------------------------------------------------------- branding

export function clampText(s: string | null | undefined, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const LOGO_URL_RE =
  /^data:image\/(png|webp|jpeg|svg\+xml);base64,[a-z0-9+/=]+$/i;

/** Accept only well-formed, size-bounded image data URLs. */
export function parseBrandLogo(raw: string | null | undefined): string | null {
  if (!raw || !LOGO_URL_RE.test(raw)) return null;
  return dataUrlByteSize(raw) <= MAX_LOGO_BYTES ? raw : null;
}

export function normalizeBranding(p: {
  name?: string | null;
  tagline?: string | null;
  logo?: string | null;
  color?: string | null;
  flicker?: boolean;
}): BrandingOptions {
  return {
    name:
      p.name == null
        ? DEFAULT_BRANDING.name
        : clampText(p.name, MAX_NAME_CHARS),
    tagline: clampText(p.tagline, MAX_TAGLINE_CHARS),
    logo: parseBrandLogo(p.logo),
    color: parseNeonColor(p.color) ?? DEFAULT_NEON_COLOR,
    flicker: p.flicker === true,
  };
}

// ------------------------------------------------------------ validation

/** Decoded size of a base64 data URL payload. */
export function dataUrlByteSize(url: string): number {
  const i = url.indexOf(",");
  if (i < 0) return 0;
  const b64 = url.slice(i + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export type LogoError = "type" | "tooLarge" | "empty";

/** Gate a picked file before decoding. */
export function validateLogoFile(type: string, size: number): LogoError | null {
  if (!(ACCEPTED_LOGO_TYPES as readonly string[]).includes(type)) return "type";
  if (size <= 0) return "empty";
  if (size > MAX_LOGO_UPLOAD_BYTES) return "tooLarge";
  return null;
}

/** Gate the final (downscaled) encoded logo. */
export function validateLogoDataUrl(url: string): LogoError | null {
  if (!LOGO_URL_RE.test(url)) return "type";
  return dataUrlByteSize(url) > MAX_LOGO_BYTES ? "tooLarge" : null;
}

/** Fit (w,h) inside max x max, never upscaling. */
export function downscaleSize(
  w: number,
  h: number,
  max = MAX_LOGO_PX,
): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 1, h: 1 };
  const k = Math.min(1, max / Math.max(w, h));
  return {
    w: Math.max(1, Math.round(w * k)),
    h: Math.max(1, Math.round(h * k)),
  };
}

// ----------------------------------------------------------------- layout

export type Measure = (text: string, px: number) => number;

/** Largest font size <= maxPx whose text fits maxW; below minPx it squashes. */
export function fitText(
  measure: Measure,
  text: string,
  maxW: number,
  maxPx: number,
  minPx: number,
): { px: number; width: number; squash: number } {
  if (!text) return { px: 0, width: 0, squash: 1 };
  let px = maxPx;
  let w = measure(text, px);
  if (w > maxW) {
    px = Math.max(minPx, (maxPx * maxW) / w);
    w = measure(text, px);
  }
  if (w > maxW) return { px, width: maxW, squash: maxW / w };
  return { px, width: w, squash: 1 };
}

export interface BrandLayout {
  logo: { x: number; y: number; size: number } | null;
  name: { x: number; y: number; px: number; maxW: number } | null;
  tagline: { x: number; y: number; px: number; maxW: number } | null;
}

/**
 * Lay the brand out inside a width x height box (px). The logo is a square on
 * the left; the name (and tagline) form a left-aligned block to its right;
 * the whole group is centred. y values are text-middle lines.
 */
export function layoutBrand(
  b: Pick<BrandingOptions, "name" | "tagline" | "logo">,
  width: number,
  height: number,
  measure: Measure,
): BrandLayout {
  const hasLogo = !!b.logo;
  const logoSize = hasLogo ? height * 0.9 : 0;
  const gap = hasLogo && (b.name || b.tagline) ? height * 0.22 : 0;
  const textMaxW = Math.max(1, width - logoSize - gap);
  const hasTag = !!b.tagline;

  const name = fitText(
    measure,
    b.name,
    textMaxW,
    height * (hasTag ? 0.52 : 0.62),
    height * 0.22,
  );
  const tag = fitText(
    measure,
    b.tagline,
    textMaxW,
    height * 0.17,
    height * 0.09,
  );
  const textW = Math.max(name.width, tag.width);
  const groupW = logoSize + gap + textW;
  const x0 = (width - groupW) / 2;

  const out: BrandLayout = { logo: null, name: null, tagline: null };
  if (hasLogo) out.logo = { x: x0, y: (height - logoSize) / 2, size: logoSize };
  const tx = x0 + logoSize + gap;
  if (b.name) {
    out.name = {
      x: tx,
      y: hasTag ? height * 0.38 : height * 0.5,
      px: name.px,
      maxW: textMaxW,
    };
  }
  if (hasTag) {
    out.tagline = {
      x: tx,
      y: b.name ? height * 0.78 : height * 0.5,
      px: tag.px,
      maxW: textMaxW,
    };
  }
  return out;
}
