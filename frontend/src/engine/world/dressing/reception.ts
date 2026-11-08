/**
 * Reception dressing (WS6 R12): the ground lobby the visitor arrives in (mat
 * well, visitor chairs under the directory wall, litter bins, a fire point)
 * and the reception on level 1 (visitor chairs, a bin). Pure: layout in,
 * pieces out.
 */
import type { BuildingLayout } from "@/engine/contracts";
import { ENTRANCE, type FactoryLayout } from "@/engine/layout/factoryLayout";
import { against, type Piece } from "./piece";

/** Lobby face of the shared (factory) wall incl. the slat feature cladding. */
const FEATURE_D = 0.03;

export function receptionPieces(
  fl: FactoryLayout,
  building: BuildingLayout,
): Piece[] {
  const e = fl.entrance;
  const out: Piece[] = [];
  const y = e.floorY;
  const zw = e.factoryDoor.z - ENTRANCE.WALL_T - FEATURE_D;

  // Mat well just inside the glazed doors (flat, no collider).
  out.push({
    role: "entranceMat",
    x: e.doors.x,
    y,
    z: e.rect.z0 + 0.8,
    yaw: 0,
    scale: [3.0, 1, 1.2],
  });

  // Visitor chairs against the north (directory) wall, clear of the door,
  // the directory board and the planters.
  for (const s of [-1, 1])
    for (const k of [0, 1, 2]) {
      const a = against("visitorChair", s * (4.6 + k * 0.65), zw, 0, -1, {
        gap: 0.05,
      });
      out.push({ role: "visitorChair", ...a, y });
    }
  for (const s of [-1, 1]) {
    // Fire point + a litter bin beside the factory door.
    const f = against("fireExtinguisher", s * 2.1, zw, 0, -1, { gap: 0.02 });
    if (s > 0) out.push({ role: "fireExtinguisher", ...f, y });
    const b = against("binIndustrial", s * 3.2, zw, 0, -1, {
      gap: 0.05,
      scale: 0.7,
    });
    out.push({ role: "binIndustrial", ...b, y, scale: 0.7 });
  }

  // Level 1 reception: visitor chairs in front of the desk wing, a bin by
  // the west wall (clear of the stair opening, the lift and the lounge).
  const up = 0;
  const halfW = building.lobby.size.x / 2;
  out.push(
    { role: "visitorChair", x: -6.5, y: up, z: -4.9, yaw: 0.15 },
    { role: "visitorChair", x: -5.75, y: up, z: -4.9, yaw: -0.1 },
    {
      role: "binIndustrial",
      x: -(halfW - 0.8),
      y: up,
      z: -2.3,
      yaw: Math.PI / 2,
      scale: 0.7,
    },
  );
  return out;
}
