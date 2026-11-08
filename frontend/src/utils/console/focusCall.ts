/**
 * Deep link to a call outside the loaded snapshot window: fetch the call
 * itself so the detail pane can open, then page back until it is in the list.
 */

import { useConsoleStore } from "@/stores/consoleStore";
import type { ToolCallDetail } from "@/utils/console/types";

/** Pages fetched at most while looking for the call. */
export const MAX_SEEK_PAGES = 20;

export interface SeekDeps {
  fetchDetail: (
    sessionId: string,
    callId: string,
  ) => Promise<ToolCallDetail | null>;
  /** Fetch the next older page into the store (no-op while another is in flight). */
  loadOlder: () => Promise<void>;
  /** Pause between retries when a page request was skipped. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const has = (sessionId: string, callId: string) =>
  !!useConsoleStore.getState().sessions[sessionId]?.calls.has(callId);

/**
 * Resolves true once `callId` is held in the store. Gives up (false) when the
 * call is unknown, pages run out, `MAX_SEEK_PAGES` is hit or `isStopped()`.
 */
export async function seekCall(
  sessionId: string,
  callId: string,
  deps: SeekDeps,
  isStopped: () => boolean = () => false,
): Promise<boolean> {
  if (has(sessionId, callId)) return true;
  const detail = await deps.fetchDetail(sessionId, callId).catch(() => null);
  if (isStopped()) return false;
  const store = useConsoleStore.getState();
  if (!detail) return false;
  store.putFocusedCall(sessionId, detail.call);
  store.putDetail(sessionId, detail);

  const sleep = deps.sleep ?? wait;
  const cursor = () =>
    useConsoleStore.getState().sessions[sessionId]?.oldestSeq ?? null;
  const target = detail.call.seq;
  let pages = 0;
  let stalls = 0;
  for (;;) {
    const s = useConsoleStore.getState().sessions[sessionId];
    if (isStopped() || !s) return false;
    // Done when every call older than the cursor down to the target is loaded.
    if (!s.hasMore || (s.oldestSeq !== null && s.oldestSeq <= target)) {
      return true;
    }
    if (pages >= MAX_SEEK_PAGES) return true;
    const before = cursor();
    await deps.loadOlder();
    if (cursor() === before) {
      // Skipped (another page in flight) or empty: back off, then give up.
      if (++stalls > 20) return true;
      await sleep(100);
    } else {
      stalls = 0;
      pages++;
    }
  }
}
