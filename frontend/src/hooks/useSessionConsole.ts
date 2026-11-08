"use client";

import { useEffect, useMemo } from "react";
import { useConsoleStore, type ConsoleSession } from "@/stores/consoleStore";
import { WS_BASE } from "@/utils/api";
import { fetchConsoleSnapshot, fetchOlderCalls } from "@/utils/consoleApi";
import {
  createConsoleController,
  type ConsoleSocketLike,
} from "@/utils/console/controller";

/**
 * Load and keep live the console data for `sessionId` in `consoleStore`.
 *
 * - Fetches the snapshot (404 sets status `missing`: fall back to the legacy log).
 * - If `sessionId` is the selected session, opens no socket: phase 2 makes
 *   `useWebSocketEvents` forward `tool_call` / `agent_node` frames with
 *   `enqueueConsoleFrame`. Any other session opens its own `/ws/{id}`.
 *
 * Returns the session state (undefined until the first render after
 * `beginLoad`) and `loadOlder` for the scroll-to-top pager.
 *
 * @param sessionId the session to show, or null for none
 * @param selectedSessionId the session `useWebSocketEvents` is connected to
 */
export function useSessionConsole(
  sessionId: string | null,
  selectedSessionId: string | null,
): { session: ConsoleSession | undefined; loadOlder: () => Promise<void> } {
  const controller = useMemo(
    () =>
      sessionId
        ? createConsoleController(sessionId, selectedSessionId, {
            fetchSnapshot: fetchConsoleSnapshot,
            fetchOlder: fetchOlderCalls,
            openSocket: (id) =>
              new WebSocket(
                `${WS_BASE}/ws/${encodeURIComponent(id)}`,
              ) as unknown as ConsoleSocketLike,
          })
        : null,
    [sessionId, selectedSessionId],
  );

  useEffect(() => {
    controller?.start();
    return () => controller?.stop();
  }, [controller]);

  const session = useConsoleStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  );
  return {
    session,
    loadOlder: controller ? controller.loadOlder : () => Promise.resolve(),
  };
}
