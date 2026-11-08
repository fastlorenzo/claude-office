/**
 * WS3 G15: every stair flight in the world comes from `stairs.ts`, and the
 * shared geometry holds for each of them: ≤ 35°, the hidden ramp's top face
 * runs exactly through the top and bottom nosings (flush with both floors,
 * no lip; it only extends below the lower floor), every tread nosing sits on
 * that face (feet never sink into a tread, never float over one by more
 * than a rise), and the side guards stay within the flight's own z range.
 */
import { describe, expect, it } from "vitest";
import { Matrix, Quaternion, Vector3 } from "@/engine/babylon";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, CROSSOVER } from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { entranceFlights } from "@/engine/world/EntranceHall";
import { dockStairFlight } from "@/engine/world/factory/Dock";
import {
  cellStairFlights,
  crossoverFlights,
  spineFlight,
} from "@/engine/world/factory/FactoryHall";
import {
  guardBox,
  pitchDeg,
  rampBox,
  STAIR_MAX_DEG,
  treads,
  type Flight,
} from "@/engine/world/stairs";

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

  it("side guards stay within the flight's z range", () => {
    for (const { f } of flights) {
      const g = guardBox(f, f.xa + 0.025, f.yBot);
      const z0 = Math.min(f.zTop, f.zBot);
      const z1 = Math.max(f.zTop, f.zBot);
      expect(g.c.z - g.s.z / 2).toBeGreaterThanOrEqual(z0 - 1e-9);
      expect(g.c.z + g.s.z / 2).toBeLessThanOrEqual(z1 + 1e-9);
    }
  });

  it("crossover decks clear the tallest workpiece", () => {
    // Belt 0.85 + pallet 0.14 + the largest body 0.66 (workpiecePlacement).
    expect(CROSSOVER.DECK_H - 0.2).toBeGreaterThan(0.85 + 0.14 + 0.66);
  });
});
