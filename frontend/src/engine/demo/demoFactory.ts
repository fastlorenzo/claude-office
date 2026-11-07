/**
 * Deterministic demo projects for the Software Factory (lanes, queue, checks,
 * pipelines, releases, local git). Pure data: no timers, no Math.random.
 *
 * `demoFactoryProjects(sessions, nowMs, opts)` builds the snapshot;
 * `demoFactoryTick(projects, nowMs)` advances queued / running checks and
 * pipelines along a fixed timeline, so later phases can animate. Ticks only move
 * forward: a finished run never changes again.
 */
import type {
  CampusProject,
  CampusSession,
  CheckRun,
  CheckState,
  CheckSummary,
  LocalGitState,
  PipelineRun,
  PrLabel,
  PullRequestInfo,
  ReleaseInfo,
} from "../contracts";
import { classifyCheckKind } from "../logic/factoryModel";

const MIN_MS = 60_000;
const DEFAULT_SEED = 7;
const MAX_PROJECTS = 4;
/** A queued check starts this long after the project's last fetch (spread by hash). */
const QUEUE_MIN_MS = 20_000;
const QUEUE_SPREAD_MS = 90_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** mulberry32: small seeded PRNG, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: stable per-item identity for queue waits and terminal outcomes. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Roll-up order, matching the factory model: failure > running > queued > cancelled > success > none. */
const RANK: Record<CheckState, number> = {
  failure: 5,
  running: 4,
  queued: 3,
  cancelled: 2,
  success: 1,
  none: 0,
};

function summarize(runs: CheckRun[]): CheckSummary {
  if (runs.length === 0) {
    return {
      state: "none",
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      runs: [],
    };
  }
  let state: CheckState = "none";
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const r of runs) {
    if (RANK[r.state] > RANK[state]) state = r.state;
    if (r.state === "success") passed++;
    else if (r.state === "failure") failed++;
    else if (r.state === "queued" || r.state === "running") pending++;
  }
  return { state, total: runs.length, passed, failed, pending, runs };
}

/** Terminal outcome for a run that finished during a tick (mostly green). */
function outcome(identity: string): CheckState {
  const h = hash(`${identity}#outcome`) % 100;
  if (h < 82) return "success";
  if (h < 92) return "failure";
  return "cancelled";
}

interface Timed {
  state: CheckState;
  startedAt?: string | null;
  durationS?: number | null;
}

/**
 * Advances one run as far as `nowMs` allows: queued -> running (after a hashed
 * wait from the project's last fetch) -> terminal (after its duration).
 * Returns the same reference when nothing changes.
 */
function advance<T extends Timed>(
  item: T,
  identity: string,
  baseMs: number,
  nowMs: number,
): T {
  let cur = item;
  if (cur.state === "queued") {
    const start =
      baseMs + QUEUE_MIN_MS + (hash(`${identity}#wait`) % QUEUE_SPREAD_MS);
    if (nowMs < start) return item;
    cur = {
      ...cur,
      state: "running",
      startedAt: iso(start),
      durationS: 90 + (hash(`${identity}#dur`) % 300),
    };
  }
  if (cur.state === "running") {
    const parsed = Date.parse(cur.startedAt ?? "");
    const start = Number.isFinite(parsed) ? parsed : nowMs;
    const dur = cur.durationS ?? 120;
    if (start + dur * 1000 > nowMs) return cur;
    return { ...cur, state: outcome(identity), durationS: dur };
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Scripted templates
// ---------------------------------------------------------------------------

/** [check name, state, attempt?]. Kind is classified from the name. */
type RunSpec = [name: string, state: CheckState, attempt?: number];

interface PrSpec {
  number: number;
  title: string;
  branch: string;
  author: string;
  bot?: boolean;
  draft?: boolean;
  review?: PullRequestInfo["reviewDecision"];
  mergeable?: PullRequestInfo["mergeable"];
  labels?: string[];
  runs: RunSpec[];
  /** Minutes since the PR was last updated. */
  ageMin: number;
  state?: "open" | "merged" | "closed";
  /** Take the next project session whose git branch is known, as this PR's head. */
  link?: boolean;
}

/** [workflow, kind, state]. */
type PipeSpec = [
  workflow: string,
  kind: PipelineRun["kind"],
  state: CheckState,
];

interface ProjectSpec {
  name: string;
  repo: string;
  prs: PrSpec[];
  pipelines: PipeSpec[];
  releases?: ReleaseInfo[];
  localGit?: "claude-office";
}

const LABEL_COLORS: Record<string, string> = {
  backend: "#1d76db",
  security: "#b60205",
  dependencies: "#0366d6",
  bug: "#d73a4a",
  docs: "#0075ca",
  refactor: "#a2eeef",
  ready: "#0e8a16",
  "needs-work": "#fbca04",
  observability: "#5319e7",
  auth: "#c5def5",
};

function labelsOf(names: string[] | undefined): PrLabel[] {
  return (names ?? []).map((name) => ({
    name,
    color: LABEL_COLORS[name] ?? "#64748b",
  }));
}

const TEMPLATES: ProjectSpec[] = [
  {
    // The busy repo: 13 open PRs (8 non-bot, one bot pallet of 3), so the lanes overflow.
    name: "continuum",
    repo: "acme/continuum",
    prs: [
      {
        number: 1201,
        title: "Retry failed webhook deliveries with backoff",
        branch: "feat/cont-839-webhook-retry",
        author: "maya-k",
        review: "approved",
        mergeable: "mergeable",
        labels: ["backend", "ready"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "success"],
          ["build", "success"],
          ["security / codeql", "success"],
        ],
        ageMin: 14,
        link: true,
      },
      {
        number: 1202,
        title: "Cursor pagination for the sessions endpoint",
        branch: "feat/sessions-cursor",
        author: "jun-l",
        draft: true,
        review: "review_required",
        mergeable: "mergeable",
        labels: ["backend"],
        runs: [
          ["lint", "queued"],
          ["test (3.12)", "queued"],
        ],
        ageMin: 40,
      },
      {
        number: 1203,
        title: "Per-key rate limiter for the public API",
        branch: "feat/rate-limit",
        author: "sam-r",
        review: "changes_requested",
        mergeable: "mergeable",
        labels: ["backend", "needs-work"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "running"],
          ["build", "queued"],
        ],
        ageMin: 26,
        link: true,
      },
      {
        number: 1204,
        title: "Bump zod from 3.23.8 to 3.24.1",
        branch: "dependabot/npm_and_yarn/zod-3.24.1",
        author: "dependabot[bot]",
        bot: true,
        review: "review_required",
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "success"],
          ["build", "success"],
        ],
        ageMin: 90,
      },
      {
        number: 1205,
        title: "Fix flaky teardown in the integration suite",
        branch: "fix/integration-teardown",
        author: "lee-p",
        review: "approved",
        mergeable: "mergeable",
        labels: ["bug"],
        runs: [
          ["lint", "success"],
          ["test:integration", "success", 2],
          ["build", "success"],
        ],
        ageMin: 35,
      },
      {
        number: 1206,
        title: "Tighten the CORS allowlist for admin origins",
        branch: "sec/cors-allowlist",
        author: "ana-v",
        review: "review_required",
        mergeable: "unknown",
        labels: ["security"],
        runs: [
          ["lint", "success"],
          ["security / codeql", "failure", 1],
          ["test (3.12)", "success"],
        ],
        ageMin: 52,
      },
      {
        number: 1207,
        title: "Webhook payload examples",
        branch: "docs/webhook-examples",
        author: "maya-k",
        draft: true,
        review: null,
        mergeable: "mergeable",
        labels: ["docs"],
        runs: [],
        ageMin: 300,
      },
      {
        number: 1208,
        title: "Split the billing ledger into its own module",
        branch: "refactor/ledger",
        author: "jun-l",
        review: "review_required",
        mergeable: "conflicting",
        labels: ["refactor"],
        runs: [
          ["build", "cancelled"],
          ["lint", "success"],
        ],
        ageMin: 70,
      },
      {
        number: 1209,
        title: "Bump vitest from 2.1.4 to 2.1.9",
        branch: "dependabot/npm_and_yarn/vitest-2.1.9",
        author: "dependabot[bot]",
        bot: true,
        review: null,
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "running"],
        ],
        ageMin: 100,
      },
      {
        number: 1210,
        title: "Emit OpenTelemetry spans from the queue worker",
        branch: "feat/otel-worker",
        author: "sam-r",
        review: "approved",
        mergeable: "mergeable",
        labels: ["observability", "ready"],
        runs: [
          ["lint", "success"],
          ["build", "running"],
          ["deploy preview", "queued"],
        ],
        ageMin: 9,
        link: true,
      },
      {
        number: 1211,
        title: "Bump @types/node to 22.9.0",
        branch: "dependabot/npm_and_yarn/types-node-22.9.0",
        author: "dependabot[bot]",
        bot: true,
        review: null,
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "success"],
        ],
        ageMin: 200,
      },
      {
        number: 1212,
        title: "Per-tenant job quota",
        branch: "feat/tenant-quota",
        author: "lee-p",
        review: "changes_requested",
        mergeable: "mergeable",
        labels: ["backend"],
        runs: [
          ["lint", "queued"],
          ["test (3.12)", "success"],
          ["release dry-run", "success"],
        ],
        ageMin: 60,
      },
      {
        number: 1213,
        title: "Move the retry queue onto Postgres advisory locks",
        branch: "feat/pg-locks",
        author: "ana-v",
        review: "review_required",
        mergeable: "mergeable",
        labels: ["backend"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "success"],
          ["deploy preview", "success"],
        ],
        ageMin: 4,
      },
      {
        number: 1198,
        title: "Drop the legacy v1 webhook signer",
        branch: "chore/drop-v1-signer",
        author: "jun-l",
        review: "approved",
        mergeable: "mergeable",
        labels: ["backend"],
        runs: [
          ["test (3.12)", "success"],
          ["build", "success"],
        ],
        ageMin: 200,
        state: "merged",
      },
    ],
    pipelines: [
      ["CI", "ci", "success"],
      ["Deploy staging", "deploy", "success"],
      ["CI", "ci", "success"],
      ["Release", "release", "success"],
    ],
    releases: [
      { tag: "v2.14.0", name: "2.14.0", publishedAt: null, prerelease: false },
      { tag: "v2.13.1", name: "2.13.1", publishedAt: null, prerelease: false },
    ],
  },
  {
    // Main is red: the newest CI run on main failed.
    name: "payments-api",
    repo: "acme/payments-api",
    prs: [
      {
        number: 412,
        title: "Add SSO login to the admin dashboard",
        branch: "feat/pay-212-sso-login",
        author: "rita-c",
        review: "changes_requested",
        mergeable: "conflicting",
        labels: ["auth"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "failure", 1],
          ["build", "success"],
        ],
        ageMin: 18,
        link: true,
      },
      {
        number: 413,
        title: "Idempotency keys for refunds",
        branch: "feat/refund-idempotency",
        author: "omar-d",
        review: "review_required",
        mergeable: "mergeable",
        labels: ["backend"],
        runs: [
          ["test (3.12)", "running"],
          ["lint", "success"],
        ],
        ageMin: 22,
      },
      {
        number: 414,
        title: "Bump stripe-python to 11.2.0",
        branch: "dependabot/pip/stripe-11.2.0",
        author: "dependabot[bot]",
        bot: true,
        review: null,
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [
          ["security / snyk", "success"],
          ["test (3.12)", "success"],
        ],
        ageMin: 75,
      },
      {
        number: 415,
        title: "Ledger reconciliation cron",
        branch: "feat/ledger-cron",
        author: "omar-d",
        draft: true,
        review: null,
        mergeable: "mergeable",
        labels: [],
        runs: [["build", "queued"]],
        ageMin: 55,
      },
      {
        number: 416,
        title: "Remove the deprecated v1 charges endpoint",
        branch: "chore/remove-v1-charges",
        author: "rita-c",
        review: "approved",
        mergeable: "mergeable",
        labels: ["ready"],
        runs: [
          ["deploy preview", "success"],
          ["test (3.12)", "success"],
          ["build", "success"],
        ],
        ageMin: 33,
      },
      {
        number: 409,
        title: "Experiment: async invoice rendering",
        branch: "exp/async-invoice",
        author: "omar-d",
        review: null,
        mergeable: "unknown",
        labels: [],
        runs: [],
        ageMin: 600,
        state: "closed",
      },
    ],
    pipelines: [
      ["CI", "ci", "failure"],
      ["CI", "ci", "success"],
      ["Deploy prod", "deploy", "success"],
    ],
    releases: [],
  },
  {
    name: "claude-office",
    repo: "acme/claude-office",
    localGit: "claude-office",
    prs: [
      {
        number: 88,
        title: "Round ops control room",
        branch: "feat/ops-control-room",
        author: "ren-w",
        review: "approved",
        mergeable: "mergeable",
        labels: ["ready"],
        runs: [
          ["lint", "success"],
          ["test (3.12)", "success"],
          ["build", "success"],
          ["deploy preview", "running"],
        ],
        ageMin: 12,
        link: true,
      },
      {
        number: 89,
        title: "Floor board lanes for the software factory",
        branch: "feat/factory-lanes",
        author: "ren-w",
        draft: true,
        review: null,
        mergeable: "mergeable",
        labels: ["docs"],
        runs: [["test (3.12)", "queued"]],
        ageMin: 30,
      },
      {
        number: 90,
        title: "Bump babylonjs to 7.x",
        branch: "dependabot/npm_and_yarn/babylonjs-7",
        author: "dependabot[bot]",
        bot: true,
        review: null,
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [
          ["test (3.12)", "success"],
          ["audit", "success"],
        ],
        ageMin: 140,
      },
      {
        number: 86,
        title: "Ops wall: project health strip",
        branch: "feat/ops-health",
        author: "ren-w",
        review: "approved",
        mergeable: "mergeable",
        labels: [],
        runs: [
          ["test (3.12)", "success"],
          ["build", "success"],
        ],
        ageMin: 300,
        state: "merged",
      },
    ],
    pipelines: [
      ["CI", "ci", "running"],
      ["CI", "ci", "success"],
      ["Release", "release", "success"],
    ],
    releases: [
      {
        tag: "v0.9.0",
        name: "0.9.0 (preview)",
        publishedAt: null,
        prerelease: true,
      },
    ],
  },
  {
    name: "docs-site",
    repo: "acme/docs-site",
    prs: [
      {
        number: 57,
        title: "Fix broken links in the setup guide",
        branch: "fix/setup-links",
        author: "jun-l",
        review: "approved",
        mergeable: "mergeable",
        labels: ["docs", "ready"],
        runs: [["docs-links", "success"]],
        ageMin: 25,
      },
      {
        number: 58,
        title: "Redesign the changelog page",
        branch: "feat/changelog-page",
        author: "maya-k",
        draft: true,
        review: null,
        mergeable: "mergeable",
        labels: ["docs"],
        runs: [],
        ageMin: 480,
      },
      {
        number: 59,
        title: "Bump astro to 5.x",
        branch: "renovate/astro-5.x",
        author: "renovate[bot]",
        bot: true,
        review: null,
        mergeable: "mergeable",
        labels: ["dependencies"],
        runs: [["build", "cancelled"]],
        ageMin: 160,
      },
    ],
    pipelines: [
      ["Pages", "deploy", "queued"],
      ["CI", "ci", "cancelled"],
      ["CI", "ci", "success"],
    ],
    releases: [],
  },
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Session pools per project: by `session.project` when it matches, else round-robin. */
function assignSessions(
  sessions: readonly CampusSession[],
  names: readonly string[],
): CampusSession[][] {
  const pools: CampusSession[][] = names.map(() => []);
  const slotOf = new Map(names.map((n, i) => [n, i]));
  sessions.forEach((cs, i) => {
    const hit = cs.project ? slotOf.get(cs.project) : undefined;
    pools[hit ?? i % names.length].push(cs);
  });
  return pools;
}

function buildRun(
  rng: () => number,
  nowMs: number,
  repoUrl: string,
  prNumber: number,
  index: number,
  [name, state, attempt]: RunSpec,
): CheckRun {
  const base: CheckRun = {
    name,
    kind: classifyCheckKind(name),
    state,
    attempt: attempt ?? 1,
    url: `${repoUrl}/actions/runs/${prNumber * 10 + index}`,
    startedAt: null,
    durationS: null,
  };
  if (state === "queued") return base;
  if (state === "running") {
    const dur = 120 + Math.floor(rng() * 480);
    const elapsed = 20 + Math.floor(rng() * (dur - 40));
    return {
      ...base,
      startedAt: iso(nowMs - elapsed * 1000),
      durationS: dur,
    };
  }
  const dur = 30 + Math.floor(rng() * 370);
  const ago = 5 * MIN_MS + Math.floor(rng() * 40 * MIN_MS);
  return { ...base, startedAt: iso(nowMs - ago), durationS: dur };
}

function buildPr(
  rng: () => number,
  nowMs: number,
  repo: string,
  spec: PrSpec,
  session: CampusSession | undefined,
): PullRequestInfo {
  const repoUrl = `https://github.com/${repo}`;
  const runs = spec.runs.map((r, i) =>
    buildRun(rng, nowMs, repoUrl, spec.number, i, r),
  );
  const updatedMs = nowMs - spec.ageMin * MIN_MS;
  const additions = 20 + Math.floor(rng() * 600);
  const deletions = Math.floor(rng() * 200);
  return {
    number: spec.number,
    title: spec.title,
    branch: session?.gitBranch ?? spec.branch,
    author: spec.author,
    url: `${repoUrl}/pull/${spec.number}`,
    draft: spec.draft ?? false,
    state: spec.state ?? "open",
    reviewDecision: spec.review ?? null,
    mergeable: spec.mergeable ?? null,
    checks: summarize(runs),
    sessionId: session?.sessionId ?? null,
    updatedAt: iso(updatedMs),
    baseBranch: "main",
    additions,
    deletions,
    changedFiles: 1 + Math.floor(additions / 90),
    labels: labelsOf(spec.labels),
    bot: spec.bot ?? false,
    createdAt: iso(updatedMs - (60 + Math.floor(rng() * 48 * 60)) * MIN_MS),
    mergedAt: spec.state === "merged" ? iso(updatedMs) : null,
    closedAt: spec.state === "closed" ? iso(updatedMs) : null,
  };
}

function buildPipelines(
  rng: () => number,
  nowMs: number,
  name: string,
  specs: PipeSpec[],
): PipelineRun[] {
  return specs.map(([workflow, kind, state], k) => {
    const base: PipelineRun = {
      id: `${name}-main-${k}`,
      workflow,
      kind,
      branch: "main",
      state,
      startedAt: null,
      durationS: null,
      url: `https://github.com/acme/${name}/actions/runs/${9000 + k}`,
      event: kind === "release" ? "release" : "push",
      headSha: hash(`${name}-${k}`)
        .toString(16)
        .padStart(8, "0")
        .repeat(5)
        .slice(0, 40),
      attempt: 1,
    };
    if (state === "queued") return base;
    if (state === "running") {
      return {
        ...base,
        startedAt: iso(nowMs - (60 + Math.floor(rng() * 240)) * 1000),
        durationS: 300,
      };
    }
    const dur = 150 + k * 95 + Math.floor(rng() * 60);
    return {
      ...base,
      startedAt: iso(nowMs - ((k + 1) * 9 + Math.floor(rng() * 4)) * MIN_MS),
      durationS: dur,
    };
  });
}

function buildLocalGit(
  nowMs: number,
  linkedSessionId: string | null,
): LocalGitState {
  return {
    branch: "feat/3d-office",
    ahead: 3,
    behind: 1,
    dirtyFiles: 4,
    lastCommit: {
      hash: "99deae3",
      message:
        "feat(3d): round ops control room, project team rooms (WIP), factory model lanes",
      at: iso(nowMs - 12 * MIN_MS),
    },
    worktrees: [
      {
        path: "/home/dev/git/claude-office",
        branch: "feat/3d-office",
        sessionId: linkedSessionId,
      },
      {
        path: "/home/dev/git/claude-office-lanes",
        branch: "feat/factory-lanes",
        sessionId: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Demo CampusProjects for the factory. Deterministic for a given (sessions, nowMs, opts).
 * `opts.projects` is clamped to 1..4 (default 4); `opts.seed` drives the PRNG for
 * sizes, timings and run ages. The first project always has >= 8 open PRs.
 */
export function demoFactoryProjects(
  sessions: CampusSession[],
  nowMs: number,
  opts?: { projects?: number; seed?: number },
): CampusProject[] {
  const requested = Math.floor(opts?.projects ?? MAX_PROJECTS);
  const count = Math.min(
    MAX_PROJECTS,
    Math.max(1, Number.isFinite(requested) ? requested : MAX_PROJECTS),
  );
  const rng = mulberry32(opts?.seed ?? DEFAULT_SEED);
  const templates = TEMPLATES.slice(0, count);
  const pools = assignSessions(
    sessions,
    templates.map((t) => t.name),
  );

  return templates.map((t, pi) => {
    const pool = [...pools[pi]];
    const prs = t.prs.map((spec) => {
      let session: CampusSession | undefined;
      if (spec.link) {
        const next = pool.findIndex((cs) => !!cs.gitBranch);
        if (next >= 0) session = pool.splice(next, 1)[0];
      }
      return buildPr(rng, nowMs, t.repo, spec, session);
    });
    const updatedAt = iso(nowMs);
    const pipelines = buildPipelines(rng, nowMs, t.name, t.pipelines);
    const ciRun = pipelines.find((p) => p.kind === "ci");
    const sessionIds = pools[pi].map((cs) => cs.sessionId);
    const project: CampusProject = {
      id: t.repo,
      name: t.name,
      repo: t.repo,
      defaultBranch: "main",
      sessionIds,
      pullRequests: prs,
      pipelines,
      ciAvailable: true,
      updatedAt,
      mainHealth: ciRun?.state ?? "none",
      releases: t.releases ?? [],
      fetchedAt: updatedAt,
    };
    if (t.localGit) {
      const linkedId =
        prs.find((p) => p.sessionId)?.sessionId ?? sessionIds[0] ?? null;
      project.localGit = buildLocalGit(nowMs, linkedId);
    }
    return project;
  });
}

/**
 * Advances the demo to `nowMs`: queued checks and pipelines start, running ones
 * finish once their duration has elapsed. Pure; returns new objects only where
 * something changed. Call with non-decreasing `nowMs` for monotonic states.
 */
export function demoFactoryTick(
  projects: CampusProject[],
  nowMs: number,
): CampusProject[] {
  return projects.map((p) => {
    const baseMs = Date.parse(p.updatedAt);
    const from = Number.isFinite(baseMs) ? baseMs : nowMs;
    let changed = false;

    const pullRequests = p.pullRequests?.map((pr) => {
      const old = pr.checks.runs ?? [];
      if (pr.state !== "open" || old.length === 0) return pr;
      const runs = old.map((r) =>
        advance(r, `${p.id}#${pr.number}:${r.name}`, from, nowMs),
      );
      if (runs.every((r, i) => r === old[i])) return pr;
      changed = true;
      return { ...pr, checks: summarize(runs) };
    });

    const pipelines = p.pipelines?.map((pl) => {
      const next = advance(pl, `${p.id}@${pl.id}`, from, nowMs);
      if (next !== pl) changed = true;
      return next;
    });

    if (!changed) return p;
    const newestCi = pipelines?.find((pl) => pl.kind === "ci");
    return {
      ...p,
      pullRequests,
      pipelines,
      mainHealth: newestCi ? newestCi.state : p.mainHealth,
    };
  });
}
