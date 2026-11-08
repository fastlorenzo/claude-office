/** Parked cars: real-proportion body variants, wheels on the ground. */
import { describe, expect, it } from "vitest";
import { Matrix, Vector3 } from "@/engine/babylon";
import {
  CAR_MODELS,
  carKind,
  carModel,
  carWheels,
  type CarKind,
} from "@/engine/layout/carModels";
import { GROUND_Y, planExterior } from "@/engine/layout/exteriorPlan";
import { FACTORY } from "@/engine/layout/factoryLayout";
import { exteriorPropBoxes } from "@/engine/world/forecourtColliders";
import {
  carTemplate,
  carWheelMatrices,
  wheelTemplate,
} from "@/engine/world/exterior/cars";

const KINDS = Object.keys(CAR_MODELS) as CarKind[];

const plan = planExterior({
  halfW: FACTORY.OUTER_X,
  zS: FACTORY.SOUTH_Z,
  zN: 80,
  entrance: { x0: -10, x1: 10, z0: -12, z1: FACTORY.SOUTH_Z },
});

function bounds(pos: Float32Array, keep: (y: number) => boolean = () => true) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    if (!keep(pos[i + 1])) continue;
    for (let a = 0; a < 3; a++) {
      mn[a] = Math.min(mn[a], pos[i + a]);
      mx[a] = Math.max(mx[a], pos[i + a]);
    }
  }
  return { mn, mx };
}

describe("parked car variants", () => {
  it("have modern European proportions", () => {
    const want: Record<string, [number, number, number]> = {
      hatch: [4.1, 1.8, 1.48],
      saloon: [4.7, 1.85, 1.45],
      suv: [4.6, 1.9, 1.7],
    };
    for (const [k, [l, w, h]] of Object.entries(want)) {
      const m = CAR_MODELS[k as CarKind];
      expect(m.length).toBeCloseTo(l, 1);
      expect(m.width).toBeCloseTo(w, 1);
      expect(m.height).toBeCloseTo(h, 1);
    }
    for (const k of KINDS) {
      const m = CAR_MODELS[k];
      // Wheelbase ~ 60-63 % of the length, overhangs positive.
      expect(m.wheelbase / m.length).toBeGreaterThan(0.56);
      expect(m.wheelbase / m.length).toBeLessThan(0.66);
      expect(m.front).toBeGreaterThan(0.7);
      expect(m.length - m.front - m.wheelbase).toBeGreaterThan(0.6);
      expect(m.track + m.tyreW).toBeLessThan(m.width);
    }
  });

  it("templates fill their model's box (mirrors and fins aside)", () => {
    for (const k of KINDS) {
      const m = CAR_MODELS[k];
      const t = carTemplate(k);
      const all = bounds(t.pos);
      // Length: bumpers to bumpers, plates proud by ≤ 15 mm.
      expect(all.mx[2] - all.mn[2]).toBeGreaterThan(m.length - 0.005);
      expect(all.mx[2] - all.mn[2]).toBeLessThan(m.length + 0.035);
      // Height: roof at the model height; aerial / rails ≤ 6 cm above.
      expect(all.mx[1]).toBeGreaterThan(m.height - 0.01);
      expect(all.mx[1]).toBeLessThan(m.height + 0.06);
      // Body width below the mirrors; mirrors add ~10 cm a side.
      const low = bounds(t.pos, (y) => y < m.height * 0.5);
      expect(low.mx[0] * 2).toBeGreaterThan(m.width - 0.02);
      expect(low.mx[0] * 2).toBeLessThan(m.width + 0.01);
      expect(all.mx[0] * 2).toBeLessThan(m.width + 0.3);
      for (const v of t.nor) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("wheels sit on the ground at the model's track and wheelbase", () => {
    const w = wheelTemplate();
    const cars = plan.cars;
    expect(cars.length).toBeGreaterThan(5);
    const buf = carWheelMatrices(cars, GROUND_Y);
    expect(buf.length).toBe(cars.length * 4 * 16);
    const v = new Vector3();
    cars.forEach((c, ci) => {
      const m = carModel(c);
      const local = carWheels(m);
      expect(local).toHaveLength(4);
      for (const p of local) expect(p[1]).toBe(m.tyreR);
      const centres: Vector3[] = [];
      for (let k = 0; k < 4; k++) {
        const mat = Matrix.FromArray(buf, (ci * 4 + k) * 16);
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < w.pos.length; i += 3) {
          v.set(w.pos[i], w.pos[i + 1], w.pos[i + 2]);
          const q = Vector3.TransformCoordinates(v, mat);
          minY = Math.min(minY, q.y);
          maxY = Math.max(maxY, q.y);
        }
        // Tyre touches the ground (no float, no sink) at its own radius.
        expect(minY).toBeCloseTo(GROUND_Y, 3);
        expect(maxY - minY).toBeCloseTo(2 * m.tyreR, 3);
        centres.push(Vector3.TransformCoordinates(Vector3.Zero(), mat));
      }
      // [front L, front R, rear L, rear R]
      expect(Vector3.Distance(centres[0], centres[1])).toBeCloseTo(m.track, 4);
      expect(Vector3.Distance(centres[0], centres[2])).toBeCloseTo(
        m.wheelbase,
        4,
      );
    });
  });

  it("picks variants deterministically and colliders match the bodies", () => {
    const kinds = new Set(plan.cars.map(carKind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    for (const c of plan.cars) expect(carKind({ ...c })).toBe(carKind(c));
    for (const c of plan.cars.filter((c) => c.van))
      expect(carKind(c)).toBe("van");
    const props = exteriorPropBoxes(plan);
    for (const c of plan.cars) {
      const box = props.find((p) => p.x === c.x && p.z === c.z);
      if (!box) continue;
      const m = carModel(c);
      expect([box.sx, box.sy, box.sz]).toEqual([m.width, m.height, m.length]);
      expect(box.y).toBeCloseTo(GROUND_Y + m.height / 2, 6);
    }
  });
});
