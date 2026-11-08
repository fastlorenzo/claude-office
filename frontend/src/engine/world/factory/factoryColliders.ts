/**
 * Factory-floor equipment colliders (G3): belts, inspection stations and the
 * cell furniture the player used to walk straight through.
 *
 *   belts     one box per straight piece of every conveyor path (lanes,
 *             trunks, main line; feeder ends trimmed at the target belt like
 *             the visual), ≤ 15° chord boxes on the filleted corners; top at
 *             the guide rails (≈ 1 m)
 *   stations  gantry uprights + arm pedestal, one box per station
 *   cells     one box per furniture cluster from `planCell` (QA desk with its
 *             stool and lamp, merge-gate posts, rework arch, intake rack per
 *             lane; holding rack, scrap bin, bench and bollards per cell).
 *             Floor markings, glows, tilted plates and the wall board (above
 *             head height) are left out.
 *
 * Everything is pure geometry (`factoryColliderBoxes`, Node-testable);
 * `syncFactoryColliders` registers the boxes in one collider group and
 * rebuilds it only when the box set changes (FactoryLines.applyModel calls
 * it on every model push).
 */
import { Vector3 } from "@/engine/babylon";
import type { FactoryLayout } from "@/engine/layout/factoryLayout";
import type { ColliderSink } from "@/engine/physics/Colliders";
import {
  buildPathGeom,
  CONVEYOR,
  evalAt,
  resolveMerges,
  slicePath,
  type PathGeom,
} from "./conveyorPlan";
import { planCell, type FurnitureKind, type Item } from "./cellPlan";
import { conveyorPaths } from "./lineAdapter";
import { acrossScale, STATION, type StationInstance } from "./stationPlan";

export const FACTORY_EQUIPMENT_GROUP = "factoryEquipment";

/** A yawed box: centre, full size, yaw (local +Z → (sin, cos)). */
export interface EquipBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

/** Guide rails stand this far above the belt top. */
const RAIL_TOP = 0.12;
/** Margin added around belts (skirts, rail brackets). */
const BELT_PAD = 0.04;

/** Lane-level clusters (one box per lane each). */
const LANE_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  "qaDesk",
  "qaLamp",
  "gatePost",
  "reworkArch",
  "intakeRack",
]);
/** Cell-level clusters (one box per kind). */
const CELL_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  "holdingRack",
  "scrapBin",
  "bench",
]);
/** Per-item boxes (small, spread out). */
const ITEM_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  "bollard",
]);
/** QA desk + its status lamp form one cluster. */
const CLUSTER_OF: Partial<Record<FurnitureKind, string>> = { qaLamp: "qaDesk" };

/** Line box between two plan points (centre on the segment). */
function segBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y0: number,
  h: number,
  w: number,
): EquipBox {
  const len = Math.hypot(bx - ax, bz - az);
  return {
    x: (ax + bx) / 2,
    y: y0 + h / 2,
    z: (az + bz) / 2,
    sx: w,
    sy: h,
    sz: len,
    yaw: Math.atan2(bx - ax, bz - az),
  };
}

function beltBoxes(g: PathGeom): EquipBox[] {
  const out: EquipBox[] = [];
  const h = g.height + RAIL_TOP;
  const w = g.width + BELT_PAD;
  // End covers: a little past the open ends (not past a merged end).
  const cover = 0.06;
  let s = 0;
  for (const p of g.pieces) {
    const a = s;
    const b = Math.min(s + p.len, g.end);
    s += p.len;
    if (b - a <= 1e-4) {
      if (s >= g.end) break;
      continue;
    }
    if (p.kind === "line") {
      const e0 = a <= 1e-6 ? cover : 0;
      const e1 = !g.merged && b >= g.end - 1e-6 ? cover : 0;
      const pa = evalAt(g, a);
      const pb = evalAt(g, b);
      out.push(
        segBox(
          pa.x - pa.tx * e0,
          pa.z - pa.tz * e0,
          pb.x + pb.tx * e1,
          pb.z + pb.tz * e1,
          g.y,
          h,
          w,
        ),
      );
    }
    if (s >= g.end) break;
  }
  // Corners: chord boxes, widened by the sagitta so the arc stays inside.
  for (const sl of slicePath(g)) {
    if (!Number.isFinite(sl.r)) continue;
    const pa = evalAt(g, sl.s0);
    const pb = evalAt(g, sl.s1);
    const ang = (sl.s1 - sl.s0) / sl.r;
    const sag = sl.r * (1 - Math.cos(ang / 2));
    const bx = segBox(pa.x, pa.z, pb.x, pb.z, g.y, h, w + 2 * sag);
    bx.sz += 0.05; // overlap the neighbours
    out.push(bx);
  }
  return out;
}

/** One station: uprights (± uprightZ, foot plates) through the pedestal. */
function stationBox(st: StationInstance): EquipBox {
  const S = STATION;
  const k = acrossScale(st);
  // Local footprint (station frame, +X downstream, Z across the belt).
  const x0 = -0.12;
  const x1 = S.pedestal.x + 0.17;
  const z0 = (S.pedestal.z - 0.17) * k;
  const z1 = (S.uprightZ + 0.1) * k;
  const lx = (x0 + x1) / 2;
  const lz = (z0 + z1) / 2;
  const c = Math.cos(st.yaw);
  const s = Math.sin(st.yaw);
  const h = S.boxY1;
  return {
    // Same rotation as poolMath.rotY / Babylon rotation.y.
    x: st.x + lx * c + lz * s,
    y: st.y + h / 2,
    z: st.z - lx * s + lz * c,
    sx: x1 - x0,
    sy: h,
    sz: z1 - z0,
    yaw: st.yaw,
  };
}

interface Aabb {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

function grow(a: Aabb | undefined, it: Item): Aabb {
  const c = Math.abs(Math.cos(it.yaw));
  const s = Math.abs(Math.sin(it.yaw));
  const hx = (c * it.sx + s * it.sz) / 2;
  const hz = (s * it.sx + c * it.sz) / 2;
  const b = {
    x0: it.x - hx,
    x1: it.x + hx,
    y0: it.y - it.sy / 2,
    y1: it.y + it.sy / 2,
    z0: it.z - hz,
    z1: it.z + hz,
  };
  if (!a) return b;
  return {
    x0: Math.min(a.x0, b.x0),
    x1: Math.max(a.x1, b.x1),
    y0: Math.min(a.y0, b.y0),
    y1: Math.max(a.y1, b.y1),
    z0: Math.min(a.z0, b.z0),
    z1: Math.max(a.z1, b.z1),
  };
}

const aabbBox = (a: Aabb): EquipBox => ({
  x: (a.x0 + a.x1) / 2,
  y: (a.y0 + a.y1) / 2,
  z: (a.z0 + a.z1) / 2,
  sx: a.x1 - a.x0,
  sy: a.y1 - a.y0,
  sz: a.z1 - a.z0,
  yaw: 0,
});

function cellBoxes(layout: FactoryLayout): EquipBox[] {
  const out: EquipBox[] = [];
  for (const cell of layout.cells) {
    const clusters = new Map<string, Aabb>();
    const lanes = cell.lanes.map((l) => l.z);
    for (const it of planCell(cell, null, "full").items) {
      if (it.part === "glow" || it.part === "plate" || it.rx || it.rz) continue;
      if (ITEM_KINDS.has(it.kind)) {
        out.push(aabbBox(grow(undefined, it)));
        continue;
      }
      let key: string;
      if (LANE_KINDS.has(it.kind)) {
        let lane = 0;
        if (CLUSTER_OF[it.kind] === "qaDesk" || it.kind === "qaDesk") {
          // QA desk, stool and lamp sit in the gap on the z0 side of their
          // lane (world −z on both sides): the first lane at or past them.
          lane = lanes.findIndex((z) => z >= it.z - 1e-6);
          if (lane < 0) lane = lanes.length - 1;
        } else
          for (let i = 1; i < lanes.length; i++)
            if (Math.abs(lanes[i] - it.z) < Math.abs(lanes[lane] - it.z))
              lane = i;
        key = `${CLUSTER_OF[it.kind] ?? it.kind}:${lane}`;
      } else if (CELL_KINDS.has(it.kind)) key = it.kind;
      else continue;
      clusters.set(key, grow(clusters.get(key), it));
    }
    for (const a of clusters.values()) out.push(aabbBox(a));
  }
  return out;
}

/** Every equipment box of the floor for this layout and station set. */
export function factoryColliderBoxes(
  layout: FactoryLayout,
  stations: readonly StationInstance[],
): EquipBox[] {
  const geoms = conveyorPaths(layout).map((p) =>
    buildPathGeom({ ...p, height: p.height ?? CONVEYOR.beltHeight }),
  );
  resolveMerges(geoms);
  return [
    ...geoms.flatMap(beltBoxes),
    ...stations.map(stationBox),
    ...cellBoxes(layout),
  ];
}

const keys = new WeakMap<ColliderSink, string>();

/**
 * Register the equipment boxes (rebuilt only when they change). `sink` is
 * the World's Colliders (absent in headless tests: no-op).
 */
export function syncFactoryColliders(
  sink: (ColliderSink & { disposeGroup(group: string): void }) | undefined,
  layout: FactoryLayout,
  stations: readonly StationInstance[],
): void {
  if (!sink) return;
  const boxes = factoryColliderBoxes(layout, stations);
  const key = boxes
    .map(
      (b) =>
        `${b.x.toFixed(2)},${b.z.toFixed(2)},${b.sx.toFixed(2)},${b.sz.toFixed(2)},${b.yaw.toFixed(2)}`,
    )
    .join(";");
  if (keys.get(sink) === key) return;
  keys.set(sink, key);
  sink.disposeGroup(FACTORY_EQUIPMENT_GROUP);
  for (const b of boxes)
    sink.addBox(
      FACTORY_EQUIPMENT_GROUP,
      new Vector3(b.x, b.y, b.z),
      new Vector3(b.sx, b.sy, b.sz),
      b.yaw,
    );
}
