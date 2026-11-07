/**
 * Client-side logo upload processing: decode PNG/SVG/JPG, downscale to
 * <= 512 px and encode as PNG (falling back to WebP) within 200 KB.
 * Browser only (canvas); pure checks live in brandLayout.ts.
 */
import {
  MAX_LOGO_BYTES,
  MAX_LOGO_PX,
  dataUrlByteSize,
  downscaleSize,
  validateLogoFile,
  type LogoError,
} from "@/engine/world/brandLayout";

export type LogoResult =
  { ok: true; dataUrl: string } | { ok: false; error: LogoError | "decode" };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement): string | null {
  const png = canvas.toDataURL("image/png");
  if (dataUrlByteSize(png) <= MAX_LOGO_BYTES) return png;
  for (const q of [0.92, 0.8, 0.65]) {
    const webp = canvas.toDataURL("image/webp", q);
    if (
      webp.startsWith("data:image/webp") &&
      dataUrlByteSize(webp) <= MAX_LOGO_BYTES
    )
      return webp;
  }
  return null;
}

export async function processLogoFile(file: File): Promise<LogoResult> {
  const bad = validateLogoFile(file.type, file.size);
  if (bad) return { ok: false, error: bad };
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    // SVGs without intrinsic size report 0: rasterise at the max edge.
    const sw = img.naturalWidth || MAX_LOGO_PX;
    const sh = img.naturalHeight || MAX_LOGO_PX;
    let scale = 1;
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = downscaleSize(sw, sh, MAX_LOGO_PX);
      const w = Math.max(1, Math.round(base.w * scale));
      const h = Math.max(1, Math.round(base.h * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return { ok: false, error: "decode" };
      ctx.drawImage(img, 0, 0, w, h);
      const out = encode(c);
      if (out) return { ok: true, dataUrl: out };
      scale *= 0.75;
    }
    return { ok: false, error: "tooLarge" };
  } catch {
    return { ok: false, error: "decode" };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
