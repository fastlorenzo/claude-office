/**
 * Zone of the free-fly camera. `zoneAt3` is a walking query: above y = 3.5 it
 * answers from x / z alone, so a camera flying over a project room (or over
 * the roof) was "in the room" and the room sightline gate hid the factory
 * hall, lobby and park "not visible from the room" behind it. A flying eye
 * above the office ceilings is in the factory volume (under the roof) or
 * outside (over it).
 */
import { LAYOUT, type BuildingLayout } from "@/engine/contracts";
import {
  FACTORY,
  zoneAt3,
  type FactoryLayout,
  type Zone3,
} from "@/engine/layout/factoryLayout";

/** Office ceilings + slab: above this a flying eye has left the rooms. */
export const FLY_ABOVE_ROOMS_Y = LAYOUT.WALL_H + 0.4;

export function flyZoneAt(
  layout: FactoryLayout,
  building: BuildingLayout,
  p: { x: number; y: number; z: number },
): Zone3 {
  if (p.y <= FLY_ABOVE_ROOMS_Y) return zoneAt3(layout, building, p);
  const b = layout.bounds;
  const inside =
    p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;
  return inside && p.y < FACTORY.ROOF_Y
    ? { kind: "factory" }
    : { kind: "outside" };
}
