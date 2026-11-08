/**
 * Pure view-model helpers for the factory HUD panels (no React, no store).
 * Panels feed them the live CampusProject + sessions; everything derived
 * (lane, queue position, roll-ups, ages) lives here so it can be unit-tested.
 */
import type {
  CampusProject,
  CampusSession,
  CheckKind,
  CheckRun,
  CheckState,
  InteractionTarget,
  PipelineRun,
  PrLabel,
  PullRequestInfo,
} from "@/engine/contracts";
import {
  buildFactoryModel,
  classifyCheckKind,
  sizeClassOf,
  stateColor,
  type LineModel,
  type SizeClass,
  type Station,
  type Workpiece,
} from "@/engine/logic/factoryModel";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "";
  const n = Math.round(s);
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m}m ${String(n % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface Ago {
  key: "factory.ago.now" | "factory.ago.m" | "factory.ago.h" | "factory.ago.d";
  n: number;
}

/** Relative age as an i18n key + count (null when the timestamp is unusable). */
export function agoParts(
  iso: string | null | undefined,
  nowMs: number,
): Ago | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (mins < 1) return { key: "factory.ago.now", n: 0 };
  if (mins < 60) return { key: "factory.ago.m", n: mins };
  const h = Math.floor(mins / 60);
  if (h < 48) return { key: "factory.ago.h", n: h };
  return { key: "factory.ago.d", n: Math.floor(h / 24) };
}

/** Tone for review / mergeable chips. */
export type Tone = "good" | "bad" | "warn" | "muted";

export const TONE_COLOR: Record<Tone, string> = {
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#f59e0b",
  muted: "#94a3b8",
};

export function reviewTone(d: PullRequestInfo["reviewDecision"]): Tone {
  if (d === "approved") return "good";
  if (d === "changes_requested") return "bad";
  if (d === "review_required") return "warn";
  return "muted";
}

export function mergeTone(m: PullRequestInfo["mergeable"]): Tone {
  if (m === "mergeable") return "good";
  if (m === "conflicting") return "bad";
  return "muted";
}

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

export function findProject(
  projects: readonly CampusProject[] | null | undefined,
  projectId: string | undefined,
): CampusProject | undefined {
  if (!projectId) return undefined;
  return (projects ?? []).find((p) => p.id === projectId);
}

/**
 * Fallback line builder for when the 3D scene has published no model
 * (`engine/logic/factoryLive`; the panels read that first, D3). Pass the cell's
 * `lanesFor` and the previous line model to reproduce the 3D lanes/queue.
 */
export function lineFor(
  project: CampusProject | undefined,
  sessions: readonly CampusSession[],
  nowMs: number,
  opts?: Parameters<typeof buildFactoryModel>[3],
): LineModel | null {
  if (!project) return null;
  return buildFactoryModel([project], sessions, nowMs, opts).lines[0] ?? null;
}

export function pieceFor(
  line: LineModel,
  target: Pick<InteractionTarget, "prNumber" | "lane">,
): Workpiece | undefined {
  if (target.prNumber !== undefined) {
    const byPr = line.workpieces.find(
      (w) =>
        w.prNumber === target.prNumber ||
        (w.prNumbers?.includes(target.prNumber!) ?? false),
    );
    if (byPr) return byPr;
  }
  if (target.lane !== undefined)
    return line.workpieces.find((w) => w.lane === target.lane);
  return undefined;
}

/** 1-based place on the intake rack, or null when the piece is not queued. */
export function queuePosition(
  line: LineModel,
  piece: Workpiece,
): number | null {
  if (piece.stamp !== "QUEUED") return null;
  const queue = line.workpieces.filter((w) => w.stamp === "QUEUED");
  const i = queue.findIndex((w) => w.id === piece.id);
  return i < 0 ? null : i + 1;
}

// ---------------------------------------------------------------------------
// PR panel
// ---------------------------------------------------------------------------

export interface CheckRow {
  name: string;
  state: CheckState;
  color: string;
  duration: string;
  attempt: number | null;
  url: string | null;
  kind: CheckKind;
}

export interface PrView {
  number: number;
  title: string;
  branch: string;
  base: string | null;
  author: string | null;
  bot: boolean;
  draft: boolean;
  prState: PullRequestInfo["state"];
  review: PullRequestInfo["reviewDecision"] | null;
  mergeable: PullRequestInfo["mergeable"] | null;
  sizeClass: SizeClass;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  labels: PrLabel[];
  checks: CheckRow[];
  rolled: CheckState;
  /** 1-based lane number for display, or null. */
  lane: number | null;
  queue: number | null;
  stamp: string | null;
  sessionId: string | null;
  url: string | null;
  updated: Ago | null;
}

export function checkRows(runs: readonly CheckRun[] | undefined): CheckRow[] {
  return (runs ?? []).map((r) => ({
    name: r.name,
    state: r.state,
    color: stateColor(r.state),
    duration: formatDuration(r.durationS),
    attempt: r.attempt && r.attempt > 1 ? r.attempt : null,
    url: r.url ?? null,
    kind: r.kind ?? classifyCheckKind(r.name),
  }));
}

export function prView(
  project: CampusProject,
  line: LineModel,
  target: Pick<InteractionTarget, "prNumber" | "lane">,
  nowMs: number,
): PrView | null {
  const piece = pieceFor(line, target);
  const number = target.prNumber ?? piece?.prNumber;
  const pr = project.pullRequests?.find((p) => p.number === number);
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    branch: pr.branch,
    base: pr.baseBranch ?? null,
    author: pr.author ?? null,
    bot: !!pr.bot,
    draft: pr.draft,
    prState: pr.state,
    review: pr.reviewDecision ?? null,
    mergeable: pr.mergeable ?? null,
    sizeClass: sizeClassOf(pr.additions, pr.deletions),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    files: pr.changedFiles ?? null,
    labels: pr.labels ?? [],
    checks: checkRows(pr.checks.runs),
    rolled: pr.checks.state,
    lane: piece && piece.lane !== null ? piece.lane + 1 : null,
    queue: piece ? queuePosition(line, piece) : null,
    stamp: piece?.stamp ?? null,
    sessionId: pr.sessionId ?? piece?.sessionId ?? null,
    url: pr.url ?? piece?.url ?? null,
    updated: agoParts(pr.updatedAt, nowMs),
  };
}

// ---------------------------------------------------------------------------
// Station panel
// ---------------------------------------------------------------------------

export interface StationRun {
  prNumber: number;
  title: string;
  lane: number | null;
  runName: string;
  state: CheckState;
  color: string;
  duration: string;
  attempt: number | null;
  url: string | null;
}

export interface StationView {
  name: string;
  kind: CheckKind;
  state: CheckState;
  color: string;
  occupants: number;
  maxAttempt: number;
  flaky: boolean;
  grouped: string[];
  runs: StationRun[];
  failures: StationRun[];
}

export function findStation(
  line: LineModel,
  checkName: string | undefined,
): Station | undefined {
  if (!checkName) return undefined;
  return line.stations.find(
    (s) => s.name === checkName || s.names.includes(checkName),
  );
}

/** A check is flaky when it was retried, or the same name has both pass and fail results. */
export function isFlaky(
  runs: readonly { state: CheckState; attempt: number | null }[],
  maxAttempt: number,
): boolean {
  if (maxAttempt > 1) return true;
  const hasOk = runs.some((r) => r.state === "success");
  const hasBad = runs.some((r) => r.state === "failure");
  return hasOk && hasBad;
}

export function stationView(
  project: CampusProject,
  line: LineModel,
  checkName: string | undefined,
): StationView | null {
  const st = findStation(line, checkName);
  if (!st) return null;
  const names = new Set(st.names);
  const runs: StationRun[] = [];
  for (const pr of project.pullRequests ?? []) {
    if (pr.state !== "open") continue;
    const lane =
      line.workpieces.find((w) => w.prNumber === pr.number)?.lane ?? null;
    for (const r of pr.checks.runs ?? []) {
      if (!names.has(r.name)) continue;
      runs.push({
        prNumber: pr.number,
        title: pr.title,
        lane: lane === null ? null : lane + 1,
        runName: r.name,
        state: r.state,
        color: stateColor(r.state),
        duration: formatDuration(r.durationS),
        attempt: r.attempt && r.attempt > 1 ? r.attempt : null,
        url: r.url ?? null,
      });
    }
  }
  // Lanes first (ascending), queued / laneless PRs after.
  runs.sort(
    (a, b) =>
      (a.lane ?? 99) - (b.lane ?? 99) ||
      a.prNumber - b.prNumber ||
      (a.runName < b.runName ? -1 : 1),
  );
  const failures = runs.filter((r) => r.state === "failure").slice(0, 5);
  return {
    name: st.name,
    kind: st.kind,
    state: st.state,
    color: stateColor(st.state),
    occupants: st.occupants,
    maxAttempt: st.attempt,
    flaky: isFlaky(runs, st.attempt),
    grouped: st.other ? st.names : [],
    runs,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Line panel
// ---------------------------------------------------------------------------

export interface PipelineRow {
  id: string;
  workflow: string;
  kind: PipelineRun["kind"];
  state: CheckState;
  color: string;
  duration: string;
  branch: string | null;
  url: string | null;
  ago: Ago | null;
}

export function pipelineRows(
  pipelines: readonly PipelineRun[] | undefined,
  nowMs: number,
  kinds?: readonly PipelineRun["kind"][],
): PipelineRow[] {
  return (pipelines ?? [])
    .filter((p) => !kinds || kinds.includes(p.kind))
    .map((p) => ({
      id: p.id,
      workflow: p.workflow,
      kind: p.kind,
      state: p.state,
      color: stateColor(p.state),
      duration: formatDuration(p.durationS),
      branch: p.branch ?? null,
      url: p.url ?? null,
      ago: agoParts(p.startedAt, nowMs),
    }));
}

export interface LinePrRow {
  number: number;
  title: string;
  lane: number | null;
  queue: number | null;
  color: string;
  state: CheckState;
  stamp: string | null;
  prState: PullRequestInfo["state"];
  url: string | null;
}

export interface LineView {
  name: string;
  repo: string | null;
  mode: LineModel["mode"];
  lanesInUse: number;
  lanes: number;
  queued: number;
  health: CheckState;
  healthColor: string;
  open: number;
  running: number;
  failing: number;
  merged24h: number;
  stale: boolean;
  /** Last CI fetch error (data shown is last-good), when any. */
  ciError: string | null;
  /** Age of the last successful CI fetch. */
  fetched: Ago | null;
  /** Rendered from demo data (not the user's repositories). */
  demo: boolean;
  prs: LinePrRow[];
  pipelines: PipelineRow[];
}

export function lineView(
  project: CampusProject,
  line: LineModel,
  nowMs: number,
  demo = false,
): LineView {
  const prs: LinePrRow[] = [];
  for (const w of line.workpieces) {
    if (w.kind === "branch" || w.prNumber === undefined) continue;
    const pr = project.pullRequests?.find((p) => p.number === w.prNumber);
    prs.push({
      number: w.prNumber,
      title: pr?.title ?? w.tag,
      lane: w.lane === null ? null : w.lane + 1,
      queue: queuePosition(line, w),
      color: w.color,
      state: pr?.checks.state ?? "none",
      stamp: w.stamp,
      prState: pr?.state ?? "open",
      url: pr?.url ?? w.url ?? null,
    });
  }
  // On a lane (by lane number) -> queued (by place) -> everything else.
  prs.sort(
    (a, b) =>
      (a.lane ?? 99) - (b.lane ?? 99) ||
      (a.queue ?? 99) - (b.queue ?? 99) ||
      a.number - b.number,
  );
  return {
    name: line.name,
    repo: line.repo,
    mode: line.mode,
    lanesInUse: line.laneBusy.filter(Boolean).length,
    lanes: line.lanes,
    queued: line.queued,
    health: line.trunk.health,
    healthColor: stateColor(line.trunk.health),
    open: line.counts.open,
    running: line.counts.running,
    failing: line.counts.failing,
    merged24h: (project.pullRequests ?? []).filter((p) => p.state === "merged")
      .length,
    stale: line.stale,
    ciError: line.ciError,
    fetched: agoParts(project.fetchedAt, nowMs),
    demo,
    prs,
    pipelines: pipelineRows(project.pipelines, nowMs, ["ci", "other"]).slice(
      0,
      6,
    ),
  };
}

// ---------------------------------------------------------------------------
// Deploy panel
// ---------------------------------------------------------------------------

export interface ReleaseRow {
  tag: string;
  name: string | null;
  prerelease: boolean;
  url: string | null;
  ago: Ago | null;
}

export interface DeployView {
  name: string;
  deploying: boolean;
  state: CheckState;
  color: string;
  releases: ReleaseRow[];
  pipelines: PipelineRow[];
  /** Newest published release, falling back to the newest successful deploy run. */
  lastShip: { label: string; ago: Ago | null; url: string | null } | null;
}

export function deployView(
  project: CampusProject,
  line: LineModel,
  nowMs: number,
): DeployView {
  const releases: ReleaseRow[] = [...(project.releases ?? [])]
    .sort(
      (a, b) =>
        (Date.parse(b.publishedAt ?? "") || 0) -
        (Date.parse(a.publishedAt ?? "") || 0),
    )
    .map((r) => ({
      tag: r.tag,
      name: r.name ?? null,
      prerelease: !!r.prerelease,
      url: r.url ?? null,
      ago: agoParts(r.publishedAt, nowMs),
    }));
  const pipelines = pipelineRows(project.pipelines, nowMs, [
    "deploy",
    "release",
  ]);
  let lastShip: DeployView["lastShip"] = null;
  const rel = releases.find((r) => !r.prerelease) ?? releases[0];
  if (rel) lastShip = { label: rel.tag, ago: rel.ago, url: rel.url };
  else {
    const ok = pipelines.find((p) => p.state === "success");
    if (ok) lastShip = { label: ok.workflow, ago: ok.ago, url: ok.url };
  }
  return {
    name: line.name,
    deploying: line.dock.deploying,
    state: line.dock.state,
    color: stateColor(line.dock.state),
    releases,
    pipelines,
    lastShip,
  };
}
