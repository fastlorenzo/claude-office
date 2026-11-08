/**
 * Hall dressing (WS6 R12): exit signs hung over the spine's centre line and
 * fire points against the room glazing. Placed on the bay grid, clear of the
 * spine-stair wells and the wayfinding signs. Pure.
 */
import { LAYOUT, type BuildingLayout } from "@/engine/contracts";
import { DRESSING_DIMS } from "@/engine/assets/proceduralProps";
import { TOWER_BAY_D, type FactoryLayout } from "@/engine/layout/factoryLayout";
import { hallSigns } from "@/engine/world/wayfinding";
import { against, planExtent, type Piece } from "./piece";

export function hallPieces(
  fl: FactoryLayout,
  building: BuildingLayout,
): Piece[] {
  const out: Piece[] = [];
  const L = building.hall.length;
  const H = LAYOUT.WALL_H;
  const half = building.hall.width / 2;

  // Exit signs: hung from the ceiling, readable from both ends; skip a spot
  // within 0.8 m of a wayfinding sign's drop.
  const signZ = hallSigns(fl, H).map((s) => s.z);
  for (const z of [2.4, L - TOWER_BAY_D - 1.0]) {
    if (z < 1 || z > L - 0.5) continue;
    if (signZ.some((sz) => Math.abs(sz - z) < 0.8)) continue;
    out.push({
      role: "exitSign",
      x: 0,
      y: H - DRESSING_DIMS.exitSign.h,
      z,
      yaw: 0,
    });
  }

  // Fire points on the glazed fronts, one per two bays, alternating sides,
  // in the glass run between a room's door and the next bay's pier.
  const pitch = LAYOUT.ROOM_W;
  const wells = fl.spineStairs.map((s) => s.rect);
  let n = 0;
  for (let k = 0; (k + 1) * pitch < L - TOWER_BAY_D; k += 2) {
    const s = n++ % 2 === 0 ? 1 : -1;
    const z = k * pitch + 4.15;
    const a = against("fireExtinguisher", s * half, z, -s, 0, { gap: 0.03 });
    const p: Piece = { role: "fireExtinguisher", ...a, y: 0 };
    const ext = planExtent(p, 0.6);
    const hit = wells.some(
      (r) => ext.x1 > r.x0 && ext.x0 < r.x1 && ext.z1 > r.z0 && ext.z0 < r.z1,
    );
    if (!hit) out.push(p);
  }
  return out;
}
