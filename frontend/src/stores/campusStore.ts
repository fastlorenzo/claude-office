"use client";

import { create } from "zustand";
import type { CampusSession } from "@/engine/contracts";

// ============================================================================
// TYPES
// ============================================================================

interface CampusStoreState {
  /** Slim per-session snapshots from /ws/campus (every session, live + done). */
  sessions: CampusSession[];
  /** Whether the campus WebSocket is currently connected. */
  connected: boolean;
  /** Wall-clock ms of the last meaningful update (null if none yet). */
  lastUpdated: number | null;

  setSessions: (sessions: CampusSession[]) => void;
  setConnected: (connected: boolean) => void;
  clear: () => void;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Structural equality for campus frames. Frames are small (slim snapshots) and
 * the backend serialises keys in a stable order, so a JSON compare is both
 * simple and robust against newly-added fields.
 */
export function sessionsEqual(a: CampusSession[], b: CampusSession[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================================
// STORE
// ============================================================================

export const useCampusStore = create<CampusStoreState>()((set) => ({
  sessions: [],
  connected: false,
  lastUpdated: null,

  setSessions: (sessions) =>
    set((state) =>
      sessionsEqual(state.sessions, sessions)
        ? state
        : { sessions, lastUpdated: Date.now() },
    ),
  setConnected: (connected) => set({ connected }),
  clear: () => set({ sessions: [], lastUpdated: null, connected: false }),
}));

export const selectCampusSessions = (s: CampusStoreState): CampusSession[] =>
  s.sessions;
export const selectCampusConnected = (s: CampusStoreState): boolean =>
  s.connected;
