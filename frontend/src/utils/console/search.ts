/** Free-text search over a call's tool name, target, input and output previews. */

import type { ToolCall } from "./types";

const haystacks = new WeakMap<ToolCall, string>();

/** Lowercased searchable text for a call; cached per call object. */
export function searchHaystack(call: ToolCall): string {
  let h = haystacks.get(call);
  if (h === undefined) {
    const parts = [call.toolName, call.target ?? ""];
    if (call.inputPreview) {
      for (const v of Object.values(call.inputPreview)) {
        parts.push(typeof v === "string" ? v : JSON.stringify(v));
      }
    }
    if (call.outputPreview) parts.push(call.outputPreview);
    if (call.error) parts.push(call.error);
    h = parts.join("\n").toLowerCase();
    haystacks.set(call, h);
  }
  return h;
}

/** Case-insensitive substring match; an empty query matches everything. */
export function matchesQuery(call: ToolCall, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || searchHaystack(call).includes(q);
}
