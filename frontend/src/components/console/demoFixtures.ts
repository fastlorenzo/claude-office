/**
 * Rich demo sessions for `/console-debug` and the UI tests: realistic tool
 * inputs/outputs, nested subagents, errors, conversation, todos, git and
 * telemetry. Built on the WS4 `fixtures.ts` builders; deterministic.
 */

import type { PullRequestInfo } from "@/engine/contracts";
import type {
  AgentNode,
  ConsoleSnapshot,
  ConversationEntry,
  GitStatus,
  ToolCall,
  ToolCallDetail,
} from "@/utils/console/types";
import {
  FIXTURE_SESSION_ID,
  MAIN_AGENT,
  makeAgent,
  makeToolCall,
} from "./fixtures";

export type DemoFixture = "subagents" | "errors" | "long" | "mobile";

/** Demo clock origin: every timestamp is relative to this. */
export const DEMO_T0 = Date.parse("2026-11-08T13:58:00Z");
const at = (s: number) => new Date(DEMO_T0 + s * 1000).toISOString();

const TELEMETRY = {
  model: "Opus 5.5",
  effort: "high",
  contextUsedPct: 64,
  contextTokens: 412_000,
  contextWindow: 1_000_000,
  costUsd: 3.42,
  linesAdded: 812,
  linesRemoved: 95,
  durationMs: 4_320_000,
  cacheWarm: true,
  updatedAt: at(600),
};

function header(lastS: number) {
  return {
    sessionId: FIXTURE_SESSION_ID,
    project: "claude-office",
    branch: "feat/3d-office",
    phase: {
      kind: "delegating" as const,
      label: "Delegating",
      detail: "2 subagents",
      since: at(lastS - 130),
    },
    alive: true,
    ended: false,
    startedAt: at(0),
    lastEventAt: at(lastS),
    telemetry: TELEMETRY,
  };
}

interface CallSpec {
  id: string;
  s: number;
  dur?: number | null;
  agent?: string;
  tool: string;
  target?: string;
  input: Record<string, unknown>;
  out?: string | null;
  status?: ToolCall["status"];
  error?: string | null;
  spawned?: string;
  outBytes?: number;
  waitMs?: number;
}

let seqCounter = 0;
function call(c: CallSpec): ToolCall {
  seqCounter += 1;
  const live =
    c.status === "running" ||
    c.status === "spawned" ||
    c.status === "waiting_permission";
  const dur = live ? null : (c.dur ?? 0.4);
  return makeToolCall(seqCounter, {
    id: c.id,
    agentId: c.agent ?? "main",
    toolName: c.tool,
    target: c.target ?? null,
    inputPreview: c.input,
    outputPreview: c.out ?? null,
    outputBytes: c.outBytes ?? (c.out ? c.out.length : null),
    outputTruncated: !!c.outBytes && !!c.out && c.outBytes > c.out.length,
    status: c.status ?? "ok",
    error: c.error ?? null,
    startedAt: at(c.s),
    endedAt: dur === null ? null : at(c.s + dur),
    durationMs: dur === null ? null : Math.round(dur * 1000),
    spawnedAgentId: c.spawned ?? null,
    permissionRequestedAt:
      c.status === "waiting_permission" ? at(c.s + 1) : null,
    permissionWaitMs: c.waitMs ?? null,
  });
}

const STORE_OLD = `const MAX = 500;

export const useConsoleStore = create<State>()((set) => ({
  calls: [] as ToolCall[],
  selected: null,`;
const STORE_NEW = `const MAX = 500;

export const useConsoleStore = create<State>()((set) => ({
  // Keyed by tool_use_id so a later frame merges into its row.
  calls: new Map<string, ToolCall>(),
  order: [] as string[],
  agents: new Map<string, AgentNode>(),
  selected: null,`;

const MAPPER_SRC = `def map_event(event_type: str, raw: dict) -> dict | None:
    """Translate a Claude Code hook payload into a backend event."""
    tool_name = raw.get("tool_name", "")
    agent_id = "main"  # forced: subagent tools look like main
    if tool_name in ("Task", "Agent"):
        agent_id = f"subagent_{raw.get('tool_use_id')}"
    prompt = raw.get("prompt", "")[:50]
    return {
        "event_type": event_type,
        "agent_id": agent_id,
        "tool_use_id": raw.get("tool_use_id"),
        "prompt": prompt,
    }`;

const PYTEST_OUT = `============================= test session starts ==============================
collected 48 items

tests/test_event_mapper.py ....F.....                                    [ 20%]
tests/test_manage_hooks.py ..........                                    [ 41%]
tests/test_tool_output.py ............................                   [100%]

=================================== FAILURES ===================================
__________________________ test_prompt_full ____________________________________

    def test_prompt_full():
        payload = {"prompt": "x" * 20000}
        out = map_event("user_prompt_submit", payload)
>       assert len(out["prompt"]) == 16384
E       AssertionError: assert 50 == 16384

tests/test_event_mapper.py:212: AssertionError
=========================== short test summary info ============================
FAILED tests/test_event_mapper.py::test_prompt_full - AssertionError: assert 50 == 16384
--- stderr ---
warning: 1 failed, 47 passed in 4.12s`;

const AUDIT_RESULT = `**The hook forces \`agent_id="main"\`** for every non-Task tool event (\`event_mapper.py:135\`), so each subagent call is recorded twice.

- \`tool_response\` is never read except for Task/Agent.
- \`success\` is hard-coded to \`True\`; \`PostToolUseFailure\` is not registered.
- Prompts are cut to 50 chars.`;

const REVIEW_RESULT = `3D-only panels are prop-driven already. Share them via a \`SessionNavContext\`; the minimap stays 3D-only.`;

function subagentsData(): {
  snap: ConsoleSnapshot;
  git: GitStatus;
  focus: { edit: string; bash: string };
} {
  seqCounter = 0;
  const agents: AgentNode[] = [
    {
      ...MAIN_AGENT,
      state: "working",
      startedAt: at(0),
      toolCalls: 11,
      currentActivity: "Bash git push origin feat/3d-office",
    },
    makeAgent("sub_audit", {
      name: "Audit hook payloads",
      agentType: "Explore",
      color: "#3B82F6",
      nativeId: "a5a60c7e91",
      state: "running",
      startedAt: at(40),
      spawnToolUseId: "toolu_task_audit",
      toolCalls: 6,
      errors: 1,
      currentActivity: "Read hooks/src/claude_office_hooks/config.py",
      taskPreview:
        "Audit what the hooks capture versus drop: tool_response, success, prompt length, which agent ran the tool.",
    }),
    makeAgent("sub_check", {
      name: "Check SubagentStop payload",
      agentType: "general-purpose",
      color: "#22C55E",
      nativeId: "9f2c41b0aa",
      parentId: "sub_audit",
      state: "done",
      startedAt: at(58),
      endedAt: at(98),
      spawnToolUseId: "toolu_agent_check",
      toolCalls: 2,
      resultPreview:
        "SubagentStop carries agent_transcript_path; no result text.",
    }),
    makeAgent("sub_review", {
      name: "Review UI parity",
      agentType: "Plan",
      color: "#A855F7",
      nativeId: "c71d0e2f55",
      state: "done",
      startedAt: at(70),
      endedAt: at(433),
      spawnToolUseId: "toolu_task_review",
      toolCalls: 4,
      resultPreview: REVIEW_RESULT,
    }),
    makeAgent("bg_build", {
      kind: "background",
      name: "bg: bun run build",
      agentType: "Bash",
      state: "running",
      startedAt: at(470),
    }),
  ];
  const calls: ToolCall[] = [
    call({
      id: "toolu_grep_agent",
      s: 6,
      dur: 0.1,
      tool: "Grep",
      input: { pattern: "agent_id", path: "hooks/src", output_mode: "content" },
      out: 'hooks/src/claude_office_hooks/event_mapper.py:135:    agent_id = "main"\nhooks/src/claude_office_hooks/event_mapper.py:183:        agent_id = f"subagent_{tool_use_id}"\nhooks/src/claude_office_hooks/main.py:41:    agent_id=data.get("agent_id")',
    }),
    call({
      id: "toolu_read_mapper",
      s: 12,
      dur: 0.02,
      tool: "Read",
      input: {
        file_path: "hooks/src/claude_office_hooks/event_mapper.py",
        offset: 100,
        limit: 210,
      },
      out: MAPPER_SRC,
    }),
    call({
      id: "toolu_task_audit",
      s: 40,
      tool: "Task",
      status: "spawned",
      spawned: "sub_audit",
      input: {
        description: "Audit hook payloads",
        subagent_type: "Explore",
        prompt:
          "Audit what the hooks capture versus drop.\n\n1. Does `tool_response` reach the backend?\n2. Is `success` ever false?\n3. How long can a prompt be?\n\nReport file:line evidence for each.",
      },
    }),
    call({
      id: "toolu_grep_resp",
      s: 42,
      dur: 0.1,
      agent: "sub_audit",
      tool: "Grep",
      input: { pattern: "tool_response", path: "hooks/src" },
      out: "hooks/src/claude_office_hooks/event_mapper.py:161\nhooks/src/claude_office_hooks/event_mapper.py:186",
    }),
    call({
      id: "toolu_read_sub",
      s: 44,
      dur: 0.03,
      agent: "sub_audit",
      tool: "Read",
      input: {
        file_path: "hooks/src/claude_office_hooks/event_mapper.py",
        offset: 100,
        limit: 210,
      },
      out: MAPPER_SRC,
    }),
    call({
      id: "toolu_agent_check",
      s: 58,
      dur: 40,
      agent: "sub_audit",
      tool: "Agent",
      spawned: "sub_check",
      input: {
        description: "Check SubagentStop payload",
        subagent_type: "general-purpose",
        prompt:
          "Read the SubagentStop handler and report which fields it receives.",
      },
      out: "SubagentStop carries agent_transcript_path; no result text.",
    }),
    call({
      id: "toolu_grep_stop",
      s: 60,
      dur: 0.1,
      agent: "sub_check",
      tool: "Grep",
      input: { pattern: "SubagentStop", path: "backend/app" },
      out: "backend/app/core/handlers/agent_handler.py:88",
    }),
    call({
      id: "toolu_read_stop",
      s: 63,
      dur: 0.02,
      agent: "sub_check",
      tool: "Read",
      input: {
        file_path: "backend/app/core/handlers/agent_handler.py",
        offset: 80,
        limit: 40,
      },
      out: 'async def handle_subagent_stop(sm, event):\n    agent = sm.agents.get(event.agent_id)\n    if agent is None:\n        return\n    agent.state = "leaving"',
    }),
    call({
      id: "toolu_glob_ui",
      s: 72,
      dur: 0.05,
      agent: "sub_review",
      tool: "Glob",
      input: { pattern: "frontend/src/components/**/*Panel.tsx" },
      out: "frontend/src/components/world/hud/InspectPanel.tsx\nfrontend/src/components/world/hud/SessionsPanel.tsx\nfrontend/src/components/layout/GitStatusPanel.tsx",
    }),
    call({
      id: "toolu_bash_pytest",
      s: 102,
      dur: 4.1,
      agent: "sub_audit",
      tool: "Bash",
      status: "error",
      input: {
        command: "cd hooks && uv run pytest -q",
        description: "Run hook tests",
      },
      out: PYTEST_OUT,
      outBytes: 18_840,
      error:
        "FAILED tests/test_event_mapper.py::test_prompt_full - AssertionError: assert 50 == 16384",
    }),
    call({
      id: "toolu_web_docs",
      s: 140,
      dur: 1.8,
      agent: "sub_review",
      tool: "WebFetch",
      input: {
        url: "https://docs.claude.com/en/docs/claude-code/hooks",
        prompt: "Which fields does PostToolUseFailure carry?",
      },
      out: "**PostToolUseFailure** fires when a tool call fails. Payload: `tool_name`, `tool_input`, `tool_use_id`, `error`.",
    }),
    call({
      id: "toolu_read_ops",
      s: 210,
      dur: 0.02,
      agent: "sub_review",
      tool: "Read",
      input: {
        file_path: "frontend/src/components/world/hud/ops/OpsDashboard.tsx",
        offset: 300,
        limit: 50,
      },
      out: '        onClick={() => onEnter(row.sessionId)}\n        className="group relative flex cursor-pointer"',
    }),
    call({
      id: "toolu_task_review",
      s: 70,
      dur: 363,
      tool: "Task",
      spawned: "sub_review",
      input: {
        description: "Review UI parity",
        subagent_type: "Plan",
        prompt:
          "Compare the 3D HUD panels with the 2D view and list what is missing where.",
      },
      out: REVIEW_RESULT,
    }),
    call({
      id: "toolu_edit_store",
      s: 440,
      dur: 0.4,
      tool: "Edit",
      input: {
        file_path: "frontend/src/stores/consoleStore.ts",
        old_string: STORE_OLD,
        new_string: STORE_NEW,
        replace_all: false,
      },
    }),
    call({
      id: "toolu_todo",
      s: 446,
      dur: 0.01,
      tool: "TodoWrite",
      input: {
        todos: [
          {
            content: "Audit hook payloads",
            status: "completed",
            activeForm: "Auditing hook payloads",
          },
          {
            content: "Design the console store",
            status: "completed",
            activeForm: "Designing the console store",
          },
          {
            content: "Build the timeline UI",
            status: "in_progress",
            activeForm: "Building the timeline UI",
          },
          {
            content: "Wire the dashboard route",
            status: "pending",
            activeForm: "Wiring the dashboard route",
          },
        ],
      },
    }),
    call({
      id: "toolu_mcp_pr",
      s: 452,
      dur: 0.9,
      tool: "mcp__github__get_pull_request",
      input: { owner: "fastlorenzo", repo: "claude-office", pull_number: 57 },
      out: '{"number":57,"state":"open","checks":{"passed":12,"total":12}}',
    }),
    call({
      id: "toolu_write_notes",
      s: 458,
      dur: 0.05,
      tool: "Write",
      input: {
        file_path: "docs/design/console-notes.md",
        content:
          "# Console notes\n\n- One call, one row.\n- The agent is always visible.\n- Newest at the bottom, live-follow by default.\n",
      },
    }),
    call({
      id: "toolu_bash_build",
      s: 470,
      tool: "Bash",
      status: "running",
      input: {
        command: "bun run build",
        description: "Production build",
        run_in_background: true,
      },
    }),
    call({
      id: "toolu_read_cfg",
      s: 476,
      agent: "sub_audit",
      tool: "Read",
      status: "running",
      input: { file_path: "hooks/src/claude_office_hooks/config.py" },
    }),
    call({
      id: "toolu_bash_push",
      s: 482,
      tool: "Bash",
      status: "waiting_permission",
      input: {
        command: "git push origin feat/3d-office",
        description: "Push the branch",
      },
    }),
  ];
  const conversation: ConversationEntry[] = [
    {
      id: "c1",
      role: "user",
      agentId: "main",
      timestamp: at(2),
      text: "I think the event log / tool use UI could be drastically improved. Also, I don't see the difference between main agent and sub agents.",
    },
    {
      id: "c2",
      role: "assistant",
      agentId: "main",
      timestamp: at(30),
      text: "I'll audit what the hooks capture first, then review UI parity in parallel with two subagents.",
    },
    {
      id: "c3",
      role: "assistant",
      agentId: "sub_audit",
      timestamp: at(120),
      text: AUDIT_RESULT,
    },
    {
      id: "c4",
      role: "thinking",
      agentId: "sub_review",
      timestamp: at(150),
      text: "The ops dashboard is already prop-driven; the overlay root is the only 3D coupling.",
    },
    {
      id: "c5",
      role: "assistant",
      agentId: "sub_review",
      timestamp: at(430),
      text: REVIEW_RESULT,
    },
    {
      id: "c6",
      role: "assistant",
      agentId: "main",
      timestamp: at(436),
      text: "Both reports are in. Next: key the store by `tool_use_id` so duplicate frames merge, then build the timeline.",
    },
  ];
  const todos = [
    { content: "Audit hook payloads", status: "completed" as const },
    { content: "Design the console store", status: "completed" as const },
    {
      content: "Build the timeline UI",
      status: "in_progress" as const,
      active_form: "Building the timeline UI",
    },
    { content: "Wire the dashboard route", status: "pending" as const },
    {
      content: "Screenshots at 1820×2020 and 390 px",
      status: "pending" as const,
    },
  ];
  const git: GitStatus = {
    branch: "feat/3d-office",
    ahead: 3,
    behind: 0,
    repo_path: "/home/dev/claude-office",
    changed_files: [
      { path: "frontend/src/stores/consoleStore.ts", status: "M" },
      {
        path: "frontend/src/components/console/Timeline.tsx",
        status: "A",
        staged: true,
      },
      { path: "docs/design/console-notes.md", status: "?" },
    ],
    commits: [
      {
        hash: "acba480e1",
        message: "feat(backend): console snapshot + tool-call detail endpoints",
        author: "dev",
        timestamp: at(-600),
        relative_time: "12 minutes ago",
      },
      {
        hash: "aa71fcf02",
        message: "feat(console): store, pure utils, fixtures",
        author: "dev",
        timestamp: at(-1800),
        relative_time: "32 minutes ago",
      },
      {
        hash: "84aef9731",
        message: "fix(stairs): walkable space under flights",
        author: "dev",
        timestamp: at(-3600),
        relative_time: "1 hour ago",
      },
    ],
  };
  return {
    snap: {
      header: header(482),
      agents,
      toolCalls: calls,
      hasMore: false,
      oldestSeq: calls[0].seq,
      conversation,
      todos,
    },
    git,
    focus: { edit: "toolu_edit_store", bash: "toolu_bash_pytest" },
  };
}

function errorsData(): ConsoleSnapshot {
  seqCounter = 0;
  const agents: AgentNode[] = [
    { ...MAIN_AGENT, startedAt: at(0), toolCalls: 7, errors: 3 },
    makeAgent("sub_fix", {
      name: "Fix failing mapper test",
      agentType: "general-purpose",
      color: "#EC4899",
      state: "done",
      startedAt: at(60),
      endedAt: at(140),
      spawnToolUseId: "toolu_task_fix",
      toolCalls: 2,
      errors: 1,
      resultPreview: "Raised the prompt cap to 16 KB; the test passes.",
    }),
  ];
  const calls = [
    call({
      id: "toolu_read_ok",
      s: 4,
      dur: 0.02,
      tool: "Read",
      input: {
        file_path: "hooks/tests/test_event_mapper.py",
        offset: 200,
        limit: 20,
      },
      out: 'def test_prompt_full():\n    payload = {"prompt": "x" * 20000}\n    out = map_event("user_prompt_submit", payload)\n    assert len(out["prompt"]) == 16384',
    }),
    call({
      id: "toolu_bash_pytest",
      s: 10,
      dur: 4.1,
      tool: "Bash",
      status: "error",
      input: {
        command: "cd hooks && uv run pytest -q",
        description: "Run hook tests",
      },
      out: PYTEST_OUT,
      outBytes: 18_840,
      error:
        "FAILED tests/test_event_mapper.py::test_prompt_full - AssertionError: assert 50 == 16384",
    }),
    call({
      id: "toolu_edit_err",
      s: 30,
      dur: 0.1,
      tool: "Edit",
      status: "error",
      input: {
        file_path: "hooks/src/claude_office_hooks/event_mapper.py",
        old_string: 'prompt = raw.get("prompt", "")[:50]',
        new_string: 'prompt = raw.get("prompt", "")[:16384]',
      },
      error: "String to replace not found in file.",
    }),
    call({
      id: "toolu_write_denied",
      s: 44,
      tool: "Write",
      status: "denied",
      dur: null,
      input: {
        file_path: "~/.bashrc",
        content: "export CLAUDE_OFFICE_DEBUG=1\n",
      },
    }),
    call({
      id: "toolu_task_fix",
      s: 60,
      dur: 80,
      tool: "Task",
      spawned: "sub_fix",
      input: {
        description: "Fix failing mapper test",
        subagent_type: "general-purpose",
        prompt:
          "Make test_prompt_full pass without breaking the 24 KB payload budget.",
      },
      out: "Raised the prompt cap to 16 KB; the test passes.",
    }),
    call({
      id: "toolu_web_err",
      s: 70,
      dur: 10,
      agent: "sub_fix",
      tool: "WebFetch",
      status: "error",
      input: {
        url: "https://example.invalid/hooks",
        prompt: "Payload limits?",
      },
      error: "getaddrinfo ENOTFOUND example.invalid",
    }),
    call({
      id: "toolu_edit_fix",
      s: 120,
      dur: 0.3,
      agent: "sub_fix",
      tool: "Edit",
      input: {
        file_path: "hooks/src/claude_office_hooks/event_mapper.py",
        old_string: '    prompt = raw.get("prompt", "")[:50]',
        new_string:
          '    prompt = raw.get("prompt", "")\n    truncated = len(prompt) > PROMPT_CAP\n    prompt = prompt[:PROMPT_CAP]',
      },
    }),
    call({
      id: "toolu_bash_sleep",
      s: 150,
      dur: 12,
      tool: "Bash",
      status: "interrupted",
      input: { command: "sleep 600", description: "Wait for CI" },
    }),
    call({
      id: "toolu_bash_ok",
      s: 170,
      dur: 3.2,
      tool: "Bash",
      input: {
        command: "cd hooks && uv run pytest -q",
        description: "Re-run hook tests",
      },
      out: "................................................ [100%]\n48 passed in 3.18s",
    }),
  ];
  return {
    header: {
      ...header(170),
      phase: {
        kind: "testing" as const,
        label: "Running tests",
        detail: "uv run pytest -q",
        since: at(168),
      },
    },
    agents,
    toolCalls: calls,
    hasMore: false,
    oldestSeq: calls[0].seq,
    conversation: [
      {
        id: "e1",
        role: "user",
        agentId: "main",
        timestamp: at(1),
        text: "The hook tests fail on main, can you fix them?",
      },
    ],
    todos: [],
  };
}

const LONG_SHAPES: Array<(n: number) => Partial<ToolCall>> = [
  (n) => ({
    toolName: "Read",
    target: `frontend/src/engine/world/part${n % 97}.ts`,
    inputPreview: { file_path: `frontend/src/engine/world/part${n % 97}.ts` },
  }),
  (n) => ({
    toolName: "Edit",
    target: `frontend/src/components/hud/Panel${n % 31}.tsx`,
    inputPreview: {
      file_path: `frontend/src/components/hud/Panel${n % 31}.tsx`,
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 1;\nconst b = 3;\nconst c = 4;",
    },
  }),
  () => ({
    toolName: "Bash",
    target: "bun run test -- --maxWorkers=4",
    inputPreview: {
      command: "bun run test -- --maxWorkers=4",
      description: "Run tests",
    },
    outputPreview: "Test Files  96 passed (96)",
  }),
  (n) => ({
    toolName: "Grep",
    target: "useConsoleStore",
    inputPreview: {
      pattern: n % 2 ? "useConsoleStore" : "flattenVisible",
      path: "frontend/src",
    },
    outputPreview: "frontend/src/components/console/Timeline.tsx:12",
  }),
  () => ({
    toolName: "Glob",
    inputPreview: { pattern: "frontend/src/**/*.test.ts" },
    outputPreview: "frontend/tests/consoleUi.test.tsx",
  }),
];

/**
 * 5000 calls: main throughout, one finished subagent early on and two
 * parallel subagents near the end (visible when scrolled up a little).
 */
function longData(): ConsoleSnapshot {
  const n = 5000;
  const end = DEMO_T0 / 1000 + n;
  const atSeq = (seq: number) =>
    new Date((end - (n - seq)) * 1000).toISOString();
  const blocks = [
    {
      id: "sub_index",
      task: 1200,
      from: 1201,
      to: 1400,
      every: 2,
      name: "Index the repository",
      type: "Explore",
      color: "#3B82F6",
      done: true,
    },
    {
      id: "sub_perf",
      task: 4700,
      from: 4701,
      to: n,
      every: 3,
      name: "Profile the renderer",
      type: "general-purpose",
      color: "#22C55E",
      done: false,
    },
    {
      id: "sub_i18n",
      task: 4820,
      from: 4821,
      to: n,
      every: 3,
      offset: 1,
      name: "Audit translations",
      type: "Explore",
      color: "#A855F7",
      done: false,
    },
  ];
  const owner = (seq: number): string => {
    for (const b of blocks) {
      if (
        seq >= b.from &&
        seq <= b.to &&
        (seq - b.from - (b.offset ?? 0)) % b.every === 0 &&
        (b.offset === undefined || seq > b.from)
      )
        return b.id;
    }
    return "main";
  };
  const calls: ToolCall[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const block = blocks.find((b) => b.task === seq);
    const failed = seq % 40 === 13;
    const base = makeToolCall(seq, {
      ...LONG_SHAPES[seq % LONG_SHAPES.length](seq),
      agentId: owner(seq),
      startedAt: atSeq(seq),
      endedAt: new Date(Date.parse(atSeq(seq)) + 400).toISOString(),
    });
    if (block) {
      calls.push({
        ...base,
        agentId: "main",
        toolName: "Task",
        target: block.name,
        inputPreview: {
          description: block.name,
          subagent_type: block.type,
          prompt: `${block.name}.`,
        },
        spawnedAgentId: block.id,
        status: block.done ? "ok" : "spawned",
        endedAt: block.done ? atSeq(block.to) : null,
        durationMs: block.done ? (block.to - block.task) * 1000 : null,
      });
    } else if (failed) {
      calls.push({
        ...base,
        status: "error",
        error: `exit 1 · ${base.target ?? base.toolName} failed`,
      });
    } else {
      calls.push(base);
    }
  }
  const counts = new Map<string, number>();
  for (const c of calls)
    counts.set(c.agentId, (counts.get(c.agentId) ?? 0) + 1);
  const agents: AgentNode[] = [
    { ...MAIN_AGENT, startedAt: atSeq(1), toolCalls: counts.get("main") ?? 0 },
    ...blocks.map((b) =>
      makeAgent(b.id, {
        name: b.name,
        agentType: b.type,
        color: b.color,
        state: b.done ? "done" : "running",
        startedAt: atSeq(b.task),
        endedAt: b.done ? atSeq(b.to) : null,
        spawnToolUseId: `toolu_${b.task}`,
        toolCalls: counts.get(b.id) ?? 0,
        resultPreview: b.done
          ? "Indexed 1,204 files; hot paths in engine/world."
          : null,
      }),
    ),
  ];
  return {
    header: {
      ...header(n),
      startedAt: atSeq(1),
      lastEventAt: atSeq(n),
      phase: {
        kind: "coding" as const,
        label: "Coding",
        detail: null,
        since: atSeq(n - 90),
      },
    },
    agents,
    toolCalls: calls,
    hasMore: false,
    oldestSeq: 1,
    conversation: [],
    todos: [],
  };
}

export interface DemoSession {
  snap: ConsoleSnapshot;
  git: GitStatus | null;
  pr: PullRequestInfo | null;
  /** Named call ids for deep links. */
  focus: Record<string, string>;
  /** "Now" for the fixed clock (ms). */
  nowMs: number;
}

const DEMO_PR = {
  number: 57,
  title: "Session console",
  branch: "feat/3d-office",
  url: "https://github.com/fastlorenzo/claude-office/pull/57",
  draft: false,
  state: "open",
  checks: { state: "success", total: 12, passed: 12, failed: 0, pending: 0 },
  updatedAt: at(400),
} as unknown as PullRequestInfo;

/** Build one demo session. */
export function demoSession(kind: DemoFixture): DemoSession {
  if (kind === "errors") {
    const snap = errorsData();
    return {
      snap,
      git: null,
      pr: null,
      focus: { bash: "toolu_bash_pytest" },
      nowMs: DEMO_T0 + 200_000,
    };
  }
  if (kind === "long") {
    const snap = longData();
    return {
      snap,
      git: null,
      pr: DEMO_PR,
      focus: {},
      nowMs: Date.parse(snap.header.lastEventAt ?? "") + 5000,
    };
  }
  const d = subagentsData();
  return {
    snap: d.snap,
    git: d.git,
    pr: DEMO_PR,
    focus: d.focus,
    nowMs: DEMO_T0 + 520_000,
  };
}

/** Synthetic full payload for "Open full" on the debug page. */
export function demoDetail(c: ToolCall): ToolCallDetail {
  const extra =
    c.toolName === "Bash" && c.outputPreview
      ? `${c.outputPreview}\n${Array.from({ length: 30 }, (_, i) => `log line ${i + 1}: ok`).join("\n")}`
      : (c.outputPreview ?? null);
  return {
    call: c,
    input: c.inputPreview ?? null,
    output: extra,
    outputSource: "transcript",
    outputTruncated: false,
  };
}

/** Frames that land after the page has scrolled (paused "N new" demo). */
export function demoLiveCalls(
  calls: readonly ToolCall[],
  n: number,
): ToolCall[] {
  const last = calls.reduce((a, b) => (b.seq > a.seq ? b : a));
  return Array.from({ length: n }, (_, i) =>
    makeToolCall(last.seq + i + 1, {
      id: `toolu_live_${i}`,
      startedAt: new Date(
        Date.parse(last.startedAt) + (i + 1) * 1000,
      ).toISOString(),
      endedAt: new Date(
        Date.parse(last.startedAt) + (i + 1) * 1000 + 300,
      ).toISOString(),
    }),
  );
}
