/**
 * WS5b P12: glTF model / character textures are capped at upload
 * (1024² at high, 512² at medium / low).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbstractEngine } from "@/engine/babylon";
import {
  cappedSize,
  capTextureUploads,
  MODEL_TEXTURE_CAP,
  MODEL_TEXTURE_URL,
} from "@/engine/assets/textureCap";

describe("texture upload cap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sizes keep the aspect and never upscale", () => {
    expect(cappedSize(2048, 2048, 1024)).toEqual({ w: 1024, h: 1024 });
    expect(cappedSize(2048, 1024, 512)).toEqual({ w: 512, h: 256 });
    expect(cappedSize(1024, 1024, 1024)).toBeNull();
    expect(cappedSize(4096, 4096, 0)).toBeNull();
    expect(MODEL_TEXTURE_CAP.high).toBe(1024);
    expect(MODEL_TEXTURE_CAP.medium).toBe(512);
  });

  it("matches models and every character pack, not the tiled materials", () => {
    expect(
      MODEL_TEXTURE_URL.test(
        "data:/assets/characters-mpfb/office_f01.glb#image3",
      ),
    ).toBe(true);
    expect(
      MODEL_TEXTURE_URL.test("/assets/characters/business_male_01.glb#image0"),
    ).toBe(true);
    expect(
      MODEL_TEXTURE_URL.test("/assets/models/sofa_02/sofa_02_diff.jpg"),
    ).toBe(true);
    expect(
      MODEL_TEXTURE_URL.test("/assets/materials2/Concrete046/albedo.webp"),
    ).toBe(false);
  });

  it("resizes large matching images before the upload and keeps the small copy", async () => {
    const resized = { width: 1024, height: 1024 };
    const cib = vi.fn(async () => resized);
    vi.stubGlobal("createImageBitmap", cib);
    const calls: { w: number }[] = [];
    const engine = {
      _prepareWebGLTexture(
        _t: unknown,
        _e: string,
        _s: unknown,
        img: { width: number },
      ) {
        calls.push({ w: img.width });
      },
    };
    const off = capTextureUploads(engine as unknown as AbstractEngine, (url) =>
      MODEL_TEXTURE_URL.test(url) ? 1024 : 0,
    );
    const big = { width: 2048, height: 2048 };
    const tex = {
      url: "/assets/models/desk.glb#image0",
      _buffer: big as unknown,
    };
    engine._prepareWebGLTexture(tex, ".png", null, big);
    engine._prepareWebGLTexture(
      { url: "/assets/materials2/x.webp" },
      ".webp",
      null,
      big,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(cib).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.w).sort()).toEqual([1024, 2048]);
    expect(tex._buffer).toBe(resized);
    off();
    engine._prepareWebGLTexture(tex, ".png", null, big);
    expect(cib).toHaveBeenCalledTimes(1);
  });
});
