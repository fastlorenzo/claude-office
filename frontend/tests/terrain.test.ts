import { describe, expect, it } from "vitest";
import {
  TERRAIN_R1,
  terrainHeight,
  valueNoise,
} from "@/engine/world/exterior/terrain";

describe("terrainHeight", () => {
  it("is deterministic per seed and differs between seeds", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const a = i * 0.7;
      const r = 1500 + i * 120;
      pts.push([Math.sin(a) * r, Math.cos(a) * r]);
    }
    const h1 = pts.map(([x, z]) => terrainHeight(x, z, 5));
    const h2 = pts.map(([x, z]) => terrainHeight(x, z, 5));
    const h3 = pts.map(([x, z]) => terrainHeight(x, z, 6));
    expect(h1).toEqual(h2);
    expect(h1).not.toEqual(h3);
  });

  it("stays in a sane range, flat near the park and tapering at the rim", () => {
    let max = 0;
    for (let i = 0; i < 4000; i++) {
      const a = (i * 2.399) % (Math.PI * 2);
      const r = 200 + ((i * 7919) % 6800);
      const h = terrainHeight(Math.sin(a) * r, Math.cos(a) * r);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(h)).toBe(true);
      if (r < 800) expect(h).toBe(0);
      max = Math.max(max, h);
    }
    expect(max).toBeGreaterThan(60);
    expect(max).toBeLessThan(600);
    expect(terrainHeight(TERRAIN_R1, 0)).toBeCloseTo(0, 5);
  });

  it("value noise is bounded and continuous", () => {
    for (let i = 0; i < 200; i++) {
      const v = valueNoise(i * 0.37, i * 0.11, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(
        Math.abs(valueNoise(i * 0.37 + 1e-4, i * 0.11, 3) - v),
      ).toBeLessThan(0.01);
    }
  });
});
