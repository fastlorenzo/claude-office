import { describe, expect, it } from "vitest";
import {
  agoParts,
  checkRows,
  deployView,
  findProject,
  formatDuration,
  isFlaky,
  lineFor,
  lineView,
  mergeTone,
  prView,
  queuePosition,
  reviewTone,
  stationView,
} from "../src/components/world/hud/factory/factoryPanelModel";
import { demoFactoryProjects } from "../src/engine/demo/demoFactory";
import { CHECK_COLORS } from "../src/engine/contracts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const projects = demoFactoryProjects([], NOW, { projects: 2 });
const project = projects[0];
const line = lineFor(project, [], NOW)!;

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3725)).toBe("1h 02m");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-1)).toBe("");
  });
  it("computes relative ages", () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    expect(agoParts(at(0), NOW)?.key).toBe("factory.ago.now");
    expect(agoParts(at(5), NOW)).toEqual({ key: "factory.ago.m", n: 5 });
    expect(agoParts(at(180), NOW)).toEqual({ key: "factory.ago.h", n: 3 });
    expect(agoParts(at(60 * 72), NOW)).toEqual({ key: "factory.ago.d", n: 3 });
    expect(agoParts("nope", NOW)).toBeNull();
    expect(agoParts(null, NOW)).toBeNull();
  });
  it("picks tones", () => {
    expect(reviewTone("approved")).toBe("good");
    expect(reviewTone("changes_requested")).toBe("bad");
    expect(reviewTone(null)).toBe("muted");
    expect(mergeTone("conflicting")).toBe("bad");
    expect(mergeTone("unknown")).toBe("muted");
  });
  it("maps check runs with state colours", () => {
    const rows = checkRows([
      { name: "test (3.12)", state: "failure", durationS: 61, attempt: 2 },
      { name: "build", state: "success" },
    ]);
    expect(rows[0]).toMatchObject({
      color: CHECK_COLORS.failure,
      duration: "1m 01s",
      attempt: 2,
      kind: "test",
    });
    expect(rows[1]).toMatchObject({ color: CHECK_COLORS.done, attempt: null });
  });
});

describe("pr view", () => {
  it("resolves a PR by number with lane and checks", () => {
    const w = line.workpieces.find(
      (x) => x.lane !== null && x.prNumber !== undefined,
    )!;
    const v = prView(project, line, { prNumber: w.prNumber }, NOW)!;
    expect(v.number).toBe(w.prNumber);
    expect(v.lane).toBe(w.lane! + 1);
    expect(v.queue).toBeNull();
    expect(v.checks.length).toBe(
      project.pullRequests!.find((p) => p.number === w.prNumber)!.checks.runs!
        .length,
    );
  });
  it("resolves by lane alone", () => {
    const w = line.workpieces.find(
      (x) => x.lane === 0 && x.prNumber !== undefined,
    )!;
    expect(prView(project, line, { lane: 0 }, NOW)?.number).toBe(w.prNumber);
  });
  it("returns null for unknown PRs", () => {
    expect(prView(project, line, { prNumber: 999999 }, NOW)).toBeNull();
  });
  it("gives queued pieces a 1-based queue position", () => {
    const small = lineFor(project, [], NOW)!;
    const queued = small.workpieces.filter((w) => w.stamp === "QUEUED");
    queued.forEach((w, i) => expect(queuePosition(small, w)).toBe(i + 1));
    const notQueued = small.workpieces.find((w) => w.stamp !== "QUEUED")!;
    expect(queuePosition(small, notQueued)).toBeNull();
  });
});

describe("station view", () => {
  it("collects runs across lanes sorted by lane", () => {
    const st = line.stations[0];
    const v = stationView(project, line, st.name)!;
    expect(v.name).toBe(st.name);
    expect(v.kind).toBe(st.kind);
    const lanes = v.runs.map((r) => r.lane ?? 99);
    expect([...lanes].sort((a, b) => a - b)).toEqual(lanes);
    expect(v.failures.every((r) => r.state === "failure")).toBe(true);
  });
  it("is null for unknown checks", () => {
    expect(stationView(project, line, "nope")).toBeNull();
    expect(stationView(project, line, undefined)).toBeNull();
  });
  it("detects flakiness", () => {
    expect(isFlaky([], 2)).toBe(true);
    expect(
      isFlaky(
        [
          { state: "success", attempt: null },
          { state: "failure", attempt: null },
        ],
        1,
      ),
    ).toBe(true);
    expect(isFlaky([{ state: "success", attempt: null }], 1)).toBe(false);
  });
});

describe("line and deploy views", () => {
  it("summarises the line", () => {
    const v = lineView(project, line, NOW);
    expect(v.lanes).toBe(line.lanes);
    expect(v.lanesInUse).toBe(line.laneBusy.filter(Boolean).length);
    expect(v.queued).toBe(line.queued);
    expect(v.prs.length).toBeGreaterThan(0);
    const laned = v.prs.filter((p) => p.lane !== null).map((p) => p.lane!);
    expect([...laned].sort((a, b) => a - b)).toEqual(laned);
  });
  it("summarises releases newest first with a last ship", () => {
    const rich = projects.find((p) => (p.releases?.length ?? 0) > 0) ?? project;
    const l = lineFor(rich, [], NOW)!;
    const v = deployView(rich, l, NOW);
    const times = v.releases.map(
      (r) =>
        Date.parse(
          rich.releases!.find((x) => x.tag === r.tag)!.publishedAt ?? "",
        ) || 0,
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    if (v.releases.length) expect(v.lastShip?.label).toBeTruthy();
  });
  it("finds projects by id", () => {
    expect(findProject(projects, project.id)).toBe(project);
    expect(findProject(null, "x")).toBeUndefined();
    expect(findProject(projects, undefined)).toBeUndefined();
  });
});
