/**
 * Robust image fetch for the tiled materials (materials2): every attempt that
 * fails (network error, HTTP error, decode error) is retried with backoff,
 * and the final failure is thrown to the caller (never swallowed). The
 * materials keep a neutral 1x1 texture until a load lands, so a surface is
 * always drawable.
 *
 * Decoding goes through `createImageBitmap` with `imageOrientation: "flipY"`
 * (WebGL ignores UNPACK_FLIP_Y for ImageBitmaps; this matches Babylon's own
 * bitmap path for `invertY` textures), resized on the CPU when the texture
 * quality caps the edge below the shipped size.
 */
import { injectedTextureFailure } from "./readiness";

/** Delay before each retry (ms); attempts = length + 1. */
export const RETRY_DELAYS_MS = [400, 1200, 3000, 6000] as const;

export type MapKind = "albedo" | "normal" | "orm";

export interface FetchImageOptions {
  /** Resize to this edge (px); omit for the shipped size. */
  edge?: number;
  /** Retry delays (tests pass zeros). */
  delays?: readonly number[];
  /** Abort further attempts (owner disposed / superseded). */
  cancelled?: () => boolean;
}

export class TextureLoadError extends Error {
  constructor(
    readonly url: string,
    readonly attempts: number,
    readonly reason: unknown,
  ) {
    super(
      `texture ${url} failed after ${attempts} attempt(s): ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    this.name = "TextureLoadError";
  }
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

async function attempt(url: string, edge?: number): Promise<ImageBitmap> {
  if (injectedTextureFailure(url))
    throw new Error("injected failure (texfail)");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(
    blob,
    edge
      ? {
          resizeWidth: edge,
          resizeHeight: edge,
          resizeQuality: "high",
          imageOrientation: "flipY",
        }
      : { imageOrientation: "flipY" },
  );
}

/** Fetch + decode with retries; rejects with `TextureLoadError` at the end. */
export async function fetchImage(
  url: string,
  opts: FetchImageOptions = {},
): Promise<ImageBitmap> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  let last: unknown = null;
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) {
      // ±25 % jitter so a burst of failed maps does not retry in lockstep.
      await sleep(delays[i - 1] * (0.75 + Math.random() * 0.5));
    }
    if (opts.cancelled?.()) throw new TextureLoadError(url, i, "cancelled");
    try {
      return await attempt(url, opts.edge);
    } catch (err) {
      last = err;
    }
  }
  throw new TextureLoadError(url, delays.length + 1, last);
}

/**
 * Neutral 1x1 RGBA for a map kind: the albedo is the set's mean colour
 * (gamma bytes; null = mid grey), the normal map is flat, ORM is AO 1 /
 * roughness 0.75 / metal by set.
 */
export function neutralPixel(
  kind: MapKind,
  meanLinear: readonly [number, number, number] | null,
  metal: boolean,
): Uint8Array {
  if (kind === "normal") return new Uint8Array([128, 128, 255, 255]);
  if (kind === "orm") return new Uint8Array([255, 191, metal ? 255 : 0, 255]);
  const m = meanLinear ?? [0.5, 0.5, 0.5];
  const g = (v: number) =>
    Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
  return new Uint8Array([g(m[0]), g(m[1]), g(m[2]), 255]);
}
