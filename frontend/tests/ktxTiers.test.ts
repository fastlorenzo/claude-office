import { describe, expect, it } from "vitest";
import {
  BASIS_TRANSCODER_FILES,
  codecFor,
  fitEdge,
  ktx2GlbName,
  materialKtx2Edges,
  materialKtx2Entry,
} from "../scripts/lib/ktxTiers";

describe("ktx tiers", () => {
  it("material tiers follow the albedo edge", () => {
    expect(materialKtx2Edges(1024)).toEqual({
      albedo: { hi: 2048, lo: 1024 },
      normal: { hi: 1024, lo: 512 },
      orm: { hi: 1024, lo: 512 },
    });
    const e = materialKtx2Edges(512);
    expect(e.albedo).toEqual({ hi: 1024, lo: 512 });
    expect(e.orm).toEqual({ hi: 512, lo: 256 });
  });
  it("never exceeds the 2K source", () => {
    expect(materialKtx2Edges(2048).albedo.hi).toBe(2048);
  });
  it("entry names", () => {
    expect(materialKtx2Entry().normal.lo).toBe("normal.lo.ktx2");
    expect(ktx2GlbName("a/b.glb")).toBe("a/b.ktx2.glb");
    expect(ktx2GlbName("rock.gltf")).toBe("rock.ktx2.glb");
  });
  it("codec per role", () => {
    expect(codecFor("color", false)).toEqual({ mode: "etc1s", srgb: true });
    expect(codecFor("color", true).mode).toBe("uastc");
    expect(codecFor("normal", false)).toEqual({ mode: "uastc", srgb: false });
  });
  it("fitEdge keeps aspect", () => {
    expect(fitEdge(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitEdge(512, 512, 1024)).toEqual({ width: 512, height: 512 });
  });
  it("transcoder list is pinned", () => {
    for (const f of BASIS_TRANSCODER_FILES)
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(BASIS_TRANSCODER_FILES.map((f) => f.urlConfigKey)).toContain(
      "wasmZSTDDecoder",
    );
  });
});
