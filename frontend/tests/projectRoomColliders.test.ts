/** WS2 G1: project-room end walls stop the player (no walk-through, no drop). */
import { describe, expect, it } from "vitest";
import { Vector3 } from "@/engine/babylon";
import { LAYOUT } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { endWallBoxes } from "@/engine/world/projectRoomColliders";
import { blocked, recorder } from "./helpers/colliderBoxes";

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

describe.each([1, 4, 6, 8, 12])("project-room end walls (n=%i)", (n) => {
  const b = demo(n);

  it("two full-height walls across the whole room depth per room", () => {
    for (const room of b.projects) {
      const walls = endWallBoxes(room);
      expect(walls).toHaveLength(2);
      const { x0, x1, z0, z1 } = room.footprint;
      expect(walls.map((w) => w.center.z)).toEqual([z0 + 0.05, z1 - 0.05]);
      for (const w of walls) {
        const lo = Math.abs(w.center.x) - w.size.x / 2;
        const hi = Math.abs(w.center.x) + w.size.x / 2;
        expect(lo).toBeLessThanOrEqual(Math.min(Math.abs(x0), Math.abs(x1)));
        // Into the outer curtain wall (0.2 m outside the glazing line).
        expect(hi).toBeGreaterThanOrEqual(
          Math.max(Math.abs(x0), Math.abs(x1)) + 0.2 - 1e-9,
        );
        expect(w.center.y - w.size.y / 2).toBeLessThanOrEqual(0);
        expect(w.center.y + w.size.y / 2).toBeGreaterThanOrEqual(LAYOUT.WALL_H);
      }
    }
  });

  it("a capsule walking along the room hits each end wall everywhere", () => {
    const { sink, boxes } = recorder();
    for (const room of b.projects)
      for (const w of endWallBoxes(room))
        sink.addBox(
          "t",
          new Vector3(w.center.x, w.center.y, w.center.z),
          new Vector3(w.size.x, w.size.y, w.size.z),
        );
    for (const room of b.projects) {
      const { x0, x1, z0, z1 } = room.footprint;
      const s = Math.sign(x1 - x0);
      // Every 10 cm across the room's walkable depth (glass front → glazing).
      for (let d = 0.35; d <= Math.abs(x1 - x0) - 0.35; d += 0.1) {
        const x = x0 + s * d;
        for (const z of [z0, z1]) expect(blocked(boxes, x, z, 0)).toBe(true);
      }
    }
  });
});
