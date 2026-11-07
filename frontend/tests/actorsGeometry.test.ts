import { describe, expect, it } from "vitest";
import {
  buildMannequinGeometry,
  COLOR_KEYS,
  restJointPosition,
} from "@/engine/characters/mannequinGeometry";
import { JOINTS } from "@/engine/characters/poses";

describe("mannequin geometry", () => {
  for (const boss of [false, true]) {
    for (const hairStyle of [0, 1, 2] as const) {
      it(`is well formed (boss=${boss}, hair=${hairStyle})`, () => {
        const g = buildMannequinGeometry({ boss, hairStyle });
        const n = g.vertexCount;
        expect(n).toBeGreaterThan(500);
        expect(n).toBeLessThan(12000);
        expect(g.normals.length).toBe(n * 3);
        expect(g.uvs.length).toBe(n * 2);
        expect(g.keys.length).toBe(n);
        expect(g.matricesIndices.length).toBe(n * 4);
        expect(g.matricesWeights.length).toBe(n * 4);
        for (let i = 0; i < g.indices.length; i++)
          expect(g.indices[i]).toBeLessThan(n);
        for (let v = 0; v < n; v++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += g.matricesWeights[v * 4 + k];
            expect(g.matricesIndices[v * 4 + k]).toBeLessThan(JOINTS.length);
          }
          expect(sum).toBeCloseTo(1, 4);
          expect(g.keys[v]).toBeLessThan(COLOR_KEYS.length);
        }
        // Height ~1.75 m, feet on the floor.
        let minY = Infinity;
        let maxY = -Infinity;
        for (let v = 0; v < n; v++) {
          minY = Math.min(minY, g.positions[v * 3 + 1]);
          maxY = Math.max(maxY, g.positions[v * 3 + 1]);
        }
        expect(minY).toBeGreaterThanOrEqual(-1e-6);
        expect(maxY).toBeGreaterThan(1.7);
        expect(maxY).toBeLessThan(1.82);
      });
    }
  }

  it("winding agrees with vertex normals (Babylon (p1-p2)x(p3-p2) convention)", () => {
    const g = buildMannequinGeometry({ boss: true, hairStyle: 1 });
    const P = g.positions;
    const N = g.normals;
    let agree = 0;
    let total = 0;
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
      const ux = P[a * 3] - P[b * 3],
        uy = P[a * 3 + 1] - P[b * 3 + 1],
        uz = P[a * 3 + 2] - P[b * 3 + 2];
      const vx = P[c * 3] - P[b * 3],
        vy = P[c * 3 + 1] - P[b * 3 + 1],
        vz = P[c * 3 + 2] - P[b * 3 + 2];
      const fx = uy * vz - uz * vy,
        fy = uz * vx - ux * vz,
        fz = ux * vy - uy * vx;
      const fl = Math.hypot(fx, fy, fz);
      if (fl < 1e-9) continue;
      const nx = N[a * 3] + N[b * 3] + N[c * 3];
      const ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
      const nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
      total++;
      if (fx * nx + fy * ny + fz * nz > 0) agree++;
    }
    expect(agree / total).toBeGreaterThan(0.97);
  });

  it("rest joints stack up to a ~1.75 m figure", () => {
    expect(restJointPosition("head")[1]).toBeCloseTo(1.5, 2);
    expect(restJointPosition("ankleL")[1]).toBeGreaterThan(0.05);
    expect(restJointPosition("shoulderR")[0]).toBeGreaterThan(0);
  });
});
