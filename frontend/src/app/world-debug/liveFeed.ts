/**
 * world-debug `?live=1`: the live backend campus feed (`/ws/campus`) instead of
 * the demo campus, so the factory shows the user's real projects / PRs. One
 * socket with the same reconnect policy as useCampusWebSocket (exponential
 * backoff + jitter, no retry on 4003, slow retry on 4013); mirrors its frame
 * handling.
 */
import type {
  CampusProject,
  CampusRevs,
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
  revs: CampusRevs | null;
  sentAt: number | null;
}

/** Session metas for the world, with the real status (not a hard-coded one). */
export function liveSessionMetas(campus: CampusSession[]): SessionMeta[] {
  return campus.map((c) => ({
    id: c.sessionId,
    label: c.sessionName || c.project || c.sessionId.slice(0, 8),
    createdAt: Date.parse(c.lastEventAt ?? "") || 0,
    status: c.ended ? "completed" : "active",
  }));
}

/** Connects (and reconnects); `onState` gets every snapshot. Returns a close function. */
export function connectLiveCampus(
  onState: (s: LiveCampus) => void,
  onStatus?: (connected: boolean, code: number | null) => void,
): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let retries = 0;

  const open = (): void => {
    if (closed) return;
    const sock = new WebSocket(`${WS_BASE}/ws/campus`);
    ws = sock;
    sock.onopen = () => {
      retries = 0;
      onStatus?.(true, null);
    };
    sock.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type?: string;
          state?: {
            sessions?: CampusSession[];
            stats?: CampusStats | null;
            projects?: CampusProject[] | null;
            revs?: CampusRevs | null;
            sentAt?: number | null;
          };
        };
        const st = msg.state;
        if (msg.type !== "state_update" || !Array.isArray(st?.sessions)) return;
        const campus = st.sessions;
        onState({
          campus,
          sessions: liveSessionMetas(campus),
          stats: st.stats ?? null,
          projects: st.projects ?? null,
          revs: st.revs ?? null,
          sentAt: typeof st.sentAt === "number" ? st.sentAt : null,
        });
      } catch {
        // Ignore malformed frames.
      }
    };
    sock.onerror = () => console.warn("[world-debug] live campus feed error");
    sock.onclose = (e) => {
      if (closed || ws !== sock) return;
      onStatus?.(false, e.code);
      if (e.code === 4003) return; // origin refused: retrying cannot help
      let delay = Math.min(1000 * 2 ** retries, 30000);
      if (e.code === 4013) delay = Math.max(delay, 10000);
      retries++;
      timer = setTimeout(open, delay + Math.random() * 500);
    };
  };
  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
