/**
 * Visibility of the factory floor (cells, main line, dock). Pure, no Babylon.
 * See docs/design/software-factory.md section 6.
 *
 *   room / balcony : own cell `full`; same-side neighbour cells `impostor`
 *                    when in the view cone (through the outer glazing) and
 *                    within IMPOSTOR_M; the opposite side, main line and dock
 *                    are `hidden`
 *   spine (hall)   : main line `full`; cells `impostor` within 2 bays of the
 *                    eye along z, else `hidden`; dock `impostor` within MAX
 *   floor zones    : (factory / cell / dock / stair) cone + distance; the cell
 *                    under the eye is always `full`
 *   tower (control): cone, IMPOSTOR_M 35, MAX_M 70
 *   lobby (reception): cells `impostor` in the cone, main line by cone
 *   entrance (ground lobby): cone + distance (through the factory door)
 *   outside        : cone + distance
 */

import { LAYOUT, type BuildingLayout } from "../contracts";
import type {
  CellLayout,
  FactoryLayout,
  Rect,
  Zone3,
} from "../layout/factoryLayout";

export type CellDetail = "full" | "impostor" | "hidden";

export const FACTORY_IMPOSTOR_M = 35;
export const FACTORY_MAX_M = 70;
/** Things closer than this are always kept (fast turns). */
export const FACTORY_ALWAYS_M = 4;
/** Default horizontal half field of view (rad), margin included. */
export const FACTORY_HALF_FOV = 1.2;
/** From the spine, cells farther than this many bays (along z) are hidden. */
export const SPINE_BAYS = 2;

export interface FactoryVisibility {
  /** projectId -> detail. */
  cells: Map<string, CellDetail>;
  mainLine: CellDetail;
  dock: CellDetail;
}

type P2 = { x: number; z: number };

function rectDistance(p: P2, r: Rect): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
  return Math.hypot(dx, dz);
}

const wrap = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

const N = 5;

/** Does any sample of the rect lie within `maxM` and inside the cone? */
function inCone(
  eye: P2,
  yaw: number,
  halfFov: number,
  r: Rect,
  maxM: number,
): boolean {
  if (rectDistance(eye, r) < FACTORY_ALWAYS_M) return true;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const px = r.x0 + ((r.x1 - r.x0) * i) / (N - 1);
      const pz = r.z0 + ((r.z1 - r.z0) * j) / (N - 1);
      const dx = px - eye.x;
      const dz = pz - eye.z;
      if (Math.hypot(dx, dz) > maxM) continue;
      if (Math.abs(wrap(Math.atan2(dx, dz) - yaw)) <= halfFov) return true;
    }
  return false;
}

const tier = (d: number, impostorM: number): CellDetail =>
  d > impostorM ? "impostor" : "full";

/**
 * Per-cell detail for the factory floor.
 *
 * World.ts call (each visibility tick, ~5 Hz):
 * ```ts
 * const v = computeCellVisibility(
 *   this.factoryLayout, this.layout,
 *   { x: eye.x, y: eye.y, z: eye.z },
 *   { x: Math.sin(yaw), z: Math.cos(yaw) },
 *   zoneAt3(this.factoryLayout, this.layout, eye),
 * ); // optional 6th arg: halfFov (default FACTORY_HALF_FOV)
 * // v.cells.get(projectId) -> cell root enable / pool detail
 * // v.mainLine, v.dock -> "hidden" disables the node; "impostor" = cheapest tier
 * ```
 * Apply with the same grace period as rooms (VisibilityController.HIDE_GRACE_MS).
 */
export function computeCellVisibility(
  layout: FactoryLayout,
  _building: BuildingLayout,
  eye: { x: number; y: number; z: number },
  forward: { x: number; z: number },
  zone3: Zone3,
  halfFov: number = FACTORY_HALF_FOV,
): FactoryVisibility {
  const yaw = Math.atan2(forward.x, forward.z);
  const e: P2 = { x: eye.x, z: eye.z };
  const cells = new Map<string, CellDetail>();
  const mainRect: Rect = {
    x0: layout.mainLine.x - 2,
    x1: layout.mainLine.x + 2,
    z0: layout.mainLine.z0,
    z1: layout.mainLine.z1,
  };
  const set = (c: CellLayout, d: CellDetail): void =>
    void cells.set(c.projectId, d);
  const out = (mainLine: CellDetail, dock: CellDetail): FactoryVisibility => ({
    cells,
    mainLine,
    dock,
  });
  const cone = (r: Rect, impostorM = FACTORY_IMPOSTOR_M): CellDetail => {
    if (!inCone(e, yaw, halfFov, r, FACTORY_MAX_M)) return "hidden";
    return tier(rectDistance(e, r), impostorM);
  };

  switch (zone3.kind) {
    case "room":
    case "balcony": {
      const own = zone3.projectId;
      const ownCell = layout.cells.find((c) => c.projectId === own);
      for (const c of layout.cells) {
        if (c.projectId === own) set(c, "full");
        else if (ownCell && c.side === ownCell.side)
          set(
            c,
            inCone(e, yaw, halfFov, c.rect, FACTORY_IMPOSTOR_M)
              ? "impostor"
              : "hidden",
          );
        else set(c, "hidden");
      }
      return out("hidden", "hidden");
    }
    case "hall": {
      const reach = SPINE_BAYS * LAYOUT.ROOM_W;
      for (const c of layout.cells) {
        const dz = Math.max(c.z0 - e.z, 0, e.z - c.z1);
        set(c, dz <= reach ? "impostor" : "hidden");
      }
      const dockD = rectDistance(e, layout.dock);
      return out("full", dockD <= FACTORY_MAX_M ? "impostor" : "hidden");
    }
    case "lobby":
      // The reception reaches into the factory (glazed gallery sides + the
      // glass strip over the main line): cells in view as impostors.
      for (const c of layout.cells)
        set(
          c,
          inCone(e, yaw, halfFov, c.rect, FACTORY_IMPOSTOR_M)
            ? "impostor"
            : "hidden",
        );
      return out(cone(mainRect), "hidden");
    case "entrance": {
      // Ground lobby: the factory shows through the open door (cone).
      for (const c of layout.cells) set(c, cone(c.rect));
      return out(cone(mainRect), cone(layout.dock));
    }
    case "control": {
      // The tower: cone, IMPOSTOR 35 m.
      for (const c of layout.cells) set(c, cone(c.rect));
      return out(cone(mainRect), cone(layout.dock));
    }
    case "cell":
    case "stair":
    case "factory":
    case "outside":
    default: {
      const own =
        zone3.kind === "cell" || zone3.kind === "stair"
          ? zone3.projectId
          : undefined;
      for (const c of layout.cells)
        set(c, c.projectId === own ? "full" : cone(c.rect));
      return out(cone(mainRect), cone(layout.dock));
    }
    case "dock": {
      for (const c of layout.cells) set(c, cone(c.rect));
      return out(cone(mainRect), "full");
    }
  }
}
