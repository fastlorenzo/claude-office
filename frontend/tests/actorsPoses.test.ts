import { describe, expect, it } from "vitest";
import type { CharacterPose } from "@/engine/contracts";
import {
  blendFrames,
  createFrame,
  getJoint,
  isSeatedPose,
  JOINTS,
  PoseBlender,
  samplePose,
  sampleWalk,
  SEAT_HEIGHT,
  SEAT_HIPS_Y,
  smoothstep,
  STAND_HIPS_Y,
  walkPhaseDelta,
} from "@/engine/characters/poses";

const POSES: CharacterPose[] = [
  "idle",
  "walking",
  "sitting",
  "typing",
  "thinking",
  "raiseHand",
  "celebrating",
];
const ctx = (t = 1.3, age = 0.6, phase = 0.4) => ({
  t,
  age,
  phase,
  seed: 0.37,
});

describe("pose maths", () => {
  it("smoothstep clamps and eases", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(0.25)).toBeLessThan(0.25);
  });

  it("blendFrames interpolates hips and joints", () => {
    const a = createFrame();
    const b = createFrame();
    b.hips[1] = 0;
    b.rot.fill(1);
    const out = blendFrames(a, b, 0.25, createFrame());
    expect(out.hips[1]).toBeCloseTo(STAND_HIPS_Y * 0.75);
    expect(out.rot.every((v) => Math.abs(v - 0.25) < 1e-9)).toBe(true);
    expect(blendFrames(a, b, 2, createFrame()).rot[0]).toBe(1); // clamped
  });

  it("every pose samples finite values for all joints", () => {
    for (const p of POSES) {
      for (const t of [0, 0.7, 3.1, 12]) {
        const f = samplePose(p, ctx(t, t), createFrame());
        expect(f.rot).toHaveLength(JOINTS.length * 3);
        expect(f.rot.every(Number.isFinite)).toBe(true);
        expect(f.hips.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it("seated poses put the hips just above the chair seat", () => {
    expect(SEAT_HIPS_Y).toBeGreaterThan(SEAT_HEIGHT);
    expect(SEAT_HIPS_Y).toBeLessThan(SEAT_HEIGHT + 0.2);
    for (const p of POSES.filter(isSeatedPose)) {
      const f = samplePose(p, ctx(2, 5), createFrame());
      expect(f.hips[1]).toBeCloseTo(SEAT_HIPS_Y, 1);
      // thighs roughly horizontal (forward swing ≈ -π/2)
      expect(getJoint(f, "hipL")[0]).toBeLessThan(-1.3);
    }
    expect(samplePose("idle", ctx(), createFrame()).hips[1]).toBeGreaterThan(
      0.9,
    );
  });

  it("raiseHand lifts the right arm high, celebrating raises both then settles", () => {
    expect(
      getJoint(samplePose("raiseHand", ctx(), createFrame()), "shoulderR")[0],
    ).toBeLessThan(-2.4);
    const cheer = samplePose("celebrating", ctx(1, 0.8), createFrame());
    expect(getJoint(cheer, "shoulderL")[0]).toBeLessThan(-2);
    expect(getJoint(cheer, "shoulderR")[0]).toBeLessThan(-2);
    const after = samplePose("celebrating", ctx(9, 5), createFrame());
    expect(getJoint(after, "shoulderR")[0]).toBeGreaterThan(-1);
  });

  it("walk cycle is left/right symmetric half a cycle apart", () => {
    const a = sampleWalk(createFrame(), ctx(0, 0, 0.9));
    const b = sampleWalk(createFrame(), ctx(0, 0, 0.9 + Math.PI));
    expect(getJoint(a, "hipL")[0]).toBeCloseTo(getJoint(b, "hipR")[0], 6);
    expect(getJoint(a, "kneeL")[0]).toBeCloseTo(getJoint(b, "kneeR")[0], 6);
    expect(getJoint(a, "shoulderL")[0]).toBeCloseTo(
      getJoint(b, "shoulderR")[0],
      6,
    );
    expect(walkPhaseDelta(1.45, 1)).toBeCloseTo(Math.PI * 2);
    expect(walkPhaseDelta(-1, 1)).toBe(0);
  });
});

describe("PoseBlender", () => {
  it("cross-fades from the previous output to the new clip", () => {
    const pb = new PoseBlender(0.2);
    pb.setPose("idle", 0);
    pb.update(0.5);
    const startY = pb.out.hips[1];
    pb.setPose("sitting", 1);
    pb.update(0.5);
    const mid = pb.out.hips[1];
    expect(mid).toBeLessThan(startY);
    expect(mid).toBeGreaterThan(SEAT_HIPS_Y);
    pb.update(0.6);
    expect(pb.out.hips[1]).toBeCloseTo(SEAT_HIPS_Y, 2);
    expect(pb.current).toBe("sitting");
  });

  it("re-setting the same pose does not restart the blend", () => {
    const pb = new PoseBlender(0.5);
    pb.setPose("typing", 0);
    pb.update(0.1);
    const before = pb.out.hips[1];
    pb.setPose("typing", 1);
    pb.update(0.01);
    expect(pb.out.hips[1]).toBeCloseTo(before, 2);
  });

  it("locomotion layer fades in with speed and out at rest", () => {
    const pb = new PoseBlender(0.1);
    pb.setPose("idle", 0);
    pb.setMoving(1.4);
    for (let i = 0; i < 30; i++) pb.update(1 / 30);
    const swing =
      Math.abs(getJoint(pb.out, "hipL")[0]) +
      Math.abs(getJoint(pb.out, "hipR")[0]);
    expect(swing).toBeGreaterThan(0.1);
    pb.setMoving(0);
    for (let i = 0; i < 60; i++) pb.update(1 / 30);
    expect(Math.abs(getJoint(pb.out, "hipL")[0])).toBeLessThan(0.1);
  });
});
