import { describe, expect, it } from "vitest";
import {
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
