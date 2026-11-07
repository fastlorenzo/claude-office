import { describe, expect, it } from "vitest";
import { FactoryMotion, MOTION } from "../src/engine/logic/factoryMotion";
import type {
  MotionEvent,
  PieceMotion,
} from "../src/engine/logic/factoryMotion";
import { buildFactoryModel } from "../src/engine/logic/factoryModel";
import type {
  FactoryModel,
  LineModel,
  Segment,
  Workpiece,
} from "../src/engine/logic/factoryModel";
import {
  demoFactoryProjects,
  demoFactoryTick,
} from "../src/engine/demo/demoFactory";

const NOW = Date.parse("2026-11-07T12:00:00Z");

function wp(
  id: string,
  segment: Segment,
  t: number,
  lane: number | null,
  extra: Partial<Workpiece> = {},
): Workpiece {
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
    ...extra,
  } as Workpiece;
}

function line(workpieces: Workpiece[]): LineModel {
  return {
    stations: [{}, {}, {}],
    workpieces,
  } as unknown as LineModel;
}

function run(m: FactoryMotion, ms: number, dt = 16) {
  const events: MotionEvent[] = [];
  let pieces: PieceMotion[] = [];
  for (let el = 0; el < ms; el += dt) {
    const f = m.step(dt);
    pieces = f.pieces;
    events.push(...f.events);
  }
  return { pieces, events };
}
const get = (ps: PieceMotion[], id: string) => ps.find((p) => p.id === id)!;

describe("FactoryMotion", () => {
  it("moves monotonically along a lane at bounded speed", () => {
    const m = new FactoryMotion();
    m.setModel(line([wp("a", "belt", 0, 0)]), NOW);
    m.step(0);
    m.setModel(line([wp("a", "gate", 1, 0)]), NOW);
    let last = -1;
    for (let i = 0; i < 1000; i++) {
      const p = get(m.step(16).pieces, "a");
      expect(p.t).toBeGreaterThanOrEqual(last);
      if (last >= 0) expect(p.t - last).toBeLessThanOrEqual(0.016 + 1e-9);
      last = p.t;
    }
    expect(last).toBeCloseTo(1, 5);
  });

  it("failure goes to rework, waits, re-run returns to the lane", () => {
    const m = new FactoryMotion();
    m.setModel(line([wp("a", "station", 0.5, 1)]), NOW);
    run(m, 20000);
    m.setModel(line([wp("a", "rework", 0.5, 1)]), NOW);
    const r1 = run(m, MOTION.REWORK_MS + 100);
    expect(r1.events).toEqual([{ type: "failed", id: "a" }]);
    expect(get(r1.pieces, "a")).toMatchObject({
      segmentPath: "rework",
      phase: "rework-wait",
      t: 1,
      laneIndex: 1,
    });
    run(m, 5000);
    expect(get(m.step(0).pieces, "a").phase).toBe("rework-wait");
    m.setModel(line([wp("a", "station", 0.2, 1)]), NOW);
    const r2 = run(m, MOTION.RETURN_MS + 50);
    expect(get(r2.pieces, "a").segmentPath).toBe("lane");
    expect(get(r2.pieces, "a").t).toBeLessThan(0.2);
    expect(r2.events).toEqual([]);
  });

  it("merge rides gate, trunk, main, qc, dock in order", () => {
    const m = new FactoryMotion();
    m.setModel(line([wp("a", "gate", 1, 0)]), NOW);
    run(m, 5000);
    m.setModel(line([wp("a", "trunk", 0.1, null)]), NOW);
    const phases: string[] = [];
    const events: MotionEvent[] = [];
    for (let i = 0; i < 700; i++) {
      const f = m.step(16);
      events.push(...f.events);
      const ph = get(f.pieces, "a").phase;
      if (phases[phases.length - 1] !== ph) phases.push(ph);
    }
    expect(phases).toEqual(["gate", "trunk", "main", "qc", "dock", "shipped"]);
    expect(events.map((e) => e.type)).toEqual(["merged", "shipped"]);
  });

  it("scraps a closed PR", () => {
    const m = new FactoryMotion();
    m.setModel(line([wp("a", "station", 0.5, 0)]), NOW);
    run(m, 5000);
    m.setModel(line([wp("a", "scrap", 0, null)]), NOW);
    const r = run(m, MOTION.SCRAP_MS + 100);
    expect(get(r.pieces, "a")).toMatchObject({ segmentPath: "scrap", t: 1 });
    expect(r.events).toEqual([{ type: "scrapped", id: "a" }]);
  });

  it("new PR enters from the queue, promotion shifts the queue", () => {
    const m = new FactoryMotion();
    const q = (id: string) => wp(id, "rack", 0, null, { stamp: "QUEUED" });
    m.setModel(line([wp("a", "belt", 0.2, 0), q("b"), q("c")]), NOW);
    run(m, 100);
    let ps = m.step(0).pieces;
    expect(get(ps, "b")).toMatchObject({ segmentPath: "queue", queueSlot: 0 });
    expect(get(ps, "c").queueSlot).toBe(1);
    // new PR arrives with a free lane
    m.setModel(
      line([wp("a", "belt", 0.2, 0), q("b"), q("c"), wp("d", "belt", 0, 1)]),
      NOW,
    );
    ps = m.step(100).pieces;
    expect(get(ps, "d")).toMatchObject({
      phase: "entering",
      segmentPath: "queue",
    });
    ps = run(m, MOTION.ENTER_MS).pieces;
    expect(get(ps, "d").phase).toBe("lane");
    // a lane frees: b promoted, c shifts forward
    m.setModel(
      line([
        wp("b", "belt", 0, 0),
        wp("c", "rack", 0, null, { stamp: "QUEUED" }),
      ]),
      NOW,
    );
    ps = m.step(50).pieces;
    expect(get(ps, "b").phase).toBe("entering");
    expect(get(ps, "c").queueSlot).toBeGreaterThan(0);
    ps = run(m, 1000).pieces;
    expect(get(ps, "b").phase).toBe("lane");
    expect(get(ps, "c").queueSlot).toBe(0);
  });

  it("is NaN-free and deterministic", () => {
    const go = () => {
      const m = new FactoryMotion();
      const out: PieceMotion[][] = [];
      m.setModel(line([wp("a", "belt", 0, 0), wp("b", "rework", 0.5, 1)]), NOW);
      for (let i = 0; i < 300; i++) {
        if (i === 50) m.setModel(line([wp("a", "trunk", 0, null)]), NOW);
        out.push(m.step(i % 7 === 0 ? NaN : 13).pieces);
      }
      return out;
    };
    const a = go();
    expect(a).toEqual(go());
    for (const f of a)
      for (const p of f) {
        expect(Number.isFinite(p.t)).toBe(true);
        expect(Number.isNaN(p.queueSlot ?? 0)).toBe(false);
      }
  });

  it("steps 150 pieces well under budget", () => {
    const m = new FactoryMotion();
    const ws = Array.from({ length: 150 }, (_, i) =>
      wp(`p${i}`, "station", (i % 10) / 10, i % 6),
    );
    m.setModel(line(ws), NOW);
    m.step(16);
    const n = 200;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) m.step(16);
    expect((performance.now() - t0) / n).toBeLessThan(1);
  });

  it("demo: no unexpected lane jumps over 10 simulated minutes", () => {
    let projects = demoFactoryProjects([], NOW, { projects: 2, seed: 7 });
    const opts = { lanesFor: () => 3 };
    let model: FactoryModel = buildFactoryModel(projects, [], NOW, opts);
    const motions = model.lines.map(() => new FactoryMotion());
    const prev = new Map<string, PieceMotion>();
    const seenPhases = new Set<string>();
    for (let s = 0; s <= 600; s++) {
      const now = NOW + s * 1000;
      projects = demoFactoryTick(projects, now);
      model = buildFactoryModel(projects, [], now, { ...opts, prev: model });
      model.lines.forEach((l, i) => motions[i].setModel(l, now));
      for (let k = 0; k < 20; k++) {
        motions.forEach((m, i) => {
          for (const p of m.step(50).pieces) {
            seenPhases.add(p.phase);
            const key = `${i}:${p.id}`;
            const was = prev.get(key);
            if (was && was.phase === "lane" && p.phase === "lane") {
              expect(p.laneIndex).toBe(was.laneIndex);
              expect(Math.abs(p.t - was.t)).toBeLessThanOrEqual(0.05 + 1e-9);
            }
            expect(Number.isFinite(p.t)).toBe(true);
            prev.set(key, p);
          }
        });
      }
    }
    expect(seenPhases.has("lane")).toBe(true);
  });
});
