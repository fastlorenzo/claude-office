import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  demoFactoryProjects,
  demoFactoryTick,
} from "@/engine/demo/demoFactory";
import { buildFactoryModel, MAX_LANES } from "@/engine/logic/factoryModel";
import type { CampusProject, CheckKind, CheckState } from "@/engine/contracts";

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);
const ALL_STATES: CheckState[] = [
  "none",
  "queued",
  "running",
  "success",
  "failure",
  "cancelled",
];
const RANK: Record<CheckState, number> = {
  queued: 0,
  running: 1,
  success: 2,
  failure: 2,
  cancelled: 2,
  none: 0,
};

const sessions = createDemoCampus(6, NOW).campus;

/** Every (key -> state) for runs and pipelines, flattened across projects. */
function stateMap(projects: CampusProject[]): Map<string, CheckState> {
  const out = new Map<string, CheckState>();
  for (const p of projects) {
    for (const pr of p.pullRequests ?? []) {
      for (const r of pr.checks.runs ?? []) {
        out.set(`${p.id}#${pr.number}:${r.name}`, r.state);
      }
    }
    for (const pl of p.pipelines ?? []) {
      out.set(`${p.id}@${pl.id}`, pl.state);
    }
  }
  return out;
}

describe("demoFactoryProjects", () => {
  it("is deterministic for the same inputs", () => {
    const a = demoFactoryProjects(sessions, NOW, { seed: 3 });
    const b = demoFactoryProjects(sessions, NOW, { seed: 3 });
    expect(a).toEqual(b);
    expect(demoFactoryProjects(sessions, NOW)).toEqual(
      demoFactoryProjects(sessions, NOW),
    );
  });

  it("changes with the seed, and defaults to 4 projects", () => {
    expect(demoFactoryProjects(sessions, NOW)).toHaveLength(4);
    expect(demoFactoryProjects(sessions, NOW, { projects: 3 })).toHaveLength(3);
    expect(demoFactoryProjects(sessions, NOW, { seed: 1 })).not.toEqual(
      demoFactoryProjects(sessions, NOW, { seed: 2 }),
    );
  });

  it("has at least 8 concurrent open PRs on one repo", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    const open = projects.map(
      (p) => (p.pullRequests ?? []).filter((pr) => pr.state === "open").length,
    );
    expect(Math.max(...open)).toBeGreaterThanOrEqual(8);
  });

  it("mixes draft, approved, changes-requested, conflicting and bot PRs", () => {
    const prs = demoFactoryProjects(sessions, NOW).flatMap(
      (p) => p.pullRequests ?? [],
    );
    expect(prs.some((pr) => pr.draft)).toBe(true);
    expect(prs.some((pr) => pr.reviewDecision === "approved")).toBe(true);
    expect(prs.some((pr) => pr.reviewDecision === "changes_requested")).toBe(
      true,
    );
    expect(prs.some((pr) => pr.mergeable === "conflicting")).toBe(true);
    expect(prs.some((pr) => pr.bot && pr.author === "dependabot[bot]")).toBe(
      true,
    );
  });

  it("has one failing main, releases, and local git for one project", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    expect(projects.some((p) => p.mainHealth === "failure")).toBe(true);
    expect(projects.some((p) => (p.releases ?? []).length >= 1)).toBe(true);
    expect(projects.filter((p) => p.localGit).length).toBe(1);
  });

  it("links PRs to the given sessions where a branch matches", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    const linked = projects
      .flatMap((p) => p.pullRequests ?? [])
      .filter((pr) => pr.sessionId);
    expect(linked.length).toBeGreaterThan(0);
    for (const pr of linked) {
      expect(sessions.some((s) => s.sessionId === pr.sessionId)).toBe(true);
    }
  });

  it("covers every check kind and check state", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    const runs = projects.flatMap((p) =>
      (p.pullRequests ?? []).flatMap((pr) => pr.checks.runs ?? []),
    );
    const kinds = new Set(runs.map((r) => r.kind));
    const allKinds: CheckKind[] = [
      "lint",
      "test",
      "build",
      "security",
      "deploy",
      "release",
      "other",
    ];
    for (const k of allKinds) expect(kinds.has(k)).toBe(true);
    expect(runs.some((r) => (r.attempt ?? 1) === 2)).toBe(true);

    const seen = new Set<CheckState>();
    for (const p of projects) {
      for (const pr of p.pullRequests ?? []) seen.add(pr.checks.state);
      for (const pl of p.pipelines ?? []) seen.add(pl.state);
      if (p.mainHealth) seen.add(p.mainHealth);
    }
    for (const r of runs) seen.add(r.state);
    for (const s of ALL_STATES) expect(seen.has(s)).toBe(true);
  });
});

describe("buildFactoryModel over the demo", () => {
  it("overflows the lanes into a queued state", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    const model = buildFactoryModel(projects, sessions, NOW);
    const busy = model.lines.find((l) => l.projectId === "acme/continuum");
    expect(busy).toBeDefined();
    expect(busy!.lanes).toBe(MAX_LANES);
    expect(busy!.queued).toBeGreaterThan(0);
    const queuedPieces = busy!.workpieces.filter((w) => w.stamp === "QUEUED");
    expect(queuedPieces.length).toBe(busy!.queued);
    expect(queuedPieces.every((w) => w.lane === null)).toBe(true);
  });
});

describe("demoFactoryTick", () => {
  it("is idempotent at a fixed time", () => {
    const projects = demoFactoryProjects(sessions, NOW);
    const t = NOW + 60_000;
    const once = demoFactoryTick(projects, t);
    expect(demoFactoryTick(once, t)).toEqual(once);
  });

  it("advances states monotonically and settles", () => {
    let projects = demoFactoryProjects(sessions, NOW);
    let prev = stateMap(projects);
    let sawProgress = false;

    for (let t = NOW + 30_000; t <= NOW + 40 * 60_000; t += 30_000) {
      projects = demoFactoryTick(projects, t);
      const cur = stateMap(projects);
      for (const [key, state] of cur) {
        const before = prev.get(key);
        if (before === undefined) continue;
        expect(RANK[state]).toBeGreaterThanOrEqual(RANK[before]);
        if (RANK[state] > RANK[before]) sawProgress = true;
      }
      prev = cur;
    }

    expect(sawProgress).toBe(true);
    for (const state of prev.values()) {
      expect(state === "queued" || state === "running").toBe(false);
    }
  });
});
