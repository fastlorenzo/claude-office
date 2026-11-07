import { describe, expect, it } from "vitest";
import {
  LAYOUT,
  type BuildingLayout,
  type ProjectSlot,
  type Vec3,
} from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  BALCONY_D,
  demandSpan,
  generateLayout,
  GLASS_FLOOR_W,
  podCapacityFor,
  projectOfSession,
  roomAt,
  roomSizeFor,
  roomSpanFor,
} from "@/engine/layout/buildingLayout";

const EPS = 1e-6;
const inside = (b: { min: Vec3; max: Vec3 }, p: { x: number; z: number }) =>
  p.x >= b.min.x - EPS &&
  p.x <= b.max.x + EPS &&
  p.z >= b.min.z - EPS &&
  p.z <= b.max.z + EPS;
const overlap = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }) =>
  a.min.x < b.max.x - EPS &&
  b.min.x < a.max.x - EPS &&
  a.min.z < b.max.z - EPS &&
  b.min.z < a.max.z - EPS;

/** 3 projects with 3 / 2 / 1 sessions (the demo shape). */
const GROUPS = [
  { id: "continuum", name: "continuum", sessionIds: ["c0", "c1", "c2"] },
  { id: "payments", name: "payments-api", sessionIds: ["p0", "p1"] },
  { id: "office", name: "claude-office", sessionIds: ["o0"] },
];
const req = (g: typeof GROUPS) =>
  g.map((x, i) => ({ id: x.id, createdAt: i, sessions: x.sessionIds.length }));

function demoLayout(): BuildingLayout {
  const slots = allocateSlots(new Map(), req(GROUPS));
  return generateLayout(slots, GROUPS, allocatePods(new Map(), GROUPS));
}

describe("room sizing", () => {
  it("scales with the session count", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(roomSizeFor)).toEqual([
      "standard",
      "standard",
      "large",
      "large",
      "wing",
      "wing",
      "wing",
    ]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(podCapacityFor)).toEqual([
      2, 2, 4, 4, 6, 6, 8, 8,
    ]);
    expect(roomSpanFor(1)).toBe(3);
    expect(roomSpanFor(3)).toBe(5);
    expect(roomSpanFor(5)).toBe(7);
  });

  it("honours spanFor demand up to the wing size", () => {
    expect(demandSpan("x", 1, { spanFor: () => 3 })).toBe(5);
    expect(demandSpan("x", 1, { spanFor: () => 40 })).toBe(7);
    expect(demandSpan("x", 3, { spanFor: () => 1 })).toBe(5);
    expect(demandSpan("x", 8, { spanFor: () => 2 })).toBe(9); // sessions always fit
    const slots = allocateSlots(
      new Map(),
      [{ id: "busy", createdAt: 0, sessions: 1 }],
      { spanFor: (id) => (id === "busy" ? 4 : 0) },
    );
    expect(slots.get("busy")?.span).toBe(5);
  });
});

describe("allocateSlots", () => {
  it("places rooms on both sides, entry bays from the lobby", () => {
    const slots = allocateSlots(new Map(), req(GROUPS));
    const c = slots.get("continuum")!;
    const p = slots.get("payments")!;
    const o = slots.get("office")!;
    expect(c).toEqual({ index: 0, side: "east", bay: 0, span: 5 });
    expect(p).toEqual({ index: 1, side: "west", bay: 0, span: 3 });
    expect(o.side).toBe("west");
    expect(o.bay).toBe(3);
  });

  it("keeps slots stable across reorder and unrelated changes", () => {
    const first = allocateSlots(new Map(), req(GROUPS));
    const again = allocateSlots(first, [...req(GROUPS)].reverse());
    expect(again).toEqual(first);
    const without = allocateSlots(
      first,
      req(GROUPS).filter((r) => r.id !== "payments"),
    );
    expect(without.get("continuum")).toEqual(first.get("continuum"));
    expect(without.get("office")).toEqual(first.get("office"));
  });

  it("grows in place when free, else relocates only that room", () => {
    const first = allocateSlots(new Map(), req(GROUPS));
    // office (1 → 3 sessions) grows past its end: west bays 6.. are free.
    const grown = allocateSlots(first, [
      ...req(GROUPS).filter((r) => r.id !== "office"),
      { id: "office", createdAt: 2, sessions: 3 },
    ]);
    expect(grown.get("office")).toEqual({ ...first.get("office")!, span: 5 });
    expect(grown.get("continuum")).toEqual(first.get("continuum"));
    // payments (2 → 3) is blocked by office right after it: it moves, alone.
    const blocked = allocateSlots(first, [
      ...req(GROUPS).filter((r) => r.id !== "payments"),
      { id: "payments", createdAt: 1, sessions: 3 },
    ]);
    expect(blocked.get("continuum")).toEqual(first.get("continuum"));
    expect(blocked.get("office")).toEqual(first.get("office"));
    const moved = blocked.get("payments")!;
    expect(moved.span).toBe(5);
    expect(moved.index).toBe(first.get("payments")!.index);
    expect(moved).not.toEqual({ ...first.get("payments")!, span: 5 });
  });

  it("shrinks in place and frees the tail", () => {
    const first = allocateSlots(new Map(), req(GROUPS));
    const shrunk = allocateSlots(first, [
      { id: "continuum", createdAt: 0, sessions: 1 },
      ...req(GROUPS).slice(1),
    ]);
    expect(shrunk.get("continuum")).toEqual({
      ...first.get("continuum")!,
      span: 3,
    });
  });

  it("never overlaps runs on a side", () => {
    let prev = new Map<string, ProjectSlot>();
    for (let step = 0; step < 30; step++) {
      const reqs = Array.from({ length: 1 + (step % 7) }, (_, i) => ({
        id: `p${(i * 3 + step) % 9}`,
        createdAt: (i * 3 + step) % 9,
        sessions: 1 + ((i + step) % 6),
      })).filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
      prev = allocateSlots(prev, reqs);
      const used = new Set<string>();
      for (const s of prev.values())
        for (let b = s.bay; b < s.bay + s.span; b++) {
          const k = `${s.side}:${b}`;
          expect(used.has(k)).toBe(false);
          used.add(k);
        }
      for (const r of reqs)
        expect(prev.get(r.id)!.span).toBe(roomSpanFor(r.sessions));
    }
  });

  it("respects a hall overlook side", () => {
    const slots = allocateSlots(new Map(), req(GROUPS), {
      hallOverlook: "west",
    });
    for (const s of slots.values()) expect(s.side).toBe("east");
  });
});

describe("allocatePods", () => {
  it("keeps pods stable and compacts only when needed", () => {
    const first = allocatePods(new Map(), GROUPS);
    expect(GROUPS[0].sessionIds.map((s) => first.get(s))).toEqual([0, 1, 2]);
    // c0 leaves: c1, c2 keep their pods (capacity 4 → still fits? no: 2 → cap 2)
    const g2 = [{ ...GROUPS[0], sessionIds: ["c1", "c2"] }];
    const next = allocatePods(first, g2);
    expect(next.get("c1")).toBe(1);
    expect(next.get("c2")).toBe(0); // pod 2 ≥ capacity 2 → lowest free
    const g3 = [{ ...GROUPS[0], sessionIds: ["c1", "c2", "c3"] }];
    const n3 = allocatePods(next, g3);
    expect(n3.get("c1")).toBe(1);
    expect(n3.get("c2")).toBe(0);
    expect(n3.get("c3")).toBe(2);
  });
});

describe("generateLayout", () => {
  const layout = demoLayout();

  it("has one room per project with one pod per session", () => {
    expect(layout.projects).toHaveLength(3);
    expect(layout.rooms).toHaveLength(6);
    const c = layout.projects.find((p) => p.projectId === "continuum")!;
    expect(c.sizeClass).toBe("large");
    expect(c.capacity).toBe(4);
    expect(c.pods.map((p) => p.sessionId)).toEqual(["c0", "c1", "c2"]);
    expect(c.podBays.map((b) => b.occupied)).toEqual([true, true, true, false]);
    expect(c.dividers).toHaveLength(4);
    expect(projectOfSession(layout, "p1")?.projectId).toBe("payments");
    expect(generateLayout(new Map()).bays).toBe(LAYOUT.MIN_BAYS);
  });

  it("rooms never overlap each other or the hall", () => {
    const hallHalf = LAYOUT.HALL_W / 2;
    for (const r of layout.projects) {
      if (r.slot.side === "east")
        expect(r.bounds.min.x).toBeGreaterThanOrEqual(hallHalf - EPS);
      else expect(r.bounds.max.x).toBeLessThanOrEqual(-hallHalf + EPS);
      expect(r.bounds.min.z).toBeGreaterThanOrEqual(-EPS);
      expect(r.bounds.max.z).toBeLessThanOrEqual(layout.hall.length + EPS);
    }
    for (const a of layout.projects)
      for (const b of layout.projects)
        if (a !== b) expect(overlap(a.bounds, b.bounds)).toBe(false);
    for (const a of layout.rooms)
      for (const b of layout.rooms)
        if (a !== b) expect(overlap(a.bounds, b.bounds)).toBe(false);
  });

  it("keeps every pod, desk, seat and walking point inside its pod / room", () => {
    for (const r of layout.projects) {
      expect(inside(r.bounds, r.door)).toBe(true);
      expect(inside(r.bounds, r.doorInside)).toBe(true);
      expect(inside(r.bounds, r.doorOutside)).toBe(false);
      for (const pod of r.pods) {
        expect(inside(r.bounds, pod.bounds.min)).toBe(true);
        expect(inside(r.bounds, pod.bounds.max)).toBe(true);
        const pts: Vec3[] = [
          pod.bossDesk.position,
          pod.bossDesk.seat,
          pod.bossDesk.approach,
          pod.whiteboard.position,
          pod.sign.position,
        ];
        for (const d of pod.desks)
          pts.push(d.position, d.seat, d.approach, d.monitor.position);
        expect(pod.desks).toHaveLength(8);
        for (const p of pts) expect(inside(pod.bounds, p)).toBe(true);
        // Nothing in the circulation strip but the walking spine itself.
        const fromGlass = (p: Vec3) => Math.abs(p.x) - LAYOUT.HALL_W / 2;
        for (const d of pod.desks)
          expect(fromGlass(d.approach)).toBeGreaterThan(LAYOUT.CORRIDOR_W);
        expect(fromGlass(pod.origin)).toBeCloseTo(LAYOUT.CORRIDOR_W / 2);
        expect(fromGlass(r.doorInside)).toBeCloseTo(LAYOUT.CORRIDOR_W / 2);
      }
    }
  });

  it("faces the lead toward its bench and the bench toward each other", () => {
    for (const pod of layout.rooms) {
      const out = pod.slot.side === "east" ? 1 : -1; // into the room
      // Lead faces back toward the bench / glass front.
      expect(Math.sin(pod.bossDesk.yaw)).toBeCloseTo(-out, 5);
      for (const d of pod.desks) {
        // Bench desks face along the hall (±z), toward the bench centre line.
        expect(Math.abs(Math.cos(d.yaw))).toBeCloseTo(1, 5);
        const toCentre = pod.origin.z - d.seat.z;
        expect(Math.sign(Math.cos(d.yaw))).toBe(Math.sign(toCentre));
      }
    }
  });

  it("exposes the factory fields (footprint, outer, balcony, glass floor, columns)", () => {
    for (const r of layout.projects) {
      const s = r.slot.side === "east" ? 1 : -1;
      const { ROOM_W, HALL_W, ROOM_D } = LAYOUT;
      expect(r.entryBay).toBe(r.slot.bay);
      expect(r.span).toBe(r.slot.span);
      expect(r.footprint).toEqual({
        x0: s * (HALL_W / 2),
        x1: s * (HALL_W / 2 + ROOM_D),
        z0: r.slot.bay * ROOM_W,
        z1: (r.slot.bay + r.slot.span) * ROOM_W,
      });
      expect(r.outer.x).toBe(r.footprint.x1);
      expect(Math.sin(r.outer.yaw)).toBeCloseTo(s);
      expect(r.balcony.x1 - r.balcony.x0).toBeCloseTo(s * BALCONY_D);
      expect(r.balcony.door.x).toBe(r.footprint.x1);
      expect(r.balcony.door.z).toBeGreaterThan(r.footprint.z0);
      expect(r.balcony.door.z).toBeLessThan(r.footprint.z0 + ROOM_W);
      expect(r.glassFloor.x1).toBe(r.footprint.x1);
      expect(r.glassFloor.x1 - r.glassFloor.x0).toBeCloseTo(s * GLASS_FLOOR_W);
      expect(r.columns).toHaveLength((r.span + 1) * 2);
      for (const c of r.columns) {
        expect(c.y).toBe(0);
        expect([r.footprint.x0, r.footprint.x1]).toContain(c.x);
        expect((c.z / ROOM_W) % 1).toBeCloseTo(0);
      }
      for (const [x, z] of [
        [r.footprint.x0, r.footprint.z0],
        [r.footprint.x1, r.footprint.z1],
      ])
        expect(r.columns.some((c) => c.x === x && c.z === z)).toBe(true);
      expect(r.overlook).not.toBeNull();
    }
  });

  it("lists free runs as empty slots and sizes the control room", () => {
    // west: payments 0..2, office 3..5; east: continuum 0..4 → hall 6 bays.
    expect(layout.bays).toBe(6);
    expect(layout.emptySlots).toEqual([
      { index: -1, side: "east", bay: 5, span: 1 },
    ]);
    const c = layout.controlRoom;
    expect(c.size.x).toBeGreaterThanOrEqual(20);
    expect(c.size.z).toBeGreaterThanOrEqual(18);
    expect(c.door.x).toBe(0);
    expect(c.door.z).toBe(layout.hall.length);
    expect(c.origin.z - c.size.z / 2).toBeCloseTo(layout.hall.length);
  });

  it("classifies zones with the project and the pod under the player", () => {
    const c = layout.projects.find((p) => p.projectId === "continuum")!;
    const pod = c.pods[1];
    expect(roomAt(layout, pod.bossDesk.seat)).toEqual({
      kind: "room",
      sessionId: pod.sessionId,
      projectId: "continuum",
    });
    expect(roomAt(layout, c.doorInside)).toEqual({
      kind: "room",
      sessionId: c.pods[0].sessionId,
      projectId: "continuum",
    });
    expect(roomAt(layout, c.doorOutside)).toEqual({ kind: "hall" });
    expect(roomAt(layout, layout.lobby.spawn)).toEqual({ kind: "lobby" });
    expect(roomAt(layout, layout.controlRoom.spawn)).toEqual({
      kind: "control",
    });
    expect(roomAt(layout, { x: 100, z: 5 })).toEqual({ kind: "outside" });
    expect(roomAt(layout, { x: 0, z: -50 })).toEqual({ kind: "outside" });
  });

  it("keeps pods in place when the room grows", () => {
    const g2 = GROUPS.map((g) =>
      g.id === "office" ? { ...g, sessionIds: ["o0", "o1", "o2"] } : g,
    );
    const first = allocateSlots(new Map(), req(GROUPS));
    const pods1 = allocatePods(new Map(), GROUPS);
    const a = generateLayout(first, GROUPS, pods1);
    const slots2 = allocateSlots(first, req(g2));
    const b = generateLayout(slots2, g2, allocatePods(pods1, g2));
    const before = a.rooms.find((r) => r.sessionId === "o0")!;
    const after = b.rooms.find((r) => r.sessionId === "o0")!;
    expect(after.slot).toEqual(before.slot);
    expect(after.bossDesk).toEqual(before.bossDesk);
  });
});

describe("P1.1 openings (elevated spine, stair wells, balconies)", () => {
  // Imported lazily: architecture.ts pulls in the Babylon barrel.
  const load = async () => ({
    ...(await import("@/engine/world/architecture")),
    ...(await import("@/engine/layout/factoryLayout")),
  });
  const area = (r: { x0: number; x1: number; z0: number; z1: number }) =>
    (r.x1 - r.x0) * (r.z1 - r.z0);
  const hit = (
    a: { x0: number; x1: number; z0: number; z1: number },
    b: { x0: number; x1: number; z0: number; z1: number },
  ) =>
    a.x0 < b.x1 - EPS &&
    b.x0 < a.x1 - EPS &&
    a.z0 < b.z1 - EPS &&
    b.z0 < a.z1 - EPS;

  it("rectMinusHoles tiles the floor around the openings exactly", async () => {
    const { rectMinusHoles } = await load();
    const r = { x0: -3.5, x1: 3.5, z0: 0, z1: 40 };
    const holes = [
      { x0: -0.8, x1: 0.8, z0: 0, z1: 36 },
      { x0: 2.3, x1: 3.5, z0: 6.4, z1: 12.8 },
      { x0: -3.5, x1: -2.3, z0: 25.6, z1: 32 },
      { x0: -3.5, x1: 3.5, z0: 36, z1: 40 },
    ];
    const out = rectMinusHoles(r, holes);
    const sum = out.reduce((a, p) => a + area(p), 0);
    expect(sum).toBeCloseTo(area(r) - holes.reduce((a, h) => a + area(h), 0));
    for (const p of out) for (const h of holes) expect(hit(p, h)).toBe(false);
    for (const p of out)
      for (const q of out) if (p !== q) expect(hit(p, q)).toBe(false);
    // Overlapping / out-of-range holes are clipped, not double counted.
    const o = rectMinusHoles({ x0: 0, x1: 2, z0: 0, z1: 2 }, [
      { x0: -1, x1: 1, z0: -1, z1: 1 },
      { x0: 0.5, x1: 1.5, z0: 0.5, z1: 3 },
    ]);
    expect(o.reduce((a, p) => a + area(p), 0)).toBeCloseTo(4 - 1 - 1.25);
  });

  it("stair wells sit in the hall, clear of the glass strip and of room doors", async () => {
    const { buildFactoryLayout } = await load();
    const SPINE_GLASS_W = 1.6; // Building.SPINE_GLASS_W
    const layout = demoLayout();
    const f = buildFactoryLayout(layout);
    expect(f.spineStairs.length).toBeGreaterThan(0);
    const strip = {
      x0: -SPINE_GLASS_W / 2,
      x1: SPINE_GLASS_W / 2,
      z0: 0,
      z1: layout.hall.length,
    };
    for (const s of f.spineStairs) {
      expect(Math.abs(s.rect.x0)).toBeLessThanOrEqual(LAYOUT.HALL_W / 2 + EPS);
      expect(Math.abs(s.rect.x1)).toBeLessThanOrEqual(LAYOUT.HALL_W / 2 + EPS);
      expect(s.rect.z1).toBeLessThanOrEqual(layout.hall.length);
      expect(hit(s.rect, strip)).toBe(false);
      for (const r of layout.projects) {
        const d = r.doorOutside;
        const doorZone = {
          x0: d.x - 0.7,
          x1: d.x + 0.7,
          z0: d.z - 1,
          z1: d.z + 1,
        };
        expect(hit(s.rect, doorZone)).toBe(false);
      }
    }
    // The lobby well is inside the lobby, clear of the hall portal.
    const lh = f.lobbyStair.rect;
    expect(lh.z1).toBeLessThan(0);
    expect(lh.z0).toBeGreaterThan(-LAYOUT.LOBBY_D);
    expect(Math.abs(lh.x1)).toBeGreaterThan(LAYOUT.HALL_W / 2);
  });

  it("every room has a walk-through balcony door at its entry bay", () => {
    const layout = demoLayout();
    for (const r of layout.projects) {
      const s = r.slot.side === "east" ? 1 : -1;
      const b = r.balcony;
      expect(b.door.x).toBe(r.outer.x);
      // Door on the entry bay, clear of the bay edges (pier + frame).
      expect(b.door.z - 0.7).toBeGreaterThan(r.footprint.z0 + 0.12);
      expect(b.door.z + 0.7).toBeLessThan(
        r.footprint.z0 + LAYOUT.ROOM_W - 0.12,
      );
      // Deck beyond the 0.2 m curtain wall is at least 1 m deep.
      expect(s * (b.x1 - b.x0) - 0.2).toBeGreaterThanOrEqual(1 - EPS);
      // The glass strip abuts the outer glazing (walkable, see-through).
      expect(r.glassFloor.x1).toBe(b.x0);
    }
  });
});
