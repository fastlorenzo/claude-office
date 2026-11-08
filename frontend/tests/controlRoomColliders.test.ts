import { describe, expect, it } from "vitest";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import { controlPlan } from "@/engine/world/controlRoomPlan";
import {
  addDeckColliders,
  DECK_RAMP,
  tierSectors,
} from "@/engine/world/controlRoomColliders";
import { recorder, surfaceY } from "./helpers/colliderBoxes";

function plan(n: number) {
  const d = createDemoCampus(n, 20000);
  const groups = groupSessions(d.campus, d.sessions, d.projects);
  const slots = allocateSlots(
    new Map(),
    groups.map((g) => ({
      id: g.id,
      createdAt: g.createdAt,
      sessions: g.sessionIds.length,
    })),
  );
  return controlPlan(
    generateLayout(slots, groups, allocatePods(new Map(), groups)),
  );
}

/**
 * Max surface slope (deg) and max step (m) along a polyline sample. The
 * capsule (r = 0.3, max slope 50°) rides over any lip lower than
 * r·(1 − cos 50°) ≈ 0.107 m; ramp corners may crease by a few cm.
 */
const STEP_OK = 0.06;
function profile(
  boxes: Parameters<typeof surfaceY>[0],
  pts: { x: number; z: number }[],
  floor = 0,
) {
  const ys = pts.map((p) => Math.max(floor, surfaceY(boxes, p.x, p.z, 3) ?? 0));
  let slope = 0;
  let step = 0;
  for (let i = 1; i < pts.length; i++)
    step = Math.max(step, Math.abs(ys[i] - ys[i - 1]));
  // Slope over ~0.2 m windows (a few-cm crease inside one is allowed).
  const W = 10;
  for (let i = W; i < pts.length; i++) {
    const run = Math.hypot(pts[i].x - pts[i - W].x, pts[i].z - pts[i - W].z);
    const dy = Math.abs(ys[i] - ys[i - W]);
    slope = Math.max(slope, (Math.atan2(dy, run) * 180) / Math.PI);
  }
  return { ys, slope, step };
}

const line = (
  a: { x: number; z: number },
  b: { x: number; z: number },
  n = 200,
) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    z: a.z + ((b.z - a.z) * i) / n,
  }));

describe.each([6, 10, 1])("control room decks (n=%i)", (n) => {
  const p = plan(n);
  const { sink, boxes } = recorder();
  addDeckColliders(sink, "t", p);
  const at = (r: number, a: number) => ({
    x: p.cx + r * Math.sin(a),
    z: p.cz + r * Math.cos(a),
  });

  it("ramp design pitch is gentle (≤ 27°)", () => {
    for (const s of tierSectors(p))
      expect((Math.atan2(s.deck, DECK_RAMP.len) * 180) / Math.PI).toBeLessThan(
        23,
      );
    if (p.supervisor)
      expect(
        (Math.atan2(p.supervisor.deck, DECK_RAMP.len) * 180) / Math.PI,
      ).toBeLessThan(27);
  });

  it("stands on the tier at deck height", () => {
    for (const s of tierSectors(p)) {
      const rm = (s.r0 + s.r1) / 2;
      for (let a = s.a0 + 0.1; a < s.a1 - 0.1; a += 0.05) {
        const q = at(rm, a);
        expect(surfaceY(boxes, q.x, q.z, 3)).toBeCloseTo(s.deck, 3);
      }
      // Off the deck (well inside C, and past the outer ramp) the floor.
      const inC = at(s.r0 - DECK_RAMP.len - 0.2, 0);
      expect(surfaceY(boxes, inC.x, inC.z, 3) ?? 0).toBeLessThanOrEqual(0);
    }
  });

  it("every tier edge is a walkable ramp (no step the capsule cannot ride)", () => {
    for (const s of tierSectors(p)) {
      const rm = (s.r0 + s.r1) / 2;
      for (let a = s.a0 + 0.05; a < s.a1 - 0.05; a += 0.07) {
        // Radial: from the floor inside, over the deck, down the outer edge.
        const pr = profile(boxes, line(at(s.r0 - 1, a), at(s.r1 + 1, a)));
        expect(pr.step).toBeLessThan(STEP_OK);
        expect(pr.slope).toBeLessThan(40);
        expect(Math.max(...pr.ys)).toBeCloseTo(s.deck, 3);
      }
      // Tangential (along an arc): in over each radial end.
      const arc = (r: number, a: number, b: number, n = 200) =>
        Array.from({ length: n + 1 }, (_, i) => at(r, a + ((b - a) * i) / n));
      for (const r of [s.r0 + 0.3, rm, s.r1 - 0.3]) {
        const pr = profile(boxes, arc(r, s.a0 - 1 / r, s.a0 + 1.2 / r));
        expect(pr.step).toBeLessThan(STEP_OK);
        expect(pr.slope).toBeLessThan(40);
        const pe = profile(boxes, arc(r, s.a1 + 1 / r, s.a1 - 1.2 / r));
        expect(pe.step).toBeLessThan(STEP_OK);
        expect(pe.slope).toBeLessThan(40);
      }
    }
  });

  it("supervisor platform: deck height, ramps on the open edges", () => {
    const sv = p.supervisor;
    if (!sv) return;
    const mid = { x: p.cx, z: (sv.pz0 + sv.pz1) / 2 };
    expect(surfaceY(boxes, mid.x, mid.z, 3)).toBeCloseTo(sv.deck, 3);
    // From the floor in front up onto the platform.
    const f = profile(
      boxes,
      line({ x: p.cx + 1, z: sv.pz1 + 1 }, { x: p.cx + 1, z: sv.pz1 - 0.5 }),
    );
    expect(f.step).toBeLessThan(STEP_OK);
    expect(f.slope).toBeLessThan(40);
    // From the side, over the open run.
    for (const s of [-1, 1]) {
      const z = sv.pz1 - 0.3;
      const pr = profile(
        boxes,
        line(
          { x: p.cx + s * (sv.phw + 1), z },
          { x: p.cx + s * (sv.phw - 0.6), z },
        ),
      );
      expect(pr.step).toBeLessThan(STEP_OK);
      expect(pr.slope).toBeLessThan(40);
      expect(pr.ys[pr.ys.length - 1]).toBeCloseTo(sv.deck, 3);
    }
  });
});
