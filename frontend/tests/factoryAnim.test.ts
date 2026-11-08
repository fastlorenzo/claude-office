import { describe, expect, it } from "vitest";
import type { CheckState } from "@/engine/contracts";
import {
  ANIM_RADIUS,
  FLASH,
  LaneScroll,
  SCAN_PERIOD,
  SETTLE,
  StationAnimator,
  armPoseAt,
  hoodFlash,
  newPose,
  phaseOf,
  scanPose,
  writeArmMatrices,
} from "@/engine/world/factory/factoryAnim";
import {
  STATION,
  armMatrices,
  armPoseFor,
  beaconLevel,
  hoodColor,
  writeBeaconRgba,
  type StationInstance,
} from "@/engine/world/factory/stationPlan";
import { writeArmBase } from "@/engine/world/factory/factoryAnim";
import { transformPoint } from "@/engine/world/factory/poolMath";
import { CONVEYOR } from "@/engine/world/factory/conveyorPlan";

function st(id: string, state: CheckState, x = 0, z = 0): StationInstance {
  return { id, x, y: 0, z, yaw: 0.4, state, kind: "test" };
}

const bufs = (n: number) => ({
  a1: new Float32Array(n * 16),
  a2: new Float32Array(n * 16),
  a3: new Float32Array(n * 16),
});

const hoodBase = (s: CheckState) => hoodColor(s);

describe("phase stagger", () => {
  it("is deterministic and in [0, 1)", () => {
    for (const id of ["a", "st-3-2", "main-qc", ""]) {
      expect(phaseOf(id)).toBe(phaseOf(id));
      expect(phaseOf(id)).toBeGreaterThanOrEqual(0);
      expect(phaseOf(id)).toBeLessThan(1);
    }
  });

  it("spreads a plant of stations across the cycle (no lockstep)", () => {
    const ph = Array.from({ length: 360 }, (_, i) => phaseOf(`st-${i}`));
    expect(new Set(ph).size).toBe(360);
    const bins = new Array<number>(10).fill(0);
    for (const p of ph) bins[Math.floor(p * 10)]++;
    for (const b of bins) expect(b).toBeGreaterThan(10);
  });

  it("different phases give different running poses at the same time", () => {
    const a = newPose();
    const b = newPose();
    armPoseAt(a, "running", 10, 1e9, phaseOf("x"));
    armPoseAt(b, "running", 10, 1e9, phaseOf("y"));
    expect(a.yaw).not.toBeCloseTo(b.yaw, 3);
  });
});

describe("arm pose functions", () => {
  const tip = (pose: ReturnType<typeof newPose>) => {
    const s = st("t", "running");
    s.yaw = 0;
    const base = new Float32Array(16);
    writeArmBase(s, base, 0);
    const o = bufs(1);
    writeArmMatrices(base, 0, pose, o.a1, o.a2, o.a3, 0);
    return transformPoint(o.a3, 0, STATION.arm.tool, 0);
  };

  it("running loops with the scan period", () => {
    const a = newPose();
    const b = newPose();
    armPoseAt(a, "running", 3.2, 1e9, 0.3);
    armPoseAt(b, "running", 3.2 + SCAN_PERIOD, 1e9, 0.3);
    expect(b.yaw).toBeCloseTo(a.yaw, 9);
    expect(b.elbow).toBeCloseTo(a.elbow, 9);
  });

  it("sweeps over the belt then dips then returns to the scan pose", () => {
    const scan = armPoseFor("running");
    const p = newPose();
    let yawMin = Infinity;
    let yawMax = -Infinity;
    let dip = 0;
    for (let u = 0; u < 1; u += 0.005) {
      scanPose(p, u);
      yawMin = Math.min(yawMin, p.yaw);
      yawMax = Math.max(yawMax, p.yaw);
      dip = Math.max(dip, p.elbow - scan.elbow);
    }
    expect(yawMax - yawMin).toBeGreaterThan(0.6);
    expect(dip).toBeGreaterThan(0.12);
    scanPose(p, 0);
    expect(p.shoulder).toBeCloseTo(scan.shoulder, 9);
    scanPose(p, 0.999);
    expect(p.elbow).toBeCloseTo(scan.elbow, 2);
  });

  it("the tool tip stays between belt top and the sensor box for the whole cycle", () => {
    const p = newPose();
    for (let u = 0; u < 1; u += 0.01) {
      scanPose(p, u);
      const y = tip(p)[1];
      expect(y).toBeGreaterThan(CONVEYOR.beltHeight + 0.03);
      expect(y).toBeLessThan(STATION.boxY0);
    }
  });

  it("idle states rest exactly; success nods then rests; failure stops raised", () => {
    const p = newPose();
    for (const s of ["queued", "none", "cancelled"] as const) {
      armPoseAt(p, s, 5, 1e9, 0.5);
      expect(p).toEqual(armPoseFor(s));
    }
    armPoseAt(p, "success", 50, SETTLE, 0.2);
    expect(p).toEqual(armPoseFor("success"));
    // nod: wrist wiggles during the settle window
    const wr: number[] = [];
    for (let a = 0.3; a < SETTLE; a += 0.05) {
      armPoseAt(p, "success", 10 + a, a, 0.2);
      wr.push(p.wrist);
    }
    expect(Math.max(...wr) - Math.min(...wr)).toBeGreaterThan(0.2);
    armPoseAt(p, "failure", 50, 5, 0.2);
    expect(p).toEqual(armPoseFor("failure"));
    expect(tip(p)[1]).toBeGreaterThan(tip(armPoseFor("running"))[1]);
  });

  it("transitions are continuous at age 0 (no snap)", () => {
    const p = newPose();
    armPoseAt(p, "failure", 7, 0, 0.1);
    const scan = armPoseFor("running");
    expect(p.shoulder).toBeCloseTo(scan.shoulder, 6);
    armPoseAt(p, "running", 7, 0, 0.1);
    expect(p.elbow).toBeCloseTo(armPoseFor("queued").elbow, 6);
  });

  it("in-place kinematics equal armMatrices()", () => {
    const s = st("k", "running", 3, -2);
    s.beltWidth = 1.1;
    const pose = { yaw: 1.9, shoulder: 0.3, elbow: 1.1, wrist: -0.4 };
    const base = new Float32Array(16);
    writeArmBase(s, base, 0);
    const o = bufs(1);
    writeArmMatrices(base, 0, pose, o.a1, o.a2, o.a3, 0);
    const [m1, m2, m3] = armMatrices(s, pose);
    for (let i = 0; i < 16; i++) {
      expect(o.a1[i]).toBeCloseTo(m1[i], 5);
      expect(o.a2[i]).toBeCloseTo(m2[i], 5);
      expect(o.a3[i]).toBeCloseTo(m3[i], 5);
    }
  });
});

describe("StationAnimator", () => {
  it("writes only running arms; settled / idle arms cost nothing", () => {
    const order = [
      st("r1", "running"),
      st("r2", "running"),
      st("i", "success"),
      st("q", "queued"),
    ];
    const an = new StationAnimator();
    const o = bufs(4);
    an.rebuild(order, 0, o, hoodBase, null);
    expect(an.workSize).toBe(2);
    const step = an.step(0.1, o);
    expect(step.written).toBe(2);
    expect([step.lo, step.hi]).toEqual([0, 1]);
    const frozen = o.a1.slice(32);
    an.step(0.2, o);
    expect(o.a1.slice(32)).toEqual(frozen);
  });

  it("respects the distance LOD and full cells, and catches up when visible", () => {
    const order = [st("near", "running", 5, 0), st("far", "running", 80, 0)];
    const an = new StationAnimator();
    const o = bufs(2);
    an.rebuild(order, 0, o, hoodBase, null);
    an.setViewer(0, 1, 0);
    expect(an.radius).toBe(ANIM_RADIUS);
    let r = an.step(1, o);
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(1);
    const farBefore = o.a3.slice(16, 32);
    r = an.step(2, o);
    expect(o.a3.slice(16, 32)).toEqual(farBefore);
    an.setFullIds(new Set(["far"]));
    r = an.step(3, o);
    expect(r.written).toBe(2);
    expect(o.a3.slice(16, 32)).not.toEqual(farBefore);
  });

  it("disabled animator writes nothing", () => {
    const an = new StationAnimator();
    const o = bufs(1);
    an.rebuild([st("a", "running")], 0, o, hoodBase, null);
    an.enabled = false;
    expect(an.step(1, o).written).toBe(0);
  });

  it("a success transition nods briefly, writes the final pose, then drops out", () => {
    const o = bufs(1);
    const an = new StationAnimator();
    an.rebuild([st("a", "running")], 0, o, hoodBase, null);
    an.rebuild([st("a", "success")], 10, o, hoodBase, null);
    expect(an.workSize).toBe(1);
    let t = 10;
    while (an.workSize > 0 && t < 20) {
      t += 1 / 30;
      an.step(t, o);
    }
    expect(t).toBeLessThan(10 + SETTLE + 0.3);
    // final matrices equal the rest pose
    const s = st("a", "success");
    const [, , m3] = armMatrices(s, armPoseFor("success"));
    for (let i = 0; i < 16; i++) expect(o.a3[i]).toBeCloseTo(m3[i], 4);
    expect(an.step(t + 1, o).written).toBe(0);
  });

  it("failure transition flashes the hood once, then returns to base", () => {
    const o = bufs(1);
    const hood = new Float32Array(4);
    const an = new StationAnimator();
    an.rebuild([st("a", "running")], 0, o, hoodBase, hood);
    expect(an.flashing).toBe(0);
    an.rebuild([st("a", "failure")], 5, o, hoodBase, hood);
    expect(an.flashing).toBe(1);
    expect(hood[0]).toBeGreaterThan(5); // bright red at age 0
    const range = new Int32Array(2);
    expect(an.stepFlash(5.1, hood, hoodBase, range)).toBe(true);
    expect(range[0]).toBe(0);
    an.stepFlash(5 + FLASH + 0.01, hood, hoodBase, range);
    expect(an.flashing).toBe(0);
    const base = hoodColor("failure");
    expect(hood[0]).toBeCloseTo(base[0], 6);
    expect(an.stepFlash(7, hood, hoodBase, range)).toBe(false);
  });

  it("first sight of a failure does not flash", () => {
    const an = new StationAnimator();
    an.rebuild([st("a", "failure")], 0, bufs(1), hoodBase, new Float32Array(4));
    expect(an.flashing).toBe(0);
    expect(an.workSize).toBe(0);
  });

  it("hoodFlash decays to the base colour", () => {
    const out = new Float32Array(4);
    const base = hoodColor("failure");
    hoodFlash(0, base, out, 0);
    const hi = out[0];
    hoodFlash(0.2, base, out, 0);
    expect(out[0]).toBeLessThan(hi);
    hoodFlash(FLASH, base, out, 0);
    expect(out[0]).toBeCloseTo(base[0], 6);
  });

  it("CPU: 360 stations, all arms animating, stays well under 0.5 ms/frame", () => {
    const order: StationInstance[] = [];
    for (let i = 0; i < 360; i++)
      order.push(
        st(`st-${i}`, "running", (i % 30) * 2, Math.floor(i / 30) * 2.4),
      );
    const an = new StationAnimator();
    const o = bufs(360);
    an.rebuild(order, 0, o, hoodBase, null);
    for (let f = 0; f < 200; f++) an.step(f / 60, o); // warm up the JIT
    const N = 2000;
    const t0 = performance.now();
    let w = 0;
    for (let f = 0; f < N; f++) w += an.step(f / 60, o).written;
    const ms = (performance.now() - t0) / N;
    console.log(
      `arm animation: ${ms.toFixed(4)} ms/frame for 360 running arms`,
    );
    expect(w).toBe(360 * N);
    expect(ms).toBeLessThan(0.5);
  });
});

describe("beacon patterns by state / time", () => {
  const rgba = (s: CheckState, t: number) => {
    const o = new Float32Array(4);
    writeBeaconRgba(s, t, o, 0);
    return o;
  };

  it("queued blinks slowly (on and off within ~1.6 s)", () => {
    const l = Array.from({ length: 32 }, (_, i) =>
      beaconLevel("queued", i * 0.05),
    );
    expect(Math.max(...l)).toBeGreaterThan(3.5);
    expect(Math.min(...l)).toBeLessThan(0.6);
    expect(beaconLevel("queued", 0.2)).toBeCloseTo(
      beaconLevel("queued", 1.8),
      9,
    );
    // neutral grey: no amber cast (red does not dominate blue)
    const c = rgba("queued", 0.4);
    expect(c[0]).toBeLessThanOrEqual(c[2]);
  });

  it("running pulses blue, faster than queued", () => {
    const l = Array.from({ length: 40 }, (_, i) =>
      beaconLevel("running", i * 0.02),
    );
    expect(Math.max(...l)).toBeGreaterThan(5);
    expect(Math.min(...l)).toBeLessThan(2);
    const c = rgba("running", 0);
    expect(c[2]).toBeGreaterThan(c[0]);
  });

  it("success is steady green", () => {
    expect(beaconLevel("success", 0)).toBe(beaconLevel("success", 3.3));
    const c = rgba("success", 1.2);
    expect(c[1]).toBeGreaterThan(c[0]);
    expect(c[1]).toBeGreaterThan(c[2]);
    expect(rgba("success", 0)).toEqual(rgba("success", 9));
  });

  it("failure strobes red", () => {
    const l = Array.from({ length: 100 }, (_, i) =>
      beaconLevel("failure", i * 0.01),
    );
    expect(Math.max(...l) / Math.min(...l)).toBeGreaterThan(8);
    const c = rgba("failure", 0.03);
    expect(c[0]).toBeGreaterThan(c[1] * 3);
  });

  it("cancelled / none are steady grey", () => {
    for (const s of ["cancelled", "none"] as const) {
      const a = rgba(s, 0);
      expect(a).toEqual(rgba(s, 2.7));
      expect(Math.abs(a[0] - a[2])).toBeLessThan(0.05);
      expect(Math.max(...a.slice(0, 3))).toBeLessThan(1);
    }
  });

  it("is a pure function of (state, t): same inputs, same colour", () => {
    expect(rgba("running", 1.234)).toEqual(rgba("running", 1.234));
  });
});

describe("LaneScroll", () => {
  it("moves only lanes with speed, per lane", () => {
    const ls = new LaneScroll();
    ls.setRanges(
      [
        { id: "a", start: 0, end: 3 },
        { id: "b", start: 3, end: 5 },
        { id: "c", start: 5, end: 8 },
      ],
      8,
    );
    ls.setLane("b", 0.5);
    ls.setLane("c", 1);
    expect(ls.moving()).toBe(2);
    const w = ls.step(0.5);
    expect(w).toBe(5);
    expect([ls.lo, ls.hi]).toEqual([3, 8]);
    expect(Array.from(ls.offsets.slice(0, 3))).toEqual([0, 0, 0]);
    expect(ls.offsets[3]).toBeCloseTo(-0.25, 6);
    expect(ls.offsets[5]).toBeCloseTo(-0.5, 6);
    ls.setLane("b", 0);
    ls.step(0.5);
    expect(ls.offsets[3]).toBeCloseTo(-0.25, 6); // stopped lanes hold position
    expect(ls.step(0)).toBe(0);
  });

  it("default speed applies to lanes without their own", () => {
    const ls = new LaneScroll();
    ls.setRanges([{ id: "a", start: 0, end: 2 }], 2);
    ls.setDefault(0.3);
    expect(ls.speedOf("a")).toBe(0.3);
    ls.setLane("a", 0);
    expect(ls.step(1)).toBe(0);
  });
});
