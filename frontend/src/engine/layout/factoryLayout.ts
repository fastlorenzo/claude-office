/**
 * Software Factory floor layout (pure data, no Babylon).
 *
 * Generated from a BuildingLayout: every project room gets a production cell
 * directly beneath it (same z extents, x from the glass-front line out to the
 * factory's outer wall), lanes run INWARD toward the main line under the spine.
 * See docs/design/software-factory.md sections 1 and 6.
 *
 * Types live here for now; they move into contracts.ts later.
 */

import {
  LAYOUT,
  type BuildingLayout,
  type RoomSide,
  type Vec3,
  type Zone,
} from "../contracts";
import { MAX_LANES } from "../logic/factoryModel";
import { roomAt } from "./buildingLayout";

export const FLOOR_Y = -6;
/** Below this y a point is on the factory floor level. */
export const FACTORY_Y = -1.5;
/** Balcony zone ceiling (above the balcony deck). */
const BALCONY_TOP_Y = 3.5;

export const FACTORY = {
  OUTER_X: 34,
  ROOF_Y: 9,
  DOCK_D: 14,
  LANE_PITCH: 2.4,
  STATION_X: [28, 25.5, 23, 20.5, 18, 15.5],
  REWORK_X: 29,
  INTAKE_X: 31.75,
  QA_X: 13.5,
  GATE_X: 11,
  TRUNK_X: 8.5,
  SPINE_STAIR_EVERY: 4,
} as const;

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const sgn = (s: RoomSide): 1 | -1 => (s === "east" ? 1 : -1);

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface LaneLayout {
  index: number;
  /** Lane centre line (constant z). */
  z: number;
  /** Signed x of each inspection station, intake to gate order. */
  stationX: number[];
  qaX: number;
  gateX: number;
  reworkX: number;
  intakeX: number;
}

export interface StairLayout {
  id: string;
  /** Plan footprint (x0 <= x1, z0 <= z1). */
  rect: Rect;
  /** Arrival point at y = 0 (balcony / hall / lobby). */
  top: Vec3;
  /** Landing at floor level (y = floorY). */
  bottom: Vec3;
}

export interface CellLayout {
  projectId: string;
  side: RoomSide;
  z0: number;
  z1: number;
  entryBay: number;
  /** Cell floor rectangle (x ordered low to high). */
  rect: Rect;
  lanes: LaneLayout[];
  trunk: { x: number; z0: number; z1: number; feederZ: number };
  /** Header board above the intake wall, facing the room (yaw = facing). */
  board: { position: Vec3; yaw: number };
  bench: Vec3;
  holding: Vec3;
  scrap: Vec3;
  technician: Vec3;
  stair: StairLayout;
  /** Floor-level column positions (y = floorY). */
  columns: Vec3[];
}

export interface EmptyCellLayout {
  side: RoomSide;
  bay: number;
  span: number;
  z0: number;
  z1: number;
  rect: Rect;
}

export interface FactoryLayout {
  floorY: number;
  bounds: { min: Vec3; max: Vec3 };
  cells: CellLayout[];
  emptyCells: EmptyCellLayout[];
  mainLine: { x: number; z0: number; z1: number; qc: number };
  dock: Rect;
  spineStairs: StairLayout[];
  lobbyStair: StairLayout;
  liftSpots: { id: string; rect: Rect; top: Vec3; bottom: Vec3 }[];
}

export interface FactoryLayoutOptions {
  outerX?: number;
  dockDepth?: number;
}

export type FactoryZone =
  | { kind: "factory" }
  | { kind: "cell"; projectId: string }
  | { kind: "dock" }
  | { kind: "stair"; id: string; projectId?: string }
  | { kind: "balcony"; projectId: string };

export type Zone3 = Zone | FactoryZone;

function rectOf(a: number, b: number, z0: number, z1: number): Rect {
  return { x0: Math.min(a, b), x1: Math.max(a, b), z0, z1 };
}

export function buildFactoryLayout(
  building: BuildingLayout,
  opts: FactoryLayoutOptions = {},
): FactoryLayout {
  const outerX = opts.outerX ?? FACTORY.OUTER_X;
  const dockDepth = opts.dockDepth ?? FACTORY.DOCK_D;
  const frontX = LAYOUT.HALL_W / 2;
  const { ROOM_W } = LAYOUT;
  const hallLen = building.hall.length;
  const controlEnd =
    building.controlRoom.origin.z + building.controlRoom.size.z / 2;
  const zMin = building.bounds.min.z;

  const cells: CellLayout[] = building.projects.map((room) => {
    const s = sgn(room.slot.side);
    const { z0, z1 } = room.footprint;
    const lanesN = Math.min(MAX_LANES, 2 * room.capacity);
    const lanes: LaneLayout[] = Array.from({ length: lanesN }, (_, i) => ({
      index: i,
      z: (room.slot.bay + 1 + (i >> 1)) * ROOM_W + (i % 2 ? 3.6 : 1.2),
      stationX: FACTORY.STATION_X.map((x) => s * x),
      qaX: s * FACTORY.QA_X,
      gateX: s * FACTORY.GATE_X,
      reworkX: s * FACTORY.REWORK_X,
      intakeX: s * FACTORY.INTAKE_X,
    }));
    const entryZ = z0 + ROOM_W / 2;
    const doorZ = room.balcony.door.z;
    const stairX0 = s * 14.4;
    const stairX1 = s * 16.4;
    const stair: StairLayout = {
      id: `cell:${room.projectId}`,
      rect: rectOf(stairX0, stairX1, z0 + 0.3, z0 + ROOM_W - 0.3),
      top: v3(room.balcony.door.x, 0, doorZ),
      bottom: v3(s * 17.2, FLOOR_Y, entryZ),
    };
    return {
      projectId: room.projectId,
      side: room.slot.side,
      z0,
      z1,
      entryBay: room.entryBay,
      rect: rectOf(s * frontX, s * outerX, z0, z1),
      lanes,
      trunk: { x: s * FACTORY.TRUNK_X, z0, z1, feederZ: entryZ },
      board: {
        position: v3(s * (outerX - 0.4), FLOOR_Y + 3, (z0 + z1) / 2),
        yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2,
      },
      bench: v3(s * FACTORY.INTAKE_X, FLOOR_Y, z0 + 2.4),
      holding: v3(s * 24, FLOOR_Y, z0 + 3.6),
      scrap: v3(s * 24, FLOOR_Y, z0 + 1.2),
      technician: v3(s * 20, FLOOR_Y, entryZ),
      stair,
      columns: room.columns.map((c) => v3(c.x, FLOOR_Y, c.z)),
    };
  });

  const emptyCells: EmptyCellLayout[] = building.emptySlots.map((e) => {
    const s = sgn(e.side);
    const z0 = e.bay * ROOM_W;
    const z1 = (e.bay + e.span) * ROOM_W;
    return {
      side: e.side,
      bay: e.bay,
      span: e.span,
      z0,
      z1,
      rect: rectOf(s * frontX, s * outerX, z0, z1),
    };
  });

  const dock = rectOf(-outerX, outerX, controlEnd, controlEnd + dockDepth);

  // Spine-node stairs every 4 bays along the hall edge, alternating sides.
  const spineStairs: StairLayout[] = [];
  const STAIR_HALF = 3.2;
  for (
    let b = 2, k = 0;
    b * ROOM_W + STAIR_HALF + 1 < hallLen;
    b += FACTORY.SPINE_STAIR_EVERY, k++
  ) {
    const zc = b * ROOM_W;
    const s = k % 2 === 0 ? 1 : -1;
    spineStairs.push({
      id: `spine:${k}`,
      rect: rectOf(s * 2.3, s * frontX, zc - STAIR_HALF, zc + STAIR_HALF),
      top: v3(s * 2.9, 0, zc - STAIR_HALF - 0.6),
      bottom: v3(s * 2.9, FLOOR_Y, zc + STAIR_HALF + 0.6),
    });
  }

  const lobbyStair: StairLayout = {
    id: "lobby",
    rect: rectOf(-8, -6.8, -9, -3),
    top: v3(-7.4, 0, -9.6),
    bottom: v3(-7.4, FLOOR_Y, -2),
  };

  return {
    floorY: FLOOR_Y,
    bounds: {
      min: v3(-outerX, FLOOR_Y, zMin),
      max: v3(outerX, FACTORY.ROOF_Y, dock.z1),
    },
    cells,
    emptyCells,
    mainLine: { x: 0, z0: 0, z1: dock.z0, qc: dock.z0 - 3 },
    dock,
    spineStairs,
    lobbyStair,
    liftSpots: [
      {
        id: "lift:0",
        rect: rectOf(7, 9, -8, -6),
        top: v3(8, 0, -9),
        bottom: v3(8, FLOOR_Y, -5),
      },
    ],
  };
}

const inRect = (r: Rect, p: { x: number; z: number }) =>
  p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;

/** Walkable floor-level stairs of a layout (cell, spine, lobby, lift). */
export function allStairs(
  f: FactoryLayout,
): { id: string; rect: Rect; projectId?: string }[] {
  return [
    ...f.cells.map((c) => ({
      id: c.stair.id,
      rect: c.stair.rect,
      projectId: c.projectId,
    })),
    ...f.spineStairs.map((s) => ({ id: s.id, rect: s.rect })),
    { id: f.lobbyStair.id, rect: f.lobbyStair.rect },
    ...f.liftSpots.map((l) => ({ id: l.id, rect: l.rect })),
  ];
}

/** y-aware zone lookup. Total: every point yields exactly one zone. */
export function zoneAt3(
  layout: FactoryLayout,
  building: BuildingLayout,
  p: { x: number; y: number; z: number },
): Zone3 {
  if (p.y < FACTORY_Y) {
    const b = layout.bounds;
    if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z)
      return { kind: "outside" };
    for (const s of allStairs(layout)) {
      if (inRect(s.rect, p))
        return s.projectId
          ? { kind: "stair", id: s.id, projectId: s.projectId }
          : { kind: "stair", id: s.id };
    }
    for (const c of layout.cells)
      if (inRect(c.rect, p)) return { kind: "cell", projectId: c.projectId };
    if (inRect(layout.dock, p)) return { kind: "dock" };
    return { kind: "factory" };
  }
  if (p.y <= BALCONY_TOP_Y) {
    for (const r of building.projects) {
      const bal = r.balcony;
      if (
        p.x >= Math.min(bal.x0, bal.x1) &&
        p.x <= Math.max(bal.x0, bal.x1) &&
        p.z >= bal.z0 &&
        p.z <= bal.z1
      )
        return { kind: "balcony", projectId: r.projectId };
    }
  }
  return roomAt(building, p);
}
