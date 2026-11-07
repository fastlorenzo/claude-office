import { describe, expect, it } from "vitest";
import { LAYOUT, type RoomSlot, type Vec3 } from "@/engine/contracts";
import {
  allocateSlots,
  generateLayout,
  roomAt,
} from "@/engine/layout/buildingLayout";

const mk = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, createdAt: 1000 + i }));
const EPS = 1e-6;
const inside = (b: { min: Vec3; max: Vec3 }, p: Vec3) =>
  p.x >= b.min.x - EPS &&
  p.x <= b.max.x + EPS &&
  p.z >= b.min.z - EPS &&
  p.z <= b.max.z + EPS;

describe("allocateSlots", () => {
  it("alternates sides and increments bays", () => {
    const m = allocateSlots(new Map(), mk(5));
    expect([...m.values()].map((s) => s.side)).toEqual([
      "east",
      "west",
      "east",
      "west",
      "east",
    ]);
    expect(m.get("s4")).toEqual({ index: 4, side: "east", bay: 2 });
  });

  it("keeps slots across reorder/add and reuses the lowest freed index", () => {
    const first = allocateSlots(new Map(), mk(3));
    const reordered = allocateSlots(first, [...mk(3)].reverse());
    expect(reordered).toEqual(first);
    const removed = allocateSlots(
      first,
      mk(3).filter((s) => s.id !== "s1"),
    );
    expect(removed.has("s1")).toBe(false);
    expect(removed.get("s2")).toEqual(first.get("s2"));
    const added = allocateSlots(removed, [
      ...mk(3).filter((s) => s.id !== "s1"),
      { id: "new", createdAt: 5000 },
    ]);
    expect(added.get("new")?.index).toBe(1);
    expect(added.get("s0")).toEqual(first.get("s0"));
  });
});

describe("generateLayout", () => {
  const slots = allocateSlots(new Map(), mk(6));
  const layout = generateLayout(slots);

  it("has min bays and emptySlots", () => {
    expect(generateLayout(new Map()).bays).toBe(LAYOUT.MIN_BAYS);
    expect(generateLayout(new Map()).emptySlots).toHaveLength(
      LAYOUT.MIN_BAYS * 2,
    );
    const one = generateLayout(allocateSlots(new Map(), mk(1)));
    expect(one.emptySlots.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(layout.bays).toBe(3);
    expect(layout.emptySlots).toHaveLength(0);
  });

  it("rooms do not overlap each other or the hall", () => {
    const hallHalf = LAYOUT.HALL_W / 2;
    for (const r of layout.rooms) {
      if (r.slot.side === "east")
        expect(r.bounds.min.x).toBeGreaterThanOrEqual(hallHalf - EPS);
      else expect(r.bounds.max.x).toBeLessThanOrEqual(-hallHalf + EPS);
      expect(r.bounds.max.z).toBeLessThanOrEqual(layout.hall.length + EPS);
      expect(r.bounds.min.z).toBeGreaterThanOrEqual(-EPS);
    }
    for (const a of layout.rooms)
      for (const b of layout.rooms) {
        if (a === b) continue;
        const ox =
          a.bounds.min.x < b.bounds.max.x - EPS &&
          b.bounds.min.x < a.bounds.max.x - EPS;
        const oz =
          a.bounds.min.z < b.bounds.max.z - EPS &&
          b.bounds.min.z < a.bounds.max.z - EPS;
        expect(ox && oz).toBe(false);
      }
  });

  it("keeps desk, seat, aisle and door points inside the room", () => {
    for (const r of layout.rooms) {
      const pts: Vec3[] = [
        r.doorInside,
        r.door,
        ...r.aisle,
        r.bossDesk.position,
        r.bossDesk.seat,
        r.bossDesk.approach,
      ];
      for (const d of r.desks)
        pts.push(d.position, d.seat, d.approach, d.monitor.position);
      expect(r.desks).toHaveLength(8);
      for (const p of pts) expect(inside(r.bounds, p)).toBe(true);
      expect(inside(r.bounds, r.doorOutside)).toBe(false);
    }
  });

  it("faces the boss desk and the door correctly", () => {
    for (const r of layout.rooms) {
      const toDoor = {
        x: r.doorInside.x - r.bossDesk.position.x,
        z: r.doorInside.z - r.bossDesk.position.z,
      };
      expect(Math.sin(r.bossDesk.yaw)).toBeCloseTo(Math.sign(toDoor.x) || 0, 5);
      const hallDir = r.slot.side === "east" ? -1 : 1;
      expect(Math.sin(r.desks[0].yaw)).toBeCloseTo(-hallDir, 5); // faces away from hall
      expect(Math.sin(r.bossDesk.yaw)).toBeCloseTo(hallDir, 5);
    }
  });

  it("classifies zones", () => {
    const r = layout.rooms[1];
    expect(roomAt(layout, r.origin)).toEqual({
      kind: "room",
      sessionId: r.sessionId,
    });
    expect(roomAt(layout, r.doorInside)).toEqual({
      kind: "room",
      sessionId: r.sessionId,
    });
    expect(roomAt(layout, r.doorOutside)).toEqual({ kind: "hall" });
    expect(roomAt(layout, layout.lobby.spawn)).toEqual({ kind: "lobby" });
    expect(roomAt(layout, layout.controlRoom.spawn)).toEqual({
      kind: "control",
    });
    expect(roomAt(layout, { x: 100, z: 5 })).toEqual({ kind: "outside" });
    expect(roomAt(layout, { x: 0, z: -50 })).toEqual({ kind: "outside" });
  });

  it("allocates slots in the expected places", () => {
    const e = layout.rooms.find((r) => r.slot.index === 0)!;
    const w = layout.rooms.find((r) => r.slot.index === 1)!;
    expect(e.origin.x).toBeGreaterThan(0);
    expect(w.origin.x).toBeLessThan(0);
    expect(e.origin.z).toBeCloseTo(w.origin.z);
    const s: RoomSlot = layout.emptySlots[0] ?? e.slot;
    expect(s).toBeDefined();
  });
});
