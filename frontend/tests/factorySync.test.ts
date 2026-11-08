import { describe, expect, it, vi } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import type { CampusProject, PullRequestInfo } from "@/engine/contracts";
import { demoFactoryProjects } from "@/engine/demo/demoFactory";
import {
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import { FactoryMotion } from "@/engine/logic/factoryMotion";
import type { FactoryModel } from "@/engine/logic/factoryModel";
import type { Factory } from "@/engine/world/factory/Factory";
import { FactoryLines } from "@/engine/world/factory/FactoryLines";
import {
  FactorySync,
  noProjectData,
  rekeyDemo,
} from "@/engine/world/factory/factorySync";
import {
  conveyorPaths,
  intakeSlot,
  laneAbsX,
  laneKnots,
  laneNorm,
  lineCtx,
  placeMotion,
  stationRows,
  waitSlots,
} from "@/engine/world/factory/lineAdapter";

const NOW = Date.parse("2026-11-07T12:00:00Z");

function pr(n: number, extra: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: n,
    title: `PR ${n}`,
    branch: `feat/${n}`,
    author: "dev",
    url: `https://github.com/o/r/pull/${n}`,
    draft: false,
    state: "open",
    reviewDecision: null,
    mergeable: "mergeable",
    checks: {
      state: "running",
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      runs: [
        { name: "lint", state: "success", kind: "lint" },
        { name: "test", state: "running", kind: "test" },
      ],
    },
    updatedAt: new Date(NOW - n * 60_000).toISOString(),
    ...extra,
  } as PullRequestInfo;
}

function project(id: string, prs: PullRequestInfo[]): CampusProject {
  return {
    id,
    name: id.split("/")[1] ?? id,
    repo: id,
    defaultBranch: "main",
    sessionIds: [],
    pullRequests: prs,
    pipelines: [],
    ciAvailable: true,
    updatedAt: new Date(NOW).toISOString(),
  };
}

const lanes4 = () => 4;
const base = (projects: CampusProject[] | null) => ({
  projects,
  campus: [],
  nowMs: NOW,
  lanesFor: lanes4,
  cellIds: (projects ?? []).map((p) => p.id),
});

function layoutFor(ids: string[]): FactoryLayout {
  const reqs = ids.map((id, i) => ({ id, createdAt: i, sessions: 2 }));
  const slots = allocateSlots(new Map(), reqs);
  const building = generateLayout(
    slots,
    reqs.map((r) => ({
      id: r.id,
      sessionIds: [`${r.id}s0`, `${r.id}s1`],
    })),
  );
  return buildFactoryLayout(building);
}

describe("FactorySync (World.sync seam)", () => {
  it("pushes a model once, then skips while the factory key is unchanged", () => {
    const sync = new FactorySync();
    const projects = [project("o/r", [pr(1), pr(2)])];
    const a = sync.update(base(projects));
    expect(a.model).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      // A fresh but identical snapshot (new objects, same content).
      const again = sync.update(base(structuredClone(projects)));
      expect(again.model).toBeNull();
    }
    expect(sync.stats).toMatchObject({ builds: 6, pushes: 1, skips: 5 });
    expect(sync.model).not.toBeNull();
  });

  it("pushes again when something visible changes", () => {
    const sync = new FactorySync();
    sync.update(base([project("o/r", [pr(1)])]));
    const failed = pr(1);
    failed.checks = {
      ...failed.checks,
      state: "failure",
      failed: 1,
      pending: 0,
      runs: [
        { name: "lint", state: "success", kind: "lint" },
        { name: "test", state: "failure", kind: "test" },
      ],
    } as PullRequestInfo["checks"];
    expect(sync.update(base([project("o/r", [failed])])).model).not.toBeNull();
    expect(sync.stats.pushes).toBe(2);
  });

  it("keeps lanes stable across updates through the previous model", () => {
    const sync = new FactorySync();
    const first = sync.update(base([project("o/r", [pr(5), pr(6), pr(7)])]));
    const laneOf = (m: FactoryModel, n: number) =>
      m.lines[0].workpieces.find((w) => w.prNumber === n)?.lane;
    const before = [5, 6, 7].map((n) => laneOf(first.model!, n));
    expect(new Set(before).size).toBe(3);
    // #5 leaves, a fresher PR (#9, would sort first) arrives.
    const next = sync.update(base([project("o/r", [pr(6), pr(7), pr(9)])]));
    expect(laneOf(next.model!, 6)).toBe(before[1]);
    expect(laneOf(next.model!, 7)).toBe(before[2]);
    // The newcomer takes the freed lane, never evicting anyone.
    expect(laneOf(next.model!, 9)).toBe(before[0]);
  });

  it("uses demo data only when asked or when the feed has no projects", () => {
    expect(noProjectData(null)).toBe(true);
    expect(noProjectData([])).toBe(true);
    const real = [project("o/r", [pr(1)])];
    const sync = new FactorySync();
    const r = sync.update(base(real));
    expect(sync.stats.demo).toBe(false);
    expect(r.projects).toBe(real);

    const empty = new FactorySync();
    const d = empty.update({ ...base(null), cellIds: ["a/x", "b/y"] });
    expect(empty.stats.demo).toBe(true);
    expect(d.projects.map((p) => p.id)).toEqual(["a/x", "b/y"]);
    expect(d.model!.lines.some((l) => l.workpieces.length > 0)).toBe(true);

    const forced = new FactorySync();
    forced.update({ ...base(real), demo: true });
    expect(forced.stats.demo).toBe(true);
  });

  it("re-keys demo templates onto the cells (cycled, unique ids)", () => {
    const t = demoFactoryProjects([], NOW, { projects: 2 });
    const out = rekeyDemo(t, ["a", "b", "c"]);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(out[2].pullRequests).toBe(t[0].pullRequests);
    expect(rekeyDemo([], ["a"])).toEqual([]);
  });
});

describe("lineAdapter", () => {
  const ids = ["o/a", "o/b"];
  const layout = layoutFor(ids);

  it("one conveyor per lane + a trunk per cell + the main line", () => {
    const paths = conveyorPaths(layout);
    const lanes = layout.cells.reduce((n, c) => n + c.lanes.length, 0);
    expect(paths.filter((p) => p.kind === "lane")).toHaveLength(lanes);
    expect(paths.filter((p) => p.kind === "trunk")).toHaveLength(2);
    expect(paths.filter((p) => p.kind === "main")).toHaveLength(1);
  });

  it("lane t maps pieces at a station under that station", () => {
    const lane = layout.cells[0].lanes[0];
    const k = laneKnots(lane, 3);
    for (let i = 0; i < 3; i++)
      expect(laneAbsX(2.5 + i, k)).toBeCloseTo(Math.abs(lane.stationX[i]));
    expect(laneAbsX(2.5 + 3, k)).toBeCloseTo(Math.abs(lane.qaX));
    expect(laneAbsX(3.5 + 3, k)).toBeCloseTo(Math.abs(lane.gateX));
    expect(laneAbsX(laneNorm(3), k)).toBeGreaterThan(
      Math.abs(layout.cells[0].trunk.x),
    );
    // Monotonic toward the spine.
    for (let u = 0; u < laneNorm(3); u += 0.1)
      expect(laneAbsX(u + 0.1, k)).toBeLessThanOrEqual(laneAbsX(u, k) + 1e-9);
  });

  it("stations: one per lane x check, beacon = the lane's PR state", () => {
    const sync = new FactorySync();
    const lanesOf = new Map(layout.cells.map((c) => [c.projectId, c.lanes.length]));
    const { model } = sync.update({
      projects: [project("o/a", [pr(1), pr(2)]), project("o/b", [])],
      campus: [],
      nowMs: NOW,
      lanesFor: (id) => lanesOf.get(id) ?? 0,
      cellIds: ids,
    });
    const models = new Map(model!.lines.map((l) => [l.projectId, l]));
    const { list, meta } = stationRows(layout, models);
    const cellA = layout.cells.find((c) => c.projectId === "o/a")!;
    expect(list).toHaveLength(cellA.lanes.length * 2);
    const line = models.get("o/a")!;
    const lane = line.workpieces.find((w) => w.prNumber === 1)!.lane!;
    const test = list.find((s) => s.id === `o/a:${lane}:1`)!;
    expect(test.state).toBe("running");
    expect(meta.get(test.id)?.checkName).toBe("test");
    expect(meta.get(test.id)?.piece?.prNumber).toBe(1);
    // Empty lanes are dark.
    const empty = cellA.lanes.find(
      (l) => !line.workpieces.some((w) => w.lane === l.index),
    )!;
    expect(list.find((s) => s.id === `o/a:${empty.index}:0`)!.state).toBe(
      "none",
    );
  });

  it("places motion pieces on their lane, rack and trunk", () => {
    const sync = new FactorySync();
    const cell = layout.cells[0];
    const { model } = sync.update({
      projects: [
        project(cell.projectId, [
          pr(1),
          pr(2, { draft: true }),
          pr(3, { state: "merged", mergedAt: new Date(NOW).toISOString() }),
        ]),
      ],
      campus: [],
      nowMs: NOW,
      lanesFor: () => cell.lanes.length,
      cellIds: [cell.projectId],
    });
    const line = model!.lines[0];
    const motion = new FactoryMotion();
    motion.setModel(line, NOW);
    const frame = motion.step(16).pieces;
    const ctx = lineCtx(layout, cell, line);
    const slots = waitSlots(frame);
    const at = (n: number) => {
      const id = line.workpieces.find((w) => w.prNumber === n)!.id;
      return placeMotion(ctx, frame.find((p) => p.id === id)!, slots)!;
    };
    const s = cell.side === "east" ? 1 : -1;
    const p1 = at(1);
    const l1 = cell.lanes[line.workpieces.find((w) => w.prNumber === 1)!.lane!];
    expect(p1.z).toBeCloseTo(l1.z);
    // Running at station 1 ("test") → under stationX[1].
    expect(p1.x).toBeCloseTo(l1.stationX[1], 0);
    // Draft waits on the intake rack (outside the lane start).
    const p2 = at(2);
    expect(Math.abs(p2.x)).toBeGreaterThan(31);
    expect(p2).toEqual(intakeSlot(ctx, 0));
    // Merged (snapped on the first model) → shipped, on the dock platform.
    const p3 = at(3);
    expect(p3.z).toBeGreaterThan(layout.dock.z0);
    expect(p3.z).toBeLessThan(layout.dock.z1);
    expect(Math.sign(p1.x)).toBe(s);
  });
});

describe("FactoryLines.feed (no pools until visible)", () => {
  it("syncs the Factory only when the key changes and never builds pools while hidden", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const layout = layoutFor(["o/r"]);
    let part: { sync?(m: FactoryModel): void } | null = null;
    const sync = vi.fn((m: FactoryModel) => part?.sync?.(m));
    const factory = {
      attach: (p: typeof part) => {
        part = p;
        return () => (part = null);
      },
      currentLayout: layout,
      sync,
    } as unknown as Factory;
    const addStaticCasters = vi.fn();
    const lines = new FactoryLines(factory, {
      scene,
      lighting: { addStaticCasters } as never,
    });
    const projects = [project("o/r", [pr(1), pr(2)])];
    expect(lines.feed(projects, [], NOW)).toBe(true);
    for (let i = 0; i < 3; i++)
      expect(lines.feed(structuredClone(projects), [], NOW)).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
    const st = lines.stats();
    expect(st.sync).toMatchObject({ pushes: 1, skips: 3, demo: false });
    expect(st.built).toBe(false);
    expect(st.pieces).toBe(2);
    lines.setVisibility({
      cells: new Map([["o/r", "hidden"]]),
      mainLine: "hidden",
      dock: "hidden",
    });
    expect(lines.stats().built).toBe(false);
    expect(addStaticCasters).not.toHaveBeenCalled();
    lines.dispose();
    scene.dispose();
    engine.dispose();
  });
});
