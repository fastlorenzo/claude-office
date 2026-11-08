/**
 * Framework-free controller behind `useSessionConsole`: loads the snapshot,
 * routes live frames into the store, pages older calls, and decides whether a
 * dedicated socket is needed. Dependencies are injected so it is unit-testable
 * without React or a real WebSocket.
 */

import { enqueueConsoleFrame, useConsoleStore } from "@/stores/consoleStore";
import type {
  ConsoleFrame,
  ConsoleSnapshot,
  ConversationEntry,
  GitStatus,
  TodoItem,
  ToolCall,
} from "./types";

/** Minimal socket surface the controller needs. */
export interface ConsoleSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  close: () => void;
}

export interface ConsoleControllerDeps {
  fetchSnapshot: (
    sessionId: string,
    opts?: { limit?: number; beforeSeq?: number; signal?: AbortSignal },
  ) => Promise<ConsoleSnapshot | null>;
  fetchOlder: (
    sessionId: string,
    beforeSeq: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ calls: ToolCall[]; hasMore: boolean } | null>;
  /** Open `/ws/{sessionId}`. Only called for non-selected sessions. */
  openSocket: (sessionId: string) => ConsoleSocketLike;
}

/** The selected session already has a socket (useWebSocketEvents); others need their own. */
export function needsOwnSocket(
  sessionId: string,
  selectedSessionId: string | null,
): boolean {
  return sessionId !== selectedSessionId;
}

/**
 * Route one parsed `/ws/{id}` message into the store. Ignores sessions the
 * console has not started loading, so it is safe to call for every message.
 */
export function routeConsoleMessage(sessionId: string, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as {
    type?: string;
    gitStatus?: GitStatus;
    state?: { conversation?: ConversationEntry[]; todos?: TodoItem[] };
  };
  const store = useConsoleStore.getState();
  // Sessions the console never began loading would only buffer forever; a
  // later beginLoad fetches a fresher snapshot, so dropping is lossless.
  if (!store.sessions[sessionId]) return;
  switch (m.type) {
    case "tool_call":
    case "agent_node":
      enqueueConsoleFrame(sessionId, msg as ConsoleFrame);
      break;
    case "git_status":
      if (m.gitStatus) store.setGitStatus(sessionId, m.gitStatus);
      break;
    case "state_update":
      if (m.state) {
        store.setConversationAndTodos(
          sessionId,
          m.state.conversation,
          m.state.todos,
        );
      }
      break;
  }
}

export interface ConsoleController {
  /** Begin loading (idempotent). */
  start: () => void;
  /** Cancel in-flight work and close any own socket. */
  stop: () => void;
  /** Fetch the next older page if there is one and none is in flight. */
  loadOlder: () => Promise<void>;
}

/**
 * Create a controller for one session. The own socket (non-selected sessions
 * only) is opened before the snapshot fetch so no update is missed; frames
 * wait in the store queue until the snapshot lands.
 */
export function createConsoleController(
  sessionId: string,
  selectedSessionId: string | null,
  deps: ConsoleControllerDeps,
): ConsoleController {
  let socket: ConsoleSocketLike | null = null;
  let abort: AbortController | null = null;
  let stopped = false;
  let paging = false;

  return {
    start() {
      if (abort) return;
      stopped = false;
      abort = new AbortController();
      const signal = abort.signal;
      const store = useConsoleStore.getState();
      store.beginLoad(sessionId);
      if (needsOwnSocket(sessionId, selectedSessionId)) {
        socket = deps.openSocket(sessionId);
        socket.onmessage = (ev) => {
          try {
            const raw = typeof ev.data === "string" ? ev.data : "";
            routeConsoleMessage(sessionId, JSON.parse(raw));
          } catch {
            // Malformed frame: ignore, the next snapshot refresh heals it.
          }
        };
      }
      deps
        .fetchSnapshot(sessionId, { signal })
        .then((snap) => {
          if (stopped) return;
          const s = useConsoleStore.getState();
          if (snap) s.applySnapshot(sessionId, snap);
          else s.markMissing(sessionId);
        })
        .catch((err: unknown) => {
          if (stopped) return;
          useConsoleStore
            .getState()
            .markError(
              sessionId,
              err instanceof Error ? err.message : String(err),
            );
        });
    },
    stop() {
      stopped = true;
      abort?.abort();
      abort = null;
      socket?.close();
      socket = null;
    },
    async loadOlder() {
      const s = useConsoleStore.getState().sessions[sessionId];
      if (!s || paging || !s.hasMore || s.oldestSeq === null) return;
      paging = true;
      try {
        const page = await deps.fetchOlder(sessionId, s.oldestSeq);
        if (page && !stopped) {
          useConsoleStore
            .getState()
            .applyOlderPage(sessionId, page.calls, page.hasMore);
        }
      } finally {
        paging = false;
      }
    },
  };
}
