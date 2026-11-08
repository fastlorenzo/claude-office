/**
 * WS2 acceptance walks replayed headlessly with real Havok and the real
 * Player controller (tests/helpers/havokWalk.ts) against the real collider
 * builders: room end walls, factory equipment, control-room decks, the
 * entrance stairs and the forecourt. Browser walks (world-debug `?walk=`)
 * stay the visual check; these keep the geometry honest on every run.
 *
 * Feet readings: the character controller hovers ≈ 0.05 m above the support
 * while moving and ≈ 0.105 m when standing still.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Canvas-backed parts of the entrance (neon sign, directory board) need a 2D
// context, which node lacks; they carry no colliders.
vi.mock("@/engine/world/BrandSign", () => ({
  BrandSign: class {
    meshes = [];
    texture = { dispose() {} };
    set() {}
    update() {}
    dispose() {}
  },
}));
vi.mock("@/engine/world/architecture", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  const { CreatePlane } = await import("@/engine/babylon");
  return {
    ...m,
    makeTexture: () => ({ dispose() {}, getContext: () => null, update() {} }),
    texturedPlane: (scene: never, name: string) =>
      CreatePlane(name, { size: 1 }, scene),
  };
});

import { Vector3 } from "@/engine/babylon";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { BuildingLayout } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  buildEntrance,
  buildFactoryLayout,
} from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import type { Lighting } from "@/engine/fx/Lighting";
import { Materials } from "@/engine/materials/Materials";
import { EntranceHall } from "@/engine/world/EntranceHall";
import {
  CELL_STAIR,
  cellStairFlights,
  FactoryHall,
  spineFlight,
} from "@/engine/world/factory/FactoryHall";
import { controlPlan } from "@/engine/world/controlRoomPlan";
import { addDeckColliders } from "@/engine/world/controlRoomColliders";
import { factoryColliderBoxes } from "@/engine/world/factory/factoryColliders";
import {
  GLYPH_KINDS,
  type StationInstance,
} from "@/engine/world/factory/stationPlan";
import { endWallBoxes } from "@/engine/world/projectRoomColliders";
import { nosingY, STAIR_HEADROOM, steelDepth } from "@/engine/world/stairs";
import { walk, walkWorld, type WalkWorld } from "./helpers/havokWalk";

const deg = Math.PI / 180;

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

const floor = (
  w: WalkWorld,
  y: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
) =>
  w.colliders.addBox(
    "floor",
    new Vector3((x0 + x1) / 2, y - 0.1, (z0 + z1) / 2),
    new Vector3(x1 - x0, 0.2, z1 - z0),
  );

describe("acceptance walks (Havok, n=6)", () => {
  const b = demo(6);
  let w: WalkWorld;

  beforeAll(async () => {
    w = await walkWorld();
    // Office slab under every room (y = 0) and the factory floor (y = −6).
    for (const r of b.projects) {
      const { x0, x1, z0, z1 } = r.footprint;
      floor(w, 0, Math.min(x0, x1), Math.max(x0, x1), z0, z1);
      for (const e of endWallBoxes(r))
        w.colliders.addBox(
          "end",
          new Vector3(e.center.x, e.center.y, e.center.z),
          new Vector3(e.size.x, e.size.y, e.size.z),
        );
    }
    const fl = buildFactoryLayout(b);
    floor(w, fl.floorY, -34, 34, -4.8, fl.dock.z0);
    const stations: StationInstance[] = fl.cells.flatMap((c) =>
      c.lanes.flatMap((l) =>
        l.stationX.map((x, k) => ({
          id: `${c.projectId}:${l.index}:${k}`,
          x,
          y: fl.floorY,
          z: l.z,
          yaw: c.side === "east" ? Math.PI : 0,
          state: "none" as const,
          kind: GLYPH_KINDS[0],
        })),
      ),
    );
    for (const e of factoryColliderBoxes(fl, stations))
      w.colliders.addBox(
        "eq",
        new Vector3(e.x, e.y, e.z),
        new Vector3(e.sx, e.sy, e.sz),
        e.yaw,
      );
    // Control room: drum floor + decks.
    const p = controlPlan(b);
    floor(w, 0, -13, 13, p.z0, p.z1);
    addDeckColliders(w.colliders, "deck", p);
  }, 60000);
  afterAll(() => w?.dispose());

  it("end wall at the far end of the east room: stops, no drop", () => {
    const r = walk(w, { x: 8, y: 0, z: 22.5, yaw: 0 }, [{ x: 8, z: 27 }], 8);
    expect(r.reached).toBe(0);
    expect(Math.min(...r.log.map((q) => q.y))).toBeGreaterThan(-0.05);
    expect(r.feet.z).toBeCloseTo(24 - 0.1 - 0.35, 1);
  });

  it("end wall between the west rooms (review walk 27): stops", () => {
    const r = walk(w, { x: -8, y: 0, z: 13, yaw: 0 }, [{ x: -8, z: 17 }], 8);
    expect(r.reached).toBe(0);
    expect(r.feet.z).toBeCloseTo(14.4 - 0.1 - 0.35, 1);
  });

  it("factory: walking across the lanes stops at the first belt", () => {
    const r = walk(
      w,
      { x: 19.25, y: -6, z: 9.6, yaw: 0 },
      [{ x: 19.25, z: 13 }],
      8,
    );
    expect(r.reached).toBe(0);
    // Belt edge at 10.8 − 0.47; feet within 0.4 m of it.
    expect(10.33 - r.feet.z).toBeLessThan(0.4);
    expect(r.feet.y).toBeLessThan(-5.8);
  });

  it("factory: a station's arm pedestal blocks", () => {
    const r = walk(
      w,
      { x: 27.58, y: -6, z: 9.95, yaw: 180 * deg },
      [{ x: 27.58, z: 8 }],
      8,
    );
    expect(r.reached).toBe(0);
    expect(r.feet.z).toBeGreaterThan(9.6); // belt alone would allow 9.22
  });

  it("control room: up onto the console tier (deck 0.25)", () => {
    const r = walk(
      w,
      { x: 0, y: 0, z: 30, yaw: 0 },
      [
        { x: 2.9, z: 33 },
        { x: 2.9, z: 37 },
        { x: 0, z: 38.6 },
        { x: 0, z: 40.3 },
      ],
      15,
    );
    expect(r.reached).toBe(4);
    // Standing on the deck: 0.25 + the controller's ~0.105 standing hover.
    expect(r.feet.y).toBeGreaterThan(0.25 + 0.03);
    expect(r.feet.y).toBeLessThan(0.25 + 0.15);
  });
});

describe("acceptance walks (Havok, entrance and forecourt)", () => {
  const b = generateLayout(
    allocateSlots(new Map(), [{ id: "a", createdAt: 0, sessions: 2 }]),
    [{ id: "a", name: "a", sessionIds: ["s0", "s1"] }],
    allocatePods(new Map(), [{ id: "a", sessionIds: ["s0", "s1"] }]),
  );
  const e = buildEntrance(b);
  let w: WalkWorld;

  beforeAll(async () => {
    w = await walkWorld();
    const assets = {
      instantiate: () => () => undefined,
      disposeGroup: () => undefined,
    } as unknown as AssetLibrary;
    new EntranceHall(
      {
        scene: w.scene,
        materials: new Materials(w.scene, "/assets"),
        assets,
        colliders: w.colliders,
      },
      e,
      { name: "X" } as never,
    );
    // The reception slab (Building draws it, cut at the stair openings,
    // which end at the flights' head z = ENTRANCE.FLIGHT_Z1).
    for (const st of e.stairs)
      floor(w, 0, st.rect.x0 - 0.5, st.rect.x1 + 0.5, st.rect.z1, 0);
  }, 60000);
  afterAll(() => w?.dispose());

  it("lobby → along the wall → lower flight → landing → upper flight → reception", () => {
    const r = walk(
      w,
      { x: 3, y: -6, z: -7.5, yaw: 90 * deg },
      [
        { x: 9.2, z: -7.0 },
        { x: 9.4, z: -5.5 },
        { x: 12.35, z: -5.5 },
        { x: 12.35, z: -10.3 },
        { x: 12.35, z: -11.25 },
        { x: 10.85, z: -11.25 },
        { x: 10.85, z: -6.2 },
        { x: 10.85, z: -5.5 },
      ],
      30,
    );
    expect(r.reached).toBe(8);
    // Landing (local 3 → world −3) visited, then the reception (y = 0).
    expect(r.log.some((q) => Math.abs(q.y + 2.9) < 0.15)).toBe(true);
    expect(r.feet.y).toBeGreaterThan(-0.05);
    expect(r.feet.y).toBeLessThan(0.2);
    expect(r.feet.z).toBeGreaterThan(-6.0);
  });

  it("under the east stair: lobby → under the upper flight → under the lower flight's head → under the landing → lobby", () => {
    // Upper flight x 10.15–11.55 (landing 3 m → reception 6 m, ≥ 2.5 m
    // clear under it), lower flight 11.65–13.05 (≥ 2 m clear only in its
    // last ~0.9 m before the landing), landing z −11.85…−10.6 (2.5 m clear).
    const r = walk(
      w,
      { x: 9.3, y: -6, z: -8.3, yaw: 90 * deg },
      [
        { x: 10.85, z: -8.3 },
        { x: 10.85, z: -9.9 },
        { x: 12.35, z: -9.9 },
        { x: 12.35, z: -11.2 },
        { x: 9.3, z: -11.2 },
      ],
      25,
    );
    expect(r.reached).toBe(5);
    // Crossed between the flights inside their z range (not round the end).
    expect(r.log.some((q) => q.x > 11.9 && q.z > -10.4)).toBe(true);
    expect(Math.max(...r.log.map((q) => q.y))).toBeLessThan(-6 + 0.15);
    expect(r.feet.x).toBeLessThan(9.8);
  });

  it("under the east stair's lower flight foot: the nook stops the walker", () => {
    // 1.5 m up the lower flight from its foot: ~0.6 m under it.
    const r = walk(
      w,
      { x: 10.85, y: -6, z: -7.5, yaw: 90 * deg },
      [{ x: 13.5, z: -7.5 }],
      8,
    );
    expect(r.reached).toBe(0);
    expect(r.feet.x).toBeLessThan(11.65 - 0.2);
  });

  it("forecourt: from the doors to the fence line, stopped by the fence", () => {
    const r = walk(
      w,
      { x: 0, y: -6, z: -20, yaw: 180 * deg },
      [
        { x: 0, z: -56 },
        { x: 0, z: -60 },
      ],
      25,
    );
    expect(r.reached).toBe(1);
    expect(r.feet.z).toBeLessThanOrEqual(-55);
    expect(r.feet.z).toBeGreaterThan(-58);
    expect(r.feet.y).toBeCloseTo(-6 + 0.1, 0);
  });
});

describe("acceptance walks (Havok, factory crossovers and stairs)", () => {
  const b = demo(6);
  const fl = buildFactoryLayout(b);
  let w: WalkWorld;
  let hall: FactoryHall;

  beforeAll(async () => {
    w = await walkWorld();
    // The real shell (floor, walls, columns, spine / cell stairs and the
    // crossovers) + the equipment under them.
    hall = new FactoryHall({
      scene: w.scene,
      materials: new Materials(w.scene, "/assets"),
      colliders: w.colliders,
      lighting: {
        addStaticCasters: () => undefined,
        registerProbe: () => undefined,
      } as unknown as Lighting,
    });
    hall.build({ ...fl, emptyCells: [] }, b);
    for (const e of factoryColliderBoxes(fl, []))
      w.colliders.addBox(
        "eq",
        new Vector3(e.x, e.y, e.z),
        new Vector3(e.sx, e.sy, e.sz),
        e.yaw,
      );
  }, 60000);
  afterAll(() => {
    hall?.dispose();
    w?.dispose();
  });

  it("over a feeder crossover: up, across the deck, down — no snag, no lip", () => {
    for (const x of fl.crossovers) {
      const [south, north] = x.feet;
      const r = walk(
        w,
        { x: x.x, y: fl.floorY, z: south.z - 0.6, yaw: 0 },
        [
          { x: x.x, z: x.z },
          { x: x.x, z: north.z },
          { x: x.x, z: north.z + 0.8 },
        ],
        20,
      );
      expect(r.reached).toBe(3);
      // Over the deck (2 m) mid-way — the controller carries a little
      // ballistic lift off the top of a 33.7° ramp at walking speed, so up
      // to ~0.3 above it — then back on the floor at the end.
      const top = Math.max(...r.log.map((q) => q.y));
      expect(top).toBeGreaterThan(x.deckY + 0.02);
      expect(top).toBeLessThan(x.deckY + 0.35);
      expect(r.feet.y).toBeGreaterThan(fl.floorY + 0.02);
      expect(r.feet.y).toBeLessThan(fl.floorY + 0.15);
      // ... and back again (north → south).
      const back = walk(
        w,
        { x: x.x, y: fl.floorY, z: north.z + 0.6, yaw: Math.PI },
        [
          { x: x.x, z: x.z },
          { x: x.x, z: south.z - 0.8 },
        ],
        20,
      );
      expect(back.reached).toBe(2);
      expect(back.feet.y).toBeLessThan(fl.floorY + 0.15);
    }
  });

  it("the crossover's side guards keep the walker on the flight", () => {
    const x = fl.crossovers[0];
    const s = Math.sign(x.x);
    // Half-way up the south flight, push sideways (toward the main line).
    const r = walk(
      w,
      { x: x.x, y: fl.floorY, z: x.feet[0].z - 0.6, yaw: 0 },
      [
        { x: x.x, z: x.z - 2.2 },
        { x: x.x - s * 2, z: x.z - 2.2 },
      ],
      8,
    );
    expect(r.reached).toBe(1);
    expect(Math.abs(r.feet.x - x.x)).toBeLessThan(0.5);
  });

  it("under a spine flight: across beneath it where headroom ≥ 2 m", () => {
    const st = fl.spineStairs[0];
    const f = spineFlight(st, fl.floorY);
    // 1.6 m down the run from the well edge: ~4.7 m clear under the flight.
    const z = f.zTop + f.dir * 1.6;
    expect(nosingY(f, z) - steelDepth(f) - fl.floorY).toBeGreaterThan(
      STAIR_HEADROOM + 2,
    );
    for (const dir of [1, -1]) {
      const x0 = dir > 0 ? f.xa - 1.2 : f.xb + 1.2;
      const x1 = dir > 0 ? f.xb + 1.2 : f.xa - 1.2;
      const r = walk(
        w,
        { x: x0, y: fl.floorY, z, yaw: (dir * Math.PI) / 2 },
        [{ x: x1, z }],
        10,
      );
      expect(r.reached).toBe(1);
      // Out the other side, on the floor all the way.
      expect(dir * (r.feet.x - x1)).toBeGreaterThan(-0.3);
      expect(Math.max(...r.log.map((q) => q.y))).toBeLessThan(fl.floorY + 0.15);
      expect(r.feet.y).toBeLessThan(fl.floorY + 0.15);
    }
  });

  it("under a spine flight's low end: the nook stops the walker", () => {
    const st = fl.spineStairs[0];
    const f = spineFlight(st, fl.floorY);
    // 2.2 m up the run from the foot: ~1.3 m under the flight (< 2 m).
    const z = f.zBot - f.dir * 2.2;
    expect(nosingY(f, z) - steelDepth(f) - fl.floorY).toBeLessThan(
      STAIR_HEADROOM,
    );
    const r = walk(
      w,
      { x: f.xa - 1.2, y: fl.floorY, z, yaw: Math.PI / 2 },
      [{ x: f.xb + 1.2, z }],
      8,
    );
    expect(r.reached).toBe(0);
    expect(r.feet.x).toBeLessThan(f.xa - 0.2);
    expect(r.feet.y).toBeLessThan(fl.floorY + 0.15);
  });

  it("under a cell stair: along beneath the switchback, and across under flights 1 and 2", () => {
    const S = CELL_STAIR;
    for (const c of fl.cells) {
      const W = 4.8;
      const m = c.stair.top.z - c.z0 > W / 2;
      const Z = (o: number) => (m ? c.z0 + W - o : c.z0 + o);
      const [f1, f2] = cellStairFlights(c, fl.floorY);
      const s = Math.sign(f1.xm);
      expect(-2 - steelDepth(f1) - fl.floorY).toBeGreaterThan(STAIR_HEADROOM);
      // (The cell's end wall stands ~0.7 m past the far landing.)
      const zOut = Z(S.far.z1 + 0.3);
      const out = (r: ReturnType<typeof walk>, from: number) => {
        expect(r.reached).toBe(1);
        // Out from under the far landing, on the floor all the way.
        expect(
          Math.sign(zOut - from) * (r.feet.z - Z(S.far.z1)),
        ).toBeGreaterThan(0.2);
        expect(Math.max(...r.log.map((q) => q.y))).toBeLessThan(
          fl.floorY + 0.15,
        );
      };
      // Along flight 1's centre line, the whole length of the switchback at
      // floor level: top landing (y 0), flight 1 (0 → −2), far landing (−2).
      const za = Z(S.top.z0 - 0.6);
      out(
        walk(
          w,
          { x: f1.xm, y: fl.floorY, z: za, yaw: zOut > za ? 0 : Math.PI },
          [{ x: f1.xm, z: zOut }],
          12,
        ),
        za,
      );
      // From the entry-bay walkway side, across under flight 1 (through
      // both its guard planes) to under flight 2 (≥ 2.7 m clear there),
      // then out under the far landing between its posts.
      const zm = Z(2.6);
      expect(nosingY(f2, zm) - steelDepth(f2) - fl.floorY).toBeGreaterThan(
        STAIR_HEADROOM + 0.5,
      );
      const x0 = s > 0 ? f1.xa - 1.0 : f1.xb + 1.0;
      const r = walk(
        w,
        { x: x0, y: fl.floorY, z: zm, yaw: (s * Math.PI) / 2 },
        [
          { x: f2.xm, z: zm },
          { x: s * 15.4, z: Z(S.far.z0) },
          { x: s * 15.4, z: zOut },
        ],
        15,
      );
      // It got under flight 2.
      expect(r.log.some((q) => q.x > f2.xa + 0.2 && q.x < f2.xb - 0.2)).toBe(
        true,
      );
      expect(r.reached).toBe(3);
      // Out from under the far landing (the harness overshoots and turns
      // back to a waypoint it brushed past, so read the log, not the end).
      expect(
        r.log.some((q) => Math.sign(zOut - zm) * (q.z - Z(S.far.z1)) > 0.2),
      ).toBe(true);
      expect(Math.max(...r.log.map((q) => q.y))).toBeLessThan(fl.floorY + 0.15);
    }
  });

  it("spine stair: hall well head down to the factory floor", () => {
    const st = fl.spineStairs[0];
    // The hall slab up to the well's top edge (Building draws it).
    w.colliders.addBox(
      "hallSlab",
      new Vector3(0, -0.1, st.rect.z0 / 2),
      new Vector3(7, 0.2, st.rect.z0),
    );
    const r = walk(
      w,
      { x: st.top.x, y: 0, z: st.rect.z0 - 0.4, yaw: 0 },
      [
        { x: st.top.x, z: st.rect.z0 + 4 },
        { x: st.top.x, z: st.bottom.z },
      ],
      20,
    );
    expect(r.reached).toBe(2);
    expect(r.feet.y).toBeLessThan(fl.floorY + 0.15);
  });
});
