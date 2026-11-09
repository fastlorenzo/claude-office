import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import { ArtBatcher, bevelRadius } from "@/engine/art/geometry";
import { Materials } from "@/engine/materials/Materials";
import { v3 } from "@/engine/util/MeshBatcher";

describe("bevelRadius", () => {
  it("caps at a quarter of the smallest side", () => {
    expect(bevelRadius(v3(1, 0.04, 2), 0.02)).toBeCloseTo(0.01);
    expect(bevelRadius(v3(1, 1, 1), 0.01)).toBeCloseTo(0.01);
  });
  it("is zero for hairline pieces or no request", () => {
    expect(bevelRadius(v3(1, 0.003, 1), 0.01)).toBe(0);
    expect(bevelRadius(v3(1, 1, 1), 0)).toBe(0);
  });
});

describe("ArtBatcher.box bevel opt-in", () => {
  const scene = new Scene(new NullEngine());
  const mats = new Materials(scene, "/assets");
  const verts = (bevel?: number) => {
    const b = new ArtBatcher(scene, mats, "t", 1);
    const m = b.box("oak", v3(0, 0, 0), v3(0.5, 0.05, 0.5), { bevel });
    return m.getTotalVertices();
  };
  it("stays sharp by default and rounds when asked", () => {
    expect(verts()).toBe(24);
    expect(verts(0.005)).toBeGreaterThan(24);
  });
});
