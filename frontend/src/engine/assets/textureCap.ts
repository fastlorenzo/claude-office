/**
 * Upload-time size cap for image textures (WS5b P12): the glTF characters
 * and props ship 2048² maps (21 MB each with mips, ~600 MB resident at
 * high). A character fills a few hundred pixels at normal viewing distance,
 * so 1024² (high) / 512² (medium, low) is visually identical and a quarter
 * of the memory.
 *
 * Babylon decodes every image texture (URL or embedded glTF image) and
 * hands it to `engine._prepareWebGLTexture` for the upload; the cap wraps
 * that one call on the engine instance. When the texture's URL matches a
 * rule and the image is larger than the cap, the image is resized on the
 * CPU (`createImageBitmap`, high quality, no premultiplication) before the
 * upload, so the full-size copy never reaches the GPU (and the decoded copy
 * Babylon keeps for a context-loss rebuild is the small one). Textures that do not
 * match (canvases, render targets, the tiled materials, which carry their
 * own cap) are untouched.
 */
import type { AbstractEngine } from "@/engine/babylon";

/** Texture edge cap (px) for glTF model / character textures per quality. */
export const MODEL_TEXTURE_CAP = {
  low: 512,
  medium: 512,
  high: 1024,
} as const;

/** URLs of glTF models and characters (embedded images keep the GLB URL). */
export const MODEL_TEXTURE_URL = /\/(characters[^/]*|models)\//;

type Img = { width: number; height: number };
type Prepare = (
  texture: { url?: string; _buffer?: unknown },
  extension: string,
  scene: unknown,
  img: Img,
  invertY: boolean,
  ...rest: unknown[]
) => void;

/** Target size for an image under a cap (aspect kept; null = leave as is). */
export function cappedSize(
  w: number,
  h: number,
  cap: number,
): { w: number; h: number } | null {
  if (!(cap > 0) || Math.max(w, h) <= cap) return null;
  const k = cap / Math.max(w, h);
  return {
    w: Math.max(1, Math.round(w * k)),
    h: Math.max(1, Math.round(h * k)),
  };
}

/**
 * Install the cap on an engine. `capFor(url)` returns the edge cap in px for
 * a texture URL (0 = no cap); it is read per upload, so a quality change
 * applies to textures loaded afterwards. Returns the uninstaller.
 */
export function capTextureUploads(
  engine: AbstractEngine,
  capFor: (url: string) => number,
): () => void {
  const e = engine as unknown as { _prepareWebGLTexture?: Prepare };
  const orig = e._prepareWebGLTexture;
  if (typeof orig !== "function" || typeof createImageBitmap !== "function")
    return () => undefined;
  const wrapped: Prepare = function (
    this: unknown,
    texture,
    extension,
    scene,
    img,
    invertY,
    ...rest
  ) {
    const size = img
      ? cappedSize(img.width, img.height, capFor(texture?.url ?? ""))
      : null;
    if (!size)
      return orig.call(this, texture, extension, scene, img, invertY, ...rest);
    const bitmap =
      typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap;
    // WebGL ignores UNPACK_FLIP_Y for ImageBitmaps: an <img> source that the
    // engine would flip on upload is flipped here instead.
    createImageBitmap(img as unknown as ImageBitmapSource, {
      resizeWidth: size.w,
      resizeHeight: size.h,
      resizeQuality: "high",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
      ...(invertY && !bitmap ? { imageOrientation: "flipY" as const } : {}),
    }).then(
      (small) => {
        // Babylon keeps the decoded image of a blob texture (embedded glTF
        // images) for a context-loss rebuild: keep the small copy instead
        // and free the full-size one.
        if (texture._buffer === img) {
          texture._buffer = small;
          if (bitmap) (img as unknown as ImageBitmap).close();
        }
        orig.call(this, texture, extension, scene, small, invertY, ...rest);
      },
      () => orig.call(this, texture, extension, scene, img, invertY, ...rest),
    );
  };
  e._prepareWebGLTexture = wrapped;
  return () => {
    if (e._prepareWebGLTexture === wrapped) e._prepareWebGLTexture = orig;
  };
}
