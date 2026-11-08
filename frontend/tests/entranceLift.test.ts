import { describe, expect, it } from "vitest";
import { LIFT_TIMING, LiftController } from "@/engine/world/entranceLift";

/** Run the controller until idle; collect teleports and the max fade. */
function run(c: LiftController, maxS = 20, dt = 1 / 60) {
  const teleports: number[] = [];
  let fade = 0;
  let car = 0;
  let doorsMax: [number, number] = [0, 0];
  for (let t = 0; t < maxS; t += dt) {
    const f = c.update(dt);
    if (f.teleportTo !== null) teleports.push(f.teleportTo);
    fade = Math.max(fade, f.fade);
    car = f.car;
    doorsMax = [
      Math.max(doorsMax[0], f.doors[0]),
      Math.max(doorsMax[1], f.doors[1]),
    ];
    if (!c.busy) break;
  }
  return { teleports, fade, car, doorsMax };
}

describe("LiftController", () => {
  it("rides from G to 1: doors open, fade, one teleport, doors close", () => {
    const c = new LiftController(0);
    expect(c.call(0)).toBe(true);
    const r = run(c);
    expect(r.teleports).toEqual([1]);
    expect(r.fade).toBe(1);
    expect(r.doorsMax).toEqual([1, 1]);
    expect(c.carLevel).toBe(1);
    expect(r.car).toBe(1);
    expect(c.busy).toBe(false);
    expect(c.update(0.1).doors).toEqual([0, 0]);
  });

  it("brings the car down first when called from the other floor", () => {
    const c = new LiftController(1);
    c.call(0);
    let sawTravel = false;
    for (let i = 0; i < 30; i++) {
      const f = c.update(LIFT_TIMING.travel / 40);
      if (f.car > 0.05 && f.car < 0.95) sawTravel = true;
    }
    expect(sawTravel).toBe(true);
    const r = run(c);
    expect(r.teleports).toEqual([1]);
    expect(c.carLevel).toBe(1);
  });

  it("ignores calls mid-ride and never teleports twice", () => {
    const c = new LiftController(0);
    c.call(0);
    c.update(LIFT_TIMING.door + 0.01);
    expect(c.call(1)).toBe(false);
    expect(c.call(0)).toBe(false);
    const r = run(c);
    expect(r.teleports).toEqual([1]);
  });

  it("rides back down from the reception", () => {
    const c = new LiftController(1);
    c.call(1);
    expect(run(c).teleports).toEqual([0]);
    expect(c.carLevel).toBe(0);
  });
});
