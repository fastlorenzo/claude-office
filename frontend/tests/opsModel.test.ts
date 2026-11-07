import { describe, expect, it } from "vitest";
import type { CampusSession, CampusStats } from "@/engine/contracts";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  alertText,
  buildOpsModel,
  contextTone,
  fmtClock,
  fmtCount,
  fmtPct,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  limitTone,
  projectWindow,
  sumSeries,
} from "@/engine/logic/opsModel";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const iso = (ms: number) => new Date(NOW + ms).toISOString();

function session(
  over: Partial<CampusSession> & { sessionId: string },
): CampusSession {
  return {
    bucket: "working",
    boss: { state: "working", currentTask: null, bubble: null },
    agents: [],
    office: {
      deskCount: 8,
      elevatorState: "closed",
      phoneState: "idle",
      contextUtilization: 0.2,
      toolUsesSinceCompaction: 0,
      printReport: false,
    },
    todos: [],
    recentActivity: [],
    ended: false,
    lastUpdated: iso(-1000),
    ...over,
  } as CampusSession;
}

describe("formatters", () => {
  it("formats tokens like the status line", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(9_500)).toBe("9.5k");
    expect(fmtTokens(191_000)).toBe("191k");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_250_000)).toBe("1.3M");
    expect(fmtTokens(null)).toBe("—");
  });

  it("formats spans compactly", () => {
    expect(fmtSpan(45_000)).toBe("45s");
    expect(fmtSpan(12 * 60_000)).toBe("12m");
    expect(fmtSpan((3 * 60 + 24) * 60_000)).toBe("3h24m");
    expect(fmtSpan(2 * 3600_000)).toBe("2h");
    expect(fmtSpan((3 * 24 + 2) * 3600_000)).toBe("3d2h");
    expect(fmtSpan(-1)).toBe("—");
  });

  it("formats currency, counts and percentages", () => {
    expect(fmtUsd(100.2)).toBe("$100.20");
    expect(fmtUsd(0.4)).toBe("$0.40");
    expect(fmtUsd(12_345)).toBe("$12.3k");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtCount(16902)).toBe("16.9k");
    expect(fmtCount(1777)).toBe("1.8k");
    expect(fmtCount(120)).toBe("120");
    expect(fmtPct(19.4)).toBe("19%");
    expect(fmtClock("not a date")).toBe("");
  });

  it("colours context and limits by threshold", () => {
    expect(contextTone(19)).toBe("ok");
    expect(contextTone(75)).toBe("warn");
    expect(contextTone(93)).toBe("bad");
    expect(limitTone({ usedPct: 19, projectedPct: 34, resetsInMs: 1 })).toBe(
      "ok",
    );
    expect(limitTone({ usedPct: 62, projectedPct: 104, resetsInMs: 1 })).toBe(
      "bad",
    );
  });
});

describe("projectWindow", () => {
  const H5 = 5 * 3600_000;
  it("prefers the backend projection", () => {
    const w = projectWindow(
      { usedPct: 40, resetsAt: iso(3600_000), projectedPct: 70 },
      H5,
      NOW,
    );
    expect(w).toEqual({ usedPct: 40, projectedPct: 70, resetsInMs: 3600_000 });
  });

  it("projects linearly from the elapsed share when absent", () => {
    // 2.5 h of 5 h elapsed, 30 % used → 60 % at reset
    const w = projectWindow({ usedPct: 30, resetsAt: iso(H5 / 2) }, H5, NOW);
    expect(w?.projectedPct).toBeCloseTo(60);
  });

  it("does not project in the first moments of a window", () => {
    const w = projectWindow(
      { usedPct: 1, resetsAt: iso(H5 - 60_000) },
      H5,
      NOW,
    );
    expect(w?.projectedPct).toBeNull();
    expect(projectWindow(null, H5, NOW)).toBeNull();
  });
});

describe("buildOpsModel", () => {
  it("sorts needs-you first, then working, done, ended", () => {
    const m = buildOpsModel(
      [
        session({
          sessionId: "a",
          bucket: "done",
          boss: { state: "idle", currentTask: null, bubble: null },
        }),
        session({ sessionId: "b", ended: true }),
        session({
          sessionId: "c",
          bucket: "needs_you",
          boss: {
            state: "waiting_permission",
            currentTask: null,
            bubble: null,
          },
        }),
        session({ sessionId: "d" }),
      ],
      null,
      NOW,
    );
    expect(m.rows.map((r) => r.sessionId)).toEqual(["c", "d", "a", "b"]);
    expect(m.counts).toMatchObject({
      needs_you: 1,
      working: 1,
      done: 1,
      ended: 1,
      live: 3,
    });
  });

  it("degrades gracefully without telemetry, activity or stats", () => {
    const m = buildOpsModel(
      [session({ sessionId: "x", project: "web" })],
      undefined,
      NOW,
    );
    const r = m.rows[0];
    expect(r.project).toBe("web");
    expect(r.contextPct).toBeCloseTo(20); // office.contextUtilization fallback
    expect(r.costUsd).toBeNull();
    expect(r.model).toBeNull();
    expect(r.spark).toEqual([]);
    expect(r.hasTelemetry).toBe(false);
    expect(m.hasStats).toBe(false);
    expect(m.usage.fiveHour).toBeNull();
    expect(m.usage.costTodayUsd).toBeNull();
    expect(m.activity.eventsPerMin).toEqual([]);
    expect(m.alerts).toEqual([]);
  });

  it("uses labels when the project is unknown", () => {
    const m = buildOpsModel(
      [session({ sessionId: "abcdef1234" })],
      null,
      NOW,
      new Map([["abcdef1234", "my-repo"]]),
    );
    expect(m.rows[0].project).toBe("my-repo");
  });

  it("raises alerts for approval, tests, context, cache and limits", () => {
    const stats: CampusStats = {
      fiveHour: { usedPct: 62, resetsAt: iso(3600_000), projectedPct: 104 },
      sevenDay: { usedPct: 19, resetsAt: iso(3 * 86400_000), projectedPct: 34 },
      sessionsByStatus: {},
      activeSubagents: 0,
      eventsPerMin: [],
      updatedAt: iso(0),
    };
    const m = buildOpsModel(
      [
        session({
          sessionId: "p",
          project: "payments",
          bucket: "needs_you",
          phase: {
            kind: "needs_approval",
            label: "Waiting for your approval",
            detail: "Bash: rm -rf build/",
          },
          telemetry: {
            contextUsedPct: 91,
            cacheWarm: true,
            cacheExpiresAt: iso(3 * 60_000 + 5000),
            updatedAt: iso(0),
          },
        }),
        session({
          sessionId: "m",
          project: "mobile",
          activity: {
            eventsPerMin: [1, 2],
            toolMix: {},
            toolCalls: 3,
            subagentsSpawned: 0,
            testFailures: 3,
          },
        }),
      ],
      stats,
      NOW,
    );
    const kinds = m.alerts.map((a) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "approval",
        "context",
        "cache",
        "tests",
        "limit5h",
      ]),
    );
    expect(kinds).not.toContain("limit7d");
    // high severity first
    expect(m.alerts[0].severity).toBe("high");
    const approval = m.alerts.find((a) => a.kind === "approval")!;
    expect(alertText(approval)).toBe(
      "payments: waiting for your approval · Bash: rm -rf build/",
    );
    expect(alertText(m.alerts.find((a) => a.kind === "cache")!)).toBe(
      "payments: prompt cache expires in 3m",
    );
  });

  it("does not alert for ended sessions", () => {
    const m = buildOpsModel(
      [
        session({
          sessionId: "e",
          ended: true,
          telemetry: { contextUsedPct: 99, updatedAt: iso(0) },
        }),
      ],
      null,
      NOW,
    );
    expect(m.alerts).toEqual([]);
  });

  it("merges the ticker newest first across sessions", () => {
    const m = buildOpsModel(
      [
        session({
          sessionId: "a",
          project: "alpha",
          recentActivity: [
            {
              timestamp: iso(-30_000),
              type: "pre_tool_use",
              agentId: "main",
              summary: "Read a.ts",
            },
            {
              timestamp: iso(-10_000),
              type: "pre_tool_use",
              agentId: "main",
              summary: "Edit a.ts",
            },
          ],
        }),
        session({
          sessionId: "b",
          project: "beta",
          recentActivity: [
            {
              timestamp: iso(-20_000),
              type: "pre_tool_use",
              agentId: "x",
              summary: "Grep foo",
            },
          ],
        }),
      ],
      null,
      NOW,
    );
    expect(m.ticker.map((t) => t.text)).toEqual([
      "Edit a.ts",
      "Grep foo",
      "Read a.ts",
    ]);
    expect(m.ticker[0]).toMatchObject({ project: "alpha", actor: "boss" });
  });

  it("derives building activity from sessions when stats are absent", () => {
    expect(sumSeries([[1, 2, 3], [5]], 3)).toEqual([1, 2, 8]);
    const m = buildOpsModel(
      [
        session({
          sessionId: "a",
          activity: {
            eventsPerMin: [1, 2, 3],
            toolMix: { coding: 4 },
            toolCalls: 4,
            subagentsSpawned: 1,
          },
        }),
        session({
          sessionId: "b",
          activity: {
            eventsPerMin: [5],
            toolMix: { coding: 1, testing: 9 },
            toolCalls: 10,
            subagentsSpawned: 2,
          },
        }),
      ],
      null,
      NOW,
    );
    expect(m.activity.eventsPerMin.slice(-3)).toEqual([1, 2, 8]);
    expect(m.activity.toolMix).toEqual([
      { kind: "testing", count: 9 },
      { kind: "coding", count: 5 },
    ]);
    expect(m.activity.toolCalls).toBe(14);
  });
});

describe("demo campus stats", () => {
  it("feeds a full model (telemetry, activity, stats)", () => {
    const demo = createDemoCampus(6, 20000);
    expect(demo.stats.eventsPerMin).toHaveLength(60);
    expect(demo.stats.costSeries).toHaveLength(36);
    const m = buildOpsModel(demo.campus, demo.stats, Date.now());
    expect(m.hasStats).toBe(true);
    expect(m.rows).toHaveLength(6);
    expect(m.rows.every((r) => r.hasTelemetry)).toBe(true);
    expect(m.usage.fiveHour?.projectedPct).toBeGreaterThan(100);
    expect(m.alerts.some((a) => a.kind === "limit5h")).toBe(true);
    expect(m.activity.toolMix.length).toBeGreaterThan(3);
  });
});
