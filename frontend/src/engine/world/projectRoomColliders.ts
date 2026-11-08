/**
 * Room-level collider boxes of a project team room that the thin-instanced
 * prefabs (ProjectShell) cannot carry themselves (pure geometry).
 *
 * End walls: the `endWall` prefab draws a 0.1 m plaster partition across the
 * room depth at both ends (z0 + 0.05, z1 − 0.05). Without a collider the
 * player walked into the neighbouring room, or — past an empty bay — off the
 * slab edge and 6 m down onto the factory floor. The box runs from the
 * glass-front line through the outer curtain wall (which starts at the
 * outer glazing line), so no slit is left at either end.
 */
import type { ProjectRoomLayout } from "@/engine/contracts";
import { LAYOUT } from "@/engine/contracts";

/** Partition thickness (matches ProjectShell's end-wall prefab). */
export const END_WALL_T = 0.1;
/** Overlap into the outer curtain wall (Building's, 0.2 m thick). */
const INTO_OUTER = 0.2;

export interface PlanBox {
  center: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

export function endWallBoxes(layout: ProjectRoomLayout): PlanBox[] {
  const { x0, x1, z0, z1 } = layout.footprint;
  const s = Math.sign(x1 - x0) || 1;
  // Footprint x runs glass front (x0) → outer glazing (x1), signed by side.
  const xa = x0;
  const xb = x1 + s * INTO_OUTER;
  const H = LAYOUT.WALL_H;
  return [z0 + END_WALL_T / 2, z1 - END_WALL_T / 2].map((z) => ({
    center: { x: (xa + xb) / 2, y: H / 2, z },
    size: { x: Math.abs(xb - xa), y: H, z: END_WALL_T },
  }));
}
