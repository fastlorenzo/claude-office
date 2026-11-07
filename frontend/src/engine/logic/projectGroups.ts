/**
 * Pure: group live sessions into projects (one team room per project).
 *
 * Source of truth is `CampusState.projects` when the backend sends it. Until
 * then (and for any session a project list does not cover) sessions are
 * grouped client-side by `CampusSession.projectId`, else the `project` name,
 * else the session label. Groups are ordered by their oldest session, and
 * sessions inside a group by creation time — both stable across updates.
 */
import type {
  CampusProject,
  CampusSession,
  SessionMeta,
} from "@/engine/contracts";

export interface ProjectGroup {
  id: string;
  name: string;
  /** Member sessions, oldest first. */
  sessionIds: string[];
  /** Oldest member's creation time (epoch ms). */
  createdAt: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Fallback grouping key + display name for a session without a project entry. */
export function sessionProjectKey(
  cs: CampusSession,
  label: string | undefined,
): { id: string; name: string } {
  const pid = cs.projectId?.trim();
  const name = cs.project?.trim() || label?.trim() || cs.sessionId.slice(0, 8);
  if (pid) return { id: pid, name };
  return { id: `name:${norm(name)}`, name };
}

export function groupSessions(
  campus: readonly CampusSession[],
  sessions: readonly SessionMeta[],
  projects?: readonly CampusProject[] | null,
): ProjectGroup[] {
  const meta = new Map(sessions.map((s) => [s.id, s]));
  const created = (id: string) => meta.get(id)?.createdAt ?? 0;
  const live = new Map(campus.map((c) => [c.sessionId, c]));
  const groups = new Map<string, ProjectGroup>();
  const claimed = new Set<string>();
  const add = (id: string, name: string, sid: string) => {
    let g = groups.get(id);
    if (!g) {
      g = { id, name, sessionIds: [], createdAt: Infinity };
      groups.set(id, g);
    }
    if (g.sessionIds.includes(sid)) return;
    g.sessionIds.push(sid);
    claimed.add(sid);
  };
  for (const p of projects ?? []) {
    for (const sid of p.sessionIds ?? []) {
      if (!live.has(sid) || claimed.has(sid)) continue;
      add(p.id, p.name?.trim() || p.repo || p.id, sid);
    }
  }
  // Sessions naming a known project id join it even if its list missed them.
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));
  for (const cs of campus) {
    if (claimed.has(cs.sessionId)) continue;
    const known = cs.projectId ? byId.get(cs.projectId) : undefined;
    if (known) {
      add(known.id, known.name?.trim() || known.id, cs.sessionId);
      continue;
    }
    const k = sessionProjectKey(cs, meta.get(cs.sessionId)?.label);
    add(k.id, k.name, cs.sessionId);
  }
  const cmp = (a: string, b: string) =>
    created(a) - created(b) || (a < b ? -1 : a > b ? 1 : 0);
  const out = [...groups.values()];
  for (const g of out) {
    g.sessionIds.sort(cmp);
    g.createdAt = Math.min(...g.sessionIds.map(created));
  }
  return out.sort(
    (a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** sessionId → project id, for lookups. */
export function projectOf(
  groups: readonly ProjectGroup[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) for (const s of g.sessionIds) m.set(s, g.id);
  return m;
}
