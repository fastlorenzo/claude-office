/**
 * WS3 G15: every stair flight in the world comes from `stairs.ts`, and the
 * shared geometry holds for each of them: ≤ 35°, the hidden ramp's top face
 * runs exactly through the top and bottom nosings (flush with both floors,
 * no lip; it only extends below the lower floor), every tread nosing sits on
 * that face (feet never sink into a tread, never float over one by more
 * than a rise), and the side guards stay within the flight's own z range.
 *
 * Under every flight (the real collider builders: FactoryHall, EntranceHall,
 * Dock) the floor is free wherever the underside is ≥ STAIR_HEADROOM up, and
 * closed where it is lower (no wedging under the low end); side guards are a
 * band along the treads, never a wall down to the floor.
 */
import { describe, expect, it, vi } from "vitest";

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

import {
  Matrix,
  NullEngine,
  Quaternion,
  Scene,
  Vector3,
} from "@/engine/babylon";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { Lighting } from "@/engine/fx/Lighting";
import { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  CELL_STAIR,
  CROSSOVER,
} from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { EntranceHall, entranceFlights } from "@/engine/world/EntranceHall";
import { addDockColliders, dockStairFlight } from "@/engine/world/factory/Dock";
import {
  cellStairFlights,
  crossoverFlights,
  FactoryHall,
  spineFlight,
} from "@/engine/world/factory/FactoryHall";
import {
  guardBoxes,
  nosingY,
  pitchDeg,
  rampBox,
  STAIR_GUARD_H,
  STAIR_HEADROOM,
  STAIR_MAX_DEG,
  steelDepth,
  treads,
  type Flight,
} from "@/engine/world/stairs";
import { recorder, type RecBox } from "./helpers/colliderBoxes";

function demo(n: number) {
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

/** World points of the ramp box's top face at its two ends (centre x). */
function rampEnds(f: Flight) {
  const r = rampBox(f);
  const m = Matrix.Compose(
    new Vector3(1, 1, 1),
    Quaternion.RotationYawPitchRoll(0, r.pitch, 0),
    r.c,
  );
  const at = (lz: number) =>
    Vector3.TransformCoordinates(new Vector3(0, r.s.y / 2, lz), m);
  return { a: at(-r.s.z / 2), b: at(r.s.z / 2), r };
}

/** Height of the ramp's top face at z (inside the flight's run). */
function rampY(f: Flight, z: number): number {
  return f.yTop - ((z - f.zTop) / (f.zBot - f.zTop)) * f.drop;
}

function allFlights(): { name: string; f: Flight }[] {
  const out: { name: string; f: Flight }[] = [];
  for (const n of [4, 6, 10]) {
    const b = demo(n);
    const fl = buildFactoryLayout(b);
    for (const st of fl.spineStairs)
      out.push({ name: `n${n} ${st.id}`, f: spineFlight(st, fl.floorY) });
    for (const c of fl.cells)
      cellStairFlights(c, fl.floorY).forEach((f, k) =>
        out.push({ name: `n${n} ${c.stair.id} #${k}`, f }),
      );
    for (const x of fl.crossovers)
      crossoverFlights(x, fl.floorY).forEach((f, k) =>
        out.push({ name: `n${n} ${x.id} #${k}`, f }),
      );
    for (const st of fl.entrance.stairs)
      entranceFlights(st, fl.entrance.floorY).forEach((f, k) =>
        out.push({ name: `n${n} ${st.id} #${k}`, f }),
      );
  }
  out.push({ name: "dock", f: dockStairFlight() });
  return out;
}

describe("stairs.ts: every flight in the world", () => {
  const flights = allFlights();

  it("covers spine, cell, crossover, entrance and dock flights", () => {
    const kinds = new Set(
      flights.map((f) => f.name.replace(/^n\d+ /, "").split(":")[0]),
    );
    for (const k of ["spine", "cell", "crossover", "entrance", "dock"])
      expect(kinds.has(k)).toBe(true);
  });

  it.each(allFlights().map((f) => [f.name, f.f] as const))(
    "%s: ≤ 35°, flush ramp, nosings on the ramp",
    (_name, f) => {
      expect(pitchDeg(f)).toBeLessThanOrEqual(STAIR_MAX_DEG + 1e-9);
      const { a, b } = rampEnds(f);
      // One end of the top face is exactly the top nosing (no lip above the
      // upper floor); the other lies on the slope's extension below the
      // bottom nosing (under the lower floor).
      const top = f.dir > 0 ? a : b;
      const low = f.dir > 0 ? b : a;
      // (Babylon matrices are float32: 4 decimals.)
      expect(top.z).toBeCloseTo(f.zTop, 4);
      expect(top.y).toBeCloseTo(f.yTop, 4);
      expect(low.y).toBeLessThan(f.yBot);
      expect(low.y).toBeGreaterThan(f.yBot - 0.15);
      const lz = f.zBot + f.dir * ((f.yBot - low.y) / f.drop) * f.run;
      expect(low.z).toBeCloseTo(lz, 4);
      for (const t of treads(f)) {
        // The nosing is on the ramp's top face ...
        expect(t.yt).toBeCloseTo(rampY(f, t.zNose), 6);
        // ... and the ramp never dips into the tread behind it (feet never
        // sink), floating at most one rise over its inner corner.
        const back = t.zNose - f.dir * f.going;
        expect(rampY(f, back) - t.yt).toBeGreaterThanOrEqual(-1e-6);
        expect(rampY(f, back) - t.yt).toBeLessThanOrEqual(f.rise + 1e-6);
      }
      // Risers within building-code limits.
      expect(f.rise).toBeLessThanOrEqual(0.21);
      expect(f.going).toBeGreaterThanOrEqual(0.24);
    },
  );

  it("side guards stay within the flight's z range, as a band along the treads", () => {
    for (const { f } of flights) {
      const gs = guardBoxes(f, f.xa + 0.025);
      const z0 = Math.min(f.zTop, f.zBot);
      const z1 = Math.max(f.zTop, f.zBot);
      let covered = 0;
      for (const g of gs) {
        const a = g.c.z - g.s.z / 2;
        const b = g.c.z + g.s.z / 2;
        expect(a).toBeGreaterThanOrEqual(z0 - 1e-9);
        expect(b).toBeLessThanOrEqual(z1 + 1e-9);
        covered += b - a;
        // Over the segment: from at most 0.25 under the treads (never down
        // to the floor) to ≥ the guard height over them, no gap a capsule
        // (r 0.3) could slip through (≤ 0.2 over the lowest tread).
        const lo = g.c.y - g.s.y / 2;
        const hi = g.c.y + g.s.y / 2;
        const ya = nosingY(f, a);
        const yb = nosingY(f, b);
        expect(lo).toBeGreaterThanOrEqual(Math.max(ya, yb) - 0.25 - 1e-9);
        expect(lo).toBeLessThanOrEqual(Math.min(ya, yb) + 0.2);
        expect(hi).toBeGreaterThanOrEqual(
          Math.max(ya, yb) + STAIR_GUARD_H - 1e-9,
        );
      }
      expect(covered).toBeCloseTo(z1 - z0, 6);
    }
  });

  it("crossover decks clear the tallest workpiece", () => {
    // Belt 0.85 + pallet 0.14 + the largest body 0.66 (workpiecePlacement).
    expect(CROSSOVER.DECK_H - 0.2).toBeGreaterThan(0.85 + 0.14 + 0.66);
  });
});

// ---------------------------------------------------------------------------
// Under the flights: walkable where the headroom allows, closed where not
// ---------------------------------------------------------------------------

/** Vertical depth of the entrance flights' soffit (EntranceHall STAIR_D). */
const ENTRANCE_SOFFIT = 0.42;
/** Dock stringers (0.26 deep). */
const DOCK_SOFFIT = 0.26;

interface UnderCase {
  name: string;
  f: Flight;
  /** Floor under the flight and the flight's underside depth (flight frame). */
  floor: number;
  depth: number;
  /** World y of the flight frame's origin (the colliders are world). */
  dy: number;
  boxes: RecBox[];
}

const inBox = (b: RecBox, x: number, y: number, z: number): boolean => {
  const l = Vector3.TransformCoordinates(new Vector3(x, y, z), b.inv);
  return Math.abs(l.x) <= 0.5 && Math.abs(l.y) <= 0.5 && Math.abs(l.z) <= 0.5;
};

const fakeColliders = (rec: ReturnType<typeof recorder>) =>
  ({
    addBox: rec.sink.addBox,
    disposeGroup: () => undefined,
  }) as unknown as Colliders;

/** Boxes whose plan AABB comes within 1 m of the flight. */
function near(boxes: RecBox[], f: Flight): RecBox[] {
  const z0 = Math.min(f.zTop, f.zBot) - 1;
  const z1 = Math.max(f.zTop, f.zBot) + 1;
  return boxes.filter((b) => {
    const r = Math.hypot(b.s.x, b.s.y, b.s.z) / 2;
    return (
      b.c.x + r > f.xa - 1 &&
      b.c.x - r < f.xb + 1 &&
      b.c.z + r > z0 &&
      b.c.z - r < z1
    );
  });
}

function underCases(): UnderCase[] {
  const out: UnderCase[] = [];
  for (const n of [4, 6, 10]) {
    const b = demo(n);
    const fl = buildFactoryLayout(b);
    const fy = fl.floorY;
    const rec = recorder();
    const scene = new Scene(new NullEngine());
    const materials = new Materials(scene, "/assets");
    const hall = new FactoryHall({
      scene,
      materials,
      colliders: fakeColliders(rec),
      lighting: {
        addStaticCasters: () => undefined,
        registerProbe: () => undefined,
      } as unknown as Lighting,
    });
    hall.build({ ...fl, emptyCells: [] }, b);
    hall.dispose();
    const steel = (name: string, f: Flight) =>
      out.push({
        name: `n${n} ${name}`,
        f,
        floor: fy,
        depth: steelDepth(f),
        dy: 0,
        boxes: near(rec.boxes, f),
      });
    for (const st of fl.spineStairs) steel(st.id, spineFlight(st, fy));
    for (const c of fl.cells)
      cellStairFlights(c, fy).forEach((f, k) =>
        steel(`${c.stair.id} #${k}`, f),
      );
    for (const x of fl.crossovers)
      crossoverFlights(x, fy).forEach((f, k) => steel(`${x.id} #${k}`, f));
    const erec = recorder();
    new EntranceHall(
      {
        scene,
        materials,
        assets: {
          instantiate: () => () => undefined,
          disposeGroup: () => undefined,
        } as unknown as AssetLibrary,
        colliders: fakeColliders(erec),
      },
      fl.entrance,
      { name: "X" } as never,
    );
    for (const st of fl.entrance.stairs)
      entranceFlights(st, fl.entrance.floorY).forEach((f, k) =>
        out.push({
          name: `n${n} ${st.id} #${k}`,
          f,
          floor: 0,
          depth: ENTRANCE_SOFFIT,
          dy: fl.entrance.floorY,
          boxes: near(erec.boxes, f),
        }),
      );
    scene.dispose();
  }
  const drec = recorder();
  addDockColliders(drec.sink, "dock");
  const f = dockStairFlight();
  out.push({
    name: "dock",
    f,
    floor: 0,
    depth: DOCK_SOFFIT,
    dy: 0,
    boxes: near(drec.boxes, f),
  });
  return out;
}

describe("under every flight: free where headroom ≥ 2 m, closed below", () => {
  const cases = underCases();
  let free = 0;
  let closed = 0;

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { f, floor, depth, dy, boxes } = c;
    // Across the width: both guard planes and the inner strip.
    const xs = [f.xa + 0.025, f.xb - 0.025];
    for (let x = f.xa + 0.1; x <= f.xb - 0.1 + 1e-9; x += 0.1) xs.push(x);
    const inner = xs.slice(2);
    const occupied: string[] = [];
    const open: string[] = [];
    for (let t = 0.01; t < 0.995; t += 0.1 / f.run) {
      const z = f.zTop + f.dir * t * f.run;
      const under = nosingY(f, z) - depth;
      const h = under - floor;
      if (h >= STAIR_HEADROOM) {
        // Nothing between the floor and the underside.
        free++;
        for (const x of xs)
          for (let y = floor + 0.02; y <= under - 0.01; y += 0.05) {
            const hit = boxes.find((b) => inBox(b, x, y + dy, z));
            if (hit)
              occupied.push(
                `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} in ${hit.group} c=${hit.c.toString()} s=${hit.s.toString()}`,
              );
          }
      } else if (h >= 0.5) {
        // Feet and head of a capsule wedging in: both blocked.
        closed++;
        for (const x of inner)
          for (const y of [floor + 0.1, floor + h - 0.3])
            if (!boxes.some((b) => inBox(b, x, y + dy, z)))
              open.push(`${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`);
      }
    }
    expect(occupied.slice(0, 5)).toEqual([]);
    expect(open.slice(0, 5)).toEqual([]);
  });

  it("exercised both: walkable undersides and closed nooks", () => {
    expect(free).toBeGreaterThan(100);
    expect(closed).toBeGreaterThan(100);
  });
});

describe("under the landings and decks", () => {
  it("free under the far landing (y −2), closed under the near one (y −4) and the crossover decks", () => {
    for (const n of [4, 6, 10]) {
      const b = demo(n);
      const fl = buildFactoryLayout(b);
      const fy = fl.floorY;
      const rec = recorder();
      const scene = new Scene(new NullEngine());
      const hall = new FactoryHall({
        scene,
        materials: new Materials(scene, "/assets"),
        colliders: fakeColliders(rec),
        lighting: {
          addStaticCasters: () => undefined,
          registerProbe: () => undefined,
        } as unknown as Lighting,
      });
      hall.build({ ...fl, emptyCells: [] }, b);
      hall.dispose();
      scene.dispose();
      const S = CELL_STAIR;
      for (const c of fl.cells) {
        const s = c.side === "east" ? 1 : -1;
        const W = 4.8;
        const m = c.stair.top.z - c.z0 > W / 2;
        const Z = (o: number) => (m ? c.z0 + W - o : c.z0 + o);
        const mid = (r: {
          x0: number;
          x1: number;
          z0: number;
          z1: number;
        }) => ({
          x: (s * (r.x0 + r.x1)) / 2,
          z: Z((r.z0 + r.z1) / 2),
        });
        const far = mid(S.far);
        // Off the posts (outer corners): centre strip.
        for (let y = fy + 0.05; y < -2 - 0.25; y += 0.1)
          expect(
            rec.boxes.some((q) => inBox(q, far.x, y, far.z)),
            `${c.projectId} far landing y=${y.toFixed(2)}`,
          ).toBe(false);
        const nr = mid(S.near);
        for (const y of [fy + 0.1, fy + 1.0, fy + 1.6])
          expect(rec.boxes.some((q) => inBox(q, nr.x, y, nr.z))).toBe(true);
      }
      // Crossover decks: 2 m up, 1.8 m clear under the plate (< 2 m): the
      // strips beside the belt under the deck are closed too.
      for (const x of fl.crossovers) {
        expect(x.deckY - 0.2 - fy).toBeLessThan(STAIR_HEADROOM);
        for (const dz of [-0.65, 0.65])
          expect(rec.boxes.some((q) => inBox(q, x.x, fy + 1.5, x.z + dz))).toBe(
            true,
          );
      }
    }
  });
});
