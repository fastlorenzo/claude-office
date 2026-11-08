import { describe, expect, it } from "vitest";
import { CHECK_COLORS } from "@/engine/contracts";
import { CI_COLORS } from "@/engine/logic/statusPalette";
import type { CheckState } from "@/engine/contracts";
import {
  CONVEYOR,
  CONVEYOR_COLORS,
  buildConveyorSegments,
  buildPathGeom,
  conveyorKey,
  evalAt,
  packBoxes,
  slicePath,
  type ConveyorPath,
} from "@/engine/world/factory/conveyorPlan";
import {
  chain,
  hexToLinear,
  rotY,
  rotZ,
  scaling,
  transformPoint,
  translation,
  writeTRS,
  yawOf,
} from "@/engine/world/factory/poolMath";
import {
  BEACON_OFF,
  GLYPH_KINDS,
  STATION,
  armMatrices,
  armPoseFor,
  beaconBase,
  beaconColor,
  beaconLevel,
  drumApothem,
  glyphIndex,
  glyphMatrices,
  orderStations,
  stationKey,
  writeBeaconColors,
  type StationInstance,
} from "@/engine/world/factory/stationPlan";

const lane = (id: string, z: number, x0 = 20, x1 = 8.5): ConveyorPath => ({
  id,
  kind: "lane",
  width: 0.9,
  points: [
    { x: x0, y: 0, z },
    { x: x1, y: 0, z },
  ],
});

const close = (a: number, b: number, eps = 1e-4) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

// ---------------------------------------------------------------------------
// Matrix packing
// ---------------------------------------------------------------------------

describe("poolMath", () => {
  it("writeTRS equals scale · yaw · translate (Babylon row-vector layout)", () => {
    const out = new Float32Array(16);
    writeTRS(out, 0, 1, 2, 3, 0.7, 2, 3, 4);
    const ref = chain(scaling(2, 3, 4), rotY(0.7), translation(1, 2, 3));
    for (let i = 0; i < 16; i++) close(out[i], ref[i]);
    // Translation sits in elements 12..14.
    expect([out[12], out[13], out[14], out[15]]).toEqual([1, 2, 3, 1]);
  });

  it("yawOf turns local +X onto the given direction", () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0.6, -0.8],
    ]) {
      const p = transformPoint(rotY(yawOf(dx, dz)), 1, 0, 0);
      close(p[0], dx);
      close(p[2], dz);
    }
  });

  it("rotZ tilts +Y toward −X for positive angles (Babylon RotationZ)", () => {
    const p = transformPoint(rotZ(Math.PI / 2), 0, 1, 0);
    close(p[0], -1);
    close(p[1], 0);
  });

  it("hexToLinear uses the 2.2 curve", () => {
    const [r, g, b] = hexToLinear("#ff8000");
    close(r, 1);
    close(g, Math.pow(128 / 255, 2.2));
    close(b, 0);
  });
});

// ---------------------------------------------------------------------------
// Conveyor segments
// ---------------------------------------------------------------------------

describe("conveyor path geometry", () => {
  it("slices a straight path into ≈ 1 m segments covering its length", () => {
    const g = buildPathGeom(lane("a", 0, 20, 8.5)); // 11.5 m
    const sl = slicePath(g);
    expect(sl.length).toBe(Math.round(11.5 / CONVEYOR.segment));
    for (const s of sl) {
      expect(s.s1 - s.s0).toBeGreaterThan(0.95);
      expect(s.s1 - s.s0).toBeLessThan(1.05);
    }
    close(sl[0].s0, 0);
    close(sl[sl.length - 1].s1, 11.5);
    // Contiguous.
    for (let i = 1; i < sl.length; i++) close(sl[i].s0, sl[i - 1].s1);
  });

  it("fillets corners with a tangent arc sliced at ≤ 15°", () => {
    const g = buildPathGeom({
      id: "t",
      kind: "trunk",
      width: 0.9,
      points: [
        { x: 8.5, y: 0, z: 10 },
        { x: 8.5, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
    });
    const arcs = g.pieces.filter((p) => p.kind === "arc");
    expect(arcs).toHaveLength(1);
    const arc = arcs[0];
    const R = Math.max(CONVEYOR.minRadius, CONVEYOR.radiusPerWidth * 0.9);
    if (arc.kind !== "arc") throw new Error("arc");
    close(arc.r, R);
    close(Math.abs(arc.sweep), Math.PI / 2);
    // Total length = two straights shortened by R each + quarter circle.
    close(g.length, 10 - R + (8.5 - R) + (Math.PI / 2) * R, 1e-3);
    const arcSlices = slicePath(g).filter((s) => Number.isFinite(s.r));
    expect(arcSlices.length).toBe(6); // 90° / 15°
    // Tangent continuity at both ends of the arc.
    const sA = 10 - R;
    const before = evalAt(g, sA - 1e-3);
    const after = evalAt(g, sA + 1e-3);
    close(before.tx, after.tx, 1e-2);
    close(before.tz, after.tz, 1e-2);
    const end = evalAt(g, g.length);
    close(end.x, 0, 1e-6);
    close(end.z, 0, 1e-6);
    close(end.tx, -1, 1e-6);
  });

  it("clamps the fillet when legs are short", () => {
    const g = buildPathGeom({
      id: "s",
      kind: "lane",
      width: 0.9,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 0.6, y: 0, z: 0 },
        { x: 0.6, y: 0, z: 0.6 },
      ],
    });
    const arc = g.pieces.find((p) => p.kind === "arc");
    if (!arc || arc.kind !== "arc") throw new Error("arc");
    expect(arc.r).toBeLessThanOrEqual(0.6 + 1e-9);
  });
});

describe("conveyor segments", () => {
  const paths: ConveyorPath[] = [
    lane("l0", 1.2),
    lane("l1", 3.6),
    lane("l2", 6.0),
    {
      id: "trunk",
      kind: "trunk",
      width: 0.9,
      points: [
        { x: 8.5, y: 0, z: 7.4 },
        { x: 8.5, y: 0, z: -1.2 },
        { x: 0, y: 0, z: -1.2 },
      ],
    },
    {
      id: "main",
      kind: "main",
      width: 1.1,
      points: [
        { x: 0, y: 0, z: -10 },
        { x: 0, y: 0, z: 16 },
      ],
    },
  ];

  it("detects lane → trunk and trunk → main merges and trims feeders", () => {
    const seg = buildConveyorSegments(paths);
    expect(seg.merges.map((m) => `${m.from}>${m.into}`).sort()).toEqual([
      "l0>trunk",
      "l1>trunk",
      "l2>trunk",
      "trunk>main",
    ]);
    const l0 = seg.geoms.find((g) => g.id === "l0")!;
    // Lane ends at the trunk's belt edge (x = 8.5 + 0.45).
    const e = evalAt(l0, l0.end);
    close(e.x, 8.5 + 0.45 + CONVEYOR.mergeGap, 1e-3);
    expect(l0.merged).toBe(true);
    const trunk = seg.geoms.find((g) => g.id === "trunk")!;
    close(evalAt(trunk, trunk.end).x, 0.55 + CONVEYOR.mergeGap, 1e-3);
    // Lanes merge on the trunk's +X side; heading −Z, the left normal (−tz, tx) is +X.
    const m = seg.merges.find((x) => x.from === "l1")!;
    expect(m.side).toBe(1);
    close(m.s, 7.4 - 3.6, 1e-3);
  });

  it("emits one belt box per slice, at belt height, and opens rails at merges", () => {
    const seg = buildConveyorSegments(paths);
    const nSlices = seg.geoms.reduce((a, g) => a + slicePath(g).length, 0);
    expect(seg.belt.length).toBe(nSlices);
    for (const b of seg.belt) {
      close(b.y + b.sy / 2, CONVEYOR.beltHeight, 3e-3);
      expect(b.sx).toBeLessThan(1.2);
    }
    // Rail segments on the trunk's right side never cover a lane opening.
    const trunk = seg.geoms.find((g) => g.id === "trunk")!;
    const rails = seg.guard.filter(
      (gd) =>
        gd.color &&
        Math.abs(gd.color[0] - hexToLinear(CONVEYOR_COLORS.rail)[0]) < 1e-6 &&
        Math.abs(gd.x - (8.5 + 0.42)) < 0.02,
    );
    expect(rails.length).toBeGreaterThan(0);
    for (const z of [1.2, 3.6, 6.0]) {
      const covering = rails.filter((r) => Math.abs(r.z - z) < r.sx / 2 - 1e-3);
      expect(covering).toHaveLength(0);
    }
    expect(trunk.merged).toBe(true);
  });

  it("puts legs on the floor and yellow bumpers only on open ends", () => {
    const seg = buildConveyorSegments(paths);
    const legColor = hexToLinear(CONVEYOR_COLORS.leg);
    const legs = seg.frame.filter(
      (f) => f.color === undefined || f.color[0] === legColor[0],
    );
    const vertical = legs.filter((f) => f.sy > 0.5);
    expect(vertical.length).toBeGreaterThan(10);
    for (const l of vertical) close(l.y - l.sy / 2, 0, 1e-6);
    const yellow = hexToLinear(CONVEYOR_COLORS.bumper);
    const bumpers = seg.guard.filter((g) => g.color?.[0] === yellow[0]);
    // 5 path starts + only the main line's (unmerged) end.
    expect(bumpers).toHaveLength(6);
  });

  it("curved slices stretch the belt to the outer chord (no wedge gaps)", () => {
    const seg = buildConveyorSegments([paths[3]]);
    const g = seg.geoms[0];
    const sl = slicePath(g);
    const arcIdx = sl.findIndex((s) => Number.isFinite(s.r));
    const s = sl[arcIdx];
    const a = evalAt(g, s.s0);
    const b = evalAt(g, s.s1);
    const chord = Math.hypot(b.x - a.x, b.z - a.z);
    expect(seg.belt[arcIdx].sx).toBeGreaterThan(
      (chord * (s.r + 0.45)) / s.r - 1e-6,
    );
  });

  it("conveyorKey changes only with geometry", () => {
    const k = conveyorKey(paths);
    expect(conveyorKey(paths.map((p) => ({ ...p })))).toBe(k);
    const moved = paths.map((p, i) =>
      i === 0 ? { ...p, points: [{ x: 21, y: 0, z: 1.2 }, p.points[1]] } : p,
    );
    expect(conveyorKey(moved)).not.toBe(k);
  });

  it("packBoxes writes 16 floats + RGBA per instance", () => {
    const seg = buildConveyorSegments([lane("x", 0, 3, 0)]);
    const n = seg.frame.length;
    const mats = new Float32Array(n * 16);
    const cols = new Float32Array(n * 4);
    expect(packBoxes(seg.frame, mats, cols)).toBe(n);
    const f = seg.frame[0];
    expect(mats[12]).toBeCloseTo(f.x, 5);
    expect(mats[13]).toBeCloseTo(f.y, 5);
    expect(mats[14]).toBeCloseTo(f.z, 5);
    expect(cols[3]).toBe(1);
    expect(cols[0]).toBeCloseTo(f.color![0], 6);
  });
});

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

const station = (
  id: string,
  state: CheckState,
  extra: Partial<StationInstance> = {},
): StationInstance => ({
  id,
  x: 20,
  y: 0,
  z: 1.2,
  yaw: Math.PI,
  state,
  kind: "test",
  ...extra,
});

describe("station colours", () => {
  it("beacon base colours come from CHECK_COLORS via stateColor", () => {
    expect(beaconBase("failure")).toEqual(hexToLinear(CHECK_COLORS.failure));
    expect(beaconBase("success")).toEqual(hexToLinear(CHECK_COLORS.done));
    expect(beaconBase("running")).toEqual(hexToLinear(CHECK_COLORS.working));
    expect(beaconBase("queued")).toEqual(hexToLinear(CI_COLORS.queued));
  });

  it("lit beacons are HDR (bloom), unlit lenses are a neutral grey", () => {
    const c = beaconColor("success", 0);
    expect(Math.max(...c)).toBeGreaterThan(1);
    expect(beaconColor("none", 0)).toEqual(BEACON_OFF);
    expect(beaconColor("cancelled", 3)).toEqual(BEACON_OFF);
  });

  it("running breathes, failure strobes, others are steady", () => {
    const run = [0, 0.3, 0.6, 0.9].map((t) => beaconLevel("running", t));
    expect(Math.max(...run) - Math.min(...run)).toBeGreaterThan(1);
    expect(beaconLevel("failure", 0.03)).toBeGreaterThan(
      beaconLevel("failure", 0.5) * 4,
    );
    expect(beaconLevel("success", 0)).toBe(beaconLevel("success", 0.77));
  });

  it("writeBeaconColors fills RGBA for the animated prefix only", () => {
    const { order, animated } = orderStations([
      station("a", "success"),
      station("b", "failure"),
      station("c", "none"),
      station("d", "running"),
    ]);
    expect(animated).toBe(2);
    expect(order.slice(0, 2).map((s) => s.id)).toEqual(["b", "d"]);
    const out = new Float32Array(16).fill(-1);
    writeBeaconColors(order, animated, 0.03, out);
    expect(out[3]).toBe(1);
    expect(out[7]).toBe(1);
    expect(out[8]).toBe(-1); // untouched beyond the prefix
  });
});

describe("station geometry", () => {
  it("maps every CheckKind to a glyph row", () => {
    expect(GLYPH_KINDS).toHaveLength(STATION.glyph.faces);
    expect(glyphIndex("lint")).toBe(0);
    expect(glyphIndex("other")).toBe(GLYPH_KINDS.length - 1);
    expect(new Set(GLYPH_KINDS.map(glyphIndex)).size).toBe(GLYPH_KINDS.length);
  });

  it("the chosen drum face sits flush on the sensor box, facing outward", () => {
    const st = station("s", "running", {
      kind: "security",
      x: 0,
      z: 0,
      yaw: 0,
    });
    const [front, back] = glyphMatrices(st);
    const a = drumApothem();
    const step = (2 * Math.PI) / STATION.glyph.faces;
    const k = glyphIndex("security");
    // Centre of face k in drum space (authored as rotZ(−k·step) of +X face).
    const local = transformPoint(rotZ(-k * step), a, 0, 0);
    const f = transformPoint(front, local[0], local[1], local[2]);
    close(f[0], STATION.boxX + 0.002, 1e-5);
    close(f[1], STATION.glyph.y, 1e-5);
    const b = transformPoint(back, local[0], local[1], local[2]);
    close(b[0], -(STATION.boxX + 0.002), 1e-5);
    // The drum stays inside the sensor box vertically.
    const R = STATION.glyph.h / (2 * Math.sin(Math.PI / STATION.glyph.faces));
    expect(STATION.glyph.y + R).toBeLessThanOrEqual(STATION.boxY1);
    expect(STATION.glyph.y - R).toBeGreaterThanOrEqual(STATION.boxY0);
  });

  it("running arm reaches over the belt, parked arm stays clear of it", () => {
    const st = station("s", "running", { x: 0, z: 0, yaw: 0 });
    const tip = (state: CheckState) => {
      const [, , m3] = armMatrices(st, armPoseFor(state));
      return transformPoint(m3, 0, STATION.arm.tool, 0);
    };
    const run = tip("running");
    expect(Math.abs(run[2])).toBeLessThan(0.2); // over the belt centreline
    expect(run[1]).toBeGreaterThan(CONVEYOR.beltHeight + 0.1);
    expect(run[1]).toBeLessThan(STATION.boxY0);
    const park = tip("success");
    expect(park[2]).toBeLessThan(-0.3); // pedestal side
  });

  it("stationKey ignores order-independent noise and tracks state", () => {
    const list = [station("a", "success"), station("b", "queued")];
    const k = stationKey(list);
    expect(stationKey(list.map((s) => ({ ...s })))).toBe(k);
    expect(stationKey([list[0], { ...list[1], state: "running" }])).not.toBe(k);
  });
});
