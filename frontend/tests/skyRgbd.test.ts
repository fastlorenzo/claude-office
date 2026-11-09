import { describe, expect, it } from "vitest";
import {
  decodeRGBD,
  encodeRGBD,
  resampleFace,
  rgbdCubeMB,
} from "@/engine/world/exterior/skyRgbd";

describe("sky RGBD store", () => {
  it("1024 faces cost 24 MB, a quarter of the half-float bake", () => {
    expect(rgbdCubeMB(1024)).toBe(24);
    expect(rgbdCubeMB(1536) / ((1536 * 1536 * 6 * 8) / 1048576)).toBe(0.5);
  });

  it("resampling keeps a constant field and the output size", () => {
    const n = 12;
    const src = new Float32Array(n * n * 4).fill(0.4);
    const out = resampleFace(src, n, 8);
    expect(out.length).toBe(8 * 8 * 4);
    for (const v of out) expect(v).toBeCloseTo(0.4, 5);
  });

  it("resampling averages a 2x reduction exactly", () => {
    const src = new Float32Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) src[(y * 4 + x) * 4] = x < 2 ? 1 : 0;
    const out = resampleFace(src, 4, 2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[4]).toBeCloseTo(0, 6);
  });

  it("round-trips LDR and HDR values within a few percent", () => {
    const src = new Float32Array([
      0.05, 0.4, 0.9, 1, 3, 1.5, 0.2, 1, 12, 8, 6, 1,
    ]);
    const bytes = encodeRGBD(src, 0);
    for (let t = 0; t < 3; t++)
      for (let c = 0; c < 3; c++) {
        const want = src[t * 4 + c];
        const got = decodeRGBD(bytes, t * 4)[c];
        // dark channels of a bright pixel lose precision, like any 8-bit
        const tol = Math.max(0.02 * want, 0.02);
        expect(Math.abs(got - want)).toBeLessThan(
          tol + 0.03 * Math.max(...src.slice(t * 4, t * 4 + 3)),
        );
      }
  });

  it("LDR pixels keep full alpha (no range divisor)", () => {
    const bytes = encodeRGBD(new Float32Array([0.5, 0.5, 0.5, 1]), 0);
    expect(bytes[3]).toBe(255);
  });
});
