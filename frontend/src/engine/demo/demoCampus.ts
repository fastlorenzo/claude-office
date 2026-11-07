/** Deterministic, time-varying fake campus data for screenshots / dev. */
import type {
  CampusActivity,
  CampusProject,
  CampusSession,
  CheckState,
  PipelineRun,
  PullRequestInfo,
  CampusStats,
  RoomStatus,
  SessionActivityStats,
  SessionMeta,
  SessionPhase,
  SessionPhaseKind,
  SessionTelemetry,
} from "../contracts";
import type { Agent, AgentState, BossState, TodoItem } from "@/types";

const PALETTE = [
  "#3B82F6",
  "#22C55E",
  "#A855F7",
  "#F97316",
  "#EC4899",
  "#14B8A6",
  "#EAB308",
  "#EF4444",
];
const BASE_MS = Date.UTC(2026, 0, 15, 9, 0, 0);

const BOSS_CYCLE: BossState[] = [
  "idle",
  "receiving",
  "working",
  "delegating",
  "working",
  "reviewing",
  "working",
  "completing",
];
const TASKS = [
  "Refactor the websocket reconnect logic and add tests",
  "Fix flaky CI job in the integration suite",
  "Implement pagination for the sessions endpoint",
  "Review terraform plan for the staging VPC",
  "Write docs for the new hooks installer",
  "Investigate memory growth in the event pipeline",
];
const AGENT_TASKS = [
  "Reading src/app/page.tsx",
  "Running make checkall",
  "Editing backend/app/main.py",
  "Searching for usages of useSession",
  "Writing tests/test_campus.py",
  "Summarising diff for review",
];
const ACTIVITY = [
  "Read src/app/page.tsx",
  "Bash: make checkall",
  "Edit backend/app/main.py",
  "Grep: useSession",
  "Read backend/app/models/campus.py",
  "Bash: git status",
  "Edit frontend/src/engine/contracts.ts",
  "Write tests/test_campus.py",
];
const BUBBLES = [
  "Looking into it…",
  "Tests are green",
  "Need to check the schema",
  "Almost there",
];
const TODO_TEXT = [
  "Explore the codebase",
  "Design the data model",
  "Implement the endpoint",
  "Write unit tests",
  "Update documentation",
  "Run the full check suite",
  "Open the pull request",
];

interface DemoProfile {
  project: string;
  /** Claude Code session name (/rename). */
  name: string;
  summary: string;
  refs: string[];
  branch: string;
  phases: Array<Omit<SessionPhase, "since">>;
}
/**
 * One profile per session index. At n = 6 the campus has 3 projects with
 * 3 / 2 / 1 sessions: continuum (0, 2, 5), payments-api (1, 4), claude-office (3).
 */
const PROFILES: DemoProfile[] = [
  {
    project: "continuum",
    name: "webhook-retry",
    summary: "Retry failed webhook deliveries with backoff",
    refs: ["CONT-839"],
    branch: "feat/cont-839-webhook-retry",
    phases: [
      { kind: "testing", label: "Running tests", detail: "pytest -q" },
      { kind: "coding", label: "Coding", detail: "editing webhooks.py" },
      { kind: "building", label: "Building", detail: "tsc --noEmit" },
    ],
  },
  {
    project: "payments-api",
    name: "sso-login",
    summary: "Add SSO login to the admin dashboard",
    refs: ["PAY-212", "#412"],
    branch: "feat/pay-212-sso-login",
    phases: [
      {
        kind: "exploring",
        label: "Exploring code",
        detail: "auth/middleware.py",
      },
      { kind: "git", label: "Git", detail: "git push origin" },
      { kind: "coding", label: "Coding", detail: "editing sso.py" },
    ],
  },
  {
    project: "continuum",
    name: "pg-job-queue",
    summary: "Move the job queue to Postgres advisory locks",
    refs: ["CONT-851"],
    branch: "feat/cont-851-pg-locks",
    phases: [
      { kind: "coding", label: "Coding", detail: "editing queue/locks.py" },
      { kind: "testing", label: "Running tests", detail: "pytest tests/queue" },
    ],
  },
  {
    project: "claude-office",
    name: "3d-office",
    summary: "Group the 3D office into project team rooms",
    refs: ["#57"],
    branch: "feat/3d-office",
    phases: [
      { kind: "coding", label: "Coding", detail: "editing buildingLayout.ts" },
      { kind: "building", label: "Building", detail: "bun run typecheck" },
    ],
  },
  {
    project: "payments-api",
    name: "payout-recon",
    summary: "Reconcile Stripe payouts every night",
    refs: ["PAY-230"],
    branch: "fix/pay-230-payout-recon",
    phases: [
      { kind: "researching", label: "Researching", detail: "Stripe API docs" },
      { kind: "running", label: "Running", detail: "make recon-dry-run" },
    ],
  },
  {
    project: "continuum",
    name: "faster-ci",
    summary: "Cut the integration suite time in half",
    refs: ["CONT-860"],
    branch: "chore/cont-860-faster-ci",
    phases: [
      { kind: "running", label: "Running", detail: "pytest --durations=20" },
      { kind: "planning", label: "Planning", detail: null },
    ],
  },
  {
    project: "infra-terraform",
    name: "private-subnets",
    summary: "Move staging VPC to private subnets",
    refs: ["#88"],
    branch: "chore/staging-private-subnets",
    phases: [
      { kind: "researching", label: "Researching", detail: "terraform docs" },
      { kind: "running", label: "Running", detail: "terraform plan" },
    ],
  },
  {
    project: "mobile-app",
    name: "push-crash",
    summary: "Fix crash when opening push notifications",
    refs: ["MOB-1042"],
    branch: "fix/mob-1042-push-crash",
    phases: [
      { kind: "planning", label: "Planning", detail: null },
      { kind: "testing", label: "Running tests", detail: "jest · 3 failing" },
    ],
  },
];

const projectId = (name: string) => `acme/${name}`;

// Phase "since" is anchored to real time (the HUD shows elapsed vs Date.now()),
// fixed per process so createDemoCampus stays deterministic.
const DEMO_EPOCH = Date.now();
const agoIso = (ms: number) => new Date(DEMO_EPOCH - ms).toISOString();

const isoAt = (ms: number) => new Date(BASE_MS + ms).toISOString();

function makeAgents(i: number, tMs: number): Agent[] {
  const agents: Agent[] = [];
  for (let k = 0; k < 6; k++) {
    const period = 34000 + k * 5200 + i * 1700;
    const life = 20000 + ((k * 3 + i) % 4) * 3000;
    const phase = (tMs + k * 9100 + i * 4300) % period;
    if (phase >= life) continue;
    let state: AgentState;
    if (phase < 1800) state = "walking_to_desk";
    else if (phase > life - 2500) state = "leaving";
    else {
      const c = Math.floor((phase - 1800) / 2500 + k) % 6;
      state =
        c === 5
          ? "thinking"
          : c === 4 && k === 2
            ? "waiting_permission"
            : "working";
    }
    const working = state === "working";
    const bubbleOn = working && Math.floor(tMs / 3000 + k) % 5 === 0;
    agents.push({
      id: `demo-${i}-a${k}`,
      name: `Agent ${k + 1}`,
      color: PALETTE[(k + i) % PALETTE.length],
      number: k + 1,
      state,
      desk: ((k * 3 + i) % 8) + 1,
      currentTask:
        state === "walking_to_desk"
          ? null
          : AGENT_TASKS[(k + i) % AGENT_TASKS.length],
      bubble: bubbleOn
        ? {
            type: "speech",
            text: BUBBLES[(k + i) % BUBBLES.length],
            icon: null,
            persistent: false,
          }
        : null,
    });
  }
  return agents;
}

function makeTodos(i: number, tMs: number): TodoItem[] {
  const n = 5 + (i % 3);
  const done = Math.floor(tMs / 12000 + i * 2) % (n + 1);
  const todos: TodoItem[] = [];
  for (let j = 0; j < n; j++) {
    todos.push({
      content: TODO_TEXT[(j + i) % TODO_TEXT.length],
      status: j < done ? "completed" : j === done ? "in_progress" : "pending",
    });
  }
  return todos;
}

// ---------------------------------------------------------------------------
// Telemetry / activity / stats (status-line style numbers for the control room)
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

interface DemoTel {
  model: string;
  effort: string;
  window: number;
  ctx: number; // base context %
  cost: number;
  added: number;
  removed: number;
  durMs: number;
  cacheMin: number; // minutes left on the prompt cache
  repo: string;
}
const TEL: DemoTel[] = [
  {
    model: "Opus 5.5",
    effort: "high",
    window: 1_000_000,
    ctx: 19,
    cost: 100.2,
    added: 16902,
    removed: 1777,
    durMs: 3 * HOUR + 24 * MIN,
    cacheMin: 59,
    repo: "acme/continuum",
  },
  {
    model: "Opus 5.5",
    effort: "xhigh",
    window: 200_000,
    ctx: 83,
    cost: 42.75,
    added: 2310,
    removed: 640,
    durMs: 1 * HOUR + 12 * MIN,
    cacheMin: 3,
    repo: "acme/payments-api",
  },
  {
    model: "Sonnet 5",
    effort: "medium",
    window: 1_000_000,
    ctx: 41,
    cost: 8.4,
    added: 120,
    removed: 12,
    durMs: 18 * MIN,
    cacheMin: 41,
    repo: "acme/infra",
  },
  {
    model: "Opus 5.5",
    effort: "high",
    window: 200_000,
    ctx: 64,
    cost: 23.1,
    added: 980,
    removed: 301,
    durMs: 52 * MIN,
    cacheMin: 12,
    repo: "acme/mobile-app",
  },
];

function demoTelemetry(
  i: number,
  tMs: number,
  ended: boolean,
): SessionTelemetry {
  const d = TEL[i % TEL.length];
  const repo = projectId(PROFILES[i % PROFILES.length].project);
  const drift = (tMs / 1000) * 0.01 * (1 + (i % 3));
  const pct = Math.min(97, d.ctx + (ended ? 0 : drift));
  const grow = ended ? 0 : tMs / 60_000;
  return {
    model: d.model,
    effort: d.effort,
    contextUsedPct: Math.round(pct * 10) / 10,
    contextTokens: Math.round((pct / 100) * d.window),
    contextWindow: d.window,
    costUsd: Math.round((d.cost + grow * 0.31 * (1 + (i % 2))) * 100) / 100,
    linesAdded: d.added + Math.floor(grow * 7),
    linesRemoved: d.removed + Math.floor(grow * 2),
    durationMs: d.durMs + (ended ? 0 : tMs),
    cacheWarm: !ended,
    cacheExpiresAt: ended ? null : agoIso(-d.cacheMin * MIN),
    repo,
    outputStyle: null,
    updatedAt: agoIso(2_000),
  };
}

const MIX_KINDS: SessionPhaseKind[] = [
  "coding",
  "exploring",
  "testing",
  "building",
  "running",
  "git",
  "researching",
  "delegating",
];

function demoActivity(
  i: number,
  tMs: number,
  ended: boolean,
): SessionActivityStats {
  const minute = Math.floor(tMs / MIN);
  const eventsPerMin: number[] = [];
  for (let k = 0; k < 30; k++) {
    const m = minute - 29 + k;
    const wave = 0.5 + 0.5 * Math.sin(m * 0.45 + i * 1.7);
    const burst = (m * 7 + i * 13) % 11 === 0 ? 14 : 0;
    const v = ended && k > 18 ? 0 : Math.round(3 + wave * (9 + i * 2) + burst);
    eventsPerMin.push(v);
  }
  const toolMix: Partial<Record<SessionPhaseKind, number>> = {};
  MIX_KINDS.forEach((k, j) => {
    const v = ((j * 17 + i * 29) % 40) + (j === i % MIX_KINDS.length ? 60 : 5);
    toolMix[k] = v;
  });
  const toolCalls = Object.values(toolMix).reduce((a, b) => a + (b ?? 0), 0);
  return {
    eventsPerMin,
    toolMix,
    toolCalls,
    subagentsSpawned: 3 + ((i * 5) % 9),
    testRuns: 2 + ((i * 3) % 7),
    testFailures: i % PROFILES.length === 3 ? 3 : 0,
    errors: (i * 2) % 5,
  };
}

/** Building-wide stats for a demo campus (account-wide limits, cost, events). */
export function createDemoStats(
  campus: CampusSession[],
  tMs: number,
): CampusStats {
  const byStatus: Partial<Record<RoomStatus, number>> = {};
  let subagents = 0;
  for (const c of campus) {
    const st: RoomStatus = c.ended ? "ended" : c.bucket;
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    subagents += c.agents.filter(
      (a) => a.state !== "completed" && a.state !== "leaving",
    ).length;
  }
  const minute = Math.floor(tMs / MIN);
  const eventsPerMin: number[] = [];
  for (let k = 0; k < 60; k++) {
    const m = minute - 59 + k;
    const base = campus.length * 6;
    const wave = 0.55 + 0.45 * Math.sin(m * 0.21) * Math.cos(m * 0.07);
    eventsPerMin.push(Math.max(0, Math.round(base * wave + ((m * 13) % 7))));
  }
  const costSeries: number[] = [];
  for (let k = 0; k < 36; k++) {
    const b = Math.floor(tMs / (5 * MIN)) - 35 + k;
    costSeries.push(
      Math.round(
        (0.8 + 0.7 * (0.5 + 0.5 * Math.sin(b * 0.4)) + (b % 5) * 0.12) * 100,
      ) / 100,
    );
  }
  const costs = campus.map((c) => c.telemetry?.costUsd ?? 0);
  const sessionsCost = costs.reduce((a, b) => a + b, 0);
  const lines = campus.reduce(
    (a, c) => [
      a[0] + (c.telemetry?.linesAdded ?? 0),
      a[1] + (c.telemetry?.linesRemoved ?? 0),
    ],
    [0, 0],
  );
  return {
    fiveHour: {
      usedPct: Math.min(99, 62 + (tMs / 1000) * 0.005),
      resetsAt: agoIso(-(1 * HOUR + 48 * MIN)),
      projectedPct: 104,
    },
    sevenDay: {
      usedPct: 19,
      resetsAt: agoIso(-(3 * 24 * HOUR + 2 * HOUR)),
      projectedPct: 34,
    },
    costTodayUsd: Math.round((sessionsCost + 31.4) * 100) / 100,
    burnUsdPerHour: 18.6,
    sessionsByStatus: byStatus,
    activeSubagents: subagents,
    eventsPerMin,
    costSeries,
    linesAddedToday: lines[0],
    linesRemovedToday: lines[1],
    updatedAt: isoAt(tMs),
  };
}

// ---------------------------------------------------------------------------
// Projects (PRs + pipelines)
// ---------------------------------------------------------------------------

interface DemoPr {
  number: number;
  title: string;
  author: string;
  draft?: boolean;
  state?: "open" | "merged" | "closed";
  review?: PullRequestInfo["reviewDecision"];
  /** Profile index of the session working on this branch. */
  session?: number;
  checks: [CheckState, number, number, number, number]; // state, total, passed, failed, pending
}

const PRS: Record<string, DemoPr[]> = {
  continuum: [
    {
      number: 1287,
      session: 0,
      title: "Retry failed webhook deliveries with backoff",
      author: "claude",
      checks: ["running", 9, 5, 0, 4],
      review: "review_required",
    },
    {
      number: 1281,
      session: 2,
      title: "Postgres advisory locks for the job queue",
      author: "claude",
      draft: true,
      checks: ["failure", 9, 7, 2, 0],
    },
    {
      number: 1276,
      session: 5,
      title: "Split integration suite into 4 shards",
      author: "mara",
      checks: ["success", 9, 9, 0, 0],
      review: "approved",
    },
    {
      number: 1270,
      title: "Bump sqlalchemy to 2.0.36",
      author: "dependabot",
      state: "merged",
      checks: ["success", 9, 9, 0, 0],
      review: "approved",
    },
  ],
  "payments-api": [
    {
      number: 412,
      session: 1,
      title: "SSO login for the admin dashboard",
      author: "claude",
      checks: ["queued", 6, 0, 0, 6],
      review: "changes_requested",
    },
    {
      number: 409,
      session: 4,
      title: "Nightly payout reconciliation job",
      author: "claude",
      checks: ["success", 6, 6, 0, 0],
      review: "approved",
    },
  ],
  "claude-office": [
    {
      number: 57,
      session: 3,
      title: "3D office: one team room per project",
      author: "claude",
      draft: true,
      checks: ["running", 4, 2, 0, 2],
    },
  ],
};

const PIPES: Record<
  string,
  Array<[string, PipelineRun["kind"], CheckState]>
> = {
  continuum: [
    ["CI", "ci", "success"],
    ["Deploy staging", "deploy", "running"],
    ["Release", "release", "success"],
  ],
  "payments-api": [
    ["CI", "ci", "success"],
    ["Deploy production", "deploy", "success"],
  ],
  "claude-office": [
    ["checkall", "ci", "running"],
    ["Pages", "deploy", "success"],
  ],
};

function demoProjects(campus: CampusSession[], tMs: number): CampusProject[] {
  const byName = new Map<string, CampusSession[]>();
  for (const cs of campus) {
    const n = cs.project ?? "unknown";
    byName.set(n, [...(byName.get(n) ?? []), cs]);
  }
  return [...byName.entries()].map(([name, list]) => {
    const prs: PullRequestInfo[] = (PRS[name] ?? []).map((p) => {
      const prof = p.session !== undefined ? PROFILES[p.session] : undefined;
      const live = list.find((cs) => cs.gitBranch === prof?.branch);
      const [state, total, passed, failed, pending] = p.checks;
      return {
        number: p.number,
        title: p.title,
        branch: prof?.branch ?? `feat/pr-${p.number}`,
        author: p.author,
        url: `https://github.com/${projectId(name)}/pull/${p.number}`,
        draft: !!p.draft,
        state: p.state ?? "open",
        reviewDecision: p.review ?? null,
        mergeable: failed ? "conflicting" : "mergeable",
        checks: { state, total, passed, failed, pending },
        sessionId: live?.sessionId ?? null,
        updatedAt: isoAt(tMs - p.number * 1000),
      };
    });
    const pipelines: PipelineRun[] = (PIPES[name] ?? []).map(
      ([workflow, kind, state], k) => ({
        id: `${name}-run-${k}`,
        workflow,
        kind,
        branch: "main",
        state,
        startedAt: agoIso((k + 1) * 9 * MIN),
        durationS: state === "running" ? null : 180 + k * 95,
        url: null,
      }),
    );
    return {
      id: projectId(name),
      name,
      repo: projectId(name),
      defaultBranch: "main",
      sessionIds: list.map((cs) => cs.sessionId),
      pullRequests: prs,
      pipelines,
      ciAvailable: true,
      updatedAt: isoAt(tMs),
    };
  });
}

export function createDemoCampus(
  count: number,
  tMs: number,
): {
  campus: CampusSession[];
  sessions: SessionMeta[];
  stats: CampusStats;
  projects: CampusProject[];
} {
  const campus: CampusSession[] = [];
  const sessions: SessionMeta[] = [];
  const permIdx = count > 1 ? 1 : 0;
  for (let i = 0; i < count; i++) {
    const id = `demo-${i}`;
    const ended = count >= 5 && i === 4;
    let bossState: BossState =
      BOSS_CYCLE[Math.floor(tMs / 4500 + i * 3) % BOSS_CYCLE.length];
    if (i === permIdx && (tMs / 1000 + 5) % 40 < 12)
      bossState = "waiting_permission";
    if (ended) bossState = "idle";
    const needs = bossState === "waiting_permission";
    const bucket = needs
      ? "needs_you"
      : bossState === "idle" || bossState === "completing"
        ? "done"
        : "working";
    const agents = ended ? [] : makeAgents(i, tMs);
    const bubbleOn = !ended && Math.floor(tMs / 3500 + i) % 6 === 0;
    const recent: CampusActivity[] = [];
    if (!ended) {
      const step = Math.floor(tMs / 2500);
      for (let j = 0; j < 8; j++) {
        recent.push({
          timestamp: isoAt((step - (7 - j)) * 2500),
          type: "pre_tool_use",
          agentId: j % 3 === 0 ? "main" : `demo-${i}-a${j % 6}`,
          summary: ACTIVITY[(step - (7 - j) + i * 3 + 800) % ACTIVITY.length],
        });
      }
    }
    const prof = PROFILES[i % PROFILES.length];
    const phase: SessionPhase | null = ended
      ? { kind: "ended", label: "Ended" }
      : needs
        ? {
            kind: "needs_approval",
            label: "Waiting for your approval",
            detail: "Bash: rm -rf build/",
            since: agoIso(45_000),
          }
        : bossState === "idle" || bossState === "completing"
          ? {
              kind: "waiting_user",
              label: "Waiting for your reply",
              since: agoIso(130_000),
            }
          : bossState === "delegating"
            ? {
                kind: "delegating",
                label: "Delegating",
                detail: `${agents.length} subagents`,
                since: agoIso(20_000),
              }
            : {
                ...prof.phases[Math.floor(tMs / 9000 + i) % prof.phases.length],
                since: agoIso(60_000 * (1 + (i % 3))),
              };
    campus.push({
      sessionId: id,
      project: prof.project,
      projectId: projectId(prof.project),
      sessionName: prof.name,
      summary: prof.summary,
      refs: prof.refs,
      gitBranch: prof.branch,
      phase,
      bucket,
      boss: {
        state: bossState,
        currentTask:
          ended || bossState === "idle"
            ? null
            : TASKS[(i + Math.floor(tMs / 20000)) % TASKS.length],
        bubble: needs
          ? {
              type: "speech",
              text: "Allow Bash: rm -rf build/?",
              icon: null,
              persistent: true,
            }
          : bubbleOn
            ? {
                type: "thought",
                text: BUBBLES[i % BUBBLES.length],
                icon: null,
                persistent: false,
              }
            : null,
      },
      agents,
      office: {
        deskCount: 8,
        elevatorState: "closed",
        phoneState: "idle",
        contextUtilization:
          0.15 + 0.7 * (0.5 + 0.5 * Math.sin(tMs / 17000 + i * 1.3)),
        toolUsesSinceCompaction: Math.floor(tMs / 2500) % 60,
        printReport: false,
      },
      todos: makeTodos(i, tMs),
      recentActivity: recent,
      telemetry: demoTelemetry(i, tMs, ended),
      activity: demoActivity(i, tMs, ended),
      alive: !ended,
      lastEventAt: ended ? agoIso(25 * MIN) : agoIso(3_000),
      ended,
      lastUpdated: isoAt(tMs),
    });
    sessions.push({
      id,
      label:
        prof.project +
        (i >= PROFILES.length ? `-${Math.floor(i / PROFILES.length) + 1}` : ""),
      createdAt: BASE_MS + i * 60000,
      status: ended ? "completed" : "active",
    });
  }
  return {
    campus,
    sessions,
    stats: createDemoStats(campus, tMs),
    projects: demoProjects(campus, tMs),
  };
}
