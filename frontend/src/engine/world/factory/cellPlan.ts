/**
 * Cell dressing plan (pure, Node-testable): CellLayout + LineModel -> box
 * primitives for the ONE shared furniture pool, plus the header-board text and
 * the gate colour mapping. No Babylon import.
 *
 * Every piece of furniture is a composition of axis-aligned primitives drawn by
 * four thin-instanced meshes (so the whole plant stays at 4 draws):
 *
 *   box    unit box, satin metal, instance colour (frames, desks, racks, bins)
 *   cyl    unit cylinder (Y axis), same material (bollards, stools, poles)
 *   glow   unit box, unlit, HDR instance colour (lamps, arms, screens, digits)
 *   plate  unit box, lane number plates (tagged `lanePlate`, thin resolver)
 *
 * Frames: lane furniture is built in an "outward" frame at world x = 0 of the
 * lane (local +X = toward the outer wall, local Z flips with the side's yaw), so
 * east and west cells are exact 180 deg rotations of each other.
 */
import { CHECK_COLORS } from "@/engine/contracts";
import type { CellLayout, LaneLayout } from "@/engine/layout/factoryLayout";
import type { LineModel } from "@/engine/logic/factoryModel";
import { stateColor } from "@/engine/logic/factoryModel";
import {
  chain,
  hexToLinear,
  rotX,
  rotY,
  rotZ,
  scaling,
  translation,
  writeTRS,
} from "./poolMath";

export type CellDetail = "full" | "impostor" | "hidden";
export type FurniturePart = "box" | "cyl" | "glow" | "plate";
export const FURNITURE_PARTS: readonly FurniturePart[] = [
  "box",
  "cyl",
  "glow",
  "plate",
];

export type FurnitureKind =
  | "qaDesk"
  | "qaLamp"
  | "gatePost"
  | "gateLamp"
  | "gateArm"
  | "reworkArch"
  | "reworkMark"
  | "intakeRack"
  | "holdingRack"
  | "scrapBin"
  | "bench"
  | "techSpot"
  | "bollard"
  | "lanePlate"
  | "laneDigit"
  | "boardMount";

export interface Item {
  part: FurniturePart;
  kind: FurnitureKind;
  owner: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  /** Extra rotation about local X / Z before the yaw (arms, tilted plates). */
  rx?: number;
  rz?: number;
  /** Linear RGBA (alpha unused, HDR allowed for glow). */
  color: [number, number, number, number];
  /** Dropped at "impostor" detail. */
  minor?: boolean;
  lane?: number;
  /** Gate key for animated arms. */
  key?: string;
}

// ---------------------------------------------------------------------------
// Gate / QA state
// ---------------------------------------------------------------------------

export type GateState = "idle" | "review" | "pending" | "open" | "blocked";

export const GATE_HEX: Record<GateState, string> = {
  idle: "#475569",
  review: CHECK_COLORS.needs_you,
  pending: CHECK_COLORS.working,
  open: CHECK_COLORS.done,
  blocked: CHECK_COLORS.failure,
};

export function gateColor(state: GateState): string {
  return GATE_HEX[state];
}

/** Gate arm raised angle (rad) per state: only a mergeable piece opens it. */
export const GATE_OPEN_ANGLE = 1.25;
export function gateArmTarget(state: GateState): number {
  return state === "open" ? GATE_OPEN_ANGLE : 0;
}

/**
 * Review / mergeable state of a lane's QA desk and merge gate from the model:
 * blocked (conflict) > open (mergeable, t = 1) > pending (at the gate, not yet
 * mergeable) > review (at QA, review required) > idle.
 */
export function laneGateState(
  model: LineModel | null | undefined,
  lane: number,
): GateState {
  if (!model) return "idle";
  let state: GateState = "idle";
  for (const w of model.workpieces) {
    if (w.lane !== lane) continue;
    const seg = w.position.segment;
    if (seg === "gate") {
      if (w.stuck) return "blocked";
      if (w.position.t >= 1) return "open";
      state = "pending";
    } else if (seg === "qa" && state === "idle") state = "review";
  }
  return state;
}

// ---------------------------------------------------------------------------
// Header board text
// ---------------------------------------------------------------------------

export interface BoardSegment {
  text: string;
  color: string;
}

export interface BoardLine {
  /** Full single-line text (segments joined). Always starts with `model.header`. */
  text: string;
  segments: BoardSegment[];
  /** Status accent (main health). */
  dot: string;
}

const SEP = " · ";

/**
 * Header board content: `LineModel.header` (project · main health · PRs ·
 * failing · stale) followed by `LANES busy/max` and `n queued` for CI lines.
 */
export function boardLine(model: LineModel): BoardLine {
  const segments: BoardSegment[] = [];
  const parts = model.header.split(SEP);
  parts.forEach((p, i) => {
    let color = "#E6E8EB";
    if (i === 0) color = "#FFFFFF";
    else if (/failing/.test(p)) color = CHECK_COLORS.failure;
    else if (p === "STALE") color = CHECK_COLORS.needs_you;
    else if (/^LOCAL$|no CI/.test(p)) color = "#8E959C";
    segments.push({ text: i === 0 ? p : SEP + p, color });
  });
  if (model.mode === "ci") {
    const busy = model.laneBusy.filter(Boolean).length;
    segments.push({
      text: `${SEP}LANES ${busy}/${model.lanes}`,
      color: busy > 0 ? "#5EEAD4" : "#8E959C",
    });
    if (model.queued > 0)
      segments.push({
        text: `${SEP}${model.queued} queued`,
        color: CHECK_COLORS.needs_you,
      });
  }
  return {
    text: segments.map((s) => s.text).join(""),
    segments,
    dot: model.mode === "ci" ? stateColor(model.trunk.health) : "#475569",
  };
}

// ---------------------------------------------------------------------------
// Instance generation
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];
const hex = (h: string, k = 1): Rgba => {
  const [r, g, b] = hexToLinear(h);
  return [r * k, g * k, b * k, 1];
};

const C = {
  graphite: "#454B52",
  dark: "#2B2F34",
  steel: "#8E959C",
  alu: "#B4BAC0",
  white: "#E6E8EB",
  yellow: "#F2BE00",
  orange: "#C9791A",
  red: "#B3402B",
  dim: "#4A5159",
};

/** Digit segments a..g for 1..6 (7-segment, a top, b/c right, d bottom, e/f left, g mid). */
export const DIGIT_SEGMENTS: Record<number, string> = {
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgecd",
};

export const BOARD = { w: 8, h: 0.625 } as const;
const BEZEL = { pad: 0.28, depth: 0.1 };
const ARM_LEN = 1.24;
const ARM_Y = 1.15;

interface Frame {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

class Builder {
  readonly items: Item[] = [];
  constructor(
    readonly owner: string,
    readonly detail: CellDetail,
  ) {}

  add(
    f: Frame,
    part: FurniturePart,
    kind: FurnitureKind,
    local: [number, number, number],
    size: [number, number, number],
    color: Rgba,
    o: Partial<Item> = {},
  ): void {
    if (this.detail === "hidden" || (o.minor && this.detail === "impostor"))
      return;
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    const [lx, ly, lz] = local;
    this.items.push({
      part,
      kind,
      owner: this.owner,
      x: f.x + lx * c + lz * s,
      y: f.y + ly,
      z: f.z - lx * s + lz * c,
      yaw: f.yaw,
      sx: size[0],
      sy: size[1],
      sz: size[2],
      color,
      ...o,
    });
  }
}

export interface GateRef {
  key: string;
  lane: number;
  state: GateState;
  target: number;
  frame: Frame;
  /** Pivot in the lane frame. */
  pivot: [number, number, number];
}

export interface CellPlan {
  projectId: string;
  items: Item[];
  gates: GateRef[];
}

/** Arm item for a gate at `angle` rad (0 = closed across the belt). */
export function gateArmItem(
  g: GateRef,
  owner: string,
  angle: number,
  color: Rgba,
): Item {
  const { frame: f, pivot } = g;
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  // Arm points toward -z (local, along `zdir`) from the pivot; raised by angle.
  const zd = g.pivot[2] >= 0 ? -1 : 1;
  const lx = pivot[0];
  const ly = pivot[1] + (ARM_LEN / 2) * Math.sin(angle);
  const lz = pivot[2] + zd * (ARM_LEN / 2) * Math.cos(angle);
  return {
    part: "glow",
    kind: "gateArm",
    owner,
    x: f.x + lx * c + lz * s,
    y: f.y + ly,
    z: f.z - lx * s + lz * c,
    yaw: f.yaw,
    sx: 0.06,
    sy: 0.07,
    sz: ARM_LEN,
    // rotX positive raises an arm pointing -z; mirrored when pointing +z.
    rx: zd < 0 ? angle : -angle,
    color,
    lane: g.lane,
    key: g.key,
  };
}

/** Piece / bench / scrap counts used by the dressing. */
function scrapCount(model: LineModel | null | undefined): number {
  return model
    ? model.workpieces.filter((w) => w.position.segment === "scrap").length
    : 0;
}

function laneHasSegment(
  model: LineModel | null | undefined,
  lane: number,
  seg: string,
): boolean {
  return !!model?.workpieces.some(
    (w) => w.lane === lane && w.position.segment === seg,
  );
}

const sgn = (cell: CellLayout) => (cell.side === "east" ? 1 : -1);

/**
 * All furniture of one cell. `armAngles` (gate key -> current angle) lets the
 * pool keep a mid-swing arm across rebuilds; default is the target angle.
 */
export function planCell(
  cell: CellLayout,
  model: LineModel | null | undefined,
  detail: CellDetail = "full",
  armAngles?: ReadonlyMap<string, number>,
): CellPlan {
  const b = new Builder(cell.projectId, detail);
  const s = sgn(cell);
  const floorY = cell.bench.y;
  const gates: GateRef[] = [];
  /** World direction of "toward z0" expressed in the lane frame's local z. */
  const dz = s > 0 ? -1 : 1;
  const yawOf = s > 0 ? 0 : Math.PI;

  for (const lane of cell.lanes) {
    const f: Frame = { x: 0, y: floorY, z: lane.z, yaw: yawOf };
    laneFurniture(b, f, lane, dz, cell, model, armAngles, gates);
  }

  const origin = (
    p: { x: number; y: number; z: number },
    yaw: number,
  ): Frame => ({
    x: p.x,
    y: p.y,
    z: p.z,
    yaw,
  });
  const cf = origin({ x: 0, y: floorY, z: 0 }, yawOf);
  holdingRack(b, origin(cell.holding, yawOf));
  scrapBin(b, origin(cell.scrap, yawOf), scrapCount(model));
  bench(b, origin(cell.bench, yawOf), model);
  techSpot(b, origin(cell.technician, yawOf));
  bollards(b, cf, cell, s);
  boardMount(b, cell);

  return { projectId: cell.projectId, items: b.items, gates };
}

function laneFurniture(
  b: Builder,
  f: Frame,
  lane: LaneLayout,
  dz: number,
  cell: CellLayout,
  model: LineModel | null | undefined,
  armAngles: ReadonlyMap<string, number> | undefined,
  gates: GateRef[],
): void {
  const state = laneGateState(model, lane.index);
  const sc = hex(GATE_HEX[state], state === "idle" ? 0.5 : 1.35);
  const qaX = Math.abs(lane.qaX);
  const gateX = Math.abs(lane.gateX);
  const reworkX = Math.abs(lane.reworkX);
  const intakeX = Math.abs(lane.intakeX);

  // ---- QA desk (between this lane and the previous, operator facing away)
  {
    const z = dz * 0.98;
    b.add(
      f,
      "box",
      "qaDesk",
      [qaX, 0.37, z],
      [1.0, 0.74, 0.5],
      hex(C.graphite),
    );
    b.add(f, "box", "qaDesk", [qaX, 0.765, z], [1.08, 0.04, 0.58], hex(C.alu));
    b.add(
      f,
      "box",
      "qaDesk",
      [qaX, 1.0, z + dz * 0.12],
      [0.58, 0.34, 0.03],
      hex(C.dark),
    );
    b.add(
      f,
      "glow",
      "qaDesk",
      [qaX, 1.0, z + dz * 0.14],
      [0.52, 0.28, 0.01],
      sc,
    );
    b.add(
      f,
      "cyl",
      "qaDesk",
      [qaX + 0.05, 0.84, z + dz * 0.12],
      [0.05, 0.14, 0.05],
      hex(C.steel),
      { minor: true },
    );
    // stool
    b.add(
      f,
      "cyl",
      "qaDesk",
      [qaX, 0.46, z + dz * 0.75],
      [0.34, 0.05, 0.34],
      hex(C.dark),
      { minor: true },
    );
    b.add(
      f,
      "cyl",
      "qaDesk",
      [qaX, 0.22, z + dz * 0.75],
      [0.05, 0.44, 0.05],
      hex(C.steel),
      { minor: true },
    );
    // status tower lamp (visible from the whole aisle)
    b.add(
      f,
      "cyl",
      "qaLamp",
      [qaX - 0.4, 1.0, z - dz * 0.18],
      [0.03, 0.4, 0.03],
      hex(C.steel),
    );
    b.add(
      f,
      "glow",
      "qaLamp",
      [qaX - 0.4, 1.26, z - dz * 0.18],
      [0.08, 0.13, 0.08],
      sc,
    );
  }

  // ---- merge gate: two posts, signal head, barrier arm
  {
    const pz = 0.62;
    // the arm hangs on the post at +z and sweeps across the belt toward -z
    const armPivotZ = pz;
    const piv: [number, number, number] = [gateX, ARM_Y, armPivotZ];
    for (const zz of [-pz, pz]) {
      b.add(
        f,
        "box",
        "gatePost",
        [gateX, 0.012, zz],
        [0.32, 0.024, 0.3],
        hex(C.dark),
      );
      b.add(
        f,
        "box",
        "gatePost",
        [gateX, 0.65, zz],
        [0.1, 1.3, 0.1],
        hex(C.graphite),
      );
    }
    b.add(
      f,
      "box",
      "gatePost",
      [gateX, 1.37, armPivotZ],
      [0.16, 0.16, 0.16],
      hex(C.dark),
    );
    b.add(
      f,
      "glow",
      "gateLamp",
      [gateX, 1.37, armPivotZ - 0.081],
      [0.1, 0.1, 0.012],
      sc,
    );
    b.add(
      f,
      "glow",
      "gateLamp",
      [gateX, 1.37, armPivotZ + 0.081],
      [0.1, 0.1, 0.012],
      sc,
    );
    b.add(
      f,
      "box",
      "gatePost",
      [gateX, 0.2, armPivotZ + 0.06],
      [0.07, 0.02, 0.02],
      hex(C.yellow),
      { minor: true },
    );
    const key = `${cell.projectId}:${lane.index}`;
    const ref: GateRef = {
      key,
      lane: lane.index,
      state,
      target: gateArmTarget(state),
      frame: f,
      pivot: piv,
    };
    gates.push(ref);
    const angle = armAngles?.get(key) ?? ref.target;
    if (b.detail !== "hidden")
      b.items.push(gateArmItem(ref, cell.projectId, angle, sc));
  }

  // ---- rework loop marker: arch + amber bar + floor chevrons
  {
    const active = laneHasSegment(model, lane.index, "rework");
    const amber = hex("#FFB020", active ? 1.5 : 0.35);
    const pz = 0.64;
    for (const zz of [-pz, pz])
      b.add(
        f,
        "box",
        "reworkArch",
        [reworkX, 1.0, zz],
        [0.08, 2.0, 0.08],
        hex(C.steel),
      );
    b.add(
      f,
      "box",
      "reworkArch",
      [reworkX, 2.05, 0],
      [0.14, 0.1, 1.4],
      hex(C.graphite),
    );
    b.add(
      f,
      "glow",
      "reworkArch",
      [reworkX, 1.985, 0],
      [0.07, 0.03, 1.12],
      amber,
    );
    for (const k of [-1, 1]) {
      b.add(
        f,
        "glow",
        "reworkMark",
        [reworkX + 0.55, 0.006, dz * 0.85 + k * 0.15],
        [0.42, 0.012, 0.06],
        amber,
        { minor: true, yaw: f.yaw + k * 0.6 },
      );
    }
  }

  // ---- intake rack behind the belt start
  {
    const rx = intakeX + 1.1;
    const w = 1.3;
    for (const [ux, uz] of [
      [-0.32, -w / 2],
      [0.32, -w / 2],
      [-0.32, w / 2],
      [0.32, w / 2],
    ])
      b.add(
        f,
        "box",
        "intakeRack",
        [rx + ux, 0.85, uz],
        [0.06, 1.7, 0.06],
        hex(C.graphite),
      );
    for (const y of [0.3, 0.95, 1.6])
      b.add(f, "box", "intakeRack", [rx, y, 0], [0.7, 0.035, w], hex(C.steel));
    b.add(
      f,
      "box",
      "intakeRack",
      [rx - 0.34, 0.3, 0],
      [0.03, 0.06, w],
      hex(C.yellow),
      { minor: true },
    );
  }

  // ---- lane number plate (tilted, 7-segment digit in glow)
  {
    const px = intakeX;
    const pz = dz * 1.0;
    const phi = 0.9;
    const a = -phi; // rotZ angle: face (-x) tilts up
    const cy = 0.62;
    b.add(
      f,
      "box",
      "lanePlate",
      [px, 0.26, pz],
      [0.1, 0.52, 0.1],
      hex(C.graphite),
      { minor: true },
    );
    b.add(
      f,
      "plate",
      "lanePlate",
      [px, cy, pz],
      [0.04, 0.5, 0.84],
      hex(C.dark),
      {
        rz: a,
        lane: lane.index,
      },
    );
    const lit = model?.laneBusy[lane.index] ?? false;
    const dc = lit ? hex("#5EEAD4", 1.6) : hex("#64748B", 0.8);
    const segs = DIGIT_SEGMENTS[lane.index + 1] ?? "g";
    const H = 0.13;
    const W = 0.062;
    const place = (sv: number, sw: number, len: [number, number]) => {
      const t = -0.026;
      const px2 = t * Math.cos(a) - sv * Math.sin(a);
      const py2 = t * Math.sin(a) + sv * Math.cos(a);
      b.add(
        f,
        "glow",
        "laneDigit",
        [px + px2, cy + py2, pz + sw],
        [0.012, len[0], len[1]],
        dc,
        {
          rz: a,
          lane: lane.index,
          minor: true,
        },
      );
    };
    const R = -W; // viewer's right is -z in the outward frame
    const L = W;
    const horiz: [number, number] = [0.03, 0.11];
    const vert: [number, number] = [0.12, 0.03];
    if (segs.includes("a")) place(H, 0, horiz);
    if (segs.includes("g")) place(0, 0, horiz);
    if (segs.includes("d")) place(-H, 0, horiz);
    if (segs.includes("b")) place(H / 2, R, vert);
    if (segs.includes("c")) place(-H / 2, R, vert);
    if (segs.includes("f")) place(H / 2, L, vert);
    if (segs.includes("e")) place(-H / 2, L, vert);
  }
}

function holdingRack(b: Builder, f: Frame): void {
  const w = 2.6;
  const d = 0.9;
  for (const x of [-d / 2, d / 2])
    for (const z of [-w / 2, 0, w / 2])
      b.add(
        f,
        "box",
        "holdingRack",
        [x, 1.0, z],
        [0.07, 2.0, 0.07],
        hex(C.graphite),
      );
  for (const y of [0.3, 0.95, 1.6]) {
    b.add(f, "box", "holdingRack", [0, y, 0], [d, 0.03, w], hex(C.dim));
    for (const x of [-d / 2, d / 2])
      b.add(
        f,
        "box",
        "holdingRack",
        [x, y - 0.045, 0],
        [0.04, 0.09, w],
        hex(C.orange),
        { minor: true },
      );
  }
  b.add(
    f,
    "glow",
    "holdingRack",
    [-d / 2 - 0.045, 1.95, 0],
    [0.012, 0.06, 1.0],
    hex("#FFB020", 0.5),
    { minor: true },
  );
}

function scrapBin(b: Builder, f: Frame, count: number): void {
  b.add(f, "box", "scrapBin", [0, 0.04, 0], [1.0, 0.06, 1.5], hex(C.dark));
  b.add(
    f,
    "box",
    "scrapBin",
    [-0.5, 0.45, 0],
    [0.04, 0.8, 1.5],
    hex(C.graphite),
  );
  b.add(
    f,
    "box",
    "scrapBin",
    [0.5, 0.45, 0],
    [0.04, 0.8, 1.5],
    hex(C.graphite),
  );
  b.add(
    f,
    "box",
    "scrapBin",
    [0, 0.45, -0.75],
    [1.0, 0.8, 0.04],
    hex(C.graphite),
  );
  b.add(
    f,
    "box",
    "scrapBin",
    [0, 0.45, 0.75],
    [1.0, 0.8, 0.04],
    hex(C.graphite),
  );
  b.add(f, "box", "scrapBin", [-0.52, 0.8, 0], [0.04, 0.05, 1.54], hex(C.red), {
    minor: true,
  });
  b.add(f, "box", "scrapBin", [0.52, 0.8, 0], [0.04, 0.05, 1.54], hex(C.red), {
    minor: true,
  });
  for (let i = 0; i < Math.min(3, count); i++)
    b.add(
      f,
      "box",
      "scrapBin",
      [(i - 1) * 0.22, 0.24 + i * 0.03, i % 2 ? 0.2 : -0.25],
      [0.4, 0.28, 0.3],
      hex("#3A3F46"),
      {
        rz: 0.3 * (i - 1),
        minor: true,
      },
    );
  b.add(
    f,
    "glow",
    "scrapBin",
    [-0.525, 0.55, 0],
    [0.012, 0.08, 0.3],
    count > 0 ? hex(CHECK_COLORS.failure, 1.4) : hex("#475569", 0.5),
  );
}

function bench(
  b: Builder,
  f: Frame,
  model: LineModel | null | undefined,
): void {
  const bm = model?.bench;
  const w = 1.8;
  b.add(f, "box", "bench", [0, 0.92, 0], [0.8, 0.05, w], hex(C.alu));
  for (const x of [-0.34, 0.34])
    for (const z of [-w / 2 + 0.08, w / 2 - 0.08])
      b.add(
        f,
        "box",
        "bench",
        [x, 0.45, z],
        [0.06, 0.9, 0.06],
        hex(C.graphite),
      );
  b.add(f, "box", "bench", [0, 0.25, 0], [0.7, 0.03, w - 0.1], hex(C.dim));
  b.add(f, "box", "bench", [0.4, 1.45, 0], [0.04, 1.0, w], hex(C.graphite));
  const lamp = bm?.failing
    ? hex(CHECK_COLORS.failure, 1.5)
    : bm?.active
      ? hex(CHECK_COLORS.working, 1.4)
      : hex("#475569", 0.5);
  b.add(
    f,
    "glow",
    "bench",
    [0.37, 1.75, 0],
    [0.012, 0.5, 1.2],
    hex(bm?.active ? "#22D3EE" : "#334155", bm?.active ? 0.6 : 0.5),
  );
  b.add(f, "glow", "bench", [0.37, 1.2, 0.7], [0.02, 0.1, 0.1], lamp);
  // laptop
  b.add(f, "box", "bench", [-0.05, 0.96, 0.1], [0.3, 0.02, 0.22], hex(C.dark), {
    minor: true,
  });
  b.add(
    f,
    "glow",
    "bench",
    [-0.18, 1.08, 0.1],
    [0.01, 0.2, 0.22],
    hex("#8FB8FF", 0.7),
    { minor: true },
  );
  // dirty files: small paper stacks
  const n = Math.min(5, bm?.dirtyFiles ?? 0);
  for (let i = 0; i < n; i++)
    b.add(
      f,
      "box",
      "bench",
      [
        0.05 + (i % 2) * 0.15,
        0.965 + Math.floor(i / 2) * 0.012,
        -0.5 - (i % 3) * 0.18,
      ],
      [0.14, 0.01, 0.2],
      hex(C.white),
      {
        minor: true,
      },
    );
}

function techSpot(b: Builder, f: Frame): void {
  const h = 0.6;
  for (const [x, z, sx, sz] of [
    [h, 0, 0.05, 2 * h],
    [-h, 0, 0.05, 2 * h],
    [0, h, 2 * h, 0.05],
    [0, -h, 2 * h, 0.05],
  ] as const)
    b.add(
      f,
      "box",
      "techSpot",
      [x, 0.004, z],
      [sx, 0.008, sz],
      hex(C.yellow, 0.8),
      { minor: true },
    );
}

function bollards(b: Builder, f: Frame, cell: CellLayout, s: number): void {
  const tx = Math.abs(cell.trunk.x);
  for (const x of [tx - 2.2, tx - 5.2])
    for (const dz of [-0.95, 0.95]) {
      const lz = cell.trunk.feederZ + dz - f.z;
      // local x is |x| (outward frame); z flips with the side
      const z = s > 0 ? lz : -lz;
      b.add(
        f,
        "cyl",
        "bollard",
        [x, 0.45, z],
        [0.16, 0.9, 0.16],
        hex(C.yellow, 0.9),
        { minor: true },
      );
      b.add(
        f,
        "cyl",
        "bollard",
        [x, 0.62, z],
        [0.17, 0.07, 0.17],
        hex(C.dark),
        { minor: true },
      );
      b.add(
        f,
        "cyl",
        "bollard",
        [x, 0.91, z],
        [0.12, 0.02, 0.12],
        hex(C.graphite),
        { minor: true },
      );
    }
}

function boardMount(b: Builder, cell: CellLayout): void {
  const f: Frame = { ...cell.board.position, yaw: cell.board.yaw + Math.PI };
  b.add(
    f,
    "box",
    "boardMount",
    [0, 0, BEZEL.depth * 0.7],
    [BOARD.w + BEZEL.pad, BOARD.h + BEZEL.pad, BEZEL.depth],
    hex(C.graphite),
  );
  b.add(
    f,
    "box",
    "boardMount",
    [0, -(BOARD.h + BEZEL.pad) / 2 - 0.02, BEZEL.depth * 0.7],
    [BOARD.w + BEZEL.pad, 0.04, BEZEL.depth + 0.02],
    hex(C.steel),
  );
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/** Matrix of one item (TRS fast path; rx / rz compose before the yaw). */
export function writeItem(out: Float32Array, offset: number, it: Item): void {
  if (!it.rx && !it.rz) {
    writeTRS(out, offset, it.x, it.y, it.z, it.yaw, it.sx, it.sy, it.sz);
    return;
  }
  const m = chain(
    scaling(it.sx, it.sy, it.sz),
    rotX(it.rx ?? 0),
    rotZ(it.rz ?? 0),
    rotY(it.yaw),
    translation(it.x, it.y, it.z),
  );
  out.set(m, offset);
}

export interface PackedPart {
  mats: Float32Array;
  cols: Float32Array;
  count: number;
}

export function packPart(
  items: readonly Item[],
  part: FurniturePart,
): PackedPart {
  const list = items.filter((i) => i.part === part);
  const mats = new Float32Array(list.length * 16);
  const cols = new Float32Array(list.length * 4);
  list.forEach((it, i) => {
    writeItem(mats, i * 16, it);
    cols.set(it.color, i * 4);
  });
  return { mats, cols, count: list.length };
}

/** Furniture instance key of a cell: layout geometry + everything the plan reads. */
export function cellFurnitureKey(
  cell: CellLayout,
  model: LineModel | null | undefined,
  detail: CellDetail,
): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  const lanes = cell.lanes
    .map((l) => [
      r(l.z),
      r(l.qaX),
      r(l.gateX),
      r(l.reworkX),
      r(l.intakeX),
      laneGateState(model, l.index),
      model?.laneBusy[l.index] ? 1 : 0,
      laneHasSegment(model, l.index, "rework") ? 1 : 0,
    ])
    .join("|");
  const bm = model?.bench;
  return [
    cell.projectId,
    cell.side,
    detail,
    lanes,
    [cell.bench, cell.holding, cell.scrap, cell.technician, cell.board.position]
      .map((p) => `${r(p.x)},${r(p.y)},${r(p.z)}`)
      .join(";"),
    r(cell.trunk.feederZ),
    r(cell.trunk.x),
    scrapCount(model),
    bm
      ? [bm.active ? 1 : 0, bm.failing ? 1 : 0, Math.min(5, bm.dirtyFiles)]
      : "",
  ].join("#");
}
