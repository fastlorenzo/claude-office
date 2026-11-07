import { describe, expect, it } from "vitest";
import type {
  CampusProject,
  CampusSession,
  CheckRun,
  CheckState,
  PipelineRun,
  PullRequestInfo,
} from "@/engine/contracts";
import { CHECK_COLORS } from "@/engine/contracts";
import {
  FADE_STEPS,
  MAX_LANES,
  MAX_STATIONS,
  RECENT_WINDOW_MS,
  STALE_PR_MS,
  assignLanes,
  buildFactoryModel,
  classifyCheckKind,
  factoryKey,
  floorBoard,
  lineProgress,
  sizeClassOf,
} from "@/engine/logic/factoryModel";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600 * 1000;
const D = 24 * H;

const run = (
  name: string,
  state: CheckState,
  extra: Partial<CheckRun> = {},
): CheckRun => ({
  name,
  state,
  ...extra,
});

function rollup(runs: CheckRun[]): PullRequestInfo["checks"] {
  const states = runs.map((r) => r.state);
  const state: CheckState = states.includes("failure")
    ? "failure"
    : states.includes("running")
      ? "running"
      : states.includes("queued")
        ? "queued"
        : states.length && states.every((s) => s === "success")
          ? "success"
          : "none";
  return {
    state,
    total: runs.length,
    passed: states.filter((s) => s === "success").length,
    failed: states.filter((s) => s === "failure").length,
    pending: states.filter((s) => s === "running" || s === "queued").length,
    runs,
  };
}

function pr(
  n: number,
  runs: CheckRun[] = [],
  extra: Partial<PullRequestInfo> = {},
): PullRequestInfo {
  return {
    number: n,
    title: `PR ${n}`,
    branch: `feat/${n}`,
    draft: false,
    state: "open",
    checks: rollup(runs),
    updatedAt: ago(H),
    ...extra,
  };
}

function project(
  prs: PullRequestInfo[],
  extra: Partial<CampusProject> = {},
): CampusProject {
  return {
    id: "o/repo",
    name: "repo",
    repo: "o/repo",
    defaultBranch: "main",
    sessionIds: [],
    pullRequests: prs,
    pipelines: [],
    ciAvailable: true,
    updatedAt: ago(0),
    ...extra,
  };
}

function session(
  id: string,
  extra: Partial<CampusSession> = {},
): CampusSession {
  return {
    sessionId: id,
    bucket: "working",
    projectId: "o/repo",
    alive: true,
    ended: false,
    lastUpdated: ago(0),
    ...extra,
  } as CampusSession;
}

const line = (p: CampusProject, ss: CampusSession[] = []) =>
  buildFactoryModel([p], ss, NOW).lines[0];
const piece = (p: CampusProject, n: number, ss: CampusSession[] = []) =>
  line(p, ss).workpieces.find((w) => w.prNumber === n)!;

const GREEN = [
  run("lint", "success"),
  run("build", "success"),
  run("test", "success"),
];

describe("check classification + size", () => {
  it("classifies names into kinds", () => {
    expect(classifyCheckKind("test (3.12)")).toBe("test");
    expect(classifyCheckKind("ESLint")).toBe("lint");
    expect(classifyCheckKind("CodeQL")).toBe("security");
    expect(classifyCheckKind("deploy-prod")).toBe("deploy");
    expect(classifyCheckKind("build")).toBe("build");
    expect(classifyCheckKind("zzz")).toBe("other");
  });
  it("size classes on log thresholds", () => {
    expect(sizeClassOf(10, 5)).toBe("S");
    expect(sizeClassOf(200, 50)).toBe("M");
    expect(sizeClassOf(1000, 100)).toBe("L");
    expect(sizeClassOf(4000, 0)).toBe("XL");
    expect(sizeClassOf(null, null)).toBe("M");
  });
});

describe("stations", () => {
  it("are the union of check names across open PRs, in pipeline order", () => {
    const l = line(
      project([
        pr(1, [run("test", "success"), run("lint", "success")]),
        pr(2, [run("build", "success")]),
      ]),
    );
    expect(l.stations.map((s) => s.name)).toEqual(["lint", "build", "test"]);
    expect(l.stations.map((s) => s.kind)).toEqual(["lint", "build", "test"]);
  });
  it("ignore merged / closed PRs", () => {
    const l = line(
      project([
        pr(1, [run("build", "success")]),
        pr(2, [run("e2e", "success")], { state: "merged", mergedAt: ago(H) }),
      ]),
    );
    expect(l.stations.map((s) => s.name)).toEqual(["build"]);
  });
  it("cap at 6 plus an other bucket", () => {
    const names = [
      "a-lint",
      "b-lint",
      "c-build",
      "d-build",
      "e-test",
      "f-test",
      "g-test",
      "h-test",
    ];
    const l = line(
      project([
        pr(
          1,
          names.map((n) => run(n, "success")),
        ),
      ]),
    );
    expect(l.stations).toHaveLength(MAX_STATIONS + 1);
    const other = l.stations[MAX_STATIONS];
    expect(other.other).toBe(true);
    expect(other.name).toBe("+2");
    expect(other.names).toHaveLength(2);
  });
  it("order is independent of PR order and run order", () => {
    const a = pr(1, [run("test", "success"), run("lint", "failure")]);
    const b = pr(2, [run("security", "queued"), run("build", "running")]);
    const x = line(project([a, b])).stations.map((s) => s.name);
    const y = line(project([b, a])).stations.map((s) => s.name);
    expect(x).toEqual(y);
    expect(x).toEqual(["lint", "build", "test", "security"]);
  });
  it("roll up the worst state over PRs and count occupants", () => {
    const l = line(
      project([
        pr(1, [run("test", "success")]),
        pr(2, [run("test", "running")]),
      ]),
    );
    expect(l.stations[0].state).toBe("running");
    expect(l.stations[0].occupants).toBe(1);
  });
  it("expose retry attempts", () => {
    const l = line(project([pr(1, [run("test", "running", { attempt: 2 })])]));
    expect(l.stations[0].attempt).toBe(2);
  });
});

describe("workpiece placement", () => {
  it("draft -> rack with DRAFT stamp and primer colour", () => {
    const w = piece(
      project([pr(1, [run("test", "running")], { draft: true })]),
      1,
    );
    expect(w.position.segment).toBe("rack");
    expect(w.stamp).toBe("DRAFT");
    expect(w.color).not.toBe(CHECK_COLORS.working);
  });
  it("no checks yet -> belt start", () => {
    const w = piece(project([pr(1)]), 1);
    expect(w.position).toMatchObject({ segment: "belt", t: 0 });
  });
  it("first non-success station holds the piece", () => {
    const p = project([
      pr(1, [
        run("lint", "success"),
        run("build", "running"),
        run("test", "queued"),
      ]),
    ]);
    const w = piece(p, 1);
    expect(w.position.segment).toBe("station");
    expect(w.position.stationIndex).toBe(1);
    expect(w.color).toBe(CHECK_COLORS.working);
  });
  it("failure -> rework with the failing check in the stamp", () => {
    const w = piece(
      project([pr(1, [run("lint", "success"), run("test", "failure")])]),
      1,
    );
    expect(w.position.segment).toBe("rework");
    expect(w.position.stationIndex).toBe(1);
    expect(w.stamp).toBe("REWORK: test");
    expect(w.color).toBe(CHECK_COLORS.failure);
  });
  it("failure beats a pending earlier station", () => {
    const w = piece(
      project([pr(1, [run("lint", "running"), run("test", "failure")])]),
      1,
    );
    expect(w.position.segment).toBe("rework");
  });
  it("all green + review_required -> qa", () => {
    const w = piece(
      project([pr(1, GREEN, { reviewDecision: "review_required" })]),
      1,
    );
    expect(w.position.segment).toBe("qa");
  });
  it("changes_requested -> rework", () => {
    const w = piece(
      project([pr(1, GREEN, { reviewDecision: "changes_requested" })]),
      1,
    );
    expect(w.position.segment).toBe("rework");
    expect(w.stamp).toBe("CHANGES REQUESTED");
  });
  it("approved + mergeable -> gate open (t = 1)", () => {
    const w = piece(
      project([
        pr(1, GREEN, { reviewDecision: "approved", mergeable: "mergeable" }),
      ]),
      1,
    );
    expect(w.position).toMatchObject({ segment: "gate", t: 1 });
    expect(w.stuck).toBe(false);
  });
  it("conflicting -> stuck at the gate with MISFIT", () => {
    const w = piece(
      project([
        pr(1, GREEN, { reviewDecision: "approved", mergeable: "conflicting" }),
      ]),
      1,
    );
    expect(w.position.segment).toBe("gate");
    expect(w.stuck).toBe(true);
    expect(w.stamp).toBe("MISFIT");
  });
  it("merged -> trunk with age fade, vanishes after the window", () => {
    const fresh = piece(
      project([pr(1, GREEN, { state: "merged", mergedAt: ago(0) })]),
      1,
    );
    expect(fresh.position.segment).toBe("trunk");
    expect(fresh.fade).toBe(1);
    expect(fresh.color).toBe(CHECK_COLORS.merged);
    expect(fresh.stamp).toBe("MERGED #1");
    const half = piece(
      project([
        pr(1, GREEN, { state: "merged", mergedAt: ago(RECENT_WINDOW_MS / 2) }),
      ]),
      1,
    );
    expect(half.fade).toBeCloseTo(0.5, 5);
    expect(half.position.t).toBeGreaterThan(fresh.position.t);
    const gone = line(
      project([
        pr(1, GREEN, { state: "merged", mergedAt: ago(RECENT_WINDOW_MS + H) }),
      ]),
    );
    expect(gone.workpieces).toHaveLength(0);
  });
  it("closed -> scrap", () => {
    const w = piece(
      project([pr(1, [], { state: "closed", closedAt: ago(2 * H) })]),
      1,
    );
    expect(w.position.segment).toBe("scrap");
    expect(w.fade).toBeLessThan(1);
  });
  it("stale > 7 d -> holding with AGING stamp", () => {
    const w = piece(
      project([pr(1, GREEN, { updatedAt: ago(STALE_PR_MS + 5 * D) })]),
      1,
    );
    expect(w.position.segment).toBe("holding");
    expect(w.stamp).toBe("AGING 12d");
    expect(w.stale).toBe(true);
  });
  it("just under 7 d is not stale", () => {
    const w = piece(
      project([pr(1, GREEN, { updatedAt: ago(STALE_PR_MS - H) })]),
      1,
    );
    expect(w.stale).toBe(false);
  });
  it("labels become at most 3 bands, null colours get a fallback", () => {
    const w = piece(
      project([
        pr(1, [], {
          labels: [
            { name: "a", color: "#ff0000" },
            { name: "b" },
            { name: "c", color: "#00ff00" },
            { name: "d", color: "#0000ff" },
          ],
        }),
      ]),
      1,
    );
    expect(w.bands.map((b) => b.name)).toEqual(["a", "b", "c"]);
    expect(w.bands[1].color).toBeTruthy();
  });
  it("size class from additions + deletions and tag from number + title", () => {
    const w = piece(
      project([
        pr(412, [], { additions: 900, deletions: 200, title: "Add SSO" }),
      ]),
      412,
    );
    expect(w.sizeClass).toBe("L");
    expect(w.tag).toBe("#412 · Add SSO");
  });
});

describe("monotonic progress", () => {
  it("position advances as checks pass, then through review to the gate", () => {
    const steps: PullRequestInfo[] = [
      pr(1),
      pr(1, [
        run("lint", "running"),
        run("build", "queued"),
        run("test", "queued"),
      ]),
      pr(1, [
        run("lint", "success"),
        run("build", "running"),
        run("test", "queued"),
      ]),
      pr(1, [
        run("lint", "success"),
        run("build", "success"),
        run("test", "running"),
      ]),
      pr(1, GREEN, { reviewDecision: "review_required" }),
      pr(1, GREEN, { reviewDecision: "approved", mergeable: "mergeable" }),
      pr(1, GREEN, { state: "merged", mergedAt: ago(0) }),
    ];
    const prog = steps.map((s) => {
      const l = line(project([s]));
      return lineProgress(l.workpieces[0].position, l.stations.length);
    });
    // stations differ per step (belt has none), so compare via a fixed station count too.
    const fixed = steps.map((s) => {
      const l = line(project([s, pr(2, GREEN)]));
      const w = l.workpieces.find((x) => x.prNumber === 1)!;
      return lineProgress(w.position, l.stations.length);
    });
    for (const series of [fixed]) {
      for (let i = 1; i < series.length; i++)
        expect(series[i]).toBeGreaterThan(series[i - 1]);
    }
    expect(prog[0]).toBeLessThan(prog[prog.length - 1]);
  });
  it("failure diverts off the line (progress -1)", () => {
    const l = line(
      project([pr(1, [run("lint", "success"), run("test", "failure")])]),
    );
    expect(lineProgress(l.workpieces[0].position, l.stations.length)).toBe(-1);
  });
});

describe("bots, sessions and local bench", () => {
  it("batches bot PRs on one pallet", () => {
    const p = project([
      pr(1, GREEN, { bot: true, author: "dependabot[bot]" }),
      pr(2, [run("lint", "running")], { bot: true }),
      pr(3, GREEN),
    ]);
    const l = line(p);
    const bots = l.workpieces.filter((w) => w.kind === "bots");
    expect(bots).toHaveLength(1);
    expect(bots[0].prNumbers).toEqual([1, 2]);
    expect(bots[0].tag).toBe("DEP ×2");
    expect(bots[0].sizeClass).toBe("S");
    expect(l.workpieces).toHaveLength(2);
  });
  it("a single bot PR stays a normal piece flagged bot", () => {
    const w = piece(project([pr(1, GREEN, { bot: true })]), 1);
    expect(w.kind).toBe("pr");
    expect(w.bot).toBe(true);
  });
  it("links sessions by explicit sessionId and by branch", () => {
    const p = project([pr(1, [], { sessionId: "s1" }), pr(2, [])]);
    const ss = [
      session("s1", { gitBranch: "other" }),
      session("s2", {
        gitBranch: "feat/2",
        phase: { kind: "coding", label: "Coding" },
      }),
    ];
    expect(piece(p, 1, ss).sessionId).toBe("s1");
    const w2 = piece(p, 2, ss);
    expect(w2.sessionId).toBe("s2");
    expect(w2.sessionPhase).toBe("coding");
  });
  it("does not link ended sessions or sessions from other projects by branch", () => {
    const p = project([pr(2, [])]);
    expect(
      piece(p, 2, [session("s", { gitBranch: "feat/2", ended: true })])
        .sessionId,
    ).toBeNull();
    expect(
      piece(p, 2, [session("s", { gitBranch: "feat/2", projectId: "x/y" })])
        .sessionId,
    ).toBeNull();
  });
  it("branches without a PR sit on the intake rack", () => {
    const p = project([pr(1, [])]);
    const l = line(p, [
      session("s1", { gitBranch: "wip/foo" }),
      session("s2", { gitBranch: "main" }),
    ]);
    const branch = l.workpieces.find((w) => w.kind === "branch")!;
    expect(branch.branch).toBe("wip/foo");
    expect(branch.position.segment).toBe("rack");
    expect(branch.sessionId).toBe("s1");
    expect(l.workpieces.filter((w) => w.kind === "branch")).toHaveLength(1);
  });
  it("local git: dirty files fill the bench, ahead marks READY", () => {
    const p = project([], {
      ciAvailable: false,
      localGit: { branch: "wip/x", ahead: 2, behind: 0, dirtyFiles: 4 },
    });
    const l = line(p);
    expect(l.bench.dirtyFiles).toBe(4);
    expect(l.workpieces[0].stamp).toBe("READY");
  });
  it("bench lights from testing phase; failures turn it red", () => {
    const p = project([]);
    const testing = session("s", {
      phase: { kind: "testing", label: "Running tests" },
    });
    expect(line(p, [testing]).bench).toMatchObject({
      active: true,
      failing: false,
    });
    const failing = session("s", {
      phase: { kind: "testing", label: "Running tests" },
      activity: {
        eventsPerMin: [],
        toolMix: {},
        toolCalls: 1,
        subagentsSpawned: 0,
        testFailures: 2,
      },
    });
    expect(line(p, [failing]).bench).toMatchObject({
      active: true,
      failing: true,
    });
    const coding = session("s", { phase: { kind: "coding", label: "Coding" } });
    expect(line(p, [coding]).bench.active).toBe(false);
  });
});

describe("line, trunk, dock and offline behaviour", () => {
  const ci = (
    id: string,
    state: CheckState,
    extra: Partial<PipelineRun> = {},
  ): PipelineRun => ({
    id,
    workflow: "CI",
    kind: "ci",
    branch: "main",
    state,
    ...extra,
  });
  it("trunk health and running come from main CI pipelines", () => {
    const l = line(
      project([], { pipelines: [ci("2", "running"), ci("1", "failure")] }),
    );
    expect(l.trunk.running).toBe(true);
    expect(l.trunk.health).toBe("running");
    expect(
      line(
        project([], { pipelines: [ci("1", "success")], mainHealth: "failure" }),
      ).trunk.health,
    ).toBe("failure");
  });
  it("deploy / release pipelines drive the dock; releases are capped at 5", () => {
    const l = line(
      project([], {
        pipelines: [
          {
            id: "9",
            workflow: "Deploy",
            kind: "deploy",
            branch: "main",
            state: "running",
          },
        ],
        releases: Array.from({ length: 7 }, (_, i) => ({ tag: `v1.${i}` })),
      }),
    );
    expect(l.dock.deploying).toBe(true);
    expect(l.dock.releases).toHaveLength(5);
  });
  it("no CI: no stations, no PRs, header says LOCAL", () => {
    const l = line(project([pr(1, GREEN)], { ciAvailable: false }));
    expect(l.mode).toBe("local");
    expect(l.stations).toHaveLength(0);
    expect(l.workpieces).toHaveLength(0);
    expect(l.header).toContain("LOCAL");
    expect(l.header).toContain("no CI");
  });
  it("stale data is flagged in the header and board", () => {
    const p = project([pr(1, GREEN)], { stale: true, ciError: "boom" });
    const l = line(p);
    expect(l.stale).toBe(true);
    expect(l.ciError).toBe("boom");
    expect(l.header).toContain("STALE");
    expect(floorBoard({ lines: [l] })[0].stale).toBe(true);
  });
  it("header reports PR and failing counts; line is lit with a live session", () => {
    const p = project([pr(1, [run("test", "failure")]), pr(2, GREEN)]);
    const l = line(p);
    expect(l.header).toContain("2 PRs");
    expect(l.header).toContain("1 failing");
    expect(l.lit).toBe(false);
    expect(line(p, [session("s")]).lit).toBe(true);
  });
  it("lines are ordered by project id regardless of input order", () => {
    const a = project([], { id: "a/a", name: "a" });
    const b = project([], { id: "b/b", name: "b" });
    expect(
      buildFactoryModel([b, a], [], NOW).lines.map((x) => x.projectId),
    ).toEqual(["a/a", "b/b"]);
  });
  it("handles null / empty inputs", () => {
    expect(buildFactoryModel(null, null, NOW).lines).toEqual([]);
    expect(buildFactoryModel(undefined, [], NOW).lines).toEqual([]);
  });
});

describe("floorBoard", () => {
  it("summarises health, open, running, failing, deploying per line", () => {
    const p = project(
      [
        pr(1, [run("test", "failure")]),
        pr(2, [run("test", "running")]),
        pr(3, GREEN),
      ],
      {
        mainHealth: "success",
        pipelines: [
          {
            id: "1",
            workflow: "Deploy",
            kind: "deploy",
            branch: "main",
            state: "queued",
          },
        ],
      },
    );
    const rows = floorBoard(buildFactoryModel([p], [], NOW));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "o/repo",
      health: "success",
      open: 3,
      running: 1,
      failing: 1,
      deploying: true,
    });
  });
});

describe("factoryKey", () => {
  const base = () =>
    project([
      pr(1, GREEN, { reviewDecision: "approved", mergeable: "mergeable" }),
    ]);
  const key = (p: CampusProject, ss: CampusSession[] = [], now = NOW) =>
    factoryKey(buildFactoryModel([p], ss, now));

  it("is stable for identical input and when the clock advances a little", () => {
    expect(key(base())).toBe(key(base()));
    expect(key(base(), [], NOW + 60_000)).toBe(key(base()));
  });
  it("ignores unrelated changes (updatedAt churn, fetchedAt)", () => {
    const p = base();
    const q = { ...base(), fetchedAt: ago(0), updatedAt: ago(5 * H) };
    q.pullRequests = [{ ...(p.pullRequests ?? [])[0], updatedAt: ago(2 * H) }];
    expect(key(q)).toBe(key(p));
  });
  it("changes when a check changes state", () => {
    const a = project([pr(1, [run("test", "running")])]);
    const b = project([pr(1, [run("test", "success")])]);
    expect(key(a)).not.toBe(key(b));
  });
  it("changes on meaningful change: new PR, stamp, session link, bench", () => {
    const k0 = key(base());
    expect(key(project([...(base().pullRequests ?? []), pr(2)]))).not.toBe(k0);
    const conflicted = project([
      pr(1, GREEN, { reviewDecision: "approved", mergeable: "conflicting" }),
    ]);
    expect(key(conflicted)).not.toBe(k0);
    expect(key(base(), [session("s", { gitBranch: "feat/1" })])).not.toBe(k0);
    expect(
      key(base(), [session("s", { phase: { kind: "testing", label: "t" } })]),
    ).not.toBe(k0);
  });
  it("merged fade only changes per quantised step", () => {
    const p = project([pr(1, GREEN, { state: "merged", mergedAt: ago(0) })]);
    const step = RECENT_WINDOW_MS / FADE_STEPS;
    expect(key(p, [], NOW + 1000)).toBe(key(p));
    expect(key(p, [], NOW + step)).not.toBe(key(p));
  });
});

describe("lanes", () => {
  const RUN = [run("test", "running")];
  const build = (
    prs: PullRequestInfo[],
    opts?: Parameters<typeof buildFactoryModel>[3],
    extra: Partial<CampusProject> = {},
    now = NOW,
  ) => buildFactoryModel([project(prs, extra)], [], now, opts);
  const laneOf = (m: ReturnType<typeof build>, n: number) =>
    m.lines[0].workpieces.find((w) => w.prNumber === n)!.lane;

  it("defaults to MAX_LANES and exposes lane fields", () => {
    const l = build([pr(1, RUN)]).lines[0];
    expect(MAX_LANES).toBe(6);
    expect(l.lanes).toBe(6);
    expect(l.laneBusy).toHaveLength(6);
    expect(l.queued).toBe(0);
    expect(l.workpieces[0].lane).toBe(0);
  });

  it("ineligible segments never take a lane", () => {
    const l = build(
      [
        pr(1, [], { draft: true }),
        pr(2, GREEN, { state: "merged", mergedAt: ago(H) }),
        pr(3, GREEN, { state: "closed", closedAt: ago(H) }),
        pr(4, RUN, { updatedAt: ago(8 * D) }),
        pr(5, RUN),
      ],
      undefined,
      { localGit: { branch: "wip", dirtyFiles: 0, ahead: 0 } as never },
    ).lines[0];
    const byNum = (n: number) => l.workpieces.find((w) => w.prNumber === n)!;
    for (const n of [1, 2, 3, 4]) expect(byNum(n).lane).toBeNull();
    expect(byNum(5).lane).toBe(0);
    expect(l.workpieces.find((w) => w.kind === "branch")!.lane).toBeNull();
    expect(l.queued).toBe(0);
  });

  it("keeps lanes stable across updates with prev", () => {
    const a = build([pr(1, RUN), pr(2, RUN), pr(3, RUN)]);
    const before = [1, 2, 3].map((n) => laneOf(a, n));
    // PR 3 becomes more urgent / newer; PR 1 stops running: order would change without prev.
    const b = build(
      [
        pr(1, GREEN),
        pr(2, RUN, { updatedAt: ago(2 * H) }),
        pr(3, RUN, { updatedAt: ago(0) }),
      ],
      { prev: a },
    );
    expect([1, 2, 3].map((n) => laneOf(b, n))).toEqual(before);
  });

  it("never double-occupies a lane", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(i + 1, RUN));
    const l = build(prs, { lanesFor: () => 4 }).lines[0];
    const lanes = l.workpieces.map((w) => w.lane).filter((x) => x !== null);
    expect(new Set(lanes).size).toBe(lanes.length);
    expect(lanes.sort()).toEqual([0, 1, 2, 3]);
  });

  it("queues overflow on the rack in priority order", () => {
    const prs = [
      pr(1, GREEN, { updatedAt: ago(5 * H) }),
      pr(2, GREEN, { updatedAt: ago(4 * H) }),
      pr(3, GREEN, { updatedAt: ago(3 * H) }),
      pr(4, RUN, { updatedAt: ago(6 * H) }),
    ];
    const m = build(prs, { lanesFor: () => 2 });
    const l = m.lines[0];
    // running first (4), then newest updatedAt (3); 2 and 1 queue.
    expect(laneOf(m, 4)).toBe(0);
    expect(laneOf(m, 3)).toBe(1);
    const q = (n: number) => l.workpieces.find((w) => w.prNumber === n)!;
    expect(q(2).position.segment).toBe("rack");
    expect(q(2).stamp).toBe("QUEUED");
    expect(q(2).lane).toBeNull();
    expect(q(1).stamp).toBe("QUEUED");
    expect(l.queued).toBe(2);
    // next freed lane goes to the higher-priority queued piece (2 before 1)
    const m2 = build(
      [
        pr(3, GREEN, { state: "merged", mergedAt: ago(0) }),
        ...prs.slice(0, 2),
        prs[3],
      ],
      { lanesFor: () => 2, prev: m },
    );
    expect(laneOf(m2, 2)).toBe(1);
    expect(laneOf(m2, 1)).toBeNull();
  });

  it("breaks priority ties by PR number", () => {
    const l = build([pr(9, GREEN), pr(3, GREEN), pr(5, GREEN)], {
      lanesFor: () => 2,
    });
    expect(laneOf(l, 3)).toBe(0);
    expect(laneOf(l, 5)).toBe(1);
    expect(laneOf(l, 9)).toBeNull();
  });

  it("reuses a freed lane and never evicts", () => {
    const a = build([pr(1, RUN), pr(2, RUN), pr(3, RUN)], {
      lanesFor: () => 3,
    });
    expect([1, 2, 3].map((n) => laneOf(a, n))).toEqual([0, 1, 2]);
    // PR 2 merges -> lane 1 free; new PR 4 takes it; 1 and 3 keep theirs.
    const b = build(
      [
        pr(1, RUN),
        pr(2, GREEN, { state: "merged", mergedAt: ago(0) }),
        pr(3, RUN),
        pr(4, RUN),
      ],
      { lanesFor: () => 3, prev: a },
    );
    expect(laneOf(b, 1)).toBe(0);
    expect(laneOf(b, 3)).toBe(2);
    expect(laneOf(b, 4)).toBe(1);
    expect(laneOf(b, 2)).toBeNull();
  });

  it("does not evict a placed piece for a higher-priority newcomer", () => {
    const a = build([pr(5, GREEN)], { lanesFor: () => 1 });
    const b = build([pr(5, GREEN), pr(1, RUN)], { lanesFor: () => 1, prev: a });
    expect(laneOf(b, 5)).toBe(0);
    expect(laneOf(b, 1)).toBeNull();
    expect(b.lines[0].queued).toBe(1);
  });

  it("shrinks capacity: lanes >= capacity go to the queue, lowest first", () => {
    const prs = [1, 2, 3, 4].map((n) => pr(n, RUN));
    const a = build(prs, { lanesFor: () => 4 });
    const b = build(prs, { lanesFor: () => 2, prev: a });
    expect(laneOf(b, 1)).toBe(0);
    expect(laneOf(b, 2)).toBe(1);
    expect(laneOf(b, 3)).toBeNull();
    expect(laneOf(b, 4)).toBeNull();
    expect(b.lines[0].lanes).toBe(2);
    expect(b.lines[0].laneBusy).toHaveLength(2);
    expect(b.lines[0].queued).toBe(2);
  });

  it("clamps lanesFor to 0..MAX_LANES", () => {
    expect(build([pr(1, RUN)], { lanesFor: () => 99 }).lines[0].lanes).toBe(6);
    const z = build([pr(1, RUN)], { lanesFor: () => 0 }).lines[0];
    expect(z.lanes).toBe(0);
    expect(z.workpieces[0].stamp).toBe("QUEUED");
  });

  it("is deterministic without prev, independent of feed order", () => {
    const prs = [pr(4, RUN), pr(2, GREEN), pr(7, RUN), pr(1, GREEN)];
    const a = build(prs, { lanesFor: () => 3 });
    const b = build([...prs].reverse(), { lanesFor: () => 3 });
    const lanes = (m: typeof a) => [1, 2, 4, 7].map((n) => laneOf(m, n));
    expect(lanes(a)).toEqual(lanes(b));
    expect(factoryKey(a)).toBe(factoryKey(b));
  });

  it("counts a bot pallet as one lane piece", () => {
    const bots = [10, 11, 12].map((n) => pr(n, RUN, { bot: true }));
    const m = build([...bots, pr(1, RUN)], { lanesFor: () => 2 });
    const l = m.lines[0];
    const pallet = l.workpieces.find((w) => w.kind === "bots")!;
    expect(pallet.lane).not.toBeNull();
    expect(laneOf(m, 1)).not.toBeNull();
    expect(l.queued).toBe(0);
    expect(l.workpieces.filter((w) => w.lane !== null)).toHaveLength(2);
  });

  it("laneBusy follows running checks; floorBoard and factoryKey reflect lanes", () => {
    const a = build([pr(1, RUN), pr(2, GREEN)]);
    const l = a.lines[0];
    expect(l.laneBusy.filter(Boolean)).toHaveLength(1);
    expect(l.laneBusy[laneOf(a, 1)!]).toBe(true);
    expect(l.laneBusy[laneOf(a, 2)!]).toBe(false);
    const row = floorBoard(a)[0];
    expect(row.lanesLit).toBe(1);
    expect(row.lanes).toBe(6);
    const idle = build([pr(1, GREEN), pr(2, GREEN)]);
    expect(factoryKey(idle)).not.toBe(factoryKey(a));
    const swapped = build([pr(1, RUN), pr(2, GREEN)], { lanesFor: () => 5 });
    expect(factoryKey(swapped)).not.toBe(factoryKey(a));
  });

  it("assignLanes is pure and honours prevLanes directly", () => {
    const l = build([pr(1, RUN), pr(2, RUN)]).lines[0].workpieces;
    const before = JSON.stringify(l);
    const out = assignLanes(l, 2, new Map([["o/repo#2", 0]]));
    expect(JSON.stringify(l)).toBe(before);
    expect(out.find((w) => w.prNumber === 2)!.lane).toBe(0);
    expect(out.find((w) => w.prNumber === 1)!.lane).toBe(1);
  });
});
