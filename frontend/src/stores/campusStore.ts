"use client";

import { create } from "zustand";
import type {
  CampusProject,
  CampusRevs,
  CampusSession,
  CampusStats,
} from "@/engine/contracts";

// ============================================================================
// TYPES
// ============================================================================

interface CampusStoreState {
  /** Slim per-session snapshots from /ws/campus (every session, live + done). */
  sessions: CampusSession[];
  /** Whether the campus WebSocket is currently connected. */
  connected: boolean;
  /**
   * Wall-clock ms of the last ACCEPTED frame (null if none yet). Advances on
   * every frame, changed or not, so liveness is observable (D2).
   */
  lastUpdated: number | null;
  /** Backend `sentAt` (epoch ms) of the last accepted frame, when sent. */
  sentAt: number | null;
  /** Last WebSocket close code (null while connected / never closed). */
  closeCode: number | null;
  /** Per-section content revisions of the last frame (D10). */
  revs: CampusRevs | null;

  /** Building-wide control-room stats (null until the backend sends them). */
  stats: CampusStats | null;

  /** Projects (team rooms + CI); null on older backends (grouped client-side). */
  projects: CampusProject[] | null;

  setProjects: (projects: CampusProject[] | null) => void;
  setSessions: (sessions: CampusSession[]) => void;
  setStats: (stats: CampusStats | null) => void;
  setConnected: (connected: boolean) => void;
  setCloseCode: (code: number | null) => void;
  /**
   * Applies one `/ws/campus` frame: stamps `lastUpdated`, then replaces each
   * section only when its server `rev` moved (or, for older backends without
   * revs, when a structural compare says it changed).
   */
  acceptFrame: (frame: CampusFrame) => void;
  clear: () => void;
}

export interface CampusFrame {
  sessions: CampusSession[];
  stats?: CampusStats | null;
  projects?: CampusProject[] | null;
  revs?: CampusRevs | null;
  sentAt?: number | null;
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
  stats: null,
  projects: null,
  sentAt: null,
  closeCode: null,
  revs: null,

  setProjects: (projects) =>
    set((state) =>
      JSON.stringify(state.projects) === JSON.stringify(projects)
        ? state
        : { projects },
    ),
  setStats: (stats) =>
    set((state) =>
      JSON.stringify(state.stats) === JSON.stringify(stats) ? state : { stats },
    ),
  setSessions: (sessions) =>
    set((state) =>
      sessionsEqual(state.sessions, sessions)
        ? state
        : { sessions, lastUpdated: Date.now() },
    ),
  setConnected: (connected) =>
    set(connected ? { connected, closeCode: null } : { connected }),
  setCloseCode: (closeCode) => set({ closeCode }),
  acceptFrame: (frame) =>
    set((state) => {
      const r = frame.revs ?? null;
      const prev = state.revs;
      const same = (k: keyof CampusRevs): boolean =>
        r?.[k] != null && prev?.[k] === r[k];
      const next: Partial<CampusStoreState> = {
        // Strictly increasing, so two frames in one millisecond still advance.
        lastUpdated: Math.max(Date.now(), (state.lastUpdated ?? 0) + 1),
        sentAt: frame.sentAt ?? state.sentAt,
        revs: r ?? state.revs,
      };
      if (!same("sessions") && !sessionsEqual(state.sessions, frame.sessions))
        next.sessions = frame.sessions;
      const stats = frame.stats ?? null;
      if (
        !same("stats") &&
        JSON.stringify(state.stats) !== JSON.stringify(stats)
      )
        next.stats = stats;
      const projects = frame.projects ?? null;
      if (
        !same("projects") &&
        JSON.stringify(state.projects) !== JSON.stringify(projects)
      )
        next.projects = projects;
      return next;
    }),
  clear: () =>
    set({
      sentAt: null,
      closeCode: null,
      revs: null,
      sessions: [],
      stats: null,
      projects: null,
      lastUpdated: null,
      connected: false,
    }),
}));

export const selectCampusLastUpdated = (s: CampusStoreState): number | null =>
  s.lastUpdated;
export const selectCampusSessions = (s: CampusStoreState): CampusSession[] =>
  s.sessions;
export const selectCampusConnected = (s: CampusStoreState): boolean =>
  s.connected;
export const selectCampusStats = (s: CampusStoreState): CampusStats | null =>
  s.stats;
