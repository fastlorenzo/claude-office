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
  /** Technician's bench against the outer wall, at the end of the entry-bay walkway. */
  BENCH_X: 32.85,
  /**
   * Loading aisle along the outer wall (|x| range): between the lane belt
   * starts (31) and the intake racks (≥ 32.49); joins every cell's entry-bay
   * walkway (the perimeter route from the factory door to every cell).
   */
  AISLE_X: [31.1, 32.35] as const,
  QA_X: 13.5,
  GATE_X: 11,
  TRUNK_X: 8.5,
  SPINE_STAIR_EVERY: 4,
  /** The envelope's south wall: one bay south of the hall start. */
  SOUTH_Z: -4.8,
} as const;

/**
 * Entrance building (pure numbers, |x| mirrored for the two stairs). The
 * ground lobby (y = FLOOR_Y) projects south of the factory envelope under the
 * reception; the reception (y = 0) reaches into the factory up to the hall
 * start (the "gallery"). Two U-shaped feature stairs against the side walls
 * (lower flight along the wall, landing at the façade, upper flight inboard
 * arriving north at y = 0) and a glass lift beside the west stair.
 */
export const ENTRANCE = {
  /** Lower flight |x| range (along the side wall). */
  LOWER_X: [11.65, 13.05] as const,
  /** Upper flight |x| range (inboard). */
  UPPER_X: [10.15, 11.55] as const,
  /** Landing (y = FLOOR_Y / 2) z range, against the south façade. */
  LANDING_Z: [-11.85, -10.6] as const,
  /**
   * Both flights run between the landing and this z (stair foot / head):
   * 3.0 m drop over 4.6 m → 17 risers of 0.176, going 0.27, 33° (G12).
   */
  FLIGHT_Z1: -6.0,
  /** Opening / footprint |x| range and z range. */
  RECT_X: [10.1, 13.1] as const,
  RECT_Z0: -11.9,
  /** Glass lift shaft (west, beside the stair, against the back wall). */
  LIFT: { x0: -9.7, x1: -7.9, z0: -6.9, z1: -5.1 },
  /** Lift door clear width (centred on the shaft's south face). */
  LIFT_DOOR_W: 1.0,
  /** Factory door in the shared north wall (centre x, clear w × h). */
  FACTORY_DOOR: { x: 0, width: 2.4, height: 3.0 },
  /** Glazed entrance doors in the south façade (centre x, clear width). */
  DOORS: { x: 0, width: 3.2 },
  /** Shared wall thickness (the factory's south wall). */
  WALL_T: 0.3,
} as const;

/** Structural glass strip down the spine (over the factory main line). */
export const SPINE_GLASS_W = 1.6;
/** Glazed tower bay at the control-room end of the spine. */
export const TOWER_BAY_D = 4;

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

/**
 * Per-cell switchback stair: three 2 m flights side by side in the entry bay
 * (|x| / z offsets from the cell's z0, mirrored toward the balcony door).
 */
export const CELL_STAIR = {
  /** Top landing, joined to the balcony edge (balustrade gap there). */
  top: { x0: 14.3, x1: 15.4, z0: 0.15, z1: 1.15 },
  /** Flight x bands (flight 1 starts at the top landing). */
  flights: [
    { x0: 14.4, x1: 15.4 },
    { x0: 15.4, x1: 16.4 },
    { x0: 16.4, x1: 17.4 },
  ],
  /** Flights run between these z offsets. */
  zNear: 1.15,
  zFar: 4.02,
  /** Far-end landing (flights 1 → 2, y = −2) and near-end (2 → 3, y = −4). */
  far: { x0: 14.4, x1: 16.4, z0: 4.02, z1: 4.72 },
  near: { x0: 15.4, x1: 17.4, z0: 0.15, z1: 1.15 },
} as const;

/**
 * World z range of a cell stair's top landing on the balcony edge (the
 * balcony balustrade leaves this gap open). The landing sits at the balcony
 * door's end of the entry bay. Pure.
 */
export function cellStairGap(
  z0: number,
  doorZ: number,
): { z0: number; z1: number } {
  const W = LAYOUT.ROOM_W;
  const m = doorZ - z0 > W / 2;
  const a = m ? z0 + W - CELL_STAIR.top.z1 : z0 + CELL_STAIR.top.z0;
  const b = m ? z0 + W - CELL_STAIR.top.z0 : z0 + CELL_STAIR.top.z1;
  return { z0: a, z1: b };
}

/** Floor point just off a cell stair's last flight (teleports land here). */
export function cellStairFoot(
  side: "east" | "west",
  z0: number,
  doorZ: number,
): { x: number; z: number } {
  const s = side === "east" ? 1 : -1;
  const W = LAYOUT.ROOM_W;
  const m = doorZ - z0 > W / 2;
  const o = (CELL_STAIR.far.z0 + CELL_STAIR.far.z1) / 2;
  return { x: s * 18.4, z: m ? z0 + W - o : z0 + o };
}

/**
 * Step-over crossover (stair · deck · stair) over a feeder belt, running
 * along z at x. Every cell's feeder (trunk → main line) cuts the central
 * strip between the main line and the trunks into bays; one crossover per
 * feeder joins them, so the spine-stair feet and every bay reach the
 * factory door on foot.
 */
export interface CrossoverLayout {
  id: string;
  x: number;
  /** Belt centre line crossed (feeder z). */
  z: number;
  /** Deck top above the floor (y = floorY + deckH). */
  deckY: number;
  /** Plan footprint including both flights (x0 <= x1, z0 <= z1). */
  rect: Rect;
  /** Floor points just off each flight's foot (south, north). */
  feet: [Vec3, Vec3];
}

export const CROSSOVER = {
  /** |x| of the centre line: clear of the spine flights (≤ 3.5), the feeder
   * bollards (3.3 / 6.3) and the trunk (≥ 8.05). */
  X: 4.8,
  /** Clear width between the handrail posts (flight / deck width). */
  W: 1.0,
  /** Deck top above the floor: the tallest piece tops out at 1.65 (belt
   * 0.85 + pallet 0.14 + body 0.66); the deck structure clears it. */
  DECK_H: 2.0,
  /** Deck half length (z) over the belt (0.9 + skirts, posts outside). */
  DECK_HALF: 0.75,
  /** Each flight's run: 2.0 / 3.0 → 33.7° (≤ STAIR_MAX_DEG). */
  RUN: 3.0,
} as const;

/** Feeder crossovers of a cell set (pure). */
export function crossoverPlan(
  cells: readonly Pick<CellLayout, "projectId" | "side" | "trunk">[],
  floorY = FLOOR_Y,
): CrossoverLayout[] {
  const C = CROSSOVER;
  const reach = C.DECK_HALF + C.RUN;
  return cells.map((c) => {
    const s = sgn(c.side);
    const x = s * C.X;
    const z = c.trunk.feederZ;
    return {
      id: `crossover:${c.projectId}`,
      x,
      z,
      deckY: floorY + C.DECK_H,
      rect: rectOf(x - C.W / 2, x + C.W / 2, z - reach, z + reach),
      feet: [v3(x, floorY, z - reach - 0.6), v3(x, floorY, z + reach + 0.6)],
    };
  });
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

export interface EntranceStair extends StairLayout {
  side: RoomSide;
  /** Lower flight: floor (foot at FLIGHT_Z1) up to the landing. */
  lower: Rect;
  /** Upper flight: landing up to y = 0 (head at FLIGHT_Z1). */
  upper: Rect;
  landing: Rect;
  landingY: number;
}

export interface LiftStop {
  /** 0 = ground (G), 1 = reception (1). */
  level: 0 | 1;
  y: number;
  /** Where a rider stands on arrival (in front of the door). */
  front: Vec3;
  /** Facing away from the door. */
  yaw: number;
}

export interface LiftLayout {
  id: string;
  rect: Rect;
  /** Door centre on the shaft's south face. */
  door: { x: number; z: number; width: number };
  stops: [LiftStop, LiftStop];
}

export interface EntranceLayout {
  /** Ground lobby footprint (outside the factory envelope). */
  rect: Rect;
  floorY: number;
  /** Reception extension at y = 0 inside the factory volume. */
  gallery: Rect;
  /** Glazed entrance doors on the south façade (centre + clear width). */
  doors: { x: number; z: number; width: number };
  /** Door into the factory in the shared north wall. */
  factoryDoor: { x: number; z: number; width: number; height: number };
  stairs: EntranceStair[];
  lift: LiftLayout;
  /** New-visitor spawn just inside the entrance doors, facing in. */
  spawn: Vec3;
  spawnYaw: number;
}

export interface FactoryLayout {
  floorY: number;
  bounds: { min: Vec3; max: Vec3 };
  cells: CellLayout[];
  emptyCells: EmptyCellLayout[];
  mainLine: { x: number; z0: number; z1: number; qc: number };
  dock: Rect;
  spineStairs: StairLayout[];
  /** Step-over crossovers on the feeders (one per cell). */
  crossovers: CrossoverLayout[];
  /** The entrance lift (G ↔ 1); interaction-driven, see EntranceHall. */
  liftSpots: { id: string; rect: Rect; top: Vec3; bottom: Vec3 }[];
  entrance: EntranceLayout;
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
  | { kind: "balcony"; projectId: string }
  /** Ground-floor entrance lobby (outside the envelope, under the reception). */
  | { kind: "entrance" };

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
  const controlEnd =
    building.controlRoom.origin.z + building.controlRoom.size.z / 2;
  const zMin = Math.max(building.bounds.min.z, FACTORY.SOUTH_Z);

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
    // The built switchback (CELL_STAIR): landings + flights footprint, and
    // the foot just off its last flight.
    const S = CELL_STAIR;
    const gap = cellStairGap(z0, doorZ);
    const mirrored = doorZ - z0 > ROOM_W / 2;
    const zo = (o: number) => (mirrored ? z0 + ROOM_W - o : z0 + o);
    const foot = cellStairFoot(room.slot.side, z0, doorZ);
    const stair: StairLayout = {
      id: `cell:${room.projectId}`,
      rect: rectOf(
        s * S.top.x0,
        s * S.flights[2].x1,
        Math.min(zo(S.top.z0), zo(S.far.z1), gap.z0),
        Math.max(zo(S.top.z0), zo(S.far.z1), gap.z1),
      ),
      top: v3(room.balcony.door.x, 0, doorZ),
      bottom: v3(foot.x, FLOOR_Y, foot.z),
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
      bench: v3(s * FACTORY.BENCH_X, FLOOR_Y, z0 + 2.4),
      // Holding rack (long side along x) and scrap bin flank the entry-bay
      // walkway (z0 + 2.4 ± 0.66) without blocking it.
      holding: v3(s * 24, FLOOR_Y, z0 + 4.2),
      scrap: v3(s * 24, FLOOR_Y, z0 + 0.95),
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

  const spineStairs = spineStairPlan(building, cells);

  const entrance = buildEntrance(building);
  const lift = entrance.lift;

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
    crossovers: crossoverPlan(cells),
    liftSpots: [
      {
        id: lift.id,
        rect: lift.rect,
        top: lift.stops[1].front,
        bottom: lift.stops[0].front,
      },
    ],
    entrance,
  };
}

/**
 * Spine-node stair wells (pure). Each well is a 1.2 × 6.4 m hole in the hall
 * floor against one glass front (|x| 2.3–3.5) centred on a bay line, with a
 * guard rail on its hall side; the flight drops 6 m along +z and carries on
 * under the slab (`SPINE_STAIR.RUN`) to a foot on the factory floor.
 *
 * Wells follow the rooms (G2): the old fixed rhythm (bays 2, 6, 10 …) could
 * put a room door inside a well — rail across the doorway from the hall, a
 * 3.6 m drop beyond it. A well is only placed where, on its side,
 *   - no room door (± DOOR_CLEAR) and no hall planter (room far end) falls
 *     inside the well's z range, and
 *   - no cell feeder (trunk → main line, at the entry bay) crosses the
 *     flight's floor footprint (± FEEDER_CLEAR);
 * and never over the glazed tower bay. Targets keep the rhythm (every
 * `SPINE_STAIR_EVERY` bays, alternating sides, preferring the target bay,
 * then the other side, then ± 1, ± 2 bays) with at least
 * `SPINE_STAIR.MIN_GAP_BAYS` between wells.
 */
export const SPINE_STAIR = {
  /** Well half length (z) and |x| range. */
  HALF: 3.2,
  X: [2.3, 3.5] as const,
  /** Flight plan length (mirrors FactoryHall.SPINE_RUN) and the foot zone. */
  RUN: 8.6,
  FOOT: 1.25,
  /** First candidate bay line. */
  FIRST_BAY: 2,
  MIN_GAP_BAYS: 2,
  /** Door opening clearance (each side, beyond DOOR_W / 2). */
  DOOR_CLEAR: 0.7,
  /** Hall planter half size + margin (at |x| 2.95, z1 − 0.6 of each room). */
  PLANTER_CLEAR: 0.5,
  /** Feeder belt half width + capsule + margin. */
  FEEDER_CLEAR: 1.0,
  /** Glazed tower bay at the hall end. */
  TOWER_BAY_D,
} as const;

/** Floor-level z range a spine flight + its foot occupy (from the well's z0). */
export function spineFootprintZ(wellZ0: number): [number, number] {
  return [wellZ0, wellZ0 + SPINE_STAIR.RUN + SPINE_STAIR.FOOT];
}

export function spineStairPlan(
  building: BuildingLayout,
  cells: readonly Pick<CellLayout, "side" | "trunk">[],
): StairLayout[] {
  const S = SPINE_STAIR;
  const W = LAYOUT.ROOM_W;
  const L = building.hall.length;
  const doorHalf = LAYOUT.DOOR_W / 2 + S.DOOR_CLEAR;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
    a0 < b1 && b0 < a1;
  const ok = (b: number, side: RoomSide): boolean => {
    const zc = b * W;
    const z0 = zc - S.HALF;
    const z1 = zc + S.HALF;
    if (b < S.FIRST_BAY || z1 > L - S.TOWER_BAY_D + 1e-9) return false;
    for (const r of building.projects) {
      if (r.slot.side !== side) continue;
      const dz = r.door.z;
      if (overlaps(z0, z1, dz - doorHalf, dz + doorHalf)) return false;
      const pz = r.footprint.z1 - 0.6;
      if (overlaps(z0, z1, pz - S.PLANTER_CLEAR, pz + S.PLANTER_CLEAR))
        return false;
    }
    const [f0, f1] = spineFootprintZ(z0);
    for (const c of cells) {
      if (c.side !== side) continue;
      const fz = c.trunk.feederZ;
      if (overlaps(f0, f1, fz - S.FEEDER_CLEAR, fz + S.FEEDER_CLEAR))
        return false;
    }
    return true;
  };
  const out: StairLayout[] = [];
  let prevBay = -Infinity;
  let prefer: RoomSide = "east";
  const maxBay = Math.floor(L / W);
  for (let t = S.FIRST_BAY; t <= maxBay;) {
    let pick: { b: number; side: RoomSide } | null = null;
    const other: RoomSide = prefer === "east" ? "west" : "east";
    for (const d of [0, 1, -1, 2, -2]) {
      const b = t + d;
      if (b - prevBay < S.MIN_GAP_BAYS + 1) continue;
      for (const side of [prefer, other])
        if (!pick && ok(b, side)) pick = { b, side };
      if (pick) break;
    }
    if (!pick) {
      t += FACTORY.SPINE_STAIR_EVERY;
      continue;
    }
    const s = sgn(pick.side);
    const zc = pick.b * W;
    const k = out.length;
    out.push({
      id: `spine:${k}`,
      rect: rectOf(s * S.X[0], s * S.X[1], zc - S.HALF, zc + S.HALF),
      top: v3(s * 2.9, 0, zc - S.HALF - 0.6),
      bottom: v3(s * 2.9, FLOOR_Y, zc - S.HALF + S.RUN + 0.6),
    });
    prevBay = pick.b;
    prefer = pick.side === "east" ? "west" : "east";
    t = pick.b + FACTORY.SPINE_STAIR_EVERY;
  }
  return out;
}

/** Entrance building data (ground lobby, stairs, lift, doors) for a layout. */
export function buildEntrance(building: BuildingLayout): EntranceLayout {
  const E = ENTRANCE;
  const halfW = building.lobby.size.x / 2;
  const zFront = building.bounds.min.z;
  const zWall = FACTORY.SOUTH_Z;
  const ly = FLOOR_Y / 2;
  const stairs: EntranceStair[] = (["west", "east"] as RoomSide[]).map(
    (side) => {
      const s = sgn(side);
      const xr = (r: readonly [number, number], z0: number, z1: number) =>
        rectOf(s * r[0], s * r[1], z0, z1);
      const [lz0, lz1] = E.LANDING_Z;
      const lowerMid = s * ((E.LOWER_X[0] + E.LOWER_X[1]) / 2);
      const upperMid = s * ((E.UPPER_X[0] + E.UPPER_X[1]) / 2);
      // Foot / head spots: mid-way between the flights' north end and the
      // shared wall's inner face (the approach strip along the wall).
      const zSpot = (E.FLIGHT_Z1 + zWall - E.WALL_T) / 2;
      return {
        id: `entrance:${side}`,
        side,
        rect: xr(E.RECT_X, E.RECT_Z0, E.FLIGHT_Z1),
        top: v3(upperMid, 0, zSpot),
        bottom: v3(lowerMid, FLOOR_Y, zSpot),
        lower: xr(E.LOWER_X, lz1, E.FLIGHT_Z1),
        upper: xr(E.UPPER_X, lz1, E.FLIGHT_Z1),
        landing: rectOf(s * E.UPPER_X[0], s * E.LOWER_X[1], lz0, lz1),
        landingY: ly,
      };
    },
  );
  const L = E.LIFT;
  const doorX = (L.x0 + L.x1) / 2;
  const front = (y: number) => v3(doorX, y, L.z0 - 0.9);
  const lift: LiftLayout = {
    id: "lift:entrance",
    rect: { ...L },
    door: { x: doorX, z: L.z0, width: E.LIFT_DOOR_W },
    stops: [
      { level: 0, y: FLOOR_Y, front: front(FLOOR_Y), yaw: Math.PI },
      { level: 1, y: 0, front: front(0), yaw: Math.PI },
    ],
  };
  return {
    rect: rectOf(-halfW, halfW, zFront, zWall),
    floorY: FLOOR_Y,
    gallery: rectOf(-halfW, halfW, zWall, 0),
    doors: { x: E.DOORS.x, z: zFront, width: E.DOORS.width },
    factoryDoor: { ...E.FACTORY_DOOR, z: zWall },
    stairs,
    lift,
    spawn: v3(E.DOORS.x, FLOOR_Y, zFront + 1.3),
    spawnYaw: 0,
  };
}

const inRect = (r: Rect, p: { x: number; z: number }) =>
  p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;

/** Walkable floor-level stairs of a layout (cell, spine, entrance, lift). */
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
    ...f.entrance.stairs.map((s) => ({ id: s.id, rect: s.rect })),
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
    if (inRect(layout.entrance.rect, p)) return { kind: "entrance" };
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
