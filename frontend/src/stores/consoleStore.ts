"use client";

/**
 * consoleStore: per-session data behind the Session Console and the compact
 * timeline (spec section 3.6).
 *
 * Usage (WS5):
 *   - Read a session with `useConsoleStore((s) => s.sessions[id])`, or a single
 *     row with `useConsoleCall(id, callId)` which re-renders only when that
 *     call object changes.
 *   - Feed it through `useSessionConsole(sessionId)`; never call the mutators
 *     from components. Live frames go through `enqueueConsoleFrame`.
 *
 * Guarantees:
 *   - Frames are queued and flushed once per animation frame (every 250 ms
 *     while the tab is hidden): N frames in a tick give one store update.
 *   - A frame whose `rev` is at or below the stored one is dropped.
 *   - Unchanged calls and agents keep object identity across updates.
 *   - Frames that arrive before the snapshot resolves are held and applied
 *     after it, so the snapshot/live race cannot lose or reorder updates.
 *   - At most {@link MAX_CONSOLE_SESSIONS} sessions are kept (LRU).
 */

import { create } from "zustand";
import { touchLru } from "@/utils/console/lru";
import type {
  AgentNode,
  ConsoleFrame,
  ConsoleHeader,
  ConsoleSnapshot,
  ConversationEntry,
  GitStatus,
  TodoItem,
  ToolCall,
  ToolCallDetail,
} from "@/utils/console/types";

/** Sessions kept in memory; the least recently used is evicted. */
export const MAX_CONSOLE_SESSIONS = 3;
/** Safety cap on frames buffered for one session before its snapshot lands. */
export const MAX_BUFFERED_FRAMES = 20_000;
/** Flush interval while the document is hidden (rAF is paused there). */
export const HIDDEN_FLUSH_MS = 250;

/** Loading lifecycle of one session. `missing` = backend has no console API/events (404). */
export type ConsoleStatus = "idle" | "loading" | "ready" | "missing" | "error";

/** Everything the console knows about one session. Treat as immutable. */
export interface ConsoleSession {
  sessionId: string;
  status: ConsoleStatus;
  errorMessage: string | null;
  /** Tool calls by id. Values keep identity until their `rev` advances. */
  calls: ReadonlyMap<string, ToolCall>;
  /** Call ids ascending by `seq`. Replaced only when ids are added. */
  order: readonly string[];
  agents: ReadonlyMap<string, AgentNode>;
  header: ConsoleHeader | null;
  conversation: readonly ConversationEntry[];
  todos: readonly TodoItem[];
  gitStatus: GitStatus | null;
  /** Full payloads fetched on demand, keyed by {@link detailKey} (`id@rev`). */
  details: ReadonlyMap<string, ToolCallDetail>;
  /** Older calls exist on the server. */
  hasMore: boolean;
  /** Smallest seq held (paging cursor for `before_seq`), or null. */
  oldestSeq: number | null;
}

/** Cache key for a detail payload: `(callId, rev)`. */
export function detailKey(callId: string, rev: number): string {
  return `${callId}@${rev}`;
}

function emptySession(sessionId: string): ConsoleSession {
  return {
    sessionId,
    status: "idle",
    errorMessage: null,
    calls: new Map(),
    order: [],
    agents: new Map(),
    header: null,
    conversation: [],
    todos: [],
    gitStatus: null,
    details: new Map(),
    hasMore: false,
    oldestSeq: null,
  };
}

// ---------------------------------------------------------------------------
// Pure merge helpers
// ---------------------------------------------------------------------------

/** Accumulates call/agent changes against a base, copying lazily. */
interface Draft {
  calls: Map<string, ToolCall> | null;
  agents: Map<string, AgentNode> | null;
  order: string[] | null;
  base: ConsoleSession;
  /** Ids appended out of seq order, needing a re-sort. */
  needsSort: boolean;
}

function startDraft(base: ConsoleSession): Draft {
  return { calls: null, agents: null, order: null, base, needsSort: false };
}

function draftCall(d: Draft, incoming: ToolCall): void {
  const cur = (d.calls ?? d.base.calls).get(incoming.id);
  if (cur && incoming.rev <= cur.rev) return;
  d.calls ??= new Map(d.base.calls);
  d.calls.set(incoming.id, incoming);
  if (!cur) {
    d.order ??= d.base.order.slice();
    const last = d.order.length
      ? d.calls.get(d.order[d.order.length - 1])
      : null;
    if (last && last.seq > incoming.seq) d.needsSort = true;
    d.order.push(incoming.id);
  }
}

function draftAgent(d: Draft, incoming: AgentNode): void {
  const cur = (d.agents ?? d.base.agents).get(incoming.id);
  if (cur && incoming.rev <= cur.rev) return;
  d.agents ??= new Map(d.base.agents);
  d.agents.set(incoming.id, incoming);
}

function finishDraft(d: Draft): Partial<ConsoleSession> | null {
  if (!d.calls && !d.agents) return null;
  const patch: Partial<ConsoleSession> = {};
  if (d.calls) {
    patch.calls = d.calls;
    if (d.order) {
      if (d.needsSort) {
        const calls = d.calls;
        d.order.sort(
          (a, b) => (calls.get(a)?.seq ?? 0) - (calls.get(b)?.seq ?? 0),
        );
      }
      patch.order = d.order;
      const first = calls0(d.calls, d.order[0]);
      patch.oldestSeq = first ? first.seq : d.base.oldestSeq;
    }
  }
  if (d.agents) patch.agents = d.agents;
  return patch;
}

function calls0(m: ReadonlyMap<string, ToolCall>, id: string | undefined) {
  return id === undefined ? undefined : m.get(id);
}

function applyFrames(
  base: ConsoleSession,
  frames: readonly ConsoleFrame[],
): ConsoleSession {
  const d = startDraft(base);
  for (const f of frames) {
    if (f.type === "tool_call") draftCall(d, f.toolCall);
    else draftAgent(d, f.agent);
  }
  const patch = finishDraft(d);
  return patch ? { ...base, ...patch } : base;
}

// ---------------------------------------------------------------------------
// Frame queue + scheduler (module level: not reactive state)
// ---------------------------------------------------------------------------

const queues = new Map<string, ConsoleFrame[]>();
let flushScheduled = false;

type Scheduler = (cb: () => void) => void;

const defaultScheduler: Scheduler = (cb) => {
  if (typeof document !== "undefined" && document.hidden) {
    setTimeout(cb, HIDDEN_FLUSH_MS);
  } else if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => cb());
  } else {
    setTimeout(cb, 16);
  }
};
let scheduler: Scheduler = defaultScheduler;

/**
 * Replace the flush scheduler (tests drive flushes by hand). Pass `null` to
 * restore the rAF default.
 */
export function setConsoleScheduler(s: Scheduler | null): void {
  scheduler = s ?? defaultScheduler;
}

/** Drop all queued frames and scheduler state (tests). */
export function resetConsoleQueues(): void {
  queues.clear();
  flushScheduled = false;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ConsoleStoreState {
  /** Sessions currently held (at most {@link MAX_CONSOLE_SESSIONS}). */
  sessions: Record<string, ConsoleSession>;
  /** Session ids, least recently used first. */
  lru: string[];

  /** Mark a session as loading its snapshot and bump it in the LRU. */
  beginLoad: (sessionId: string) => void;
  /**
   * Install a snapshot (initial load or refresh) and then apply any frames
   * that arrived while it was loading. Marks the session `ready`.
   */
  applySnapshot: (sessionId: string, snapshot: ConsoleSnapshot) => void;
  /** Prepend an older page (`before_seq`) fetched by scrolling to the top. */
  applyOlderPage: (
    sessionId: string,
    calls: readonly ToolCall[],
    hasMore: boolean,
  ) => void;
  /** Backend has no console data for this session (404). */
  markMissing: (sessionId: string) => void;
  /** Snapshot fetch failed. */
  markError: (sessionId: string, message: string) => void;
  /** Mark a session recently used without loading. */
  touch: (sessionId: string) => void;
  /** Forget a session and its queued frames. */
  drop: (sessionId: string) => void;

  /** Replace the git status (from a `git_status` frame). */
  setGitStatus: (sessionId: string, git: GitStatus | null) => void;
  /**
   * Update conversation and todos from a `state_update`. Compared shallowly
   * (length and last id / content) so unchanged lists keep identity.
   */
  setConversationAndTodos: (
    sessionId: string,
    conversation: readonly ConversationEntry[] | undefined,
    todos: readonly TodoItem[] | undefined,
  ) => void;
  /** Cache a full-payload response under `(callId, rev)`. */
  putDetail: (sessionId: string, detail: ToolCallDetail) => void;
}

function withSession(
  state: ConsoleStoreState,
  sessionId: string,
  fn: (s: ConsoleSession) => ConsoleSession,
): Partial<ConsoleStoreState> | ConsoleStoreState {
  const cur = state.sessions[sessionId];
  if (!cur) return state;
  const next = fn(cur);
  if (next === cur) return state;
  return { sessions: { ...state.sessions, [sessionId]: next } };
}

/** Insert into the session map, bump LRU and evict. */
function ensureSession(
  state: ConsoleStoreState,
  sessionId: string,
): { sessions: Record<string, ConsoleSession>; lru: string[] } {
  const { list, evicted } = touchLru(
    state.lru,
    sessionId,
    MAX_CONSOLE_SESSIONS,
  );
  const sessions = { ...state.sessions };
  sessions[sessionId] ??= emptySession(sessionId);
  for (const id of evicted) {
    delete sessions[id];
    queues.delete(id);
  }
  return { sessions, lru: list };
}

function sameLast<T extends { id?: unknown }>(
  a: readonly T[],
  b: readonly T[],
): boolean {
  return (
    a.length === b.length &&
    (a.length === 0 || a[a.length - 1]?.id === b[b.length - 1]?.id)
  );
}

function sameTodos(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (t, i) => t.content === b[i].content && t.status === b[i].status,
  );
}

export const useConsoleStore = create<ConsoleStoreState>()((set) => ({
  sessions: {},
  lru: [],

  beginLoad: (sessionId) =>
    set((state) => {
      const { sessions, lru } = ensureSession(state, sessionId);
      sessions[sessionId] = {
        ...sessions[sessionId],
        status: "loading",
        errorMessage: null,
      };
      return { sessions, lru };
    }),

  applySnapshot: (sessionId, snapshot) =>
    set((state) => {
      const { sessions, lru } = ensureSession(state, sessionId);
      const cur = sessions[sessionId];
      const d = startDraft(cur);
      for (const a of snapshot.agents) draftAgent(d, a);
      for (const c of snapshot.toolCalls) draftCall(d, c);
      const patch = finishDraft(d) ?? {};
      let next: ConsoleSession = {
        ...cur,
        ...patch,
        status: "ready",
        errorMessage: null,
        header: snapshot.header,
        conversation: sameLast(cur.conversation, snapshot.conversation)
          ? cur.conversation
          : snapshot.conversation,
        todos: sameTodos(cur.todos, snapshot.todos)
          ? cur.todos
          : snapshot.todos,
        // Keep a larger known history (refresh over an already-paged list).
        hasMore:
          cur.oldestSeq !== null &&
          snapshot.oldestSeq != null &&
          cur.oldestSeq < snapshot.oldestSeq
            ? cur.hasMore
            : snapshot.hasMore,
        oldestSeq: patch.oldestSeq ?? snapshot.oldestSeq ?? cur.oldestSeq,
      };
      // The snapshot wins the race, then frames buffered meanwhile land on top.
      const pending = queues.get(sessionId);
      if (pending?.length) {
        next = applyFrames(next, pending);
        queues.delete(sessionId);
      }
      sessions[sessionId] = next;
      return { sessions, lru };
    }),

  applyOlderPage: (sessionId, older, hasMore) =>
    set((state) =>
      withSession(state, sessionId, (s) => {
        const d = startDraft(s);
        for (const c of older) draftCall(d, c);
        const patch = finishDraft(d);
        return { ...s, ...(patch ?? {}), hasMore };
      }),
    ),

  markMissing: (sessionId) =>
    set((state) => {
      const { sessions, lru } = ensureSession(state, sessionId);
      sessions[sessionId] = { ...sessions[sessionId], status: "missing" };
      queues.delete(sessionId);
      return { sessions, lru };
    }),

  markError: (sessionId, message) =>
    set((state) => {
      const { sessions, lru } = ensureSession(state, sessionId);
      sessions[sessionId] = {
        ...sessions[sessionId],
        status: "error",
        errorMessage: message,
      };
      return { sessions, lru };
    }),

  touch: (sessionId) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state;
      return { lru: touchLru(state.lru, sessionId, MAX_CONSOLE_SESSIONS).list };
    }),

  drop: (sessionId) =>
    set((state) => {
      queues.delete(sessionId);
      if (!state.sessions[sessionId]) return state;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions, lru: state.lru.filter((x) => x !== sessionId) };
    }),

  setGitStatus: (sessionId, git) =>
    set((state) =>
      withSession(state, sessionId, (s) => ({ ...s, gitStatus: git })),
    ),

  setConversationAndTodos: (sessionId, conversation, todos) =>
    set((state) =>
      withSession(state, sessionId, (s) => {
        const c =
          conversation && !sameLast(s.conversation, conversation)
            ? conversation
            : s.conversation;
        const t = todos && !sameTodos(s.todos, todos) ? todos : s.todos;
        return c === s.conversation && t === s.todos
          ? s
          : { ...s, conversation: c, todos: t };
      }),
    ),

  putDetail: (sessionId, detail) =>
    set((state) =>
      withSession(state, sessionId, (s) => {
        const details = new Map(s.details);
        details.set(detailKey(detail.call.id, detail.call.rev), detail);
        return { ...s, details };
      }),
    ),
}));

/** Flush every ready session's queue in one store update. */
function flushQueues(): void {
  flushScheduled = false;
  const state = useConsoleStore.getState();
  let sessions: Record<string, ConsoleSession> | null = null;
  for (const [id, frames] of queues) {
    const cur = state.sessions[id];
    if (!cur || cur.status !== "ready" || frames.length === 0) continue; // held for the snapshot
    queues.delete(id);
    const next = applyFrames(cur, frames);
    if (next !== cur) {
      sessions ??= { ...state.sessions };
      sessions[id] = next;
    }
  }
  if (sessions) useConsoleStore.setState({ sessions });
}

/**
 * Queue a live frame for a session. Flushed once per animation frame; held
 * until the snapshot has landed if the session is not `ready` yet.
 */
export function enqueueConsoleFrame(
  sessionId: string,
  frame: ConsoleFrame,
): void {
  let q = queues.get(sessionId);
  if (!q) queues.set(sessionId, (q = []));
  q.push(frame);
  if (q.length > MAX_BUFFERED_FRAMES)
    q.splice(0, q.length - MAX_BUFFERED_FRAMES);
  if (!flushScheduled) {
    flushScheduled = true;
    scheduler(flushQueues);
  }
}

/** Apply queued frames immediately (tests, and before reading after a mutation). */
export function flushConsoleFrames(): void {
  flushQueues();
}

/**
 * One call by id. Re-renders only when that call's object changes (frames
 * keep identity for unchanged calls). Import `useConsoleStore` selectors
 * directly if you need more.
 */
export function useConsoleCall(
  sessionId: string,
  callId: string,
): ToolCall | undefined {
  return useConsoleStore((s) => s.sessions[sessionId]?.calls.get(callId));
}
