import { describe, expect, it } from "vitest";
import type { BuildingLayout } from "@/engine/contracts";
import {
  CONSOLE,
  HALF_ARC,
  WALL_Y,
  controlPlan,
  feedCells,
  sightClearance,
  upperSpans,
} from "@/engine/world/controlRoomPlan";

/** Only `controlRoom.origin/size` feed the plan. */
function layoutOf(w: number, d: number, h = 4.5, z0 = 20): BuildingLayout {
  return {
    controlRoom: {
      origin: { x: 0, y: 0, z: z0 + d / 2 },
      size: { x: w, y: h, z: d },
    },
  } as unknown as BuildingLayout;
}

describe("controlPlan", () => {
  it("fits a round room inside a 20 × 18 footprint", () => {
    const p = controlPlan(layoutOf(20, 18));
    expect(p.R).toBeGreaterThan(7);
    expect(p.cx - p.roomR).toBeGreaterThanOrEqual(p.x0);
    expect(p.cx + p.roomR).toBeLessThanOrEqual(p.x1);
    expect(p.cz + p.roomR).toBeLessThanOrEqual(p.z1);
    expect(p.H).toBeGreaterThanOrEqual(WALL_Y.trim + 0.5);
    expect(p.a1 - p.a0).toBeCloseTo(2 * HALF_ARC);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[1].deck).toBeGreaterThan(p.rows[0].deck);
    expect(p.supervisor?.deck).toBeCloseTo(0.3);
    // Supervisor platform stays clear of the door.
    expect(p.supervisor!.pz0 - p.z0).toBeGreaterThan(3);
  });

  it("scales down to a shallow footprint (one row)", () => {
    const p = controlPlan(layoutOf(21, 10));
    expect(p.R).toBeLessThan(5);
    expect(p.rows).toHaveLength(1);
    expect(p.cz + p.roomR).toBeLessThanOrEqual(p.z1 + 1e-9);
  });

  it("splits every console row with a centre aisle", () => {
    const p = controlPlan(layoutOf(26, 18));
    for (const row of p.rows) {
      expect(row.halves).toHaveLength(2);
      const gap = (row.halves[1][0] - row.halves[0][1]) * row.r;
      expect(gap).toBeGreaterThanOrEqual(1.4);
    }
  });

  it("monitors on one seat fit within the seat's share of the arc", () => {
    const p = controlPlan(layoutOf(20, 18));
    for (const row of p.rows) {
      const rm = row.r + CONSOLE.depth / 2 - 0.14;
      const perHalf = row.seats.length / row.halves.length;
      const [h0, h1] = row.halves[1];
      const share = ((h1 - h0) / perHalf) * rm;
      expect(row.seats[0].monitors * (CONSOLE.monW + 0.03)).toBeLessThanOrEqual(
        share + 1e-6,
      );
    }
  });
});

describe("sight lines", () => {
  it.each([
    [20, 18],
    [26.2, 18],
    [24, 20],
  ])("nothing blocks the lower tier from any seat (%s × %s)", (w, d) => {
    const p = controlPlan(layoutOf(w, d));
    const res = sightClearance(p);
    expect(res.length).toBeGreaterThanOrEqual(3);
    for (const r of res) expect(r.clearance).toBeGreaterThan(0.02);
  });
});

describe("wall spans", () => {
  it("covers the arc left → right with the board centred", () => {
    const p = controlPlan(layoutOf(20, 18));
    const s = upperSpans(p);
    expect(s.map((x) => x.key)).toEqual([
      "map",
      "usage",
      "board",
      "activity",
      "projects",
    ]);
    expect(s[0].a0).toBeCloseTo(p.a0);
    expect(s[s.length - 1].a1).toBeCloseTo(p.a1);
    const board = s[2];
    expect((board.a0 + board.a1) / 2).toBeCloseTo(0);
  });

  it("puts symmetric feed cells on the lower tier, outside the centre block", () => {
    const p = controlPlan(layoutOf(20, 18));
    const { cells, center } = feedCells(p);
    expect(cells.length).toBe(8);
    for (const c of cells) {
      expect(c.a1 <= center[0] + 1e-9 || c.a0 >= center[1] - 1e-9).toBe(true);
      expect(c.a0).toBeGreaterThanOrEqual(p.a0);
      expect(c.a1).toBeLessThanOrEqual(p.a1);
      expect(c.y1).toBeLessThanOrEqual(WALL_Y.lower1);
      expect(c.y0).toBeGreaterThan(WALL_Y.lower0);
    }
    const w0 = cells.find((c) => c.side === "west" && c.index === 0)!;
    const e0 = cells.find((c) => c.side === "east" && c.index === 0)!;
    expect(w0.a1).toBeCloseTo(-e0.a0);
  });
});
