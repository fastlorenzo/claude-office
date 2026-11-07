import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions, projectOf } from "@/engine/logic/projectGroups";
import type { CampusProject, CampusSession } from "@/engine/contracts";

describe("groupSessions", () => {
  const { campus, sessions, projects } = createDemoCampus(6, 20000);

  it("prefers CampusState.projects (3 projects with 3 / 2 / 1 sessions)", () => {
    const g = groupSessions(campus, sessions, projects);
    expect(g.map((x) => [x.name, x.sessionIds.length])).toEqual([
      ["continuum", 3],
      ["payments-api", 2],
      ["claude-office", 1],
    ]);
    expect(g[0].id).toBe("acme/continuum");
    expect(g[0].sessionIds).toEqual(["demo-0", "demo-2", "demo-5"]);
  });

  it("derives the same grouping client-side when projects are absent", () => {
    const stripped = campus.map((c) => ({ ...c, projectId: null }));
    const g = groupSessions(stripped, sessions, null);
    expect(g.map((x) => [x.name, x.sessionIds])).toEqual([
      ["continuum", ["demo-0", "demo-2", "demo-5"]],
      ["payments-api", ["demo-1", "demo-4"]],
      ["claude-office", ["demo-3"]],
    ]);
  });

  it("falls back to the session label, and to projectId when present", () => {
    const bare: CampusSession[] = campus.slice(0, 2).map((c) => ({
      ...c,
      project: null,
      projectId: null,
    }));
    const labels = [
      { ...sessions[0], label: "alpha" },
      { ...sessions[1], label: "Alpha " },
    ];
    const g = groupSessions(bare, labels, null);
    expect(g).toHaveLength(1);
    expect(g[0].sessionIds).toEqual(["demo-0", "demo-1"]);
    const byId = groupSessions(
      bare.map((c) => ({ ...c, projectId: "x/y" })),
      labels,
      null,
    );
    expect(byId.map((x) => x.id)).toEqual(["x/y"]);
  });

  it("ignores dead sessions in project lists and catches missed ones", () => {
    const p: CampusProject[] = [
      {
        id: "acme/continuum",
        name: "continuum",
        sessionIds: ["demo-0", "ghost"],
        updatedAt: "",
      },
    ];
    const g = groupSessions(campus, sessions, p);
    const cont = g.find((x) => x.id === "acme/continuum")!;
    expect(cont.sessionIds).toEqual(["demo-0", "demo-2", "demo-5"]);
    expect(projectOf(g).get("demo-3")).toBe("acme/claude-office");
    expect(g.flatMap((x) => x.sessionIds)).toHaveLength(6);
  });

  it("is stable across reorders", () => {
    const a = groupSessions(campus, sessions, projects);
    const b = groupSessions(
      [...campus].reverse(),
      [...sessions].reverse(),
      [...projects].reverse(),
    );
    expect(b).toEqual(a);
  });
});

describe("demo projects", () => {
  it("carries realistic PRs and pipelines", () => {
    const { projects, campus } = createDemoCampus(6, 20000);
    expect(projects.map((p) => p.sessionIds.length)).toEqual([3, 2, 1]);
    for (const p of projects) {
      expect(p.ciAvailable).toBe(true);
      expect(p.pullRequests!.length).toBeGreaterThan(0);
      expect(p.pipelines!.length).toBeGreaterThan(0);
      for (const pr of p.pullRequests!) {
        expect(pr.checks.total).toBe(
          pr.checks.passed + pr.checks.failed + pr.checks.pending,
        );
        if (pr.sessionId)
          expect(
            campus.find((c) => c.sessionId === pr.sessionId)?.gitBranch,
          ).toBe(pr.branch);
      }
    }
  });
});
