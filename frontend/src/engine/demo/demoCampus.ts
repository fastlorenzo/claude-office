/** Deterministic, time-varying fake campus data for screenshots / dev. */
import type {
  CampusActivity,
  CampusSession,
  SessionMeta,
  SessionPhase,
} from "../contracts";
import type { Agent, AgentState, BossState, TodoItem } from "@/types";

const LABELS = [
  "claude-office",
  "git-continuum",
  "payments-api",
  "infra-terraform",
  "mobile-app",
  "docs-site",
  "data-pipeline",
  "auth-service",
];
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
  summary: string;
  refs: string[];
  branch: string;
  phases: Array<Omit<SessionPhase, "since">>;
}
const PROFILES: DemoProfile[] = [
  {
    project: "continuum",
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
    project: "infra-terraform",
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
    summary: "Fix crash when opening push notifications",
    refs: ["MOB-1042"],
    branch: "fix/mob-1042-push-crash",
    phases: [
      { kind: "planning", label: "Planning", detail: null },
      { kind: "testing", label: "Running tests", detail: "jest · 3 failing" },
    ],
  },
];

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

export function createDemoCampus(
  count: number,
  tMs: number,
): { campus: CampusSession[]; sessions: SessionMeta[] } {
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
      ended,
      lastUpdated: isoAt(tMs),
    });
    sessions.push({
      id,
      label:
        LABELS[i % LABELS.length] +
        (i >= LABELS.length ? `-${Math.floor(i / LABELS.length) + 1}` : ""),
      createdAt: BASE_MS + i * 60000,
      status: ended ? "completed" : "active",
    });
  }
  return { campus, sessions };
}
