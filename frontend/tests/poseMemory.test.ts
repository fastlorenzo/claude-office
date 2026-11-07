import { describe, expect, it } from "vitest";
import {
  canSavePose,
  FALL_Y,
  isFallen,
  isFresh,
  parsePose,
  POSE_MAX_AGE_MS,
  restoreSuppressed,
  serializePose,
} from "@/engine/player/poseMemory";

const base = {
  x: 1,
  y: 0.05,
  z: -3,
  yaw: 1.2,
  pitch: -0.1,
  mode: "fp" as const,
};

describe("poseMemory", () => {
  it("round-trips", () => {
    const p = parsePose(serializePose(base, 1000));
    expect(p).toMatchObject({ ...base, v: 1, t: 1000 });
  });
  it("rejects malformed input", () => {
    expect(parsePose(null)).toBeNull();
    expect(parsePose("nope")).toBeNull();
    expect(parsePose(JSON.stringify({ v: 2, ...base, t: 1 }))).toBeNull();
    expect(
      parsePose(JSON.stringify({ v: 1, ...base, x: null, t: 1 })),
    ).toBeNull();
    expect(
      parsePose(JSON.stringify({ v: 1, ...base, mode: "xx", t: 1 })),
    ).toBeNull();
  });
  it("freshness", () => {
    const now = 10 * POSE_MAX_AGE_MS;
    expect(isFresh({ t: now - 1000 }, now)).toBe(true);
    expect(isFresh({ t: now - POSE_MAX_AGE_MS - 1 }, now)).toBe(false);
    expect(isFresh({ t: now + 3_600_000 }, now)).toBe(false);
  });
  it("suppressed by shot=1 / cam", () => {
    expect(restoreSuppressed("?shot=1")).toBe(true);
    expect(restoreSuppressed("?cam=1,2,3")).toBe(true);
    expect(restoreSuppressed("?foo=1")).toBe(false);
  });
});

describe("save guard and fall net", () => {
  it("saves only grounded poses above -7", () => {
    expect(canSavePose({ grounded: true, y: 0.05 })).toBe(true);
    expect(canSavePose({ grounded: true, y: -6 })).toBe(true);
    expect(canSavePose({ grounded: false, y: 0 })).toBe(false);
    expect(canSavePose({ grounded: true, y: -7.5 })).toBe(false);
    expect(canSavePose({ grounded: true, y: NaN })).toBe(false);
  });
  it("detects falling below the world or airborne outside too long", () => {
    expect(isFallen({ y: -6, airborneOutsideS: 0 })).toBe(false);
    expect(isFallen({ y: FALL_Y - 0.1, airborneOutsideS: 0 })).toBe(true);
    expect(isFallen({ y: 0, airborneOutsideS: 1.4 })).toBe(false);
    expect(isFallen({ y: 0, airborneOutsideS: 1.6 })).toBe(true);
    expect(isFallen({ y: NaN, airborneOutsideS: 0 })).toBe(true);
  });
});
