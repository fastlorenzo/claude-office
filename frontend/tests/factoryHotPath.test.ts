import { describe, expect, it } from "vitest";
import { FactoryMotion } from "../src/engine/logic/factoryMotion";
import type {
  LineModel,
  Segment,
  Workpiece,
} from "../src/engine/logic/factoryModel";
import {
  packPieces,
  resolvePiece,
  writePackedMatrices,
  type PieceInstance,
  type ResolvedPiece,
} from "../src/engine/world/factory/workpiecePlacement";

/**
 * WS4 / P3: the per-frame workpiece path (motion step → in-place matrices)
 * must not allocate per piece and must stay far below the 0.3 ms budget for
 * 40 moving pieces.
 */
const NOW = Date.parse("2026-11-07T12:00:00Z");

function wp(id: string, segment: Segment, t: number, lane: number | null) {
  return {
    id,
    kind: "pr",
    branch: id,
    position: {
      segment,
      t,
      stationIndex: segment === "station" ? 0 : undefined,
    },
    lane,
    fade: 1,
    stamp: null,
  } as Workpiece;
}

const line = (workpieces: Workpiece[]) =>
  ({ stations: [{}, {}, {}], workpieces }) as unknown as LineModel;

function motion40(): FactoryMotion {
  const m = new FactoryMotion();
  m.setModel(
    line(
      Array.from({ length: 40 }, (_, i) =>
        wp(`p${i}`, "station", (i % 10) / 10, i % 6),
      ),
    ),
    NOW,
  );
  return m;
}

describe("pooled motion step", () => {
  it("matches the snapshot step and reuses its objects", () => {
    const a = motion40();
    const b = motion40();
    for (let i = 0; i < 30; i++) {
      const snap = a.step(16).pieces;
      const pooled = b.stepPooled(16).pieces;
      expect(pooled.map((p) => ({ ...p }))).toEqual(
        snap.map((p) => ({ ...p })),
      );
    }
    const f1 = b.stepPooled(16);
    const first = f1.pieces[0];
    const f2 = b.stepPooled(16);
    expect(f2.pieces).toBe(f1.pieces);
    expect(f2.pieces[0]).toBe(first);
  });
});

describe("in-place workpiece matrices", () => {
  const base: PieceInstance = {
    id: "x",
    t: 0,
    lanePath: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ],
    sizeClass: "M",
    state: "running",
  };
  const pieces = (t: number): ResolvedPiece[] =>
    Array.from({ length: 40 }, (_, i) =>
      resolvePiece(
        {
          ...base,
          id: `p${i}`,
          t: (t + i / 40) % 1,
          sizeClass: (["XS", "S", "M", "L"] as const)[i % 4],
          draft: i % 9 === 0,
        },
        [],
      ),
    );

  it("writes exactly what a full pack writes", () => {
    const pk = packPieces(pieces(0));
    const moved = pieces(0.37);
    writePackedMatrices(moved, pk);
    const ref = packPieces(moved);
    expect(Array.from(pk.pallet.subarray(0, 40 * 16))).toEqual(
      Array.from(ref.pallet.subarray(0, 40 * 16)),
    );
    for (let v = 0; v < 4; v++) {
      const n = ref.bodies[v].count * 16;
      expect(Array.from(pk.bodies[v].m.subarray(0, n))).toEqual(
        Array.from(ref.bodies[v].m.subarray(0, n)),
      );
    }
    const g = ref.ghost.count * 16;
    expect(Array.from(pk.ghost.m.subarray(0, g))).toEqual(
      Array.from(ref.ghost.m.subarray(0, g)),
    );
  });

  it("steps 40 moving pieces well under 0.3 ms per frame", () => {
    const m = motion40();
    const rs = pieces(0);
    const pk = packPieces(rs);
    const frame = () => {
      const f = m.stepPooled(16);
      for (let i = 0; i < f.pieces.length && i < rs.length; i++) {
        const q = rs[i].placed;
        q.x = f.pieces[i].t * 10;
        q.z = f.pieces[i].laneIndex ?? 0;
      }
      writePackedMatrices(rs, pk);
    };
    for (let i = 0; i < 50; i++) frame(); // warm up (JIT)
    const n = 500;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame();
    expect((performance.now() - t0) / n).toBeLessThan(0.3);
  });
});
