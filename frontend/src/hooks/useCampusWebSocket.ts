"use client";

import { WS_BASE } from "@/utils/api";
import { useCallback, useEffect, useRef } from "react";
import { useCampusStore } from "@/stores/campusStore";
import type {
  CampusProject,
  CampusRevs,
  CampusSession,
  CampusStats,
} from "@/engine/contracts";

/** Origin refused by the backend: retrying cannot help (D9). */
export const CLOSE_ORIGIN_REFUSED = 4003;
/** Backend client cap (8 campus watchers) reached: keep retrying, tell the user. */
export const CLOSE_TOO_MANY = 4013;

/**
 * Connects to the global `/ws/campus` feed that carries one boss snapshot per
 * session (the 3D office). Separate from {@link useWebSocketEvents},
 * which is session-bound. Connects only while {@link enabled} is true (i.e. the
 * 3D view is mounted) and tears down on disable/unmount.
 *
 * Mirrors the reconnect / connection-id guard pattern of useWebSocketEvents.
 */
export function useCampusWebSocket({ enabled }: { enabled: boolean }): void {
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const retryCountRef = useRef(0);
  const enabledRef = useRef(enabled);
  // Holds the latest `connect` so the reconnect timer can call it without a
  // self-reference (which trips no-use-before-define).
  const connectRef = useRef<(() => void) | null>(null);

  // Keep refs in sync without touching them during render.
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const acceptFrame = useCampusStore((s) => s.acceptFrame);
  const setCloseCode = useCampusStore((s) => s.setCloseCode);
  const setConnected = useCampusStore((s) => s.setConnected);

  const connect = useCallback(() => {
    connectionIdRef.current++;
    const thisConnectionId = connectionIdRef.current;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const ws = new WebSocket(`${WS_BASE}/ws/campus`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (connectionIdRef.current !== thisConnectionId) {
        ws.close();
        return;
      }
      retryCountRef.current = 0;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (connectionIdRef.current !== thisConnectionId) return;
      try {
        const msg = JSON.parse(event.data) as {
          type?: string;
          state?: {
            sessions?: CampusSession[];
            stats?: CampusStats | null;
            projects?: CampusProject[] | null;
            revs?: CampusRevs | null;
            sentAt?: number | null;
          };
        };
        if (msg.type === "state_update") {
          // Validate the shape before applying so a malformed payload can't
          // throw at render time.
          if (Array.isArray(msg.state?.sessions)) {
            acceptFrame({
              sessions: msg.state.sessions,
              stats: msg.state.stats ?? null,
              projects: msg.state.projects ?? null,
              revs: msg.state.revs ?? null,
              sentAt:
                typeof msg.state.sentAt === "number" ? msg.state.sentAt : null,
            });
          } else {
            console.warn("[campus WS] ignoring malformed state_update frame");
          }
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    ws.onerror = () => {
      if (connectionIdRef.current !== thisConnectionId) return;
      console.warn("[campus WS] connection error — will retry");
    };

    ws.onclose = (event: { code?: number }) => {
      if (connectionIdRef.current !== thisConnectionId) return;
      setConnected(false);
      const code = typeof event?.code === "number" ? event.code : null;
      setCloseCode(code);
      // The origin check will fail again the same way: stop, the banner says why.
      if (code === CLOSE_ORIGIN_REFUSED) return;
      if (enabledRef.current) {
        // Exponential backoff with random jitter (0–500ms) so many clients
        // don't reconnect in lockstep after a backend restart.
        let baseDelay = Math.min(
          1000 * Math.pow(2, retryCountRef.current),
          30000,
        );
        // The backend accepts then closes when its client cap is hit, so the
        // open resets the backoff: back off explicitly instead (D9).
        if (code === CLOSE_TOO_MANY) baseDelay = Math.max(baseDelay, 10000);
        const delay = baseDelay + Math.random() * 500;
        retryCountRef.current++;
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (enabledRef.current) connectRef.current?.();
        }, delay);
      }
    };
  }, [setConnected, setCloseCode, acceptFrame]);

  // Expose the latest connect to the reconnect timer.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!enabled) {
      connectionIdRef.current++; // invalidate any pending handlers
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      setConnected(false);
      useCampusStore.getState().clear();
      return;
    }

    connect();

    const connectionIdAtSetup = connectionIdRef;
    return () => {
      // Invalidate any in-flight handlers so a closing socket doesn't reconnect
      // after unmount.
      connectionIdAtSetup.current++;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Don't leave a stale "connected" + old entries behind on unmount.
      setConnected(false);
      useCampusStore.getState().clear();
    };
  }, [enabled, connect, setConnected]);
}
