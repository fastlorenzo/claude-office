/**
 * Factory line adapter (pure, Node-testable): FactoryLayout + FactoryModel +
 * FactoryMotion frames → the inputs of the machine pools.
 *
 *   conveyorPaths(layout)          lanes (intake → trunk), trunks (→ main line
 *                                  at the entry bay), the main line (→ dock)
 *   stationRows(layout, models)    one station per lane × check (lanes are
 *                                  identical copies of the cell's station row);
 *                                  beacon = that lane's PR check state
 *   placeMotion(ctx, motion, …)    a `PieceMotion` (abstract path + t) → world
 *                                  pose in the Workpieces "path frame" (y is
 *                                  the belt's floor level; the pool adds the
 *                                  belt height)
 *   pieceLook(workpiece)           size / colour / tag of a workpiece
 *
 * Lane t ↔ x: FactoryMotion maps `lineProgress` (rack 0, belt 1, station i at
 * 2+i, qa 2+S, gate 3+S) to t = u / (3.99 + S). `laneAbsX(u)` turns u back
 * into |x| with knots so that a piece AT station i sits under `stationX[i]`,
 * at QA under `qaX`, at the gate under `gateX`.
 */
import type { CheckState } from "@/engine/contracts";
import type {
  CellLayout,
  FactoryLayout,
  LaneLayout,
} from "@/engine/layout/factoryLayout";
import type { PieceMotion } from "@/engine/logic/factoryMotion";
import {
  MAX_STATIONS,
  worseState,
  type LineModel,
  type Workpiece,
} from "@/engine/logic/factoryModel";
import type { ConveyorPath } from "./conveyorPlan";
import type { StationInstance } from "./stationPlan";
import {
  BELT_HEIGHT,
  samplePolyline,
  type PieceInstance,
  type Placed,
  type Vec3,
} from "./workpiecePlacement";

export const LINE = {
  /** |x| where a lane belt starts (just inside the intake rack). */
  LANE_START_X: 31,
  /** |x| of a piece at lane t = 1 (past the merge gate, before the trunk). */
  LANE_END_X: 10,
  LANE_W: 0.9,
  TRUNK_W: 0.9,
  MAIN_W: 1.1,
  /** Intake rack: |x| offset from the lane's intake, shelf tops, slot z. */
  RACK_DX: 1.1,
  SHELF_TOPS: [0.3175, 0.9675, 1.6175] as const,
  RACK_Z: [-0.33, 0.33] as const,
  HOLD_Z: [-0.85, 0, 0.85] as const,
  /** Dock (matches Dock.ts DOCK.platformH / gantry at ~6 m inside the doors). */
  DOCK_PLATFORM_H: 1.2,
  DOCK_GANTRY_IN: 6,
  /** Shipped pallets: staging spots on the dock platform (|x| columns, rows in from the doors). */
  SHIP_X: [2.9, 4.1, 5.3, 6.5] as const,
  SHIP_ROW0: 2.4,
  SHIP_ROW_DZ: 1.1,
  SHIP_ROWS: 3,
  /** Belt speeds (m/s) for busy lanes / running trunk + main line. */
  LANE_MPS: 0.45,
  TRUNK_MPS: 0.6,
} as const;

const sgn = (c: CellLayout): 1 | -1 => (c.side === "east" ? 1 : -1);
/** Heading (Workpieces yaw convention: atan2(-dz, dx)) travelling toward the spine. */
const inwardYaw = (s: number) => (s > 0 ? Math.PI : 0);

// ---------------------------------------------------------------------------
// Conveyors
// ---------------------------------------------------------------------------

export const lanePathId = (projectId: string, lane: number) =>
  `${projectId}:lane${lane}`;
export const trunkPathId = (projectId: string) => `${projectId}:trunk`;
export const MAIN_PATH_ID = "main";

export function trunkPoints(c: CellLayout, y: number): Vec3[] {
  return [
    { x: c.trunk.x, y, z: c.trunk.z1 - 0.4 },
    { x: c.trunk.x, y, z: c.trunk.feederZ },
    { x: 0, y, z: c.trunk.feederZ },
  ];
}

/** Every belt of the plant; depends on the cell set only (rebuild key). */
export function conveyorPaths(layout: FactoryLayout): ConveyorPath[] {
  const y = layout.floorY;
  const out: ConveyorPath[] = [];
  for (const c of layout.cells) {
    const s = sgn(c);
    for (const l of c.lanes)
      out.push({
        id: lanePathId(c.projectId, l.index),
        kind: "lane",
        width: LINE.LANE_W,
        points: [
          { x: s * LINE.LANE_START_X, y, z: l.z },
          { x: c.trunk.x, y, z: l.z },
        ],
      });
    out.push({
      id: trunkPathId(c.projectId),
      kind: "trunk",
      width: LINE.TRUNK_W,
      points: trunkPoints(c, y),
    });
  }
  if (layout.cells.length > 0)
    out.push({
      id: MAIN_PATH_ID,
      kind: "main",
      width: LINE.MAIN_W,
      points: [
        {
          x: 0,
          y,
          z: Math.min(...layout.cells.map((c) => c.trunk.feederZ)) - 1,
        },
        { x: 0, y, z: layout.mainLine.z1 },
      ],
    });
  return out;
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export interface StationMeta {
  id: string;
  projectId: string;
  lane: number;
  index: number;
  checkName: string;
  /** The lane's PR (if any). */
  piece: Workpiece | null;
}

/** The piece occupying a lane (lanes hold one piece each), or null. */
export function laneOccupant(line: LineModel, lane: number): Workpiece | null {
  return line.workpieces.find((w) => w.lane === lane) ?? null;
}

export function stationRows(
  layout: FactoryLayout,
  models: ReadonlyMap<string, LineModel>,
): { list: StationInstance[]; meta: Map<string, StationMeta> } {
  const list: StationInstance[] = [];
  const meta = new Map<string, StationMeta>();
  for (const c of layout.cells) {
    const m = models.get(c.projectId);
    if (!m || m.stations.length === 0) continue;
    const s = sgn(c);
    for (const l of c.lanes) {
      const piece = laneOccupant(m, l.index);
      const n = Math.min(m.stations.length, l.stationX.length, MAX_STATIONS);
      for (let k = 0; k < n; k++) {
        const st = m.stations[k];
        const id = `${c.projectId}:${l.index}:${k}`;
        list.push({
          id,
          x: l.stationX[k],
          y: layout.floorY,
          z: l.z,
          yaw: inwardYaw(s),
          state: piece?.stationStates[k] ?? "none",
          kind: st.kind,
        });
        meta.set(id, {
          id,
          projectId: c.projectId,
          lane: l.index,
          index: k,
          checkName: st.name,
          piece,
        });
      }
    }
  }
  return { list, meta };
}

// ---------------------------------------------------------------------------
// Lane t ↔ x
// ---------------------------------------------------------------------------

/** Motion's lane normaliser for `stations` stations (see FactoryMotion). */
export const laneNorm = (stations: number) => 3 + stations + 0.99;

/** Piecewise-linear knots (u, |x|) of one lane, u ascending, |x| descending. */
export function laneKnots(
  lane: LaneLayout,
  stations: number,
): [number, number][] {
  // `stations` is the model's full count (it sets the motion's normaliser);
  // stations past the drawn row (a grouped "+N") share the gap before QA.
  const S = Math.max(0, Math.floor(stations));
  const drawn = Math.min(S, lane.stationX.length);
  const qa = Math.abs(lane.qaX);
  const gate = Math.abs(lane.gateX);
  const k: [number, number][] = [
    [0, LINE.LANE_START_X],
    [1, Math.abs(lane.reworkX) + 1],
    [1.5, Math.abs(lane.reworkX)],
  ];
  const lastX = drawn > 0 ? Math.abs(lane.stationX[drawn - 1]) - 1 : qa + 1;
  for (let i = 0; i < S; i++) {
    if (i < drawn) {
      const x = Math.abs(lane.stationX[i]);
      k.push([2 + i, x + 1], [2.5 + i, x], [2.99 + i, x - 1]);
    } else {
      const x = lastX + ((qa + 1 - lastX) * (i - drawn + 1)) / (S - drawn + 1);
      k.push([2 + i, x], [2.99 + i, x]);
    }
  }
  k.push([2 + S, qa + 1], [2.5 + S, qa], [2.99 + S, qa - 0.8]);
  k.push([3 + S, gate + 1.2], [3.5 + S, gate], [laneNorm(S), LINE.LANE_END_X]);
  // Keep |x| non-increasing (short lanes / custom layouts).
  for (let i = 1; i < k.length; i++) k[i][1] = Math.min(k[i][1], k[i - 1][1]);
  return k;
}

export function laneAbsX(
  u: number,
  knots: readonly [number, number][],
): number {
  if (u <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [u1, x1] = knots[i];
    if (u <= u1) {
      const [u0, x0] = knots[i - 1];
      const f = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
      return x0 + (x1 - x0) * f;
    }
  }
  return knots[knots.length - 1][1];
}

// ---------------------------------------------------------------------------
// Motion → pose
// ---------------------------------------------------------------------------

/** Per-line context for placements (built once per model / layout). */
export interface LineCtx {
  cell: CellLayout;
  floorY: number;
  stations: number;
  knots: [number, number][][];
  /** Main line south end / QC / dock (shared). */
  qcZ: number;
  dockZ0: number;
  dockZ1: number;
}

export function lineCtx(
  layout: FactoryLayout,
  cell: CellLayout,
  line: LineModel | null,
): LineCtx {
  const stations = line?.stations.length ?? 0;
  return {
    cell,
    floorY: layout.floorY,
    stations,
    knots: cell.lanes.map((l) => laneKnots(l, stations)),
    qcZ: layout.mainLine.qc,
    dockZ0: layout.dock.z0,
    dockZ1: layout.dock.z1,
  };
}

function lanePose(ctx: LineCtx, lane: number, t: number): Placed | null {
  const l = ctx.cell.lanes[lane];
  if (!l) return null;
  const s = sgn(ctx.cell);
  const u = Math.max(0, Math.min(1, t)) * laneNorm(ctx.stations);
  return {
    x: s * laneAbsX(u, ctx.knots[lane]),
    y: ctx.floorY,
    z: l.z,
    yaw: inwardYaw(s),
  };
}

/** Rack slot `i` (intake: shelves × lanes × 2; overflow stacks above). */
export function intakeSlot(ctx: LineCtx, i: number): Placed {
  const c = ctx.cell;
  const s = sgn(c);
  const lanes = c.lanes.length ? c.lanes : null;
  const per = (lanes?.length ?? 1) * LINE.RACK_Z.length;
  const levels = LINE.SHELF_TOPS.length;
  const idx = Math.max(0, Math.floor(i));
  const lap = Math.floor(idx / (per * levels));
  const r = idx % (per * levels);
  const level = Math.floor(r / per);
  const k = r % per;
  const lane = lanes ? lanes[Math.floor(k / LINE.RACK_Z.length)] : null;
  const z = (lane?.z ?? c.bench.z) + LINE.RACK_Z[k % LINE.RACK_Z.length];
  const ax = Math.abs(lane?.intakeX ?? c.bench.x) + LINE.RACK_DX;
  return {
    x: s * ax,
    y: ctx.floorY + LINE.SHELF_TOPS[level] + lap * 1.95 - BELT_HEIGHT,
    z,
    yaw: inwardYaw(s),
  };
}

/** Holding rack slot `i` (aging PRs, entry bay). */
export function holdingSlot(ctx: LineCtx, i: number): Placed {
  const h = ctx.cell.holding;
  const per = LINE.HOLD_Z.length;
  const levels = LINE.SHELF_TOPS.length;
  const idx = Math.max(0, Math.floor(i));
  const lap = Math.floor(idx / (per * levels));
  const r = idx % (per * levels);
  return {
    x: h.x,
    y:
      ctx.floorY +
      LINE.SHELF_TOPS[Math.floor(r / per)] +
      lap * 1.95 -
      BELT_HEIGHT,
    z: h.z + LINE.HOLD_Z[r % per],
    yaw: inwardYaw(sgn(ctx.cell)),
  };
}

/** Shipped pallet staging spot `i` on the dock platform (both sides of the truck door). */
export function shippedSlot(ctx: LineCtx, i: number): Placed {
  const cols = LINE.SHIP_X.length * 2;
  const per = cols * LINE.SHIP_ROWS;
  const idx = Math.max(0, Math.floor(i));
  const lap = Math.floor(idx / per);
  const r = idx % per;
  const row = Math.floor(r / cols);
  const col = r % cols;
  const side = col % 2 === 0 ? -1 : 1;
  return {
    x: side * LINE.SHIP_X[col >> 1],
    y: ctx.floorY + LINE.DOCK_PLATFORM_H + lap * 0.9 - BELT_HEIGHT,
    z: ctx.dockZ1 - LINE.SHIP_ROW0 - row * LINE.SHIP_ROW_DZ,
    yaw: Math.PI / 2,
  };
}

/** Scrap bin spot `i` (closed PRs pile up inside the bin). */
export function scrapSlot(ctx: LineCtx, i: number): Placed {
  const sc = ctx.cell.scrap;
  const k = Math.max(0, Math.floor(i));
  return {
    x: sc.x + ((k % 2) - 0.5) * 0.3,
    y: ctx.floorY + 0.1 + Math.floor(k / 4) * 0.25 - BELT_HEIGHT,
    z: sc.z + ((Math.floor(k / 2) % 2) - 0.5) * 0.6,
    yaw: inwardYaw(sgn(ctx.cell)) + (k % 3) * 0.4,
  };
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
function lerpPose(a: Placed, b: Placed, f: number, lift = 0): Placed {
  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f) + Math.sin(Math.PI * f) * lift,
    z: lerp(a.z, b.z, f),
    yaw: f < 0.5 ? a.yaw : b.yaw,
  };
}

/** Slot indices of the waiting pieces of one line, per rack. */
export interface WaitSlots {
  intake: Map<string, number>;
  holding: Map<string, number>;
  shipped: Map<string, number>;
  scrap: Map<string, number>;
}

/** Ranks waiting / parked pieces per rack (by smoothed queue slot, then id). */
export function waitSlots(frame: readonly PieceMotion[]): WaitSlots {
  const by = (pred: (p: PieceMotion) => boolean) =>
    new Map(
      frame
        .filter(pred)
        .sort(
          (a, b) =>
            (a.queueSlot ?? 0) - (b.queueSlot ?? 0) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((p, i) => [p.id, i] as const),
    );
  return {
    intake: by(
      (p) =>
        p.segmentPath === "queue" &&
        (p.phase === "rack" || p.phase === "queued" || p.phase === "entering"),
    ),
    holding: by((p) => p.phase === "holding"),
    shipped: by((p) => p.phase === "shipped"),
    scrap: by((p) => p.phase === "scrapped"),
  };
}

/**
 * World pose of one motion piece in the Workpieces path frame (the pool adds
 * BELT_HEIGHT to y), or null when it has nowhere to be (lane beyond the cell).
 */
export function placeMotion(
  ctx: LineCtx,
  pm: PieceMotion,
  slots: WaitSlots,
): Placed | null {
  const c = ctx.cell;
  const y = ctx.floorY;
  const lane = pm.laneIndex ?? -1;
  switch (pm.segmentPath) {
    case "lane":
      return lanePose(ctx, lane, pm.t);
    case "queue": {
      if (pm.phase === "holding")
        return holdingSlot(ctx, slots.holding.get(pm.id) ?? 0);
      const rack = intakeSlot(ctx, slots.intake.get(pm.id) ?? 0);
      if (pm.phase !== "entering") return rack;
      const start = lanePose(ctx, lane, 0);
      return start ? lerpPose(rack, start, pm.t, 0.25) : rack;
    }
    case "rework": {
      const l = c.lanes[lane];
      if (!l) return null;
      const from = lanePose(ctx, lane, pm.fromT ?? 0);
      if (!from) return null;
      const bay: Placed = { x: l.reworkX, y, z: l.z, yaw: from.yaw };
      return lerpPose(from, bay, pm.t, 0.6);
    }
    case "trunk": {
      // Lane end → onto the trunk at the lane's z → feeder → main line.
      const end = lanePose(ctx, lane, 1);
      const z0 = end?.z ?? c.trunk.z1 - 0.4;
      const pts: Vec3[] = [
        { x: c.trunk.x, y, z: z0 },
        { x: c.trunk.x, y, z: c.trunk.feederZ },
        { x: 0, y, z: c.trunk.feederZ },
      ];
      if (end) pts.unshift({ x: end.x, y, z: end.z });
      return samplePolyline(pts, pm.t);
    }
    case "main":
      return samplePolyline(
        [
          { x: 0, y, z: c.trunk.feederZ },
          { x: 0, y, z: ctx.qcZ },
        ],
        pm.t,
      );
    case "dock": {
      if (pm.phase === "shipped")
        return shippedSlot(ctx, slots.shipped.get(pm.id) ?? 0);
      const py = y + LINE.DOCK_PLATFORM_H - BELT_HEIGHT;
      return samplePolyline(
        [
          { x: 0, y, z: ctx.qcZ },
          { x: 0, y, z: ctx.dockZ0 },
          { x: 0, y: py, z: ctx.dockZ0 + 0.6 },
          { x: 0, y: py, z: ctx.dockZ1 - LINE.DOCK_GANTRY_IN },
        ],
        pm.t,
      );
    }
    case "scrap": {
      const bin = scrapSlot(ctx, slots.scrap.get(pm.id) ?? 0);
      if (pm.phase === "scrapped") return bin;
      const from = lanePose(ctx, lane, pm.fromT ?? 0) ?? bin;
      return lerpPose(from, bin, pm.t, 1.2);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/** Rolled-up colour state of a piece (merged pieces read green). */
export function pieceState(w: Workpiece): CheckState {
  if (w.position.segment === "trunk") return "success";
  if (w.position.segment === "rework") return "failure";
  let s: CheckState = "none";
  for (const x of w.stationStates) if (x) s = worseState(s, x);
  return s;
}

export function pieceLook(
  w: Workpiece,
): Omit<PieceInstance, "id" | "t" | "lanePath" | "queueSlot"> {
  return {
    sizeClass: w.kind === "branch" ? "XS" : w.sizeClass,
    state: pieceState(w),
    draft: w.draft,
    bot: w.bot,
    labels: w.bands,
    tag: w.tag,
  };
}
