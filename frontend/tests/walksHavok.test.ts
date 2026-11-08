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
import { Materials } from "@/engine/materials/Materials";
import { EntranceHall } from "@/engine/world/EntranceHall";
import { controlPlan } from "@/engine/world/controlRoomPlan";
import { addDeckColliders } from "@/engine/world/controlRoomColliders";
import { factoryColliderBoxes } from "@/engine/world/factory/factoryColliders";
import {
  GLYPH_KINDS,
  type StationInstance,
} from "@/engine/world/factory/stationPlan";
import { endWallBoxes } from "@/engine/world/projectRoomColliders";
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
