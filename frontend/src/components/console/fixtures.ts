/**
 * Deterministic console fixtures for tests, Storybook-style previews and the
 * WS5 UI work. Every builder is pure and seeded: the same arguments give the
 * same data. All timestamps are on 2026-01-01 starting at 14:00:00Z.
 *
 * Builders:
 *  - {@link makeToolCall} / {@link makeAgent}: single objects with overrides.
 *  - {@link longSession}: N calls (default 5000) over main plus a few
 *    subagents, mixed tools, some errors.
 *  - {@link errorsSession}: ok / error / denied / interrupted rows.
 *  - {@link permissionSession}: one call `waiting_permission`.
 *  - {@link nestedAgentsSession}: main -> A -> B spawn chain with calls.
 *  - {@link reattributionSession}: a call first attributed to main, then moved
 *    to a subagent by a later higher-rev frame.
 */

import type {
  AgentNode,
  ConsoleHeader,
  ConsoleSnapshot,
  ToolCall,
} from "@/utils/console/types";

const T0 = Date.parse("2026-01-01T14:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/** Session id used by every fixture. */
export const FIXTURE_SESSION_ID = "fixture-session";

/** A ToolCall with sensible defaults; `seq` also drives id and start time. */
export function makeToolCall(
  seq: number,
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: `toolu_${seq}`,
    seq,
    rev: 1,
    agentId: "main",
    toolName: "Read",
    kind: "reading",
    target: `src/file${seq}.ts`,
    inputPreview: { file_path: `src/file${seq}.ts` },
    outputPreview: `contents of file ${seq}`,
    status: "ok",
    startedAt: iso(seq * 1000),
    endedAt: iso(seq * 1000 + 400),
    durationMs: 400,
    ...overrides,
  };
}

/** An AgentNode with defaults for a finished subagent. */
export function makeAgent(
  id: string,
  overrides: Partial<AgentNode> = {},
): AgentNode {
  return {
    id,
    kind: "subagent",
    name: id,
    parentId: "main",
    agentType: "Explore",
    state: "done",
    toolCalls: 0,
    errors: 0,
    rev: 1,
    ...overrides,
  };
}

/** The main agent node. */
export const MAIN_AGENT: AgentNode = {
  id: "main",
  kind: "main",
  name: "Main agent",
  parentId: null,
  state: "working",
  toolCalls: 0,
  errors: 0,
  rev: 1,
};

function header(overrides: Partial<ConsoleHeader> = {}): ConsoleHeader {
  return {
    sessionId: FIXTURE_SESSION_ID,
    project: "claude-office",
    branch: "feat/3d-office",
    ended: false,
    alive: true,
    startedAt: iso(0),
    lastEventAt: iso(0),
    ...overrides,
  };
}

function snapshot(
  agents: AgentNode[],
  toolCalls: ToolCall[],
  extra: Partial<ConsoleSnapshot> = {},
): ConsoleSnapshot {
  return {
    header: header(),
    agents,
    toolCalls,
    hasMore: false,
    oldestSeq: toolCalls.length ? toolCalls[0].seq : null,
    conversation: [],
    todos: [],
    ...extra,
  };
}

/** Rotating tool shapes so row renderers all get exercised. */
function shaped(seq: number): Partial<ToolCall> {
  switch (seq % 6) {
    case 1:
      return {
        toolName: "Edit",
        kind: "editing",
        target: `src/file${seq}.ts`,
        inputPreview: {
          file_path: `src/file${seq}.ts`,
          old_string: "const a = 1;\nconst b = 2;",
          new_string: "const a = 1;\nconst b = 3;\nconst c = 4;",
        },
        outputPreview: "ok",
      };
    case 2:
      return {
        toolName: "Bash",
        kind: "executing",
        target: "bun run test",
        inputPreview: { command: "bun run test", description: "Run tests" },
        outputPreview: "....",
      };
    case 3:
      return {
        toolName: "Grep",
        kind: "searching",
        target: "TODO",
        inputPreview: { pattern: "TODO", path: "src" },
        outputPreview: "src/a.ts:3: TODO",
      };
    case 4:
      return {
        toolName: "mcp__rea__list_names",
        kind: null,
        target: null,
        inputPreview: { query: "main" },
        outputPreview: "[]",
      };
    default:
      return {};
  }
}

/**
 * A long session for perf and virtualization work.
 * Main plus 3 subagents (calls spread across them), roughly 1 error per 40 calls,
 * and a Task row every 500 calls spawning one of the subagents.
 */
export function longSession(count = 5000): ConsoleSnapshot {
  const subs = ["sub_a", "sub_b", "sub_c"];
  const agents = [
    MAIN_AGENT,
    ...subs.map((id, i) =>
      makeAgent(id, {
        name: `Worker ${i + 1}`,
        spawnToolUseId: `toolu_${(i + 1) * 500}`,
      }),
    ),
  ];
  const calls: ToolCall[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const spawnIdx = seq % 500 === 0 ? seq / 500 - 1 : -1;
    const spawned =
      spawnIdx >= 0 && spawnIdx < subs.length ? subs[spawnIdx] : null;
    const owner =
      seq % 7 === 0 ? subs[Math.floor(seq / 7) % subs.length] : "main";
    const failed = seq % 40 === 13;
    calls.push(
      makeToolCall(seq, {
        ...shaped(seq),
        agentId: spawned ? "main" : owner,
        ...(spawned
          ? {
              toolName: "Task",
              kind: "delegating",
              target: `Worker task ${spawnIdx + 1}`,
              inputPreview: {
                description: `Worker task ${spawnIdx + 1}`,
                subagent_type: "Explore",
                prompt: "Look around",
              },
              spawnedAgentId: spawned,
              status: "spawned" as const,
            }
          : {}),
        ...(failed
          ? { status: "error" as const, error: `exit 1 at call ${seq}` }
          : {}),
      }),
    );
  }
  return snapshot(agents, calls, {
    header: header({ lastEventAt: iso(count * 1000) }),
  });
}

/** One row per terminal status plus an error with output. */
export function errorsSession(): ConsoleSnapshot {
  const calls = [
    makeToolCall(1),
    makeToolCall(2, {
      toolName: "Bash",
      target: "uv run pytest -q",
      inputPreview: { command: "uv run pytest -q" },
      status: "error",
      error: "FAILED tests/test_mapper.py::test_prompt_full - AssertionError",
      outputPreview:
        "....F.....\nFAILED tests/test_mapper.py::test_prompt_full",
    }),
    makeToolCall(3, {
      toolName: "Write",
      target: "~/.bashrc",
      inputPreview: { file_path: "~/.bashrc", content: "x" },
      status: "denied",
    }),
    makeToolCall(4, {
      toolName: "Bash",
      target: "sleep 600",
      inputPreview: { command: "sleep 600" },
      status: "interrupted",
      durationMs: 12000,
    }),
  ];
  return snapshot([MAIN_AGENT], calls);
}

/** A Bash call blocked on a permission prompt. */
export function permissionSession(): ConsoleSnapshot {
  const calls = [
    makeToolCall(1),
    makeToolCall(2, {
      toolName: "Bash",
      target: "git push origin feat/3d-office",
      inputPreview: { command: "git push origin feat/3d-office" },
      status: "waiting_permission",
      endedAt: null,
      durationMs: null,
      outputPreview: null,
      permissionRequestedAt: iso(2500),
    }),
  ];
  return snapshot([MAIN_AGENT], calls);
}

/** main -> sub_a (spawned by toolu_2) -> sub_b (spawned by sub_a's toolu_4). */
export function nestedAgentsSession(): ConsoleSnapshot {
  const agents = [
    MAIN_AGENT,
    makeAgent("sub_a", {
      name: "Audit hook payloads",
      state: "running",
      spawnToolUseId: "toolu_2",
      toolCalls: 3,
    }),
    makeAgent("sub_b", {
      name: "Check SubagentStop",
      parentId: "sub_a",
      agentType: "general-purpose",
      spawnToolUseId: "toolu_4",
      toolCalls: 2,
    }),
  ];
  const calls = [
    makeToolCall(1),
    makeToolCall(2, {
      toolName: "Task",
      target: "Audit hook payloads",
      inputPreview: {
        description: "Audit hook payloads",
        subagent_type: "Explore",
      },
      spawnedAgentId: "sub_a",
      status: "spawned",
    }),
    makeToolCall(3, { agentId: "sub_a" }),
    makeToolCall(4, {
      agentId: "sub_a",
      toolName: "Agent",
      target: "Check SubagentStop",
      inputPreview: { description: "Check SubagentStop" },
      spawnedAgentId: "sub_b",
      status: "spawned",
    }),
    makeToolCall(5, { agentId: "sub_b" }),
    makeToolCall(6, { agentId: "sub_b", toolName: "Bash", target: "ls" }),
    makeToolCall(7, { agentId: "sub_a" }),
    makeToolCall(8),
  ];
  return snapshot(agents, calls);
}

/**
 * Re-attribution merge: the hook first reported call 3 as `main` (rev 1); the
 * backend later merges it into the subagent that really ran it (rev 2).
 * `initial` is the snapshot; `merged` is the live frame payload to apply.
 */
export function reattributionSession(): {
  initial: ConsoleSnapshot;
  merged: ToolCall;
} {
  const agents = [
    MAIN_AGENT,
    makeAgent("sub_a", { spawnToolUseId: "toolu_2", state: "running" }),
  ];
  const calls = [
    makeToolCall(1),
    makeToolCall(2, {
      toolName: "Task",
      target: "Look around",
      inputPreview: { description: "Look around" },
      spawnedAgentId: "sub_a",
      status: "spawned",
    }),
    makeToolCall(3, { agentId: "main" }),
    makeToolCall(4),
  ];
  return {
    initial: snapshot(agents, calls),
    merged: { ...calls[2], rev: 2, agentId: "sub_a" },
  };
}
