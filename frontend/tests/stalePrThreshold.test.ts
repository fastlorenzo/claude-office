/**
 * C6 / D4: the frontend and backend must agree on what a "stale" PR is.
 * Backend: `CI_STALE_PR_DAYS` (config.py, default 14) sets `pr.stale` on every
 * campus frame. Frontend: must honour `pr.stale`, falling back to a threshold
 * equal to the backend default only when the flag is absent.
 *
 * The factory model honours `pr.stale ?? age > STALE_PR_MS` (WS1, D4).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CampusProject, PullRequestInfo } from "@/engine/contracts";
import * as factoryModel from "@/engine/logic/factoryModel";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const D = 24 * 3600 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function pr(extra: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    number: 1,
    title: "PR 1",
    branch: "feat/1",
    draft: false,
    state: "open",
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0, runs: [] },
    updatedAt: ago(D),
    ...extra,
  };
}
function segmentOf(p: PullRequestInfo): string {
  const project: CampusProject = {
    id: "o/r",
    name: "r",
    repo: "o/r",
    defaultBranch: "main",
    sessionIds: [],
    pullRequests: [p],
    pipelines: [],
    ciAvailable: true,
    updatedAt: ago(0),
  };
  const m = factoryModel.buildFactoryModel([project], [], NOW);
  return m.lines[0].workpieces.find((w) => w.prNumber === p.number)!.position
    .segment;
}

function backendDefaultDays(): number {
  const cfg = readFileSync(
    path.resolve(__dirname, "..", "..", "backend", "app", "config.py"),
    "utf8",
  );
  const m = /CI_STALE_PR_DAYS:\s*int\s*=\s*(\d+)/.exec(cfg);
  if (!m) throw new Error("CI_STALE_PR_DAYS not found in backend config");
  return Number(m[1]);
}

describe("stale PR threshold", () => {
  it("the backend default is readable (guards the cross-check below)", () => {
    expect(backendDefaultDays()).toBeGreaterThan(0);
  });

  it("a very old open PR sits in holding; a fresh one does not", () => {
    expect(segmentOf(pr({ updatedAt: ago(60 * D), stale: true }))).toBe("holding");
    expect(segmentOf(pr({ updatedAt: ago(D / 24) }))).not.toBe("holding");
  });

  it("holds a PR the backend flags stale even if recently updated", () => {
    expect(segmentOf(pr({ updatedAt: ago(D), stale: true }))).toBe("holding");
  });

  it("does not hold a PR the backend says is not stale (10 d < 14 d)", () => {
    expect(segmentOf(pr({ updatedAt: ago(10 * D), stale: false }))).not.toBe(
      "holding",
    );
  });

  it("fallback threshold equals the backend CI_STALE_PR_DAYS default", () => {
    const ms = (factoryModel as Record<string, unknown>).STALE_PR_MS;
    expect(ms).toBe(backendDefaultDays() * D);
  });
});
