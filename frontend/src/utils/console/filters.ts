/** Timeline filter model and predicate (spec section 2.5, "Filters"). */

import { matchesQuery } from "./search";
import { toolKindOf, type ToolKind } from "./toolFormat";
import type { ToolCall } from "./types";

export interface ConsoleFilters {
  /** Agent ids to show; empty means all. Callers expand descendants first. */
  agentIds: ReadonlySet<string>;
  /** Tool kinds to show; empty means all. */
  kinds: ReadonlySet<ToolKind>;
  errorsOnly: boolean;
  waitingOnly: boolean;
  /** Free text (already debounced by the UI). */
  query: string;
}

export const EMPTY_FILTERS: ConsoleFilters = {
  agentIds: new Set(),
  kinds: new Set(),
  errorsOnly: false,
  waitingOnly: false,
  query: "",
};

/** True when no filter narrows the list. */
export function isUnfiltered(f: ConsoleFilters): boolean {
  return (
    f.agentIds.size === 0 &&
    f.kinds.size === 0 &&
    !f.errorsOnly &&
    !f.waitingOnly &&
    f.query.trim() === ""
  );
}

/** Whether a call passes every active filter. */
export function callPasses(call: ToolCall, f: ConsoleFilters): boolean {
  if (f.agentIds.size > 0 && !f.agentIds.has(call.agentId)) return false;
  if (f.kinds.size > 0 && !f.kinds.has(toolKindOf(call.toolName))) return false;
  if (f.errorsOnly && call.status !== "error") return false;
  if (f.waitingOnly && call.status !== "waiting_permission") return false;
  return matchesQuery(call, f.query);
}
