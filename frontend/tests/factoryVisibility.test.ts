import { describe, expect, it } from "vitest";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, zoneAt3 } from "@/engine/layout/factoryLayout";
import {
  FACTORY_IMPOSTOR_M,
  FACTORY_MAX_M,
  computeCellVisibility,
} from "@/engine/world/factoryVisibility";

const reqs = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  createdAt: i,
  sessions: 1,
}));
const building = generateLayout(
  allocateSlots(new Map(), reqs),
  reqs.map((r) => ({ id: r.id, sessionIds: [`${r.id}s`] })),
);
const factory = buildFactoryLayout(building);
const fwd = (deg: number) => ({
  x: Math.sin((deg * Math.PI) / 180),
  z: Math.cos((deg * Math.PI) / 180),
});
const run = (eye: [number, number, number], deg: number) => {
  const p = { x: eye[0], y: eye[1], z: eye[2] };
  return computeCellVisibility(
    factory,
    building,
    p,
    fwd(deg),
    zoneAt3(factory, building, p),
  );
};

describe("computeCellVisibility", () => {
  it("from a room only its own cell is full", () => {
    const own = factory.cells[0];
    const room = building.projects.find((p) => p.projectId === own.projectId)!;
    const v = run([room.origin.x, 1.7, room.origin.z], 90);
    expect(v.cells.get(own.projectId)).toBe("full");
    for (const [id, d] of v.cells)
      if (id !== own.projectId) expect(d).not.toBe("full");
    const opp = factory.cells.filter((c) => c.side !== own.side);
    expect(opp.every((c) => v.cells.get(c.projectId) === "hidden")).toBe(true);
    expect(v.mainLine).toBe("hidden");
    expect(v.dock).toBe("hidden");
  });

  it("from a room, same-side neighbours need the cone", () => {
    const own = factory.cells[0];
    const room = building.projects.find((p) => p.projectId === own.projectId)!;
    const s = own.side === "east" ? 1 : -1;
    const looking = run([room.origin.x, 1.7, room.origin.z], s * 90 + 45 * 0);
    const away = run([room.origin.x, 1.7, room.origin.z], -s * 90);
    const same = factory.cells.filter(
      (c) => c.side === own.side && c.projectId !== own.projectId,
    );
    expect(same.length).toBeGreaterThan(0);
    expect(
      same.some((c) => looking.cells.get(c.projectId) === "impostor"),
    ).toBe(true);
    expect(same.every((c) => away.cells.get(c.projectId) !== "full")).toBe(
      true,
    );
  });

  it("from the spine: main line full, cells within 2 bays impostor else hidden", () => {
    const z = 9.6;
    const v = run([0, 1.7, z], 0);
    expect(v.mainLine).toBe("full");
    for (const c of factory.cells) {
      const dz = Math.max(c.z0 - z, 0, z - c.z1);
      expect(v.cells.get(c.projectId)).toBe(dz <= 9.6 ? "impostor" : "hidden");
    }
    expect([...v.cells.values()].some((d) => d === "hidden")).toBe(true);
  });

  it("from the floor, cone and distance decide", () => {
    const z = 8;
    const ahead = run([0, -4.3, z], 0);
    const back = run([0, -4.3, z], 180);
    const far = factory.cells.filter((c) => c.z0 > z + FACTORY_IMPOSTOR_M + 2);
    const nearAhead = factory.cells.filter((c) => c.z0 > z && c.z0 < z + 10);
    expect(
      nearAhead.every((c) => ahead.cells.get(c.projectId) !== "hidden"),
    ).toBe(true);
    for (const c of far) expect(ahead.cells.get(c.projectId)).toBe("impostor");
    const behind = factory.cells.filter((c) => c.z1 < z - 10);
    for (const c of behind) expect(ahead.cells.get(c.projectId)).toBe("hidden");
    expect(back.cells.size).toBe(factory.cells.length);
  });

  it("the cell under the eye is full", () => {
    const c = factory.cells[1];
    const v = run([(c.rect.x0 + c.rect.x1) / 2, -4.3, (c.z0 + c.z1) / 2], 0);
    expect(v.cells.get(c.projectId)).toBe("full");
  });

  it("the tower cone: facing the floor sees it, facing away hides it", () => {
    const ctrlZ = building.controlRoom.origin.z;
    const facing = run([0, 1.7, ctrlZ], 180);
    const turned = run([0, 1.7, ctrlZ], 0);
    for (const c of factory.cells) {
      const dz = Math.max(ctrlZ - c.z1, 0);
      const d = facing.cells.get(c.projectId)!;
      if (dz > FACTORY_IMPOSTOR_M + 1 && d !== "hidden")
        expect(d).toBe("impostor");
      if (dz < FACTORY_IMPOSTOR_M - 1) expect(d).toBe("full");
    }
    expect(facing.mainLine).not.toBe("hidden");
    expect([...facing.cells.values()].some((d) => d !== "hidden")).toBe(true);
    // turned toward the dock: the dock is seen, cells behind are not
    expect(turned.dock).not.toBe("hidden");
    const behind = factory.cells.filter((c) => ctrlZ - c.z1 > 8);
    expect(behind.length).toBeGreaterThan(0);
    for (const c of behind)
      expect(turned.cells.get(c.projectId)).toBe("hidden");
    // distance split
    for (const c of factory.cells) {
      const d = facing.cells.get(c.projectId)!;
      const dist = ctrlZ - c.z1;
      if (dist > FACTORY_MAX_M + 6) expect(d).toBe("hidden");
    }
  });

  it("distance cut-offs", () => {
    const far = run([0, -4.3, -200], 0);
    for (const d of far.cells.values()) expect(d).toBe("hidden");
    expect(far.mainLine).toBe("hidden");
  });
});
