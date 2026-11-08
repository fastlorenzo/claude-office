/**
 * WS2 G2 / G12: spine-stair wells follow the rooms (never over a door, a hall
 * planter or a cell feeder; never on the tower bay) and the entrance flights
 * are ≤ 35° with a ≥ 0.27 m going.
 */
import { describe, expect, it } from "vitest";
import { LAYOUT, type BuildingLayout } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  ENTRANCE,
  FLOOR_Y,
  SPINE_STAIR,
  spineFootprintZ,
} from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { TOWER_BAY_D } from "@/engine/world/Building";
import { SPINE_RUN, STAIR_MAX_DEG } from "@/engine/world/factory/FactoryHall";

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

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 200 random session sets, each evolved from the previous one (projects come
 * and go, sessions grow / shrink) so slots keep their history like the live
 * world: rooms end up at arbitrary entry bays on both sides.
 */
function randomLayouts(count = 200): BuildingLayout[] {
  const r = rng(20261108);
  const out: BuildingLayout[] = [];
  let slots = new Map();
  let pods = new Map<string, number>();
  let projects: { id: string; createdAt: number; sessions: number }[] = [];
  let next = 0;
  for (let i = 0; i < count; i++) {
    // Mutate: drop, add, resize.
    projects = projects.filter(() => r() > 0.2);
    while (projects.length < 1 + Math.floor(r() * 7))
      projects.push({ id: `p${next}`, createdAt: next++, sessions: 1 });
    for (const p of projects)
      if (r() < 0.5) p.sessions = 1 + Math.floor(r() * 7);
    const groups = projects.map((p) => ({
      id: p.id,
      name: p.id,
      sessionIds: Array.from({ length: p.sessions }, (_, k) => `${p.id}s${k}`),
    }));
    slots = allocateSlots(slots, projects);
    pods = allocatePods(pods, groups);
    out.push(generateLayout(slots, groups, pods));
  }
  return out;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
  a0 < b1 - 1e-9 && b0 < a1 - 1e-9;

function checkWells(b: BuildingLayout): void {
  const f = buildFactoryLayout(b);
  const W = LAYOUT.ROOM_W;
  const side = (x: number) => (x > 0 ? "east" : "west");
  for (const st of f.spineStairs) {
    const r = st.rect;
    const s = side(r.x0 + r.x1);
    // In the hall, against a glass front, clear of the tower bay.
    expect(Math.min(Math.abs(r.x0), Math.abs(r.x1))).toBeCloseTo(2.3, 6);
    expect(Math.max(Math.abs(r.x0), Math.abs(r.x1))).toBeCloseTo(
      LAYOUT.HALL_W / 2,
      6,
    );
    expect(r.z0).toBeGreaterThan(0);
    expect(r.z1).toBeLessThanOrEqual(b.hall.length - TOWER_BAY_D + 1e-9);
    for (const room of b.projects) {
      if (room.slot.side !== s) continue;
      // Door opening ± 0.7 m.
      const d = room.door.z;
      const h = LAYOUT.DOOR_W / 2 + 0.7;
      expect(overlaps(r.z0, r.z1, d - h, d + h)).toBe(false);
      // Hall planter at the room's far end (|x| 2.95).
      const pz = room.footprint.z1 - 0.6;
      expect(overlaps(r.z0, r.z1, pz - 0.4, pz + 0.4)).toBe(false);
    }
    // No feeder belt across the flight's floor footprint.
    const [f0, f1] = spineFootprintZ(r.z0);
    for (const c of f.cells)
      if (c.side === s)
        expect(
          overlaps(f0, f1, c.trunk.feederZ - 0.8, c.trunk.feederZ + 0.8),
        ).toBe(false);
    // Arrival in the hall, foot on the floor past the flight.
    expect(st.top.z).toBeGreaterThan(0);
    expect(st.top.y).toBe(0);
    expect(st.bottom.y).toBe(FLOOR_Y);
    expect(st.bottom.z).toBeGreaterThan(r.z0 + SPINE_RUN);
  }
  // Wells keep their distance (≥ 3 bays apart).
  const zs = f.spineStairs.map((s) => (s.rect.z0 + s.rect.z1) / 2);
  for (let i = 1; i < zs.length; i++)
    expect(zs[i] - zs[i - 1]).toBeGreaterThanOrEqual(3 * W - 1e-6);
}

describe("spine-stair wells (G2)", () => {
  it("mirror the shell constants", () => {
    expect(SPINE_STAIR.RUN).toBe(SPINE_RUN);
    expect(SPINE_STAIR.TOWER_BAY_D).toBe(TOWER_BAY_D);
  });

  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    "demo campus n=%i: no well over a door, planter or feeder",
    (n) => checkWells(demo(n)),
  );

  it("200 random session sets: no well over a door, planter or feeder", () => {
    let wells = 0;
    let long = 0;
    let longWithWell = 0;
    for (const b of randomLayouts()) {
      checkWells(b);
      const n = buildFactoryLayout(b).spineStairs.length;
      wells += n;
      if (b.bays >= 6) {
        long += 1;
        if (n > 0) longWithWell += 1;
      }
    }
    expect(wells).toBeGreaterThan(100);
    // Halls of 6+ bays nearly always keep a spine stair.
    expect(longWithWell / long).toBeGreaterThan(0.9);
  });

  it("the n=10 repro (west room at entry bay 5) has no well at its door", () => {
    const b = demo(10);
    const west5 = b.projects.find(
      (p) => p.slot.side === "west" && p.slot.bay === 5,
    );
    expect(west5).toBeDefined();
    checkWells(b);
  });
});

describe("entrance stairs (G12)", () => {
  // EntranceHall: risers = round(drop / 0.18), going = run / risers.
  const drop = -FLOOR_Y / 2;
  const run = ENTRANCE.FLIGHT_Z1 - ENTRANCE.LANDING_Z[1];
  const n = Math.max(2, Math.round(drop / 0.18));

  it("pitch ≤ 35° and going ≥ 0.27 m", () => {
    expect((Math.atan2(drop, run) * 180) / Math.PI).toBeLessThanOrEqual(
      STAIR_MAX_DEG,
    );
    expect(run / n).toBeGreaterThanOrEqual(0.27 - 1e-9);
  });

  it("the stair foot still leaves a capsule-wide strip to the north wall", () => {
    // Factory south wall inner face (ground lobby side) at SOUTH_Z − WALL_T.
    const wallFace = -4.8 - ENTRANCE.WALL_T;
    expect(wallFace - ENTRANCE.FLIGHT_Z1).toBeGreaterThanOrEqual(0.8);
  });
});
