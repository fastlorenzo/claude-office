/**
 * WS2 G3: factory equipment colliders block the belts, stations and cell
 * furniture without stranding the player: with every collider of the shell
 * (FactoryHall), the dock and the equipment (worst case: every lane carries
 * all six stations), a 0.35 m capsule flood fill checks that each cell is
 * usable from its stair, the door reaches the dock and the first cells, and
 * every spine-stair foot leads to another exit.
 */
import { describe, expect, it } from "vitest";
import { NullEngine, Scene, Vector3 } from "@/engine/babylon";
import type { BuildingLayout } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  SPINE_STAIR,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import type { Lighting } from "@/engine/fx/Lighting";
import { Materials } from "@/engine/materials/Materials";
import { framedSink, type Colliders } from "@/engine/physics/Colliders";
import {
  addDockColliders,
  DOCK,
  DOCK_STAIR,
} from "@/engine/world/factory/Dock";
import { dressingBoxes } from "@/engine/world/dressing";
import { FactoryHall } from "@/engine/world/factory/FactoryHall";
import {
  FACTORY_EQUIPMENT_GROUP,
  factoryColliderBoxes,
  syncFactoryColliders,
} from "@/engine/world/factory/factoryColliders";
import {
  GLYPH_KINDS,
  type StationInstance,
} from "@/engine/world/factory/stationPlan";
import { blocked, recorder, type RecBox } from "./helpers/colliderBoxes";

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

/** Worst case: all six stations on every lane. */
function allStations(fl: FactoryLayout): StationInstance[] {
  const out: StationInstance[] = [];
  for (const c of fl.cells)
    for (const l of c.lanes)
      l.stationX.forEach((x, k) =>
        out.push({
          id: `${c.projectId}:${l.index}:${k}`,
          x,
          y: fl.floorY,
          z: l.z,
          yaw: c.side === "east" ? Math.PI : 0,
          state: "none",
          kind: GLYPH_KINDS[0],
        }),
      );
  return out;
}

/** Every collider on the factory floor: shell + dock + equipment. */
function floorColliders(b: BuildingLayout) {
  const fl = buildFactoryLayout(b);
  const rec = recorder();
  const fake = {
    addBox: rec.sink.addBox,
    disposeGroup: () => undefined,
  } as unknown as Colliders;
  const scene = new Scene(new NullEngine());
  const hall = new FactoryHall({
    scene,
    materials: new Materials(scene, "/assets"),
    colliders: fake,
    lighting: {
      addStaticCasters: () => undefined,
      registerProbe: () => undefined,
    } as unknown as Lighting,
  });
  // Empty-cell stencils need a 2D canvas: drop them (no colliders there).
  hall.build({ ...fl, emptyCells: [] }, b);
  addDockColliders(
    framedSink(rec.sink, new Vector3(0, fl.floorY, fl.dock.z1), 0),
    "dock",
  );
  const shell = rec.boxes.length;
  const stations = allStations(fl);
  syncFactoryColliders(
    { addBox: rec.sink.addBox, disposeGroup: () => undefined },
    fl,
    stations,
  );
  // WS6 set dressing: its solid props must not strand anything either.
  for (const d of dressingBoxes(fl, b))
    rec.sink.addBox(
      "dressing",
      new Vector3(d.x, d.y, d.z),
      new Vector3(d.sx, d.sy, d.sz),
      d.yaw,
    );
  hall.dispose();
  return { fl, boxes: rec.boxes, equipment: rec.boxes.slice(shell), stations };
}

/** 4-connected flood fill of capsule-free grid points from `start`. */
function reach(
  boxes: readonly RecBox[],
  fl: FactoryLayout,
  start: { x: number; z: number } | { x: number; z: number }[],
  step = 0.1,
) {
  const y = fl.floorY;
  const x0 = fl.bounds.min.x;
  const z0 = fl.bounds.min.z;
  const nx = Math.ceil((fl.bounds.max.x - x0) / step) + 1;
  const nz = Math.ceil((fl.bounds.max.z - z0) / step) + 1;
  // Bucket the floor-level obstacles (2 m cells) for speed.
  const B = 2;
  const bx = Math.ceil((nx * step) / B) + 1;
  const bz = Math.ceil((nz * step) / B) + 1;
  const buckets: RecBox[][] = Array.from({ length: bx * bz }, () => []);
  for (const b of boxes) {
    if (b.pitch === 0 && b.c.y + b.s.y / 2 < y + 0.3) continue;
    const r = Math.hypot(b.s.x, b.s.z, b.pitch ? b.s.y : 0) / 2 + 0.4;
    const i0 = Math.max(0, Math.floor((b.c.x - r - x0) / B));
    const i1 = Math.min(bx - 1, Math.floor((b.c.x + r - x0) / B));
    const k0 = Math.max(0, Math.floor((b.c.z - r - z0) / B));
    const k1 = Math.min(bz - 1, Math.floor((b.c.z + r - z0) / B));
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++) buckets[k * bx + i].push(b);
  }
  const free = (i: number, k: number) => {
    const x = x0 + i * step;
    const z = z0 + k * step;
    const list =
      buckets[Math.floor((z - z0) / B) * bx + Math.floor((x - x0) / B)];
    return !blocked(list, x, z, y);
  };
  const seen = new Uint8Array(nx * nz); // 0 unknown, 1 free+reached, 2 blocked
  const idx = (p: { x: number; z: number }) => [
    Math.round((p.x - x0) / step),
    Math.round((p.z - z0) / step),
  ];
  // Start at the nearest free grid point within 0.6 m (a stair foot sits
  // against the ramp end, which the conservative AABB test blocks).
  const q: number[] = [];
  const seed = (p: { x: number; z: number }) => {
    const [ci, ck] = idx(p);
    let best = Infinity;
    let pick = -1;
    for (let di = -6; di <= 6; di++)
      for (let dk = -6; dk <= 6; dk++) {
        const d = di * di + dk * dk;
        if (d < best && free(ci + di, ck + dk)) {
          best = d;
          pick = (ck + dk) * nx + (ci + di);
        }
      }
    if (pick >= 0 && seen[pick] !== 1) {
      seen[pick] = 1;
      q.push(pick);
    }
  };
  for (const p of Array.isArray(start) ? start : [start]) seed(p);
  while (q.length) {
    const c = q.pop()!;
    const i = c % nx;
    const k = (c - i) / nx;
    for (const [di, dk] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ii = i + di;
      const kk = k + dk;
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const n = kk * nx + ii;
      if (seen[n]) continue;
      if (!free(ii, kk)) {
        seen[n] = 2;
        continue;
      }
      seen[n] = 1;
      q.push(n);
    }
  }
  return {
    reached: (p: { x: number; z: number }) => {
      // Any reached grid point within 0.6 m (the point itself may sit
      // against an obstacle, e.g. a stair foot at the ramp end).
      const [i, k] = idx(p);
      for (let di = -6; di <= 6; di++)
        for (let dk = -6; dk <= 6; dk++) {
          const n = (k + dk) * nx + (i + di);
          if (seen[n] === 1) return true;
        }
      return false;
    },
  };
}

function pointsOfInterest(fl: FactoryLayout) {
  const pts: { name: string; x: number; z: number }[] = [
    { name: "factory door", x: 0, z: fl.entrance.factoryDoor.z + 0.6 },
    {
      name: "dock stair foot",
      x: DOCK_STAIR.x,
      z: fl.dock.z1 - DOCK.depth - DOCK_STAIR.run - 0.6,
    },
  ];
  for (const st of fl.spineStairs)
    pts.push({
      name: st.id,
      x: st.bottom.x,
      z: st.rect.z0 + SPINE_STAIR.RUN + 0.6,
    });
  for (const c of fl.cells) {
    const s = c.side === "east" ? 1 : -1;
    const W = 4.8;
    const m = c.stair.top.z - c.z0 > W / 2;
    const fz0 = m ? c.z0 + W - 4.72 : c.z0 + 4.02;
    pts.push({ name: `${c.projectId} stair foot`, x: s * 17.5, z: fz0 + 0.35 });
    pts.push({
      name: `${c.projectId} technician`,
      x: c.technician.x,
      z: c.technician.z,
    });
    pts.push({
      name: `${c.projectId} layout stair foot`,
      x: c.stair.bottom.x,
      z: c.stair.bottom.z,
    });
    pts.push({
      name: `${c.projectId} bench`,
      x: c.bench.x - s * 0.9,
      z: c.bench.z,
    });
  }
  return pts;
}

describe.each([6, 10, 4])("factory floor colliders (n=%i)", (n) => {
  const b = demo(n);
  const { fl, boxes, equipment, stations } = floorColliders(b);

  it("blocks every belt along its whole length", () => {
    expect(equipment.length).toBeGreaterThan(fl.cells.length * 8);
    for (const c of fl.cells)
      for (const l of c.lanes) {
        // Walk the lane centre line from the intake to the trunk.
        const s = c.side === "east" ? 1 : -1;
        for (let x = 30.5; x > 9.2; x -= 0.25)
          expect(blocked(equipment, s * x, l.z, fl.floorY, 0.05)).toBe(true);
        // ... and just off the belt edge (0.45 + capsule 0.3) it is blocked
        // for a standing capsule.
        expect(blocked(equipment, s * 20, l.z + 0.7, fl.floorY, 0.3)).toBe(
          true,
        );
      }
    // Main line and each trunk.
    for (
      let z = fl.mainLine.z1 - 1;
      z > Math.min(...fl.cells.map((c) => c.trunk.feederZ));
      z -= 0.5
    )
      expect(blocked(equipment, 0, z, fl.floorY, 0.05)).toBe(true);
    for (const c of fl.cells)
      for (let z = c.trunk.feederZ + 1.5; z < c.trunk.z1 - 0.5; z += 0.5)
        expect(blocked(equipment, c.trunk.x, z, fl.floorY, 0.05)).toBe(true);
  });

  it("blocks station pedestals, intake racks and the bench", () => {
    for (const st of stations.slice(0, 12)) {
      // Pedestal at local (0.42, −0.87): world z = st.z ± 0.87.
      const c = Math.cos(st.yaw);
      const sn = Math.sin(st.yaw);
      const px = st.x + 0.42 * c + -0.87 * sn;
      const pz = st.z - 0.42 * sn + -0.87 * c;
      expect(blocked(equipment, px, pz, fl.floorY, 0.05)).toBe(true);
    }
    for (const c of fl.cells) {
      const s = c.side === "east" ? 1 : -1;
      expect(blocked(equipment, c.bench.x, c.bench.z, fl.floorY, 0.05)).toBe(
        true,
      );
      expect(blocked(equipment, s * 32.85, c.lanes[0].z, fl.floorY, 0.05)).toBe(
        true,
      );
    }
  });

  it("every cell, spine-stair foot and the dock are reachable from the factory door", () => {
    // Belts split the floor into bays; the loading aisle along the outer
    // wall joins every cell's entry bay, and one step-over crossover per
    // feeder joins the central strips (spine-stair feet). Flood from the
    // door, then across every crossover whose other foot is reached, until
    // nothing new is added.
    const pts = pointsOfInterest(fl);
    const get = (name: string) => pts.find((p) => p.name === name)!;
    const starts: { x: number; z: number }[] = [get("factory door")];
    let r = reach(boxes, fl, starts);
    for (let pass = 0; pass < fl.crossovers.length + 1; pass++) {
      let grew = false;
      for (const x of fl.crossovers) {
        const [a, c] = x.feet;
        const ra = r.reached(a);
        const rc = r.reached(c);
        if (ra !== rc) {
          starts.push(ra ? c : a);
          grew = true;
        }
      }
      if (!grew) break;
      r = reach(boxes, fl, starts);
    }
    const missing = pts.filter((p) => !r.reached(p)).map((p) => p.name);
    expect(missing).toEqual([]);
    for (const x of fl.crossovers)
      for (const f of x.feet) expect(r.reached(f)).toBe(true);
  });

  it("never strands the player: every floor region keeps a way out", () => {
    // Each cell is usable from its stair, the door reaches the dock and the
    // first cell on each side, and every spine-stair foot leads to another
    // exit without the crossovers too.
    const pts = pointsOfInterest(fl);
    const get = (name: string) => pts.find((p) => p.name === name)!;
    const door = get("factory door");
    const fromDoor = reach(boxes, fl, door);
    expect(fromDoor.reached(get("dock stair foot"))).toBe(true);
    for (const side of ["east", "west"] as const) {
      const first = fl.cells
        .filter((c) => c.side === side)
        .sort((a, b2) => a.z0 - b2.z0)[0];
      if (first)
        expect(fromDoor.reached(get(`${first.projectId} stair foot`))).toBe(
          true,
        );
    }
    for (const c of fl.cells) {
      const r = reach(boxes, fl, get(`${c.projectId} stair foot`));
      expect(r.reached(get(`${c.projectId} technician`))).toBe(true);
    }
    const exits = pts.filter(
      (p) => p.name.endsWith("stair foot") || p.name === "factory door",
    );
    for (const st of fl.spineStairs) {
      const foot = get(st.id);
      const r = reach(boxes, fl, foot);
      expect(r.reached(foot)).toBe(true);
      expect(exits.filter((e) => r.reached(e)).length).toBeGreaterThan(0);
    }
  });

  it("rebuilds the group only when the boxes change", () => {
    let disposed = 0;
    let added = 0;
    const sink = {
      addBox: () => {
        added += 1;
      },
      disposeGroup: (g: string) => {
        expect(g).toBe(FACTORY_EQUIPMENT_GROUP);
        disposed += 1;
      },
    };
    syncFactoryColliders(sink, fl, stations);
    syncFactoryColliders(sink, fl, stations);
    expect(disposed).toBe(1);
    expect(added).toBe(factoryColliderBoxes(fl, stations).length);
    syncFactoryColliders(sink, fl, stations.slice(1));
    expect(disposed).toBe(2);
  });
});
