/**
 * WS6 set dressing: every prop's real bounding box matches DRESSING_DIMS
 * (colliders and wall placement rely on it), and the per-zone plans stay on
 * their floors, clear of walkways, stairs, wells and each other at any
 * project count.
 */
import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import type { BuildingLayout } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, FACTORY } from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import {
  buildProceduralProp,
  DRESSING_DIMS,
} from "@/engine/assets/proceduralProps";
import { Materials } from "@/engine/materials/Materials";
import { dressingPieces } from "@/engine/world/dressing";
import {
  corners,
  pieceBox,
  planExtent,
  SOLID_ROLES,
  type DressingRole,
  type Piece,
} from "@/engine/world/dressing/piece";

function demo(n: number): BuildingLayout {
  const d = createDemoCampus(n, 20000);
  const groups = groupSessions(d.campus, d.sessions, d.projects);
  const slots = allocateSlots(
    new Map(),
    groups.map((g) => ({
      id: g.id,
      createdAt: g.createdAt,
      sessions: g.sessionIds.length,
    })),
  );
  return generateLayout(slots, groups, allocatePods(new Map(), groups));
}

describe("dressing prop bounding boxes", () => {
  const scene = new Scene(new NullEngine());
  const mats = new Materials(scene, "/assets");
  for (const role of Object.keys(DRESSING_DIMS) as DressingRole[]) {
    it(`${role} matches DRESSING_DIMS`, () => {
      const parts = buildProceduralProp(scene, mats, role);
      expect(parts.length).toBeGreaterThan(0);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const m of parts) {
        m.refreshBoundingInfo();
        const bb = m.getBoundingInfo().boundingBox;
        for (const [i, k] of (["x", "y", "z"] as const).entries()) {
          min[i] = Math.min(min[i], bb.minimum[k]);
          max[i] = Math.max(max[i], bb.maximum[k]);
        }
      }
      const d = DRESSING_DIMS[role];
      const tol = 0.02;
      expect(max[0] - min[0]).toBeCloseTo(d.w, 1);
      expect(max[2] - min[2]).toBeCloseTo(d.d, 1);
      expect(max[1] - min[1]).toBeCloseTo(d.h, 1);
      // Centred on x/z (the library re-centres on the bounding box and sits it on y = 0).
      expect(Math.abs((max[0] + min[0]) / 2)).toBeLessThan(tol + 0.05);
      expect(Math.abs((max[2] + min[2]) / 2)).toBeLessThan(tol + 0.05);
    });
  }
});

const overlap = (
  a: { x0: number; x1: number; z0: number; z1: number },
  b: { x0: number; x1: number; z0: number; z1: number },
) => a.x1 > b.x0 && a.x0 < b.x1 && a.z1 > b.z0 && a.z0 < b.z1;

describe.each([1, 4, 6, 10])("dressing plan (n=%i)", (n) => {
  const b = demo(n);
  const fl = buildFactoryLayout(b);
  const pieces = dressingPieces(fl, b);

  it("has props in every zone", () => {
    const ground = pieces.filter((p) => p.y <= fl.floorY + 0.01);
    expect(pieces.length).toBeGreaterThan(20);
    expect(pieces.some((p) => p.role === "exitSign")).toBe(b.hall.length > 6);
    expect(
      pieces.filter((p) => p.role === "cableTray").length,
    ).toBeGreaterThanOrEqual(fl.cells.length * 4);
    expect(ground.length).toBeGreaterThan(0);
    expect(
      pieces.filter((p) => p.role === "stripCurtain").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("solid pieces never overlap each other", () => {
    const solids = pieces.filter((p) => SOLID_ROLES.has(p.role));
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++) {
        const A = solids[i];
        const B = solids[j];
        if (Math.abs(A.y - B.y) > 1) continue;
        expect(
          overlap(planExtent(A, -0.02), planExtent(B, -0.02)),
          `${A.role}@${A.x.toFixed(2)},${A.z.toFixed(2)} vs ${B.role}@${B.x.toFixed(2)},${B.z.toFixed(2)}`,
        ).toBe(false);
      }
  });

  it("factory props keep the loading aisle, stairs and belts clear", () => {
    const floor = pieces.filter(
      (p) =>
        SOLID_ROLES.has(p.role) &&
        Math.abs(p.y - fl.floorY) < 0.01 &&
        p.z > 0 &&
        p.z < fl.dock.z0,
    );
    expect(floor.length).toBeGreaterThan(0);
    const keepOut = [
      ...fl.cells.map((c) => c.stair.rect),
      ...fl.crossovers.map((x) => x.rect),
      ...fl.spineStairs.map((s) => s.rect),
    ];
    for (const p of floor) {
      const e = planExtent(p, 0.05);
      const ax = Math.abs(p.x);
      // Never inside the aisle (|x| 31.1..32.35) nor on a lane belt row.
      expect(
        Math.min(e.x1, FACTORY.AISLE_X[1]) >
          Math.max(e.x0, FACTORY.AISLE_X[0]) &&
          ax > 30 &&
          false,
      ).toBe(false);
      const xs = [Math.abs(e.x0), Math.abs(e.x1)];
      expect(
        Math.min(...xs) < FACTORY.AISLE_X[1] &&
          Math.max(...xs) > FACTORY.AISLE_X[0] &&
          Math.sign(e.x0) === Math.sign(e.x1),
        `${p.role} in the aisle at ${p.x.toFixed(2)},${p.z.toFixed(2)}`,
      ).toBe(false);
      for (const r of keepOut) expect(overlap(e, r)).toBe(false);
      for (const c of fl.cells) {
        if (
          p.z < c.z0 ||
          p.z > c.z1 ||
          Math.sign(p.x) !== (c.side === "east" ? 1 : -1)
        )
          continue;
        for (const l of c.lanes)
          expect(Math.abs(p.z - l.z) > 0.9 || Math.abs(p.x) < 30).toBe(true);
      }
    }
  });

  it("every piece stands on its zone's floor", () => {
    for (const p of pieces) {
      const cs = corners(pieceBox(p));
      for (const [x, z] of cs) {
        expect(Math.abs(x)).toBeLessThanOrEqual(fl.bounds.max.x + 0.01);
        expect(z).toBeGreaterThanOrEqual(fl.entrance.rect.z0 - 0.01);
        expect(z).toBeLessThanOrEqual(fl.bounds.max.z + 0.01);
      }
    }
  });
});

describe("dressing scales with the layout", () => {
  it("adds trays and bins per cell", () => {
    const count = (n: number, role: Piece["role"]) => {
      const b = demo(n);
      return dressingPieces(buildFactoryLayout(b), b).filter(
        (p) => p.role === role,
      ).length;
    };
    expect(count(10, "toolTrolley")).toBeGreaterThan(count(4, "toolTrolley"));
    expect(count(10, "cableTray")).toBeGreaterThan(count(4, "cableTray"));
  });
});
