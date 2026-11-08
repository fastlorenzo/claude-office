/**
 * Display rows: the `flattenVisible` call rows plus the timeline's two
 * synthetic row types (spec 2.5): conversation markers ("▶ You", "◀ Claude")
 * interleaved at the root level, and a "↩ result" row closing each open
 * subagent block. Pure, so the virtual list just maps over the output.
 */

import type { TimelineRow } from "@/utils/console/tree";
import type {
  AgentNode,
  ConversationEntry,
  ToolCall,
} from "@/utils/console/types";

export type DisplayRow =
  | { kind: "call"; key: string; row: TimelineRow }
  | { kind: "marker"; key: string; entry: ConversationEntry }
  | {
      kind: "result";
      key: string;
      depth: number;
      agent: AgentNode;
      spawnCallId: string;
    };

/** The agent a Task/Agent call spawned, via either link direction. */
export function spawnedAgentOf(
  call: ToolCall,
  agents: ReadonlyMap<string, AgentNode>,
  bySpawn: ReadonlyMap<string, AgentNode>,
): AgentNode | undefined {
  if (call.spawnedAgentId) {
    const a = agents.get(call.spawnedAgentId);
    if (a) return a;
  }
  return bySpawn.get(call.id);
}

/** spawnToolUseId -> agent. */
export function agentsBySpawn(
  agents: ReadonlyMap<string, AgentNode>,
): Map<string, AgentNode> {
  const m = new Map<string, AgentNode>();
  for (const a of agents.values()) {
    if (a.spawnToolUseId) m.set(a.spawnToolUseId, a);
  }
  return m;
}

const ts = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Conversation entries that become timeline markers. */
export function markerEntries(
  conversation: readonly ConversationEntry[],
): ConversationEntry[] {
  return conversation.filter(
    (e) =>
      (e.role === "user" || e.role === "assistant") &&
      (e.agentId === "main" || e.agentId === "" || e.role === "user") &&
      e.text.trim() !== "",
  );
}

export function buildDisplayRows(
  rows: readonly TimelineRow[],
  agents: ReadonlyMap<string, AgentNode>,
  markers: readonly ConversationEntry[],
  opts: { results: boolean },
): DisplayRow[] {
  const out: DisplayRow[] = [];
  const bySpawn = agentsBySpawn(agents);
  let mi = 0;
  const stack: Array<{ depth: number; agent: AgentNode; callId: string }> = [];

  const closeTo = (depth: number) => {
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      const b = stack.pop()!;
      out.push({
        kind: "result",
        key: `result:${b.callId}`,
        depth: b.depth + 1,
        agent: b.agent,
        spawnCallId: b.callId,
      });
    }
  };

  for (const row of rows) {
    if (opts.results) closeTo(row.depth);
    if (row.depth === 0 && mi < markers.length) {
      const t = ts(row.call.startedAt);
      while (mi < markers.length && ts(markers[mi].timestamp) <= t) {
        out.push({
          kind: "marker",
          key: `marker:${markers[mi].id}`,
          entry: markers[mi],
        });
        mi++;
      }
    }
    out.push({ kind: "call", key: row.key, row });
    if (opts.results && row.expanded && row.childCount > 0) {
      const agent = spawnedAgentOf(row.call, agents, bySpawn);
      if (agent && (agent.resultPreview || agent.endedAt)) {
        stack.push({ depth: row.depth, agent, callId: row.call.id });
      }
    }
  }
  if (opts.results) closeTo(0);
  while (mi < markers.length) {
    out.push({
      kind: "marker",
      key: `marker:${markers[mi].id}`,
      entry: markers[mi],
    });
    mi++;
  }
  return out;
}
