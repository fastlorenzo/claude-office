import type {
  CampusSession,
  RoomStatus,
  SessionMeta,
} from "@/engine/contracts";
import { stripRefs } from "@/engine/logic/sessionInfo";
import type { Session } from "@/hooks/useSessions";

/** True for Claude Code's dash-encoded project dirs, e.g. "-home-zio-git-foo". */
export function isEncodedPath(v: string | null | undefined): boolean {
  return !!v && /^-[A-Za-z0-9._-]*-[A-Za-z0-9._-]*$/.test(v.trim());
}

/** Last non-empty segment of a real path ("/home/zio/git/foo/" -> "foo"). */
export function pathBasename(p: string | null | undefined): string | null {
  const parts = (p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** "-home-zio-git-foo" -> "git-foo" (drops the "-home-<user>-" prefix). */
export function prettifyEncodedPath(v: string): string {
  const stripped = v.trim().replace(/^-(?:home|Users)-[^-]+-/, "");
  return stripped.replace(/^-+/, "") || v.replace(/^-+/, "");
}

function usable(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Project folder name for a session (never a dash-encoded path). */
export function projectBasename(s: Session): string | null {
  const root = usable(s.projectRoot);
  if (root && !isEncodedPath(root)) {
    const b = pathBasename(root);
    if (b) return b;
  }
  const name = usable(s.projectName);
  if (name) return isEncodedPath(name) ? prettifyEncodedPath(name) : name;
  if (root) return prettifyEncodedPath(root);
  return null;
}

/**
 * Display label precedence:
 * 1. in-app rename (Session.label)  2. campus sessionName (/rename)
 * 3. REST displayName unless an encoded path  4. project basename
 * 5. short session id.
 */
export function sessionLabel(s: Session, cs?: CampusSession): string {
  return (
    usable(s.label) ??
    usable(cs?.sessionName) ??
    (isEncodedPath(s.displayName) ? null : usable(s.displayName)) ??
    projectBasename(s) ??
    s.id.slice(0, 8)
  );
}

/** Muted secondary line: project folder when it differs from the label. */
export function sessionSubLabel(s: Session, cs?: CampusSession): string | null {
  const base = projectBasename(s);
  const project =
    base && base.toLowerCase() !== sessionLabel(s, cs).toLowerCase()
      ? base
      : null;
  const host = usable(cs?.host) ?? usable(s.host);
  return [project, host].filter(Boolean).join(" · ") || null;
}

/** Project / app name: backend `project`, else the session's project folder. */
export function sessionProject(s?: Session, cs?: CampusSession): string | null {
  return usable(cs?.project) ?? (s ? projectBasename(s) : null);
}

/**
 * User-chosen name worth a mention next to the project: null when it merely
 * repeats the project, the summary, or is nothing but ticket refs.
 */
export function distinctName(
  name: string | null | undefined,
  project: string | null,
  summary: string | null,
): string | null {
  const n = usable(name);
  if (!n) return null;
  const low = n.toLowerCase();
  if (project && low === project.toLowerCase()) return null;
  if (summary && low === summary.toLowerCase()) return null;
  if (!stripRefs(n)) return null;
  return n;
}

/** id -> label for every known session. */
export function labelMap(
  sessions: Session[],
  campus: CampusSession[],
): Map<string, string> {
  const byId = new Map(campus.map((c) => [c.sessionId, c]));
  return new Map(sessions.map((s) => [s.id, sessionLabel(s, byId.get(s.id))]));
}

export function toSessionMeta(s: Session, cs?: CampusSession): SessionMeta {
  const createdAt = Date.parse(s.createdAt);
  return {
    id: s.id,
    label: sessionLabel(s, cs),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    status: s.status === "active" ? "active" : "completed",
  };
}

/** Room status for a campus session (mirrors engine/logic/status.ts). */
export function campusStatus(cs: CampusSession | undefined): RoomStatus {
  if (!cs || cs.ended) return "ended";
  return cs.bucket;
}
