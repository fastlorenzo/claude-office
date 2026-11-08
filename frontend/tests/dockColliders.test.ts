import { describe, expect, it } from "vitest";
import type { Vector3 } from "@/engine/babylon";
import type { ColliderBoxOpts, ColliderSink } from "@/engine/physics/Colliders";
import {
  DOCK,
  DOCK_STAIR,
  addDockColliders,
} from "@/engine/world/factory/Dock";

interface Box {
  c: Vector3;
  s: Vector3;
  pitch: number;
}

function collect(): Box[] {
  const out: Box[] = [];
  const sink: ColliderSink = {
    addBox: (_g, c, s, _yaw, o?: ColliderBoxOpts) =>
      out.push({ c, s, pitch: o?.pitch ?? 0 }),
  };
  addDockColliders(sink, "t");
  return out;
}

describe("dock colliders", () => {
  const boxes = collect();

  it("has a platform slab topping out at the platform height", () => {
    const slab = boxes.find((b) => b.s.x === DOCK.width && b.pitch === 0);
    expect(slab).toBeDefined();
    expect(slab!.c.y + slab!.s.y / 2).toBeCloseTo(DOCK.platformH, 6);
  });

  it("stair ramp is <= 35 deg and its top face is flush at both ends", () => {
    const ramp = boxes.find((b) => b.pitch !== 0)!;
    expect(Math.abs(ramp.pitch)).toBeLessThanOrEqual((35 * Math.PI) / 180);
    const th = Math.abs(ramp.pitch);
    // Top face point at a given z along the slope.
    const half = ramp.s.y / 2;
    const zc = ramp.c.z - Math.sin(th) * half;
    const yc = ramp.c.y + Math.cos(th) * half;
    // The +z end is the top: the face rises with +z.
    const topY = (z: number): number => yc + (z - zc) * Math.tan(th);
    expect(topY(-DOCK.depth)).toBeCloseTo(DOCK.platformH, 2);
    expect(topY(-DOCK.depth - DOCK_STAIR.run)).toBeCloseTo(0, 2);
  });
});
