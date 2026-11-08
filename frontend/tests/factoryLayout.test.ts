import { describe, expect, it } from "vitest";
import type { ProjectSlot, RoomSide, Vec3 } from "@/engine/contracts";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import {
  allStairs,
  buildFactoryLayout,
  zoneAt3,
  type CellLayout,
  type Rect,
} from "@/engine/layout/factoryLayout";

function make(n: number, spans?: number[], sides?: RoomSide[]) {
  const reqs = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    createdAt: i,
    sessions: spans?.[i] ?? (i % 3) + 1,
  }));
  const slots = allocateSlots(new Map(), reqs, sides ? { sides } : {});
  const groups = reqs.map((r) => ({
    id: r.id,
    sessionIds: Array.from({ length: r.sessions }, (_, k) => `${r.id}s${k}`),
  }));
  return generateLayout(slots, groups, undefined, sides ? { sides } : {});
}

/** Same plus a hand-made gap so empty slots exist. */
function withGap() {
  const slots = new Map<string, ProjectSlot>([
    ["a", { index: 0, side: "east", bay: 0, span: 3 }],
    ["b", { index: 1, side: "west", bay: 3, span: 3 }],
  ]);
  return generateLayout(slots);
}

const cases: [string, ReturnType<typeof make>][] = [
  ["1 project", make(1)],
  ["3 projects", make(3)],
  ["10 projects", make(10)],
  ["10 wings", make(10, Array(10).fill(6))],
  ["east only", make(4, undefined, ["east"])],
  ["gap/empty slots", withGap()],
];

const segDist = (p: Vec3, a: Vec3, b: Vec3) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
};
const overlap = (a: Rect, b: Rect) =>
  a.x0 < b.x1 - 1e-6 &&
  b.x0 < a.x1 - 1e-6 &&
  a.z0 < b.z1 - 1e-6 &&
  b.z0 < a.z1 - 1e-6;
const inRect = (r: Rect, p: { x: number; z: number }) =>
  p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;

describe.each(cases)("factoryLayout: %s", (_name, building) => {
  const f = buildFactoryLayout(building);

  it("has one cell per project, lanes per bay (<= 6)", () => {
    expect(f.floorY).toBe(-6);
    expect(f.cells.map((c) => c.projectId)).toEqual(
      building.projects.map((p) => p.projectId),
    );
    for (const c of f.cells) {
      const room = building.projects.find((p) => p.projectId === c.projectId)!;
      expect(c.lanes.length).toBe(Math.min(6, 2 * room.capacity));
      expect(c.z0).toBe(room.footprint.z0);
      expect(c.z1).toBe(room.footprint.z1);
      expect(c.entryBay).toBe(room.entryBay);
    }
    expect(f.emptyCells.length).toBe(building.emptySlots.length);
  });

  it("lanes never intersect columns (0.6 m clearance)", () => {
    const CLEAR = 0.6;
    for (const c of f.cells) {
      for (const l of c.lanes) {
        const xs = [l.intakeX, l.reworkX, ...l.stationX, l.qaX, l.gateX];
        const a = { x: Math.min(...xs), y: -6, z: l.z };
        const b = { x: Math.max(...xs), y: -6, z: l.z };
        for (const col of c.columns)
          expect(segDist(col, a, b)).toBeGreaterThan(CLEAR);
        // lane lies within its own cell, inside the lane's room bays
        expect(l.z).toBeGreaterThan(c.z0 + 4.8);
        expect(l.z).toBeLessThan(c.z1);
      }
      for (const col of c.columns) {
        expect(col.y).toBe(-6);
        expect(
          segDist(
            col,
            { x: c.trunk.x, y: 0, z: c.trunk.z0 },
            { x: c.trunk.x, y: 0, z: c.trunk.z1 },
          ),
        ).toBeGreaterThan(CLEAR);
      }
    }
  });

  it("cells (and empty cells) never overlap", () => {
    const rects: Rect[] = [
      ...f.cells.map((c) => c.rect),
      ...f.emptyCells.map((c) => c.rect),
    ];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(overlap(rects[i], rects[j])).toBe(false);
    for (const r of rects) {
      expect(overlap(r, f.dock)).toBe(false);
      expect(r.z1).toBeLessThanOrEqual(building.hall.length + 1e-6);
    }
  });

  it("stairs land inside walkable floor", () => {
    const b = f.bounds;
    const stairs = [
      ...f.cells.map((c) => ({ s: c.stair, cell: c })),
      ...f.spineStairs.map((s) => ({
        s,
        cell: undefined as CellLayout | undefined,
      })),
    ];
    const all = allStairs(f).map((s) => s.rect);
    for (const { s, cell } of stairs) {
      expect(s.bottom.y).toBe(-6);
      expect(s.bottom.x).toBeGreaterThanOrEqual(b.min.x);
      expect(s.bottom.x).toBeLessThanOrEqual(b.max.x);
      expect(s.bottom.z).toBeGreaterThanOrEqual(b.min.z);
      expect(s.bottom.z).toBeLessThanOrEqual(b.max.z);
      // not inside any stair footprint, columns, or dock
      for (const r of all) expect(inRect(r, s.bottom)).toBe(false);
      expect(inRect(f.dock, s.bottom)).toBe(false);
      if (cell) {
        expect(inRect(cell.rect, s.bottom)).toBe(true);
        expect(inRect(cell.rect, { x: s.rect.x0, z: s.rect.z0 })).toBe(true);
        expect(inRect(cell.rect, { x: s.rect.x1, z: s.rect.z1 })).toBe(true);
        for (const col of cell.columns)
          expect(
            Math.hypot(col.x - s.bottom.x, col.z - s.bottom.z),
          ).toBeGreaterThan(0.6);
      } else {
        for (const c of f.cells) expect(inRect(c.rect, s.bottom)).toBe(false);
      }
    }
    // each cell stair top is at its balcony door
    for (const c of f.cells) {
      const room = building.projects.find((p) => p.projectId === c.projectId)!;
      expect(c.stair.top.z).toBe(room.balcony.door.z);
    }
    for (const s of f.spineStairs) {
      expect(s.rect.z1).toBeLessThan(building.hall.length);
    }
  });

  it("every sampled point maps to exactly one zone", () => {
    const kinds = new Set([
      "factory",
      "cell",
      "dock",
      "stair",
      "balcony",
      "entrance",
      "lobby",
      "hall",
      "control",
      "room",
      "outside",
    ]);
    let n = 0;
    for (let x = -40; x <= 40; x += 2.3)
      for (let z = -14; z <= f.bounds.max.z + 4; z += 2.1)
        for (const y of [-6, -3, 0, 1.5, 8]) {
          const zone = zoneAt3(f, building, { x, y, z });
          expect(kinds.has(zone.kind)).toBe(true);
          const again = zoneAt3(f, building, { x, y, z });
          expect(again).toEqual(zone);
          if (y < -1.5) {
            expect([
              "factory",
              "cell",
              "dock",
              "stair",
              "entrance",
              "outside",
            ]).toContain(zone.kind);
            // at most one cell rect contains the point
            const hits = f.cells.filter((c) => inRect(c.rect, { x, z })).length;
            expect(hits).toBeLessThanOrEqual(1);
            if (zone.kind === "cell") expect(hits).toBe(1);
          } else {
            expect(["factory", "cell", "dock", "entrance"]).not.toContain(
              zone.kind,
            );
          }
          n++;
        }
    expect(n).toBeGreaterThan(1000);
  });

  it("classifies representative points", () => {
    for (const c of f.cells) {
      const s = c.side === "east" ? 1 : -1;
      const mid = { x: s * 31, y: -6, z: (c.z0 + c.z1) / 2 + 0.3 };
      expect(zoneAt3(f, building, mid)).toEqual({
        kind: "cell",
        projectId: c.projectId,
      });
      const st = zoneAt3(f, building, {
        x: (c.stair.rect.x0 + c.stair.rect.x1) / 2,
        y: -6,
        z: (c.stair.rect.z0 + c.stair.rect.z1) / 2,
      });
      expect(st).toMatchObject({ kind: "stair", projectId: c.projectId });
      const room = building.projects.find((p) => p.projectId === c.projectId)!;
      const bx = (room.balcony.x0 + room.balcony.x1) / 2;
      expect(
        zoneAt3(f, building, { x: bx, y: 0.5, z: (c.z0 + c.z1) / 2 }),
      ).toEqual({
        kind: "balcony",
        projectId: c.projectId,
      });
    }
    expect(zoneAt3(f, building, { x: 0, y: -6, z: 5 })).toEqual({
      kind: "factory",
    });
    expect(zoneAt3(f, building, { x: 0, y: -6, z: f.dock.z0 + 3 })).toEqual({
      kind: "dock",
    });
    expect(zoneAt3(f, building, { x: 0, y: 0, z: 5 })).toEqual({
      kind: "hall",
    });
    expect(zoneAt3(f, building, { x: 0, y: 0, z: -3 })).toEqual({
      kind: "lobby",
    });
  });

  it("entrance: stairs, lift and doors sit in the ground lobby", () => {
    const e = f.entrance;
    // Outside the factory envelope, directly under the reception.
    expect(e.rect.z1).toBe(f.bounds.min.z);
    expect(e.rect.z0).toBe(building.bounds.min.z);
    expect(e.rect.x1 - e.rect.x0).toBeCloseTo(building.lobby.size.x, 6);
    expect(e.gallery.z0).toBe(e.rect.z1);
    expect(e.gallery.z1).toBe(0);
    // Two mirrored U-stairs inside the footprint, clear of each other / the lift.
    expect(e.stairs.map((s) => s.side)).toEqual(["west", "east"]);
    for (const s of e.stairs) {
      for (const r of [s.rect, s.lower, s.upper, s.landing]) {
        expect(inRect(e.rect, { x: r.x0, z: r.z0 })).toBe(true);
        expect(inRect(e.rect, { x: r.x1, z: r.z1 })).toBe(true);
      }
      expect(overlap(s.rect, e.lift.rect)).toBe(false);
      expect(s.top.y).toBe(0);
      expect(s.bottom.y).toBe(-6);
      expect(s.landingY).toBe(-3);
      // Foot and head clear of the stair itself, inside the lobby, before the wall.
      expect(inRect(s.rect, s.bottom)).toBe(false);
      expect(inRect(e.rect, s.bottom)).toBe(true);
      expect(s.bottom.z).toBeLessThan(e.factoryDoor.z - 0.6);
      // Flights: walkable slope, the upper one arrives inside the opening edge.
      const run = s.lower.z1 - s.lower.z0;
      expect((Math.atan2(3, run) * 180) / Math.PI).toBeLessThan(45);
      expect(s.upper.z1).toBe(s.rect.z1);
      expect(s.landing.z1).toBe(s.lower.z0);
    }
    expect(e.stairs[0].rect.x0).toBeCloseTo(-e.stairs[1].rect.x1, 9);
    expect(overlap(e.stairs[0].rect, e.stairs[1].rect)).toBe(false);
    // Factory door on the shared north wall, centred between the stairs.
    expect(e.factoryDoor.z).toBe(e.rect.z1);
    expect(e.factoryDoor.x - e.factoryDoor.width / 2).toBeGreaterThan(
      e.stairs[0].rect.x1,
    );
    expect(e.factoryDoor.x + e.factoryDoor.width / 2).toBeLessThan(
      e.stairs[1].rect.x0,
    );
    // Entrance doors on the south façade; spawn just inside, facing in.
    expect(e.doors.z).toBe(e.rect.z0);
    expect(inRect(e.rect, e.spawn)).toBe(true);
    expect(e.spawn.y).toBe(-6);
    expect(e.spawnYaw).toBe(0);
    // Lift: two stops (G, 1), arrival spots in front of the door, on floor.
    const L = e.lift;
    expect(L.stops.map((s) => [s.level, s.y])).toEqual([
      [0, -6],
      [1, 0],
    ]);
    expect(inRect(e.rect, { x: L.rect.x0, z: L.rect.z0 })).toBe(true);
    expect(inRect(e.rect, { x: L.rect.x1, z: L.rect.z1 })).toBe(true);
    for (const st of L.stops) {
      expect(inRect(L.rect, st.front)).toBe(false);
      expect(inRect(e.rect, st.front)).toBe(true);
      for (const s of e.stairs) expect(inRect(s.rect, st.front)).toBe(false);
    }
    expect(L.door.z).toBe(L.rect.z0);
    expect(f.liftSpots[0].rect).toEqual(L.rect);
  });

  it("zoneAt3: the ground lobby is the entrance, the reception the lobby", () => {
    const e = f.entrance;
    for (const p of [
      e.spawn,
      { ...e.stairs[0].bottom },
      { x: 0, y: -6, z: (e.rect.z0 + e.rect.z1) / 2 },
    ])
      expect(zoneAt3(f, building, { ...p, y: -6 + 1.65 })).toEqual({
        kind: "entrance",
      });
    expect(zoneAt3(f, building, { x: 0, y: 1.65, z: -9 })).toEqual({
      kind: "lobby",
    });
    // Under the gallery: factory floor.
    expect(zoneAt3(f, building, { x: 5, y: -4.35, z: -2 })).toEqual({
      kind: "factory",
    });
    // South of the entrance façade: outside.
    expect(zoneAt3(f, building, { x: 0, y: -4.35, z: e.rect.z0 - 2 })).toEqual({
      kind: "outside",
    });
  });

  it("is deterministic", () => {
    expect(buildFactoryLayout(building)).toEqual(f);
    expect(JSON.stringify(buildFactoryLayout(building))).toBe(
      JSON.stringify(f),
    );
  });

  it("main line runs under the spine to the dock", () => {
    expect(f.mainLine.x).toBe(0);
    expect(f.mainLine.z1).toBe(f.dock.z0);
    expect(f.mainLine.qc).toBeLessThan(f.mainLine.z1);
    expect(f.mainLine.qc).toBeGreaterThan(building.hall.length - 1);
  });
});
