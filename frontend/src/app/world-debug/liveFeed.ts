/**
 * world-debug `?live=1`: the live backend campus feed (`/ws/campus`) instead of
 * the demo campus, so the factory shows the user's real projects / PRs. One
 * socket, latest snapshot kept; mirrors useCampusWebSocket's frame handling.
 */
import type {
  CampusProject,
  CampusSession,
  CampusStats,
  SessionMeta,
} from "@/engine/contracts";
import { WS_BASE } from "@/utils/api";

export interface LiveCampus {
  campus: CampusSession[];
  sessions: SessionMeta[];
  stats: CampusStats | null;
  projects: CampusProject[] | null;
}

/** Connects; `onState` gets every snapshot. Returns a close function. */
export function connectLiveCampus(
  onState: (s: LiveCampus) => void,
): () => void {
  const ws = new WebSocket(`${WS_BASE}/ws/campus`);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as {
        type?: string;
        state?: {
          sessions?: CampusSession[];
          stats?: CampusStats | null;
          projects?: CampusProject[] | null;
        };
      };
      const st = msg.state;
      if (msg.type !== "state_update" || !Array.isArray(st?.sessions)) return;
      const campus = st.sessions;
      onState({
        campus,
        sessions: campus.map((c) => ({
          id: c.sessionId,
          label: c.sessionName || c.project || c.sessionId.slice(0, 8),
          createdAt: Date.parse(c.lastEventAt ?? "") || 0,
          status: "active",
        })),
        stats: st.stats ?? null,
        projects: st.projects ?? null,
      });
    } catch {
      // Ignore malformed frames.
    }
  };
  ws.onerror = () => console.warn("[world-debug] live campus feed error");
  return () => ws.close();
}
