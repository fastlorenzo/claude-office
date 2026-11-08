/**
 * `flattenVisible`: turns the call map, agent tree, expansion set and filters
 * into the single row list the virtualized timeline renders.
 *
 * Tree mode nests each subagent's calls under the Task/Agent row that spawned
 * it (the block is open while that row id is in `expanded`). Flat mode is
 * strictly chronological. Attribution always follows the call's *current*
 * `agentId`, so a re-attribution (a later frame moving a call from main to a
 * subagent) moves the row between blocks.
 */

import { callPasses, isUnfiltered, type ConsoleFilters } from "./filters";
import type { AgentNode, ToolCall } from "./types";

export type GroupMode = "tree" | "flat";

export interface TimelineRow {
  /** Stable React key: the call id. */
  key: string;
  call: ToolCall;
  /** Nesting depth (agent ancestry), 0 for main and orphan agents. */
  depth: number;
  /** Row id is in the expanded set. */
  expanded: boolean;
  /** Task rows: calls inside the spawned block (all descendants). */
  childCount: number;
  /** Task rows: descendant calls removed by the active filters. */
  hiddenCount: number;
}

const MAX_AGENT_DEPTH = 16;

/** Agent id -> depth along parent links (cycle-safe). */
function agentDepths(
  agents: ReadonlyMap<string, AgentNode>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of agents.keys()) {
    let d = 0;
    let cur = agents.get(id)?.parentId ?? null;
    while (cur && d < MAX_AGENT_DEPTH) {
      d++;
      cur = agents.get(cur)?.parentId ?? null;
    }
    out.set(id, d);
  }
  return out;
}

/** The agent plus all its descendants (for click-to-filter in the tree). */
export function agentWithDescendants(
  agents: ReadonlyMap<string, AgentNode>,
  id: string,
): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of agents.values()) {
      if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Flatten to visible rows.
 *
 * @param calls    id -> call
 * @param order    call ids ascending by seq (the store's `order`)
 * @param agents   id -> agent node
 * @param expanded ids of expanded rows (for a Task row: block open)
 * @param filters  active filters
 * @param mode     "tree" nests blocks; "flat" is chronological
 */
export function flattenVisible(
  calls: ReadonlyMap<string, ToolCall>,
  order: readonly string[],
  agents: ReadonlyMap<string, AgentNode>,
  expanded: ReadonlySet<string>,
  filters: ConsoleFilters,
  mode: GroupMode,
): TimelineRow[] {
  const unfiltered = isUnfiltered(filters);
  const depths = agentDepths(agents);
  const depthOf = (agentId: string) => depths.get(agentId) ?? 0;

  if (mode === "flat") {
    const rows: TimelineRow[] = [];
    for (const id of order) {
      const call = calls.get(id);
      if (!call || (!unfiltered && !callPasses(call, filters))) continue;
      rows.push({
        key: id,
        call,
        depth: depthOf(call.agentId),
        expanded: expanded.has(id),
        childCount: 0,
        hiddenCount: 0,
      });
    }
    return rows;
  }

  // Tree: group calls by agent.
  const byAgent = new Map<string, ToolCall[]>();
  for (const id of order) {
    const call = calls.get(id);
    if (!call) continue;
    let list = byAgent.get(call.agentId);
    if (!list) byAgent.set(call.agentId, (list = []));
    list.push(call);
  }

  // Spawn row -> spawned agent, via the call's spawnedAgentId or the agent's
  // spawnToolUseId pointing back at the call.
  const spawnTarget = new Map<string, string>();
  const owned = new Set<string>(); // agents rendered inside a spawn block
  for (const call of calls.values()) {
    const t = call.spawnedAgentId;
    if (t && t !== call.agentId && byAgent.has(t) && !owned.has(t)) {
      spawnTarget.set(call.id, t);
      owned.add(t);
    }
  }
  for (const a of agents.values()) {
    const sid = a.spawnToolUseId;
    if (sid && calls.has(sid) && !spawnTarget.has(sid) && !owned.has(a.id)) {
      if (byAgent.has(a.id) && calls.get(sid)?.agentId !== a.id) {
        spawnTarget.set(sid, a.id);
        owned.add(a.id);
      }
    }
  }

  // Root list: calls of every agent without a spawn row (main, orphans),
  // merged chronologically.
  const rootCalls: ToolCall[] = [];
  for (const id of order) {
    const call = calls.get(id);
    if (call && !owned.has(call.agentId)) rootCalls.push(call);
  }

  const visiting = new Set<string>();

  interface BlockResult {
    rows: TimelineRow[];
    total: number;
    shown: number;
  }

  /** Emit rows for one call list at `depth`; returns counts for the badge. */
  function emitList(list: ToolCall[], depth: number): BlockResult {
    const out: TimelineRow[] = [];
    let total = 0;
    let shown = 0;
    for (const call of list) {
      total++;
      const passes = unfiltered || callPasses(call, filters);
      const target = spawnTarget.get(call.id);
      let childRows: TimelineRow[] = [];
      let childTotal = 0;
      let childShown = 0;
      if (target && !visiting.has(target)) {
        visiting.add(target);
        const r = emitList(byAgent.get(target) ?? [], depth + 1);
        visiting.delete(target);
        childRows = r.rows;
        childTotal = r.total;
        childShown = r.shown;
      }
      total += childTotal;
      const keep = passes || childShown > 0;
      if (!keep) continue;
      const open = expanded.has(call.id);
      out.push({
        key: call.id,
        call,
        depth,
        expanded: open,
        childCount: childTotal,
        hiddenCount: childTotal - childShown,
      });
      shown++;
      if (open) out.push(...childRows);
      shown += childShown;
    }
    return { rows: out, total, shown };
  }

  return emitList(rootCalls, 0).rows;
}
