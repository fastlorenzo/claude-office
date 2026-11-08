/**
 * Resident GPU texture memory estimate (`__worldStats.textureMB`): every
 * internal texture the engine holds (materials, canvases, shadow maps,
 * probes, post-process targets), deduplicated, sized by format × type, × 6
 * for cubes and × 4/3 for a mip chain. An estimate: drivers pad RGB to RGBA
 * and may keep extra copies, so this is a lower bound of the real figure.
 */
import { Constants, type AbstractEngine } from "@/engine/babylon";

interface TexLike {
  width: number;
  height: number;
  depth?: number;
  isCube: boolean;
  is3D?: boolean;
  is2DArray?: boolean;
  generateMipMaps: boolean;
  type: number;
  format: number;
}

function bytesPerChannel(type: number): number {
  switch (type) {
    case Constants.TEXTURETYPE_FLOAT:
    case Constants.TEXTURETYPE_INT:
    case Constants.TEXTURETYPE_UNSIGNED_INTEGER:
      return 4;
    case Constants.TEXTURETYPE_HALF_FLOAT:
    case Constants.TEXTURETYPE_SHORT:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT:
      return 2;
    default:
      return 1;
  }
}

function channels(format: number): number {
  switch (format) {
    case Constants.TEXTUREFORMAT_ALPHA:
    case Constants.TEXTUREFORMAT_LUMINANCE:
    case Constants.TEXTUREFORMAT_R:
    case Constants.TEXTUREFORMAT_RED_INTEGER:
      return 1;
    case Constants.TEXTUREFORMAT_LUMINANCE_ALPHA:
    case Constants.TEXTUREFORMAT_RG:
      return 2;
    default:
      return 4; // RGB is padded to RGBA by every driver
  }
}

/** Bytes one internal texture occupies (pure; exported for tests). */
export function textureBytes(t: TexLike): number {
  const w = Math.max(1, t.width);
  const h = Math.max(1, t.height);
  let px = w * h;
  if (t.isCube) px *= 6;
  else if (t.is3D || t.is2DArray) px *= Math.max(1, t.depth ?? 1);
  const depthFormat =
    t.format >= Constants.TEXTUREFORMAT_DEPTH24_STENCIL8 &&
    t.format <= Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8;
  const bpp = depthFormat ? 4 : bytesPerChannel(t.type) * channels(t.format);
  return px * bpp * (t.generateMipMaps ? 4 / 3 : 1);
}

/** Resident texture memory in MB (rounded to 0.1). */
export function estimateTextureMB(engine: AbstractEngine): number {
  let bytes = 0;
  const seen = new Set<unknown>();
  for (const t of engine.getLoadedTexturesCache()) {
    if (seen.has(t)) continue;
    seen.add(t);
    bytes += textureBytes(t);
  }
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** The `n` largest internal textures (debug: `?drawdbg=1`). */
export function largestTextures(
  engine: AbstractEngine,
  n = 12,
): { name: string; mb: number; w: number; cube: boolean; type: number }[] {
  const seen = new Set<unknown>();
  const out: {
    name: string;
    mb: number;
    w: number;
    cube: boolean;
    type: number;
  }[] = [];
  for (const t of engine.getLoadedTexturesCache()) {
    if (seen.has(t)) continue;
    seen.add(t);
    const name = (t.label || t.url || `src${t.source}`).slice(-40);
    out.push({
      name,
      mb: Math.round((textureBytes(t) / 1048576) * 10) / 10,
      w: t.width,
      cube: t.isCube,
      type: t.type,
    });
  }
  return out.sort((a, b) => b.mb - a.mb).slice(0, n);
}

/** MB per source group (debug: `?drawdbg=1`). */
export function textureMBByGroup(
  engine: AbstractEngine,
): Record<string, number> {
  const seen = new Set<unknown>();
  const out: Record<string, number> = {};
  for (const t of engine.getLoadedTexturesCache()) {
    if (seen.has(t)) continue;
    seen.add(t);
    const id = `${t.url ?? ""} ${t.label ?? ""}`;
    const g = /materials2/.test(id)
      ? "materials2"
      : /characters|skinned|_diffuse|_normal|body|eyes|hair|teeth|cloth/i.test(
            id,
          )
        ? "characters"
        : /[Ss]hadow/.test(id)
          ? "shadows"
          : t.isCube
            ? "cubes"
            : /\.(png|jpe?g|webp|ktx2?)/i.test(id)
              ? "files"
              : "generated";
    out[g] = (out[g] ?? 0) + textureBytes(t) / 1048576;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10) / 10;
  return out;
}
