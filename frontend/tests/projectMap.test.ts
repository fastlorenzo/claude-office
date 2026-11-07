import { describe, expect, it } from "vitest";
import type { CampusProject, CampusSession } from "@/engine/contracts";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  dotPosition,
  layoutProjectMap,
  mapKey,
  mapSessions,
  pointAt,
  projectGroups,
} from "@/engine/logic/projectMap";

const demo = createDemoCampus(6, 20000);

function sess(
  id: string,
  project: string | null,
  extra: Partial<CampusSession> = {},
): CampusSession {
  const base = demo.campus[0];
  return { ...base, sessionId: id, project, projectId: null, ...extra };
}

describe("projectGroups", () => {
  it("groups sessions by project name when the backend sends no projects", () => {
    const campus = [sess("a", "alpha"), sess("b", "beta"), sess("c", "alpha")];
    const g = projectGroups(campus);
    expect(g.map((x) => x.name).sort()).toEqual(["alpha", "beta"]);
    expect(g.find((x) => x.name === "alpha")!.sessionIds).toEqual(["a", "c"]);
  });

  it("uses CampusState.projects (with CI roll-up) and falls back for the rest", () => {
    const campus = [sess("a", "alpha"), sess("b", "beta"), sess("x", "stray")];
    const projects: CampusProject[] = [
      {
        id: "org/alpha",
        name: "alpha",
        repo: "org/alpha",
        sessionIds: ["a", "b", "gone"],
        ciAvailable: true,
        updatedAt: "",
        pullRequests: [
          {
            number: 7,
            title: "feat",
            branch: "f",
            draft: false,
            state: "open",
            checks: {
              state: "failure",
              total: 3,
              passed: 2,
              failed: 1,
              pending: 0,
            },
            updatedAt: "",
          },
        ],
        pipelines: [{ id: "1", workflow: "CI", kind: "ci", state: "success" }],
      },
    ];
    const g = projectGroups(campus, projects);
    const alpha = g.find((x) => x.id === "org/alpha")!;
    expect(alpha.sessionIds).toEqual(["a", "b"]);
    expect(alpha.ci).toBe("failure");
    expect(alpha.openPrs).toBe(1);
    expect(g.find((x) => x.name === "stray")!.sessionIds).toEqual(["x"]);
  });
});

describe("layoutProjectMap", () => {
  const groups = projectGroups(demo.campus);
  const sessions = mapSessions(demo.campus);
  const W = 1760;
  const H = 960;
  const m = layoutProjectMap(groups, sessions, W, H);

  it("draws one line per project and one node per session, inside the box", () => {
    expect(m.lines.length).toBe(Math.min(7, groups.length));
    const drawn = m.lines.reduce(
      (s, l) =>
        s + Math.min(6, groups.find((g) => g.id === l.id)!.sessionIds.length),
      0,
    );
    expect(m.nodes.length).toBe(drawn);
    for (const n of m.nodes) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(W);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(H);
    }
  });

  it("runs every line into the hub with a 45° bend", () => {
    for (const l of m.lines) {
      const [, b, c, d] = l.points;
      expect(Math.abs(Math.abs(c.x - b.x) - Math.abs(c.y - b.y))).toBeLessThan(
        1e-6,
      );
      expect(d.x).toBeCloseTo(m.hub.x - m.hub.r * 0.98);
      expect(Math.abs(d.y - m.hub.y)).toBeLessThan(m.hub.r);
    }
  });

  it("emits subagent dots that stay on their path", () => {
    const withAgents = [...sessions.values()].filter((s) => s.subagents > 0);
    if (withAgents.length) expect(m.dots.length).toBeGreaterThan(0);
    for (const d of m.dots) {
      for (const t of [0, 1.3, 7.7]) {
        const p = dotPosition(d, t);
        const xs = d.path.map((q) => q.x);
        const ys = d.path.map((q) => q.y);
        expect(p.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
        expect(p.x).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
        expect(p.y).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
      }
    }
  });

  it("is deterministic and caps lines", () => {
    expect(mapKey(layoutProjectMap(groups, sessions, W, H))).toBe(mapKey(m));
    const many = Array.from({ length: 12 }, (_, i) => sess(`s${i}`, `p${i}`));
    const big = layoutProjectMap(projectGroups(many), mapSessions(many), W, H);
    expect(big.lines.length).toBe(7);
    expect(big.moreLines).toBe(5);
  });

  it("handles an empty campus", () => {
    const e = layoutProjectMap([], new Map(), W, H);
    expect(e.lines).toEqual([]);
    expect(e.dots).toEqual([]);
  });
});

describe("pointAt", () => {
  it("walks a polyline by length", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(pointAt(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(path, 0.5)).toEqual({ x: 10, y: 0 });
    expect(pointAt(path, 0.75)).toEqual({ x: 10, y: 5 });
    expect(pointAt(path, 1)).toEqual({ x: 10, y: 10 });
  });
});
