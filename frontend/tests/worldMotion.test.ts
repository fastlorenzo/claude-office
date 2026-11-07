import { describe, expect, it } from "vitest";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import {
  PathFollower,
  buildPath,
  damp,
  dampAngle,
} from "@/engine/logic/motion";

const layout = generateLayout(
  allocateSlots(new Map(), [
    { id: "a", createdAt: 1 },
    { id: "b", createdAt: 2 },
  ]),
);

describe("motion", () => {
  for (const room of layout.rooms) {
    it(`builds paths in ${room.slot.side} room`, () => {
      for (let i = 0; i < 8; i++) {
        const p = buildPath(room, "outside", { desk: i });
        expect(p[0]).toEqual(room.doorOutside);
        expect(p[p.length - 1]).toEqual(room.desks[i].seat);
        for (let k = 1; k < p.length; k++) {
          expect(
            Math.hypot(
              p[k].x - p[k - 1].x,
              p[k].y - p[k - 1].y,
              p[k].z - p[k - 1].z,
            ),
          ).toBeGreaterThan(1e-6);
        }
      }
      const back = buildPath(room, { desk: 3 }, "outside");
      expect(back[0]).toEqual(room.desks[3].seat);
      expect(back[back.length - 1]).toEqual(room.doorOutside);
      const toBoss = buildPath(room, { desk: 0 }, "boss");
      expect(toBoss[toBoss.length - 1]).toEqual(room.bossDesk.approach);
    });
  }

  it("follower reaches the end with travel-direction yaw", () => {
    const room = layout.rooms[0];
    const path = buildPath(room, "outside", { desk: 0 });
    const f = new PathFollower(path);
    const total = f.remaining;
    expect(total).toBeGreaterThan(3);
    const first = f.update(0.1);
    expect(Math.sin(first.yaw)).toBeGreaterThan(0.9); // east room: hall -> room is +X
    let r = first;
    for (let i = 0; i < 1000 && !r.done; i++) r = f.update(0.05);
    expect(r.done).toBe(true);
    expect(r.position).toEqual(room.desks[0].seat);
    expect(f.remaining).toBe(0);
  });

  it("damps", () => {
    expect(damp(0, 10, 5, 100)).toBeCloseTo(10);
    expect(damp(0, 10, 5, 0)).toBe(0);
    // shortest arc from 3.0 to -3.0 goes through pi, so angle increases
    expect(dampAngle(3.0, -3.0, 5, 0.1)).toBeGreaterThan(3.0);
    expect(dampAngle(0, Math.PI * 2 + 0.1, 100, 1)).toBeCloseTo(0.1, 3);
  });
});
