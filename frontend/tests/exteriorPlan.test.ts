import { describe, expect, it } from "vitest";
import {
  carRect,
  overlaps,
  planExterior,
  shedRect,
  treeRadius,
  TREE_WALL_GAP,
  grow,
  type Rect,
  type Footprint,
} from "@/engine/layout/exteriorPlan";

const entrance = { x0: -13.1, x1: 13.1, z0: -12, z1: -4.8 };
const fps: Footprint[] = [
  { halfW: 34, zS: -12, zN: 60 },
  { halfW: 34, zS: -12, zN: 130 },
  { halfW: 34, zS: -4.8, zN: 70, entrance },
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

    it(`keeps trees off the pavement and out of the sheds (zN=${fp.zN})`, () => {
      expect(p.trees.length).toBeGreaterThan(20);
      expect(p.trees.some((t) => t.species === 2)).toBe(true);
      for (const t of p.trees) {
        expect([0, 1, 2]).toContain(t.species);
        const pt = {
          x0: t.x - 0.1,
          x1: t.x + 0.1,
          z0: t.z - 0.1,
          z1: t.z + 0.1,
        };
        expect(overlaps(pt, factory)).toBe(false);
        for (const a of p.asphalt) expect(overlaps(pt, a)).toBe(false);
        for (const s of p.sheds) expect(overlaps(pt, shedRect(s))).toBe(false);
      }
    });

    it(`parks cars only inside the car park (zN=${fp.zN})`, () => {
      expect(p.cars.length).toBeGreaterThan(10);
      const lot = p.lot;
      expect(lot.z1).toBe((fp.entrance?.z0 ?? fp.zS) - 8);
      for (const c of p.cars) {
        const r = carRect(c);
        expect(r.x0).toBeGreaterThanOrEqual(lot.x0);
        expect(r.x1).toBeLessThanOrEqual(lot.x1);
        expect(r.z0).toBeGreaterThanOrEqual(lot.z0);
        expect(r.z1).toBeLessThanOrEqual(lot.z1);
        expect(overlaps(r, p.apron)).toBe(false);
      }
    });

    it(`front plaza, drop-off and walk lead to the entrance doors (zN=${fp.zN})`, () => {
      const front = fp.entrance?.z0 ?? fp.zS;
      expect(p.plaza.z1).toBe(front);
      expect(p.plaza.x0).toBeLessThan(0);
      expect(p.plaza.x1).toBeGreaterThan(0);
      expect(p.dropOff.z1).toBe(p.plaza.z0);
      expect(p.path.z1).toBe(p.dropOff.z0);
      expect(p.path.x0).toBeLessThan(0);
      expect(p.path.x1).toBeGreaterThan(0);
      // No parked car in the drop-off lay-by or on the walk.
      for (const c of p.cars) {
        expect(overlaps(carRect(c), p.dropOff)).toBe(false);
        expect(overlaps(carRect(c), p.path)).toBe(false);
      }
      if (fp.entrance)
        for (const s of p.sheds)
          expect(overlaps(shedRect(s), fp.entrance)).toBe(false);
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

  // Current factory envelope (buildFactoryLayout bounds start at z = -4.8)
  // for 1 / 3 / 10 project layouts (dock end moves north with the bays).
  const envelopes: Footprint[] = [
    { halfW: 34, zS: -4.8, zN: 58, entrance },
    { halfW: 34, zS: -4.8, zN: 94, entrance },
    { halfW: 34, zS: -4.8, zN: 190, entrance },
  ];
  for (const fp of envelopes) {
    it(`keeps trees, hedges, cars and sheds clear of the envelope (zN=${fp.zN})`, () => {
      const p = planExterior(fp);
      const factory: Rect = {
        x0: -fp.halfW,
        x1: fp.halfW,
        z0: fp.zS,
        z1: fp.zN,
      };
      const walls = [
        grow(factory, TREE_WALL_GAP),
        grow(fp.entrance!, TREE_WALL_GAP),
      ];
      const hard = [...p.asphalt, ...p.concrete, p.apron];
      expect(p.trees.length).toBeGreaterThan(20);
      for (const t of p.trees) {
        const r = treeRadius(t);
        const f = { x0: t.x - r, x1: t.x + r, z0: t.z - r, z1: t.z + r };
        for (const w of walls) expect(overlaps(f, w)).toBe(false);
        for (const a of hard) expect(overlaps(f, a)).toBe(false);
        for (const s of p.sheds) expect(overlaps(f, shedRect(s))).toBe(false);
      }
      const solids = [factory, fp.entrance!];
      for (const c of p.cars)
        for (const w of [...solids, p.apron, ...p.concrete])
          expect(overlaps(carRect(c), w)).toBe(false);
      for (const s of p.sheds)
        for (const w of [...solids, p.apron, ...hard])
          expect(overlaps(shedRect(s), w)).toBe(false);
    });
  }
});
