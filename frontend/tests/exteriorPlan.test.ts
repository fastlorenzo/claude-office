import { describe, expect, it } from "vitest";
import {
  carRect,
  overlaps,
  planExterior,
  shedRect,
  type Footprint,
} from "@/engine/layout/exteriorPlan";

const fps: Footprint[] = [
  { halfW: 34, zS: -12, zN: 60 },
  { halfW: 34, zS: -12, zN: 130 },
];

describe("planExterior", () => {
  it("is deterministic", () => {
    expect(planExterior(fps[0])).toEqual(planExterior(fps[0]));
  });

  for (const fp of fps) {
    const p = planExterior(fp);
    const factory = { x0: -fp.halfW, x1: fp.halfW, z0: fp.zS, z1: fp.zN };

    it(`keeps sheds clear of factory, apron, roads and lot (zN=${fp.zN})`, () => {
      expect(p.sheds.length).toBeGreaterThan(3);
      for (const s of p.sheds) {
        const r = shedRect(s);
        expect(overlaps(r, factory)).toBe(false);
        for (const a of p.asphalt) expect(overlaps(r, a)).toBe(false);
        expect(overlaps(r, p.apron)).toBe(false);
      }
      for (const [i, a] of p.sheds.entries())
        for (const b of p.sheds.slice(i + 1))
          expect(overlaps(shedRect(a), shedRect(b))).toBe(false);
    });

    it(`parks cars only inside the car park (zN=${fp.zN})`, () => {
      expect(p.cars.length).toBeGreaterThan(10);
      const lot = p.asphalt.find((a) => a.z1 === fp.zS - 8)!;
      for (const c of p.cars) {
        const r = carRect(c);
        expect(r.x0).toBeGreaterThanOrEqual(lot.x0);
        expect(r.x1).toBeLessThanOrEqual(lot.x1);
        expect(r.z0).toBeGreaterThanOrEqual(lot.z0);
        expect(r.z1).toBeLessThanOrEqual(lot.z1);
        expect(overlaps(r, p.apron)).toBe(false);
      }
    });

    it(`apron meets the dock end and spans the doors (zN=${fp.zN})`, () => {
      expect(p.apron.z0).toBe(fp.zN);
      expect(p.apron.x0).toBeLessThanOrEqual(-fp.halfW);
      expect(p.apron.x1).toBeGreaterThanOrEqual(fp.halfW);
      const road = p.asphalt.find((a) => a.z0 === p.apron.z1)!;
      expect(road.x0).toBeLessThan(0);
      expect(road.x1).toBeGreaterThan(0);
    });
  }
});
