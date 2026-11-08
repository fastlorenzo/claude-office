import { describe, expect, it } from "vitest";
import {
  FLY,
  adjustBaseSpeed,
  resolveLanding,
  speedMultiplier,
  stepVelocity,
  viewForward,
  wishVelocity,
} from "@/engine/player/FlyCamera";

const len = (v: { x: number; y: number; z: number }) =>
  Math.hypot(v.x, v.y, v.z);

describe("speed modifiers", () => {
  it("shift x4, alt x0.25, both cancel", () => {
    expect(speedMultiplier({ shift: false, alt: false })).toBe(1);
    expect(speedMultiplier({ shift: true, alt: false })).toBe(4);
    expect(speedMultiplier({ shift: false, alt: true })).toBe(0.25);
    expect(speedMultiplier({ shift: true, alt: true })).toBe(1);
  });
  it("wheel adjusts and clamps the base speed", () => {
    expect(adjustBaseSpeed(8, -100)).toBeGreaterThan(8);
    expect(adjustBaseSpeed(8, 100)).toBeLessThan(8);
    expect(adjustBaseSpeed(8, 0)).toBe(8);
    expect(adjustBaseSpeed(FLY.maxSpeed, -5000)).toBe(FLY.maxSpeed);
    expect(adjustBaseSpeed(FLY.minSpeed, 5000)).toBe(FLY.minSpeed);
    expect(adjustBaseSpeed(8, Number.NaN)).toBe(8);
  });
});

describe("wishVelocity", () => {
  it("flies where you look, pitch included", () => {
    const f = viewForward(0, Math.PI / 4); // looking down 45 deg, facing +z
    expect(f.z).toBeGreaterThan(0);
    expect(f.y).toBeLessThan(0);
    const w = wishVelocity({ fwd: 1, right: 0, up: 0 }, 0, Math.PI / 4, 10);
    expect(len(w)).toBeCloseTo(10);
    expect(w.y).toBeLessThan(0);
  });
  it("strafes horizontally and goes up on the world axis", () => {
    const w = wishVelocity({ fwd: 0, right: 1, up: 0 }, 0, 0.7, 5);
    expect(w.x).toBeCloseTo(5);
    expect(w.y).toBeCloseTo(0);
    const u = wishVelocity({ fwd: 0, right: 0, up: 1 }, 1, 0.7, 5);
    expect(u).toEqual({ x: 0, y: 5, z: 0 });
  });
  it("does not boost diagonals and is zero with no input", () => {
    const w = wishVelocity({ fwd: 1, right: 1, up: 1 }, 0.3, 0.2, 6);
    expect(len(w)).toBeCloseTo(6);
    expect(wishVelocity({ fwd: 0, right: 0, up: 0 }, 0, 0, 6)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });
});

describe("stepVelocity", () => {
  it("accelerates toward the wish and damps to rest", () => {
    let v = { x: 0, y: 0, z: 0 };
    const wish = { x: 10, y: 0, z: 0 };
    v = stepVelocity(v, wish, 1 / 60);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(10);
    for (let i = 0; i < 120; i++) v = stepVelocity(v, wish, 1 / 60);
    expect(v.x).toBeCloseTo(10, 1);
    for (let i = 0; i < 240; i++)
      v = stepVelocity(v, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(Math.abs(v.x)).toBeLessThan(0.01);
  });
  it("is framerate independent", () => {
    const wish = { x: 10, y: 0, z: 0 };
    let a = { x: 0, y: 0, z: 0 };
    let b = { x: 0, y: 0, z: 0 };
    a = stepVelocity(a, wish, 0.1);
    for (let i = 0; i < 10; i++) b = stepVelocity(b, wish, 0.01);
    expect(a.x).toBeCloseTo(b.x, 5);
  });
});

describe("resolveLanding", () => {
  const ok = { walkable: () => true };
  it("lands on the floor below the camera x/z", () => {
    const p = resolveLanding({ x: 3, y: 12, z: -4 }, 1.65, {
      ...ok,
      floorBelow: () => 0.2,
    });
    expect(p).toEqual({ x: 3, y: 0.25, z: -4 });
  });
  it("returns null with no floor, a bad floor or a non-walkable spot", () => {
    const cam = { x: 0, y: 5, z: 0 };
    expect(
      resolveLanding(cam, 1.65, { ...ok, floorBelow: () => null }),
    ).toBeNull();
    expect(
      resolveLanding(cam, 1.65, { ...ok, floorBelow: () => Number.NaN }),
    ).toBeNull();
    expect(
      resolveLanding(cam, 1.65, { walkable: () => false, floorBelow: () => 0 }),
    ).toBeNull();
    expect(
      resolveLanding({ x: Number.NaN, y: 0, z: 0 }, 1.65, {
        ...ok,
        floorBelow: () => 0,
      }),
    ).toBeNull();
  });
  it("checks walkability at the standing eye height", () => {
    let seen = 0;
    resolveLanding({ x: 1, y: 9, z: 2 }, 1.65, {
      floorBelow: () => 1,
      walkable: (p) => ((seen = p.y), true),
    });
    expect(seen).toBeCloseTo(2.65);
  });
});
