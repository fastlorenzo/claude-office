/**
 * Forecourt colliders (G5), pure: the walkable yard in front of the entrance
 * now runs to the fence the exterior actually draws (exteriorPlan: the fence
 * stands 30 m outside the factory's side walls and 46 m in front of the
 * entrance façade) instead of an invisible line 12–30 m short of it that cut
 * the car park in half. North of the façade line it stops at the factory's
 * south wall (the yard beside / behind the factory is not walkable: the dock
 * doors there are only closed once the factory is built).
 *
 * Forecourt boxes are in the entrance's ground frame (y = 0 is the ground
 * floor); prop boxes (cars, trees in the forecourt) are in world space.
 */
import {
  GROUND_Y,
  treeRadius,
  type ExteriorPlan,
} from "@/engine/layout/exteriorPlan";
import { FACTORY, type EntranceLayout } from "@/engine/layout/factoryLayout";

/** Mirrors planExterior's fence: rect(-halfW-30, halfW+30, zF-46, …). */
export const FENCE = { outsideWalls: 30, beforeFacade: 46, height: 2.5 };

/** Collider group of the exterior props (cars, trees). */
export const EXTERIOR_PROPS_GROUP = "exteriorProps";

export interface PropBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

export interface ForecourtBox {
  center: [number, number, number];
  size: [number, number, number];
}

export function forecourtBoxes(
  e: EntranceLayout,
  halfW: number = FACTORY.OUTER_X,
): ForecourtBox[] {
  const hx = halfW + FENCE.outsideWalls;
  const z0 = e.rect.z0 - FENCE.beforeFacade;
  const z1 = e.rect.z1;
  const H = FENCE.height;
  const T = 0.2;
  const out: ForecourtBox[] = [
    // Ground slab (top at the ground floor level).
    { center: [0, -0.1, (z0 + z1) / 2], size: [hx * 2, 0.2, z1 - z0] },
    // Fence line (gates closed) and the two sides.
    { center: [0, H / 2, z0 - T / 2], size: [hx * 2 + 2 * T, H, T] },
  ];
  for (const s of [-1, 1]) {
    out.push({
      center: [s * (hx + T / 2), H / 2, (z0 + z1) / 2],
      size: [T, H, z1 - z0],
    });
    // Along the factory's south wall line, from its corner to the fence.
    out.push({
      center: [(s * (halfW + hx)) / 2, H / 2, z1 + T / 2],
      size: [hx - halfW, H, T],
    });
  }
  return out;
}

/** Cars, vans and tree trunks standing in the walkable forecourt. */
export function exteriorPropBoxes(plan: ExteriorPlan): PropBox[] {
  const g = GROUND_Y;
  const walk = {
    x0: plan.fence.x0,
    x1: plan.fence.x1,
    z0: plan.fence.z0,
    z1: plan.footprint.zS,
  };
  const inside = (x: number, z: number, m: number) =>
    x > walk.x0 - m && x < walk.x1 + m && z > walk.z0 - m && z < walk.z1 + m;
  const out: PropBox[] = [];
  for (const c of plan.cars) {
    const len = c.van ? 5.0 : 4.3;
    if (!inside(c.x, c.z, len)) continue;
    const h = c.van ? 1.95 : 1.42;
    // Exterior draws the body rotated by −yaw in Babylon terms.
    out.push({
      x: c.x,
      y: g + h / 2,
      z: c.z,
      sx: 1.8,
      sy: h,
      sz: len,
      yaw: -c.yaw,
    });
  }
  for (const t of plan.trees) {
    if (!inside(t.x, t.z, 1)) continue;
    const w = t.species === 2 ? treeRadius(t) : 0.45;
    const h = t.species === 2 ? Math.min(1.5, t.h) : 3;
    out.push({ x: t.x, y: g + h / 2, z: t.z, sx: w, sy: h, sz: w, yaw: 0 });
  }
  return out;
}
