import type {
  CampusSession,
  RoomStatus,
  SessionMeta,
} from "@/engine/contracts";
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
  if (!base) return null;
  return base.toLowerCase() === sessionLabel(s, cs).toLowerCase() ? null : base;
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
