import { describe, expect, it } from "vitest";
import type { BuildingLayout } from "@/engine/contracts";
import {
  CONSOLE,
  DRUM,
  HALF_ARC,
  SURROUND_HALF,
  WALL_Y,
  controlPlan,
  drumOutline,
  drumPlan,
  eyes,
  feedCells,
  inWindow,
  onArc,
  sightClearance,
  upperSpans,
  windowDownReach,
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

describe("drum + windows", () => {
  const sizes = [
    [20, 18],
    [26.2, 18],
    [24, 20],
  ] as const;

  it.each(sizes)("the drum fits the footprint (%s × %s)", (w, dd) => {
    const p = controlPlan(layoutOf(w, dd));
    const d = drumPlan(p);
    expect(p.cx - d.rOut).toBeGreaterThanOrEqual(p.x0 - 1e-9);
    expect(p.cx + d.rOut).toBeLessThanOrEqual(p.x1 + 1e-9);
    // The skin may stand proud of the footprint's north edge by its own
    // thickness (the interior keeps the 0.7 m wall depth behind the screens).
    expect(p.cz + d.rOut).toBeLessThanOrEqual(
      p.z1 + DRUM.wallT + DRUM.cladT + 1e-9,
    );
    // The drum reaches the hall end (the neck is short, never negative).
    expect(p.cz - d.rOut).toBeGreaterThanOrEqual(p.z0 - DRUM.cladT - 1e-9);
    expect(p.cz - d.rOut - p.z0).toBeLessThan(2.5);
  });

  it.each(sizes)(
    "ribbons stay clear of the video wall and the neck (%s × %s)",
    (w, dd) => {
      const p = controlPlan(layoutOf(w, dd));
      const d = drumPlan(p);
      expect(d.windows).toHaveLength(2);
      for (const win of d.windows) {
        const lo = Math.min(Math.abs(win.a0), Math.abs(win.a1));
        const hi = Math.max(Math.abs(win.a0), Math.abs(win.a1));
        expect(lo).toBeGreaterThanOrEqual(SURROUND_HALF + 0.1);
        expect(hi).toBeLessThanOrEqual(d.aNeck - 0.1);
        // Every wall panel and camera feed is on the solid arc.
        for (const s of upperSpans(p)) {
          expect(inWindow(d, s.a0)).toBe(false);
          expect(inWindow(d, s.a1)).toBe(false);
        }
        for (const c of feedCells(p).cells)
          expect(inWindow(d, (c.a0 + c.a1) / 2)).toBe(false);
      }
      // Window head clears a standing supervisor's eye, under the cove.
      expect(DRUM.head).toBeGreaterThan(
        (p.supervisor?.deck ?? 0) + CONSOLE.eyeStanding + 0.5,
      );
      expect(DRUM.head).toBeLessThan(p.H - 0.42 - 0.3);
      // Mullions frame both ends of each ribbon at a sane pitch.
      const per = d.mullions.length / 2;
      expect(per).toBeGreaterThanOrEqual(3);
      const pitch =
        ((d.windows[0].a1 - d.windows[0].a0) * d.rGlass) / (per - 1);
      expect(pitch).toBeGreaterThan(1);
      expect(pitch).toBeLessThan(2);
    },
  );

  it("operators see the factory floor out of the side ribbons", () => {
    const p = controlPlan(layoutOf(26.2, 18));
    const d = drumPlan(p);
    const mid = (d.windows[1].a0 + d.windows[1].a1) / 2;
    // Standing at the glass: straight down through the glazed floor strip.
    const at = onArc(p.cx, p.cz, d.rGlassFloor - 0.4, mid);
    expect(
      windowDownReach(p, d, { ...at, y: CONSOLE.eyeStanding }, mid, -6),
    ).toBeLessThan(2);
    // Supervisor platform: the factory floor in view within the envelope
    // (cells reach ~21 m beyond the drum's flank).
    const sv = p.supervisor!;
    const sup = eyes(p).find((e) => e.who === "supervisor")!;
    const reach = windowDownReach(
      p,
      d,
      { x: sv.x + 1.5, z: p.cz + sup.r, y: sup.y },
      mid,
      -6,
    );
    expect(reach).toBeGreaterThan(0);
    expect(reach).toBeLessThan(22);
  });

  it("the floor outline is a closed star around C with radial window steps", () => {
    const p = controlPlan(layoutOf(26.2, 18));
    const d = drumPlan(p);
    const o = drumOutline(p, d, d.rWall, d.rGlassFloor, p.neckHW);
    expect(o[0]).toEqual({ x: p.cx + p.neckHW, z: p.z0 });
    expect(o[o.length - 1]).toEqual({ x: p.cx - p.neckHW, z: p.z0 });
    // Angles from C strictly decrease along the arc part (star-shaped).
    const ang = o.slice(1, -1).map((q) => Math.atan2(q.x - p.cx, q.z - p.cz));
    for (let i = 1; i < ang.length; i++)
      expect(ang[i]).toBeLessThanOrEqual(ang[i - 1] + 1e-9);
    const radii = o.slice(2, -2).map((q) => Math.hypot(q.x - p.cx, q.z - p.cz));
    expect(Math.min(...radii)).toBeCloseTo(d.rGlassFloor, 6);
    expect(Math.max(...radii)).toBeCloseTo(d.rWall, 6);
  });

  it("columns stand under the drum, clear of the main line", () => {
    const p = controlPlan(layoutOf(26.2, 18, 4.5, 28.8));
    const d = drumPlan(p);
    expect(d.columns.length).toBeGreaterThanOrEqual(6);
    for (const c of d.columns) {
      expect(Math.hypot(c.x - p.cx, c.z - p.cz)).toBeLessThan(d.rOut - 1);
      expect(Math.abs(c.x - p.cx)).toBeGreaterThan(3.3);
    }
  });
});
