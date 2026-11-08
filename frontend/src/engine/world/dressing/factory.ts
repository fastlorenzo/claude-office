/**
 * Factory-floor dressing (WS6 R12), per cell and entirely derived from the
 * cell layout (so it follows the project / session count):
 *
 *  - entry bay (between the stair, the holding rack, the scrap bin and the
 *    loading aisle): a tool trolley, two industrial bins, a loaded pallet;
 *  - the outer wall: a fire point in the nook behind the aisle and a
 *    galvanised cable tray along the whole cell at 2.6 m (above the intake
 *    racks), mounted on the perimeter columns.
 *
 * Walkways (entry-bay row at the technician, the loading aisle) stay clear:
 * every solid piece is checked against them in `tests/dressing.test.ts`
 * and against the factory flood fill. Pure.
 */
import { DRESSING_DIMS } from "@/engine/assets/proceduralProps";
import type { FactoryLayout } from "@/engine/layout/factoryLayout";
import { against, type Piece } from "./piece";

/** Tray height above the floor. */
const TRAY_Y = 2.6;

export function factoryPieces(fl: FactoryLayout): Piece[] {
  const out: Piece[] = [];
  const y = fl.floorY;
  const wallX = fl.bounds.max.x;
  for (const c of fl.cells) {
    const s = c.side === "east" ? 1 : -1;
    const z0 = c.z0;
    // ---- entry bay, in front of the first lane (z0 .. z0 + 5)
    out.push(
      { role: "toolTrolley", x: s * 29.4, y, z: z0 + 0.9, yaw: 0 },
      {
        role: "binIndustrial",
        x: s * 26.6,
        y,
        z: z0 + 0.75,
        yaw: s * 0.1,
      },
      {
        role: "binIndustrial",
        x: s * 27.35,
        y,
        z: z0 + 0.75,
        yaw: -s * 0.08,
      },
      { role: "pallet", x: s * 21.2, y, z: z0 + 0.9, yaw: s * 0.05 },
    );
    // ---- fire point on the outer wall, between bench and first rack
    const f = against("fireExtinguisher", s * wallX, z0 + 4.2, -s, 0, {
      gap: 0.02,
    });
    out.push({ role: "fireExtinguisher", ...f, y });
    // ---- cable tray along the wall, whole cell
    const len = DRESSING_DIMS.cableTray.w;
    const a = z0 + 0.15;
    const b = c.z1 - 0.15;
    const n = Math.max(1, Math.floor((b - a) / len));
    const step = (b - a) / n;
    for (let i = 0; i < n; i++) {
      const t = against("cableTray", s * wallX, a + step * (i + 0.5), -s, 0, {
        back: "+z",
      });
      out.push({
        role: "cableTray",
        ...t,
        y: y + TRAY_Y,
        scale: [step / len, 1, 1],
      });
    }
  }
  return out;
}
