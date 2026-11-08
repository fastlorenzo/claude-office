"use client";

import { useEffect, useState } from "react";
import { useCampusStore } from "@/stores/campusStore";

/** No frame for this long while "connected" counts as frozen data (D2). */
export const STALL_MS = 30_000;
/** The first connect gets this long before the banner appears. */
export const CONNECT_GRACE_MS = 3_000;

export type ConnectionKind =
  "ok" | "connecting" | "reconnecting" | "stalled" | "tooMany" | "origin";

export interface ConnectionStatus {
  kind: ConnectionKind;
  /** Wall-clock ms of the last accepted frame (null when none yet). */
  since: number | null;
}

export function connectionStatus(
  s: {
    connected: boolean;
    lastUpdated: number | null;
    closeCode: number | null;
  },
  now: number,
  mountedMs: number,
): ConnectionStatus {
  const since = s.lastUpdated;
  if (s.closeCode === 4003) return { kind: "origin", since };
  if (!s.connected) {
    if (s.closeCode === 4013) return { kind: "tooMany", since };
    if (since === null)
      return {
        kind: mountedMs < CONNECT_GRACE_MS ? "ok" : "connecting",
        since,
      };
    return { kind: "reconnecting", since };
  }
  if (since !== null && now - since > STALL_MS)
    return { kind: "stalled", since };
  return { kind: "ok", since };
}

/** Live connection status; re-evaluated every second. */
export function useCampusConnection(): ConnectionStatus {
  const connected = useCampusStore((s) => s.connected);
  const lastUpdated = useCampusStore((s) => s.lastUpdated);
  const closeCode = useCampusStore((s) => s.closeCode);
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return connectionStatus({ connected, lastUpdated, closeCode }, now, now - t0);
}
