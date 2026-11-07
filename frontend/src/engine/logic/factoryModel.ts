/**
 * Pure "software factory" model: CampusProject[] + CampusSession[] -> production
 * lines (repos), inspection stations (CI checks) and workpieces (PRs / branches).
 * No Babylon imports: every renderer, panel and the ops wall read this.
 * See docs/design/software-factory.md (section 2 mapping table, section 6).
 *
 * Placement rules, in priority order for one PR:
 *   merged -> trunk (age fade) | closed -> scrap (age fade) | stale (> 7 d) -> holding
 *   | draft -> rack | any check failure or changes_requested -> rework
 *   | conflicting -> gate (stuck, "MISFIT")
 *   | first station whose check is not yet green -> station
 *   | no checks yet -> belt | review_required -> qa | otherwise -> gate
 *     (t = 1 when mergeable, i.e. the gate opens).
 */
import type {
  CampusProject,
  CampusSession,
  CheckKind,
  CheckRun,
  CheckState,
  PrLabel,
  PullRequestInfo,
  SessionPhaseKind,
} from "@/engine/contracts";
import { CHECK_COLORS } from "@/engine/contracts";

// ---------------------------------------------------------------------------
// Thresholds (all tunable here)
// ---------------------------------------------------------------------------

export const STALE_PR_MS = 7 * 24 * 3600 * 1000;
/** Merged / closed pieces linger this long (fading) before they vanish. */
export const RECENT_WINDOW_MS = 24 * 3600 * 1000;
export const MAX_STATIONS = 6;
/** Parallel lanes per production cell (a layout may offer fewer, see `lanesFor`). */
export const MAX_LANES = 6;
export const MAX_LABEL_BANDS = 3;
export const SIZE_S_MAX = 50;
export const SIZE_M_MAX = 300;
export const SIZE_L_MAX = 1500;
export const TAG_TITLE_MAX = 36;
/** `fade` is quantised to this many steps so factoryKey does not flicker with the clock. */
export const FADE_STEPS = 10;

export const PRIMER_COLOR = "#9ca3af";
export const BOT_COLOR = "#3b82f6";
export const LABEL_FALLBACK_COLOR = "#64748b";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Segment =
  | "rack"
  | "belt"
  | "station"
  | "qa"
  | "gate"
  | "trunk"
  | "rework"
  | "holding"
  | "scrap";

export type SizeClass = "S" | "M" | "L" | "XL";
export type PieceKind = "pr" | "branch" | "bots";

export interface WorkpiecePosition {
  segment: Segment;
  /** station / rework: index into LineModel.stations (rework: the failing one, when known). */
  stationIndex?: number;
  /** 0..1 progress inside the segment. */
  t: number;
}

export interface Station {
  index: number;
  name: string;
  kind: CheckKind;
  /** Rolled up over every open PR (failure > running > queued > cancelled > success > none). */
  state: CheckState;
  /** True for the trailing "+N" bucket that groups overflow check names. */
  other: boolean;
  /** Names grouped into this station (one entry unless `other`). */
  names: string[];
  /** Max `attempt` seen on any run here (>1 = retried). */
  attempt: number;
  /** Open PRs currently sitting at this station. */
  occupants: number;
}

export interface Workpiece {
  id: string;
  kind: PieceKind;
  prNumber?: number;
  /** bots: every batched PR number. */
  prNumbers?: number[];
  branch: string;
  position: WorkpiecePosition;
  /** 0-based lane; null = not on a lane (rack / queued / holding / scrap / trunk). */
  lane: number | null;
  sizeClass: SizeClass;
  /** Body colour (rolled-up check state / merged purple / primer grey). */
  color: string;
  bands: PrLabel[];
  /** Short plate text: "#412 · title". */
  tag: string;
  /** Overlay stamp: DRAFT, REWORK: test, MISFIT, AGING 12d, MERGED #412, ... */
  stamp: string | null;
  sessionId: string | null;
  sessionPhase: SessionPhaseKind | null;
  stale: boolean;
  bot: boolean;
  draft: boolean;
  stuck: boolean;
  /** 1 = fully visible, falls to 0 over RECENT_WINDOW_MS (merged / closed only), else 1. */
  fade: number;
  /** One CheckState (or null = this PR has no such check) per station. */
  stationStates: (CheckState | null)[];
  url: string | null;
}

export interface TrunkModel {
  health: CheckState;
  /** Belt moves only while a main-branch CI run is active. */
  running: boolean;
}

export interface DockModel {
  state: CheckState;
  deploying: boolean;
  releases: {
    tag: string;
    name: string | null;
    prerelease: boolean;
    url: string | null;
  }[];
}

export interface BenchModel {
  branch: string | null;
  dirtyFiles: number;
  ahead: number;
  /** A session in the repo is in testing / building phase. */
  active: boolean;
  /** active && that session has testFailures > 0 (red lamp). */
  failing: boolean;
  sessionIds: string[];
}

export type LineMode = "ci" | "local";

export interface LineModel {
  projectId: string;
  name: string;
  repo: string | null;
  defaultBranch: string | null;
  mode: LineMode;
  /** Any live session or running/queued check (line lit vs dimmed). */
  lit: boolean;
  stale: boolean;
  ciError: string | null;
  header: string;
  stations: Station[];
  /** Lane capacity of this cell (<= MAX_LANES). */
  lanes: number;
  /** Eligible pieces waiting on the intake rack for a free lane. */
  queued: number;
  /** Belt running per lane (length = lanes). */
  laneBusy: boolean[];
  workpieces: Workpiece[];
  trunk: TrunkModel;
  dock: DockModel;
  bench: BenchModel;
  counts: { open: number; running: number; failing: number };
}

export interface FactoryModel {
  lines: LineModel[];
}

export interface FloorRow {
  projectId: string;
  name: string;
  mode: LineMode;
  health: CheckState;
  open: number;
  running: number;
  failing: number;
  deploying: boolean;
  stale: boolean;
  /** Lanes whose belt is running / lane capacity. */
  lanesLit: number;
  lanes: number;
}

// ---------------------------------------------------------------------------
// Helpers (exported where renderers / tests need them)
// ---------------------------------------------------------------------------

const KIND_ORDER: CheckKind[] = [
  "lint",
  "build",
  "test",
  "security",
  "deploy",
  "release",
  "other",
];

const KIND_PATTERNS: [CheckKind, RegExp][] = [
  [
    "security",
    /secur|codeql|snyk|trivy|semgrep|audit|vuln|secret|sast|dependabot/i,
  ],
  ["deploy", /deploy|rollout|\bcd\b|preview|staging/i],
  ["release", /release|publish/i],
  [
    "lint",
    /lint|format|fmt|prettier|ruff|eslint|style|typecheck|type-check|mypy|tsc/i,
  ],
  ["test", /test|pytest|vitest|jest|spec|e2e|unit|integration|coverage/i],
  ["build", /build|compile|bundle|package|docker|image/i],
];

/** Same classification as the backend (first matching pattern wins). */
export function classifyCheckKind(name: string): CheckKind {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(name)) return kind;
  return "other";
}

const STATE_RANK: Record<CheckState, number> = {
  failure: 5,
  running: 4,
  queued: 3,
  cancelled: 2,
  success: 1,
  none: 0,
};

export function worseState(a: CheckState, b: CheckState): CheckState {
  return STATE_RANK[b] > STATE_RANK[a] ? b : a;
}

/** Colour of a rolled-up check state (CHECK_COLORS: failure red, merged purple). */
export function stateColor(state: CheckState): string {
  switch (state) {
    case "failure":
      return CHECK_COLORS.failure;
    case "success":
      return CHECK_COLORS.done;
    case "running":
      return CHECK_COLORS.working;
    case "queued":
      return CHECK_COLORS.needs_you;
    default:
      return CHECK_COLORS.ended;
  }
}

export function sizeClassOf(
  additions?: number | null,
  deletions?: number | null,
): SizeClass {
  if (additions == null && deletions == null) return "M";
  const n = (additions ?? 0) + (deletions ?? 0);
  if (n < SIZE_S_MAX) return "S";
  if (n < SIZE_M_MAX) return "M";
  if (n < SIZE_L_MAX) return "L";
  return "XL";
}

/**
 * Monotonic "how far down the line" scalar: rack 0, belt 1, stations 2.., then qa,
 * gate, trunk. Off-line segments (rework / holding / scrap) return -1.
 */
export function lineProgress(
  pos: WorkpiecePosition,
  stationCount: number,
): number {
  switch (pos.segment) {
    case "rack":
      return 0;
    case "belt":
      return 1 + pos.t * 0.5;
    case "station":
      return 2 + (pos.stationIndex ?? 0) + pos.t * 0.99;
    case "qa":
      return 2 + stationCount + pos.t * 0.99;
    case "gate":
      return 3 + stationCount + pos.t * 0.99;
    case "trunk":
      return 4 + stationCount + pos.t * 0.99;
    default:
      return -1;
  }
}

const parseMs = (v?: string | null): number | null => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const quant = (n: number, steps: number) =>
  Math.round(clamp01(n) * steps) / steps;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function runKind(run: CheckRun): CheckKind {
  return run.kind && run.kind !== "other"
    ? run.kind
    : classifyCheckKind(run.name);
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

interface StationPlan {
  stations: Station[];
  /** check name -> station index (named stations + the other bucket). */
  indexOf: Map<string, number>;
}

function planStations(prs: PullRequestInfo[]): StationPlan {
  const names = new Map<
    string,
    { kind: CheckKind; state: CheckState; attempt: number }
  >();
  for (const pr of prs) {
    for (const run of pr.checks.runs ?? []) {
      const cur = names.get(run.name);
      if (cur) {
        cur.state = worseState(cur.state, run.state);
        cur.attempt = Math.max(cur.attempt, run.attempt ?? 1);
      } else {
        names.set(run.name, {
          kind: runKind(run),
          state: run.state,
          attempt: run.attempt ?? 1,
        });
      }
    }
  }
  // Stable pipeline order: kind rank, then name. (Independent of PR / run order, so
  // stations never jump when a PR closes or a check changes state.)
  const sorted = [...names.entries()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a[1].kind) - KIND_ORDER.indexOf(b[1].kind) ||
      a[0].localeCompare(b[0]),
  );
  const kept = sorted.slice(0, MAX_STATIONS);
  const rest = sorted.slice(MAX_STATIONS);
  const stations: Station[] = kept.map(([name, v], index) => ({
    index,
    name,
    kind: v.kind,
    state: v.state,
    other: false,
    names: [name],
    attempt: v.attempt,
    occupants: 0,
  }));
  const indexOf = new Map<string, number>();
  kept.forEach(([name], i) => indexOf.set(name, i));
  if (rest.length > 0) {
    const index = stations.length;
    let state: CheckState = "none";
    let attempt = 1;
    for (const [name, v] of rest) {
      state = worseState(state, v.state);
      attempt = Math.max(attempt, v.attempt);
      indexOf.set(name, index);
    }
    stations.push({
      index,
      name: `+${rest.length}`,
      kind: "other",
      state,
      other: true,
      names: rest.map(([n]) => n),
      attempt,
      occupants: 0,
    });
  }
  return { stations, indexOf };
}

function stationStatesFor(
  pr: PullRequestInfo,
  plan: StationPlan,
): (CheckState | null)[] {
  const out: (CheckState | null)[] = plan.stations.map(() => null);
  for (const run of pr.checks.runs ?? []) {
    const i = plan.indexOf.get(run.name);
    if (i === undefined) continue;
    const cur = out[i];
    out[i] = cur == null ? run.state : worseState(cur, run.state);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workpieces
// ---------------------------------------------------------------------------

interface Placement {
  position: WorkpiecePosition;
  stamp: string | null;
  stuck: boolean;
  fade: number;
}

function placeOpen(
  pr: PullRequestInfo,
  states: (CheckState | null)[],
  plan: StationPlan,
  nowMs: number,
): Placement {
  const updated = parseMs(pr.updatedAt);
  if (updated !== null && nowMs - updated > STALE_PR_MS) {
    const days = Math.floor((nowMs - updated) / 86400000);
    return {
      position: { segment: "holding", t: 0 },
      stamp: `AGING ${days}d`,
      stuck: false,
      fade: 1,
    };
  }
  if (pr.draft) {
    return {
      position: { segment: "rack", t: 0 },
      stamp: "DRAFT",
      stuck: false,
      fade: 1,
    };
  }
  const failIdx = states.findIndex((s) => s === "failure");
  const summaryFail =
    states.every((s) => s === null) && pr.checks.state === "failure";
  if (failIdx >= 0 || summaryFail) {
    const name = failIdx >= 0 ? plan.stations[failIdx].names[0] : undefined;
    return {
      position: {
        segment: "rework",
        stationIndex: failIdx >= 0 ? failIdx : undefined,
        t: 0.5,
      },
      stamp: name ? `REWORK: ${name}` : "REWORK",
      stuck: false,
      fade: 1,
    };
  }
  if (pr.reviewDecision === "changes_requested") {
    return {
      position: { segment: "rework", t: 0.5 },
      stamp: "CHANGES REQUESTED",
      stuck: false,
      fade: 1,
    };
  }
  if (pr.mergeable === "conflicting") {
    return {
      position: { segment: "gate", t: 0.5 },
      stamp: "MISFIT",
      stuck: true,
      fade: 1,
    };
  }
  const pendingIdx = states.findIndex((s) => s !== null && s !== "success");
  if (pendingIdx >= 0) {
    const st = states[pendingIdx];
    const t = st === "running" ? 0.5 : 0;
    return {
      position: { segment: "station", stationIndex: pendingIdx, t },
      stamp: null,
      stuck: false,
      fade: 1,
    };
  }
  const anyRun = states.some((s) => s !== null);
  if (!anyRun && pr.checks.state !== "success") {
    // No per-run data yet: summary running/queued/none -> on the belt, waiting for a station.
    const t = pr.checks.state === "running" ? 0.5 : 0;
    return {
      position: { segment: "belt", t },
      stamp: null,
      stuck: false,
      fade: 1,
    };
  }
  if (pr.reviewDecision === "review_required") {
    return {
      position: { segment: "qa", t: 0.5 },
      stamp: "REVIEW",
      stuck: false,
      fade: 1,
    };
  }
  const ready = pr.mergeable === "mergeable";
  return {
    position: { segment: "gate", t: ready ? 1 : 0.5 },
    stamp: ready ? "READY" : null,
    stuck: false,
    fade: 1,
  };
}

function placeEnded(pr: PullRequestInfo, nowMs: number): Placement | null {
  const endedAt =
    parseMs(pr.state === "merged" ? pr.mergedAt : pr.closedAt) ??
    parseMs(pr.updatedAt);
  const age = endedAt === null ? 0 : Math.max(0, nowMs - endedAt);
  if (age >= RECENT_WINDOW_MS) return null;
  const ratio = age / RECENT_WINDOW_MS;
  const fade = quant(1 - ratio, FADE_STEPS);
  if (pr.state === "merged") {
    return {
      position: { segment: "trunk", t: quant(ratio, FADE_STEPS) },
      stamp: `MERGED #${pr.number}`,
      stuck: false,
      fade,
    };
  }
  return {
    position: { segment: "scrap", t: 0 },
    stamp: "CLOSED",
    stuck: false,
    fade,
  };
}

function bandsOf(labels?: PrLabel[]): PrLabel[] {
  return (labels ?? []).slice(0, MAX_LABEL_BANDS).map((l) => ({
    name: l.name,
    color: l.color || LABEL_FALLBACK_COLOR,
  }));
}

interface SessionIndex {
  forProject: CampusSession[];
}

function findSession(
  idx: SessionIndex,
  branch: string,
  explicit?: string | null,
): CampusSession | null {
  if (explicit) {
    const hit = idx.forProject.find((s) => s.sessionId === explicit);
    if (hit) return hit;
  }
  const byBranch = idx.forProject.filter(
    (s) => s.gitBranch === branch && !s.ended,
  );
  return byBranch.find((s) => s.alive !== false) ?? byBranch[0] ?? null;
}

function pieceFromPr(
  project: CampusProject,
  pr: PullRequestInfo,
  place: Placement,
  states: (CheckState | null)[],
  idx: SessionIndex,
): Workpiece {
  const sess = findSession(idx, pr.branch, pr.sessionId);
  const ended = pr.state !== "open";
  const color = ended
    ? pr.state === "merged"
      ? CHECK_COLORS.merged
      : CHECK_COLORS.ended
    : pr.draft
      ? PRIMER_COLOR
      : stateColor(pr.checks.state);
  return {
    id: `${project.id}#${pr.number}`,
    kind: "pr",
    prNumber: pr.number,
    branch: pr.branch,
    position: place.position,
    lane: null,
    sizeClass: sizeClassOf(pr.additions, pr.deletions),
    color,
    bands: bandsOf(pr.labels),
    tag: `#${pr.number} · ${truncate(pr.title, TAG_TITLE_MAX)}`,
    stamp: place.stamp,
    sessionId: sess?.sessionId ?? pr.sessionId ?? null,
    sessionPhase: sess?.phase?.kind ?? null,
    stale: place.position.segment === "holding",
    bot: !!pr.bot,
    draft: pr.draft,
    stuck: place.stuck,
    fade: place.fade,
    stationStates: states,
    url: pr.url ?? null,
  };
}

function batchBots(
  project: CampusProject,
  bots: Workpiece[],
  stationCount: number,
): Workpiece {
  // The batch sits where its least-advanced member sits (off-line segments count as -1).
  let lead = bots[0];
  for (const b of bots)
    if (
      lineProgress(b.position, stationCount) <
      lineProgress(lead.position, stationCount)
    )
      lead = b;
  const nums = bots.map((b) => b.prNumber as number).sort((a, b) => a - b);
  return {
    ...lead,
    id: `${project.id}#bots`,
    kind: "bots",
    prNumber: undefined,
    prNumbers: nums,
    lane: null,
    sizeClass: "S",
    bands: [],
    color: lead.color === PRIMER_COLOR ? BOT_COLOR : lead.color,
    tag: `DEP ×${bots.length}`,
    stamp: lead.stamp ?? "DEP",
    draft: false,
    sessionId: null,
    sessionPhase: null,
    bot: true,
    url: null,
  };
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

const LANE_SEGMENTS: ReadonlySet<Segment> = new Set<Segment>([
  "belt",
  "station",
  "qa",
  "gate",
  "rework",
]);

/** True when a piece at this segment needs a lane (rack / holding / scrap / trunk never do). */
export function laneEligible(segment: Segment): boolean {
  return LANE_SEGMENTS.has(segment);
}

export interface LaneMeta {
  /** Epoch ms of the last update (newer first among equals). */
  updatedAt?: number;
  /** Checks running / queued (priority + lane belt). Derived from stationStates when absent. */
  running?: boolean;
}

function isRunning(w: Workpiece, meta?: LaneMeta): boolean {
  return (
    meta?.running ??
    w.stationStates.some((s) => s === "running" || s === "queued")
  );
}

/**
 * Pure lane assignment. Returns new pieces (same order): eligible pieces get `lane`,
 * overflow becomes rack + "QUEUED" + lane null; ineligible pieces get lane null.
 *  1. keep the previous lane for every eligible piece whose lane < capacity (no eviction);
 *  2. the rest, by priority (running/queued first, updatedAt desc, PR number, id), take
 *     the lowest free lane;
 *  3. whoever is left is queued.
 * Without `prevLanes` only step 2 runs (deterministic). A bots pallet is one piece.
 */
export function assignLanes(
  pieces: readonly Workpiece[],
  lanes: number,
  prevLanes: ReadonlyMap<string, number> = new Map(),
  meta: ReadonlyMap<string, LaneMeta> = new Map(),
): Workpiece[] {
  const cap = Math.max(0, Math.min(MAX_LANES, Math.floor(lanes) || 0));
  const taken = new Map<number, string>();
  const assigned = new Map<string, number>();
  const eligible = pieces.filter((w) => laneEligible(w.position.segment));
  const rest: Workpiece[] = [];
  for (const w of eligible) {
    const prev = prevLanes.get(w.id);
    if (
      prev !== undefined &&
      Number.isInteger(prev) &&
      prev >= 0 &&
      prev < cap &&
      !taken.has(prev)
    ) {
      taken.set(prev, w.id);
      assigned.set(w.id, prev);
    } else rest.push(w);
  }
  const maxPr = (w: Workpiece) =>
    w.prNumber ?? Math.min(...(w.prNumbers ?? [Number.MAX_SAFE_INTEGER]));
  rest.sort((a, b) => {
    const ra = isRunning(a, meta.get(a.id)) ? 1 : 0;
    const rb = isRunning(b, meta.get(b.id)) ? 1 : 0;
    return (
      rb - ra ||
      (meta.get(b.id)?.updatedAt ?? 0) - (meta.get(a.id)?.updatedAt ?? 0) ||
      maxPr(a) - maxPr(b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
  let free = 0;
  const queued = new Set<string>();
  for (const w of rest) {
    while (free < cap && taken.has(free)) free++;
    if (free < cap) {
      taken.set(free, w.id);
      assigned.set(w.id, free);
    } else queued.add(w.id);
  }
  return pieces.map((w) => {
    if (queued.has(w.id))
      return {
        ...w,
        position: { segment: "rack", t: 0 },
        lane: null,
        stamp: "QUEUED",
        stuck: false,
      };
    return { ...w, lane: assigned.get(w.id) ?? null };
  });
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

const BENCH_PHASES: SessionPhaseKind[] = ["testing", "building"];

function buildLine(
  project: CampusProject,
  sessions: CampusSession[],
  nowMs: number,
  lanes: number,
  prevPieces: readonly Workpiece[],
): LineModel {
  const ci = !!project.ciAvailable;
  const allPrs = ci ? (project.pullRequests ?? []) : [];
  const open = allPrs.filter((p) => p.state === "open");
  const plan = ci
    ? planStations(open)
    : { stations: [], indexOf: new Map<string, number>() };

  const members = sessions.filter(
    (s) =>
      s.projectId === project.id || project.sessionIds.includes(s.sessionId),
  );
  const idx: SessionIndex = { forProject: members };

  let pieces: Workpiece[] = [];
  const bots: Workpiece[] = [];
  const meta = new Map<string, LaneMeta>();
  const prById = new Map<string, PullRequestInfo>();
  const ordered = [...allPrs].sort((a, b) => a.number - b.number);
  for (const pr of ordered) {
    if (pr.state === "open") {
      const states = stationStatesFor(pr, plan);
      const w = pieceFromPr(
        project,
        pr,
        placeOpen(pr, states, plan, nowMs),
        states,
        idx,
      );
      prById.set(w.id, pr);
      meta.set(w.id, {
        updatedAt: parseMs(pr.updatedAt) ?? 0,
        running: pr.checks.state === "running" || pr.checks.state === "queued",
      });
      (pr.bot ? bots : pieces).push(w);
    } else {
      const place = placeEnded(pr, nowMs);
      if (place) pieces.push(pieceFromPr(project, pr, place, [], idx));
    }
  }
  if (bots.length === 1) pieces.push(bots[0]);
  else if (bots.length > 1) {
    const batch = batchBots(project, bots, plan.stations.length);
    pieces.push(batch);
    const ms = bots.map((b) => meta.get(b.id) ?? {});
    meta.set(batch.id, {
      updatedAt: Math.max(...ms.map((m) => m.updatedAt ?? 0)),
      running: ms.some((m) => m.running),
    });
  }

  // Local-only branches (sessions, current branch, worktrees) without any PR -> intake rack.
  const known = new Set(allPrs.map((p) => p.branch));
  const local = new Map<string, { sessionId: string | null; ahead: number }>();
  const addLocal = (
    branch: string | null | undefined,
    sessionId: string | null,
    ahead = 0,
  ) => {
    if (!branch || branch === project.defaultBranch || known.has(branch))
      return;
    const cur = local.get(branch);
    local.set(branch, {
      sessionId: cur?.sessionId ?? sessionId,
      ahead: Math.max(cur?.ahead ?? 0, ahead),
    });
  };
  for (const s of members) if (!s.ended) addLocal(s.gitBranch, s.sessionId);
  const lg = project.localGit;
  if (lg) {
    addLocal(lg.branch, null, lg.ahead);
    for (const w of lg.worktrees ?? []) addLocal(w.branch, w.sessionId ?? null);
  }
  for (const branch of [...local.keys()].sort()) {
    const info = local.get(branch) as {
      sessionId: string | null;
      ahead: number;
    };
    const sess = findSession(idx, branch, info.sessionId);
    pieces.push({
      id: `${project.id}@${branch}`,
      kind: "branch",
      branch,
      position: { segment: "rack", t: 0 },
      lane: null,
      sizeClass: "S",
      color: PRIMER_COLOR,
      bands: [],
      tag: truncate(branch, TAG_TITLE_MAX),
      stamp: info.ahead > 0 ? "READY" : null,
      sessionId: sess?.sessionId ?? info.sessionId,
      sessionPhase: sess?.phase?.kind ?? null,
      stale: false,
      bot: false,
      draft: false,
      stuck: false,
      fade: 1,
      stationStates: [],
      url: null,
    });
  }

  const prevLanes = new Map<string, number>();
  for (const w of prevPieces)
    if (w.lane !== null && w.lane !== undefined) prevLanes.set(w.id, w.lane);
  pieces = assignLanes(pieces, lanes, prevLanes, meta);
  const laneBusy: boolean[] = Array.from({ length: lanes }, () => false);
  for (const w of pieces)
    if (
      w.lane !== null &&
      w.position.segment !== "rework" &&
      meta.get(w.id)?.running
    )
      laneBusy[w.lane] = true;
  const queuedCount = pieces.filter((w) => w.stamp === "QUEUED").length;

  for (const w of pieces) {
    if (
      w.position.segment === "station" &&
      w.position.stationIndex !== undefined
    )
      plan.stations[w.position.stationIndex].occupants++;
  }

  // Trunk / dock from the default-branch pipelines (newest first).
  const pipes = ci ? (project.pipelines ?? []) : [];
  const onMain = pipes.filter(
    (p) => !project.defaultBranch || p.branch === project.defaultBranch,
  );
  const newestCi = onMain.find((p) => p.kind === "ci");
  const health: CheckState = project.mainHealth ?? newestCi?.state ?? "none";
  const trunk: TrunkModel = {
    health,
    running: onMain.some(
      (p) => p.kind === "ci" && (p.state === "running" || p.state === "queued"),
    ),
  };
  const shipping = pipes.filter(
    (p) => p.kind === "deploy" || p.kind === "release",
  );
  const dock: DockModel = {
    state: shipping[0]?.state ?? "none",
    deploying: shipping.some(
      (p) => p.state === "running" || p.state === "queued",
    ),
    releases: (project.releases ?? []).slice(0, 5).map((r) => ({
      tag: r.tag,
      name: r.name ?? null,
      prerelease: !!r.prerelease,
      url: r.url ?? null,
    })),
  };

  // Local bench from the live session phase.
  const benchSessions = members.filter(
    (s) => !s.ended && s.phase && BENCH_PHASES.includes(s.phase.kind),
  );
  const bench: BenchModel = {
    branch: lg?.branch ?? null,
    dirtyFiles: lg?.dirtyFiles ?? 0,
    ahead: lg?.ahead ?? 0,
    active: benchSessions.length > 0,
    failing: benchSessions.some(
      (s) => s.phase?.kind === "testing" && (s.activity?.testFailures ?? 0) > 0,
    ),
    sessionIds: benchSessions.map((s) => s.sessionId).sort(),
  };

  const counts = {
    open: open.length,
    running: open.filter(
      (p) => p.checks.state === "running" || p.checks.state === "queued",
    ).length,
    failing: open.filter((p) => p.checks.state === "failure").length,
  };
  const liveSession = members.some((s) => !s.ended && s.alive !== false);
  const lit =
    liveSession || counts.running > 0 || trunk.running || dock.deploying;

  const dot = health === "none" ? "○" : "●";
  let header: string;
  if (!ci) {
    header = `${project.name.toUpperCase()} · LOCAL · no CI`;
  } else {
    const parts = [
      project.name.toUpperCase(),
      `${project.defaultBranch ?? "main"} ${dot}`,
      `${counts.open} PR${counts.open === 1 ? "" : "s"}`,
    ];
    if (counts.failing > 0) parts.push(`${counts.failing} failing`);
    if (project.stale) parts.push("STALE");
    header = parts.join(" · ");
  }

  return {
    projectId: project.id,
    name: project.name,
    repo: project.repo ?? null,
    defaultBranch: project.defaultBranch ?? null,
    mode: ci ? "ci" : "local",
    lit,
    stale: !!project.stale,
    ciError: project.ciError ?? null,
    header,
    stations: plan.stations,
    lanes,
    queued: queuedCount,
    laneBusy,
    workpieces: pieces,
    trunk,
    dock,
    bench,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Lines are ordered by project id so bays stay stable regardless of feed order. */
export function buildFactoryModel(
  projects: readonly CampusProject[] | null | undefined,
  sessions: readonly CampusSession[] | null | undefined,
  nowMs: number,
  opts?: { lanesFor?: (projectId: string) => number; prev?: FactoryModel },
): FactoryModel {
  const ss = sessions ?? [];
  const lanesFor = opts?.lanesFor ?? (() => MAX_LANES);
  const prevLines = new Map(
    (opts?.prev?.lines ?? []).map((l) => [l.projectId, l.workpieces]),
  );
  const lines = [...(projects ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => {
      const n = Math.floor(lanesFor(p.id));
      const cap = Math.max(0, Math.min(MAX_LANES, Number.isFinite(n) ? n : 0));
      return buildLine(
        p,
        ss as CampusSession[],
        nowMs,
        cap,
        prevLines.get(p.id) ?? [],
      );
    });
  return { lines };
}

/**
 * Change-detection key: identical strings mean nothing a renderer shows has changed.
 * Excludes raw timestamps (fade / age are quantised), titles beyond the tag, URLs.
 */
export function factoryKey(model: FactoryModel): string {
  return JSON.stringify(
    model.lines.map((l) => [
      l.projectId,
      l.header,
      l.mode,
      l.lit ? 1 : 0,
      l.stale ? 1 : 0,
      l.lanes,
      l.queued,
      l.laneBusy.map((b) => (b ? 1 : 0)).join(""),
      l.stations.map((s) => [s.name, s.kind, s.state, s.attempt, s.occupants]),
      l.workpieces.map((w) => [
        w.id,
        w.position.segment,
        w.position.stationIndex ?? -1,
        w.lane ?? -1,
        Math.round(w.position.t * 100),
        w.color,
        w.sizeClass,
        w.stamp,
        w.tag,
        w.sessionId,
        w.sessionPhase,
        Math.round(w.fade * FADE_STEPS),
        w.bands.map((b) => `${b.name}:${b.color}`),
        w.prNumbers ?? null,
      ]),
      [l.trunk.health, l.trunk.running ? 1 : 0],
      [
        l.dock.state,
        l.dock.deploying ? 1 : 0,
        l.dock.releases.map((r) => r.tag),
      ],
      [
        l.bench.active ? 1 : 0,
        l.bench.failing ? 1 : 0,
        l.bench.dirtyFiles,
        l.bench.ahead,
        l.bench.branch,
      ],
    ]),
  );
}

/** One row per line for the control-room FLOOR panel (canvas + DOM twin). */
export function floorBoard(model: FactoryModel): FloorRow[] {
  return model.lines.map((l) => ({
    projectId: l.projectId,
    name: l.name,
    mode: l.mode,
    health: l.trunk.health,
    open: l.counts.open,
    running: l.counts.running,
    failing: l.counts.failing,
    deploying: l.dock.deploying,
    stale: l.stale,
    lanesLit: l.laneBusy.filter(Boolean).length,
    lanes: l.lanes,
  }));
}
