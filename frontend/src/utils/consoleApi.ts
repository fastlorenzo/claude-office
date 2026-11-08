/** REST client for the Session Console endpoints (spec section 3.4). */

import { apiFetch } from "@/utils/api";
import type {
  ConsoleSnapshot,
  ToolCall,
  ToolCallDetail,
} from "@/utils/console/types";

/** Default snapshot page size, matching the backend default. */
export const SNAPSHOT_LIMIT = 300;

export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

const base = (sessionId: string) =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}`;

/**
 * `GET /sessions/{id}/console`. Returns null on 404 (no events, or an older
 * backend without the console API), so callers can fall back to the legacy
 * event log. Other failures throw {@link ConsoleApiError}.
 */
export async function fetchConsoleSnapshot(
  sessionId: string,
  opts: { limit?: number; beforeSeq?: number; signal?: AbortSignal } = {},
): Promise<ConsoleSnapshot | null> {
  const q = new URLSearchParams({
    limit: String(opts.limit ?? SNAPSHOT_LIMIT),
  });
  if (opts.beforeSeq !== undefined) q.set("before_seq", String(opts.beforeSeq));
  const res = await apiFetch(`${base(sessionId)}/console?${q}`, {
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ConsoleApiError(res.status, `console ${res.status}`);
  return (await res.json()) as ConsoleSnapshot;
}

/**
 * Older page: same endpoint with `before_seq`. Returns the calls and whether
 * more exist; null on 404.
 */
export async function fetchOlderCalls(
  sessionId: string,
  beforeSeq: number,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ calls: ToolCall[]; hasMore: boolean } | null> {
  const snap = await fetchConsoleSnapshot(sessionId, { ...opts, beforeSeq });
  return snap ? { calls: snap.toolCalls, hasMore: snap.hasMore } : null;
}

/** `GET /sessions/{id}/tool-calls/{callId}`: full input and output. Null on 404. */
export async function fetchToolCallDetail(
  sessionId: string,
  callId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolCallDetail | null> {
  const res = await apiFetch(
    `${base(sessionId)}/tool-calls/${encodeURIComponent(callId)}`,
    { signal: opts.signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new ConsoleApiError(res.status, `detail ${res.status}`);
  return (await res.json()) as ToolCallDetail;
}
