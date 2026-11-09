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
  /** Levels of an uploaded chain (KTX2 ships its own mips). */
  mipLevelCount?: number;
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

/**
 * Bits per pixel of a compressed internal format (the GL enum Babylon stores
 * in `texture.format` for KTX2 uploads), or 0 when `format` is not one.
 * Block formats are fixed-rate: 128 bits per block.
 */
export function compressedBitsPerPixel(format: number): number {
  switch (format) {
    // BC1 / DXT1, ETC1, ETC2 RGB(A1), EAC R11, PVRTC 4bpp
    case 33776:
    case 33777:
    case 35916:
    case 35917:
    case 36196:
    case 37488:
    case 37489:
    case 37492:
    case 37493:
    case 37494:
    case 37495:
    case 35840:
    case 35842:
      return 4;
    // PVRTC 2bpp
    case 35841:
    case 35843:
      return 2;
    // BC2/3 DXT3/5, BC6H, BC7, ETC2 RGBA8, EAC RG11
    case 33778:
    case 33779:
    case 35918:
    case 35919:
    case 36492:
    case 36493:
    case 36494:
    case 36495:
    case 37490:
    case 37491:
    case 37496:
    case 37497:
      return 8;
  }
  // ASTC (linear 37808..37821, sRGB 37840..37853): 128 bits / block texels.
  const astc = format >= 37840 ? format - 37840 : format - 37808;
  if (astc >= 0 && astc <= 13 && (format <= 37821 || format >= 37840)) {
    const blocks = [16, 20, 25, 30, 36, 40, 48, 64, 50, 60, 80, 100, 120, 144];
    return 128 / blocks[astc];
  }
  return 0;
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
  const mips = t.generateMipMaps || (t.mipLevelCount ?? 1) > 1;
  const compressed = compressedBitsPerPixel(t.format);
  if (compressed > 0) return (px * compressed * (mips ? 4 / 3 : 1)) / 8;
  const bpp = depthFormat ? 4 : bytesPerChannel(t.type) * channels(t.format);
  return px * bpp * (mips ? 4 / 3 : 1);
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
    const name = (t.label || t.url || `src${t.source}`).slice(-60);
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
