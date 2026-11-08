/** WS2 G5: the forecourt is walkable up to the fence the exterior draws. */
import { describe, expect, it } from "vitest";
import { Vector3 } from "@/engine/babylon";
import { LAYOUT } from "@/engine/contracts";
import { planExterior } from "@/engine/layout/exteriorPlan";
import { buildEntrance, FACTORY, FLOOR_Y } from "@/engine/layout/factoryLayout";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  exteriorPropBoxes,
  forecourtBoxes,
} from "@/engine/world/forecourtColliders";
import { blocked, recorder, surfaceY } from "./helpers/colliderBoxes";

const building = generateLayout(
  allocateSlots(new Map(), [{ id: "a", createdAt: 0, sessions: 2 }]),
  [{ id: "a", name: "a", sessionIds: ["s0", "s1"] }],
  allocatePods(new Map(), [{ id: "a", sessionIds: ["s0", "s1"] }]),
);
const e = buildEntrance(building);
// The footprint Exterior plans the park against (Exterior.footprint()).
const halfE = (LAYOUT.HALL_W + 2 * LAYOUT.ROOM_D) / 2;
const plan = planExterior({
  halfW: FACTORY.OUTER_X,
  zS: FACTORY.SOUTH_Z,
  zN: 80,
  entrance: { x0: -halfE, x1: halfE, z0: -LAYOUT.LOBBY_D, z1: FACTORY.SOUTH_Z },
});

function world() {
  const { sink, boxes } = recorder();
  for (const f of forecourtBoxes(e))
    sink.addBox(
      "f",
      new Vector3(f.center[0], f.center[1] + FLOOR_Y, f.center[2]),
      new Vector3(...f.size),
    );
  const props = exteriorPropBoxes(plan);
  for (const p of props)
    sink.addBox(
      "p",
      new Vector3(p.x, p.y, p.z),
      new Vector3(p.sx, p.sy, p.sz),
      p.yaw,
    );
  return { boxes, props };
}

describe("forecourt colliders", () => {
  const { boxes, props } = world();

  it("the invisible fence is the drawn fence", () => {
    const fence = boxes.find((b) => b.s.x > 100 && b.s.y > 1)!;
    expect(fence.c.z + fence.s.z / 2).toBeCloseTo(plan.fence.z0, 6);
    const side = boxes.filter((b) => b.s.x < 1 && b.s.z > 10);
    expect(side).toHaveLength(2);
    for (const b of side)
      expect(Math.abs(b.c.x) - b.s.x / 2).toBeCloseTo(plan.fence.x1, 6);
    expect(-plan.fence.x0).toBeCloseTo(plan.fence.x1, 9);
  });

  it("walk from the doors to the fence line (z ≤ −55) on solid ground", () => {
    for (let z = e.rect.z0 - 1; z >= -57; z -= 0.25) {
      expect(blocked(boxes, 0, z, FLOOR_Y)).toBe(false);
      expect(surfaceY(boxes, 0, z, 0)).toBeCloseTo(FLOOR_Y, 6);
    }
    expect(blocked(boxes, 0, plan.fence.z0 + 0.2, FLOOR_Y)).toBe(true);
    // The far corners of the car park are inside too.
    expect(blocked(boxes, -33, -47.5, FLOOR_Y)).toBe(false);
    expect(blocked(boxes, 60, -10, FLOOR_Y)).toBe(false);
  });

  it("parked cars and forecourt trees are solid", () => {
    expect(props.length).toBeGreaterThan(5);
    for (const c of plan.cars.slice(0, 10))
      expect(blocked(boxes, c.x, c.z, FLOOR_Y, 0.05)).toBe(true);
  });
});
