/**
 * Shipping-dock dressing (WS6 R4/R12), dock-local frame converted to world:
 * strip curtains and a leveller plate at each door, yellow bollards beside
 * every bay, staged pallets between the bays with a pallet jack, bins and fire
 * points by the side walls. Keeps the main-line axis, the loading stair, the
 * teleport spot in front of the truck door and the release racks clear. Pure.
 */
import type { FactoryLayout } from "@/engine/layout/factoryLayout";
import { DOCK } from "@/engine/world/factory/Dock";
import { against, type Piece } from "./piece";

export function dockPieces(fl: FactoryLayout): Piece[] {
  const out: Piece[] = [];
  const oz = fl.dock.z1; // dock-local z = 0 (the door wall's plant face + 0.3)
  const y = fl.floorY + DOCK.platformH;
  const P = (
    role: Piece["role"],
    x: number,
    z: number,
    yaw = 0,
    sc?: Piece["scale"],
  ) => out.push({ role, x, y, z: oz + z, yaw, ...(sc ? { scale: sc } : {}) });

  for (const dx of DOCK.doorXs) {
    // Curtain just inside the door wall (wall plant face at z = -0.3).
    out.push({
      role: "stripCurtain",
      x: dx,
      y: y + 0.05,
      z: oz - 0.42,
      yaw: 0,
    });
    // Leveller plate in front of the door (plate 2.0 x 2.0 scaled to the
    // door's 3.0 clear width and 2.4 m reach).
    P("dockLeveller", dx, -1.55, 0, [1.5, 1, 1.2]);
    for (const sx of [-1, 1]) P("bollard", dx + sx * 2.1, -0.9);
  }
  // Staged pallets between the bays (clear of the truck door's bay lines).
  for (const sx of [-1, 1]) {
    P("pallet", sx * 4.5, -1.2, 0);
    P("pallet", sx * 4.5, -2.5, sx * 0.08);
  }
  P("palletJack", -4.4, -4.1, 0.25);
  // Fire points on the door wall between the outer bays and the racks.
  for (const sx of [-1, 1]) {
    const f = against("fireExtinguisher", sx * 12.6, -0.3, 0, -1, {
      gap: 0.02,
    });
    out.push({ role: "fireExtinguisher", ...f, y, z: oz + f.z });
  }
  P("binIndustrial", -12.4, -1.6, Math.PI / 2);
  return out;
}
