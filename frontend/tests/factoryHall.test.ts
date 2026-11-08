import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, FLOOR_Y } from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { Materials } from "@/engine/materials/Materials";
import { Colliders } from "@/engine/physics/Colliders";
import {
  CELL_STAIR,
  cellStairGap,
  FactoryHall,
  planMinus,
  SPINE_RUN,
  STAIR_MAX_DEG,
} from "@/engine/world/factory/FactoryHall";
import type { Lighting } from "@/engine/fx/Lighting";

const deg = (rad: number) => (rad * 180) / Math.PI;

function demoLayout(n = 6) {
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

describe("planMinus", () => {
  it("returns the rect when there are no holes", () => {
    const r = { x0: 0, x1: 4, z0: 0, z1: 2 };
    expect(planMinus(r, [])).toEqual([r]);
  });

  it("covers exactly the area outside the holes", () => {
    const r = { x0: -3.5, x1: 3.5, z0: 0, z1: 20 };
    const holes = [
      { x0: -0.8, x1: 0.8, z0: 0, z1: 16 },
      { x0: 2.3, x1: 3.5, z0: 6.4, z1: 12.8 },
      { x0: -9, x1: 9, z0: 16, z1: 20 },
    ];
    const out = planMinus(r, holes);
    const area = out.reduce((a, p) => a + (p.x1 - p.x0) * (p.z1 - p.z0), 0);
    expect(area).toBeCloseTo(7 * 20 - 1.6 * 16 - 1.2 * 6.4 - 7 * 4, 6);
    for (const p of out)
      for (const h of holes) {
        const ox = Math.min(p.x1, h.x1) - Math.max(p.x0, h.x0);
        const oz = Math.min(p.z1, h.z1) - Math.max(p.z0, h.z0);
        expect(ox > 1e-6 && oz > 1e-6).toBe(false);
      }
  });
});

describe("factory stairs are walkable", () => {
  const fl = buildFactoryLayout(demoLayout());

  it("spine flights are at most 35°", () => {
    expect(fl.spineStairs.length).toBeGreaterThan(0);
    expect(deg(Math.atan2(-FLOOR_Y, SPINE_RUN))).toBeLessThanOrEqual(
      STAIR_MAX_DEG,
    );
  });

  it("cell switchback flights are at most 35° and fit the entry bay", () => {
    const run = CELL_STAIR.zFar - CELL_STAIR.zNear;
    const drop = -FLOOR_Y / CELL_STAIR.flights.length;
    expect(deg(Math.atan2(drop, run))).toBeLessThanOrEqual(STAIR_MAX_DEG);
    expect(CELL_STAIR.far.z1).toBeLessThan(4.8);
    expect(CELL_STAIR.top.z0).toBeGreaterThan(0);
    // Top landing joins the balcony edge (balcony = 1.2 m outside 13.1).
    expect(CELL_STAIR.top.x0).toBeLessThanOrEqual(13.1 + 1.2 + 1e-9);
    // Flights and landings are wide enough for the 0.6 m capsule.
    for (const f of CELL_STAIR.flights)
      expect(f.x1 - f.x0).toBeGreaterThanOrEqual(0.9);
    for (const l of [CELL_STAIR.top, CELL_STAIR.far, CELL_STAIR.near])
      expect(l.z1 - l.z0).toBeGreaterThanOrEqual(0.65);
    // The top landing never sits above the near (y −4) landing.
    expect(CELL_STAIR.top.x1).toBeLessThanOrEqual(CELL_STAIR.near.x0);
  });

  it("the balcony gap sits at the door end of the entry bay", () => {
    // Door near the far end (east rooms): landing mirrored toward it.
    expect(cellStairGap(0, 3.8).z0).toBeCloseTo(3.65, 6);
    expect(cellStairGap(0, 3.8).z1).toBeCloseTo(4.65, 6);
    // Door near the lobby end (west rooms).
    expect(cellStairGap(14.4, 15.4).z0).toBeCloseTo(14.55, 6);
    expect(cellStairGap(14.4, 15.4).z1).toBeCloseTo(15.55, 6);
  });
});

describe("FactoryHall build", () => {
  const lighting = {
    addStaticCasters: () => undefined,
    registerProbe: () => undefined,
  } as unknown as Lighting;
  const make = () => {
    const scene = new Scene(new NullEngine());
    return new FactoryHall({
      scene,
      materials: new Materials(scene, "/assets"),
      colliders: new Colliders(scene),
      lighting,
    });
  };
  // Empty-cell stencils need a 2D canvas (DynamicTexture); not in node.
  const noStencils = (b: ReturnType<typeof demoLayout>) => ({
    ...buildFactoryLayout(b),
    emptyCells: [],
  });

  it("merges the whole shell into at most 9 meshes (draws)", () => {
    const hall = make();
    const b = demoLayout();
    expect(hall.build(noStencils(b), b)).toBe(true);
    expect(hall.staticMeshes.length).toBeGreaterThan(4);
    expect(hall.staticMeshes.length).toBeLessThanOrEqual(9);
    expect(hall.fixtures.length).toBeGreaterThan(20);
    hall.dispose();
  });

  it("rebuilds only when the set of rooms changes", () => {
    const hall = make();
    const b = demoLayout();
    expect(hall.build(noStencils(b), b)).toBe(true);
    expect(hall.build(noStencils(b), b)).toBe(false);
    const b2 = demoLayout(9);
    const changed =
      FactoryHall.keyOf(buildFactoryLayout(b2), b2) !==
      FactoryHall.keyOf(buildFactoryLayout(b), b);
    expect(hall.build(noStencils(b2), b2)).toBe(changed);
    hall.dispose();
  });
});
