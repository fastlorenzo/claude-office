/**
 * Pure helpers that turn a CampusSession into human-readable glance data:
 * summary, ticket refs, humanized branch, phase. Every backend field is
 * optional (older backends), so each helper has a client-side fallback.
 * No React, no Babylon.
 */

import type {
  CampusSession,
  SessionPhase,
  SessionPhaseKind,
} from "../contracts";

export const PHASE_KINDS: readonly SessionPhaseKind[] = [
  "needs_approval",
  "waiting_user",
  "planning",
  "researching",
  "exploring",
  "coding",
  "testing",
  "building",
  "running",
  "git",
  "delegating",
  "compacting",
  "idle",
  "ended",
];

/** English fallback labels (the UI prefers translated `hud.phase.<kind>`). */
export const PHASE_LABEL_EN: Record<SessionPhaseKind, string> = {
  needs_approval: "Waiting for your approval",
  waiting_user: "Waiting for your reply",
  planning: "Planning",
  researching: "Researching",
  exploring: "Exploring code",
  coding: "Coding",
  testing: "Running tests",
  building: "Building",
  running: "Working",
  git: "Git",
  delegating: "Delegating",
  compacting: "Compacting context",
  idle: "Idle",
  ended: "Ended",
};

export function isPhaseKind(k: string): k is SessionPhaseKind {
  return (PHASE_KINDS as readonly string[]).includes(k);
}

export function clean(s: string | null | undefined): string | null {
  const v = s?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

const TICKET_RE = /\b[A-Za-z][A-Za-z0-9]+-\d+\b/g;
const TICKET_STRICT_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const PR_RE = /(?<![\w&])#\d+\b/g;

/** Ticket ids (CONT-839) and PR numbers (#412) found in the given texts, deduped, in order. */
export function extractRefs(
  ...texts: Array<string | null | undefined>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (r: string): void => {
    const k = r.toUpperCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  };
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.match(TICKET_STRICT_RE) ?? []) add(m);
    // lower-case ticket ids as found in branch names (feat/cont-839-x)
    for (const m of t.match(
      /(?<![A-Za-z0-9])[a-z][a-z0-9]{1,9}-\d{1,6}(?![A-Za-z0-9])/g,
    ) ?? [])
      add(m.toUpperCase());
    for (const m of t.match(PR_RE) ?? []) add(m);
  }
  return out;
}

/** Remove ticket / PR tokens and the punctuation they leave behind. */
export function stripRefs(text: string): string {
  return text
    .replace(TICKET_RE, " ")
    .replace(PR_RE, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/^[\s:\-–—|/,.]+|[\s:\-–—|/,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(
  (
    "and or the to for with fix fixes fixed wip of in on at by from into a an pr prs " +
    "ticket tickets issue issues task tasks work working implement do please per via vs also plus"
  ).split(" "),
);

/** True when `text` keeps >= 2 real words (>= 3 letters, not connectors) once refs are removed. */
function meaningful(text: string): boolean {
  const words = text.match(/[\p{L}]+/gu) ?? [];
  return (
    words.filter((w) => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
      .length >= 2
  );
}

/** Refs: backend `refs`, else extracted from sessionName / branch / objective. */
export function sessionRefs(cs: CampusSession, max = 3): string[] {
  const given = (cs.refs ?? [])
    .map((r) => clean(r))
    .filter((r): r is string => r !== null);
  const refs = given.length
    ? given
    : extractRefs(cs.sessionName, cs.gitBranch, cs.objective);
  return refs.slice(0, max);
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

const ACRONYMS: Record<string, string> = {
  sso: "SSO",
  api: "API",
  ui: "UI",
  ux: "UX",
  ci: "CI",
  cd: "CD",
  db: "DB",
  sql: "SQL",
  jwt: "JWT",
  url: "URL",
  css: "CSS",
  html: "HTML",
  oauth: "OAuth",
  csv: "CSV",
  pdf: "PDF",
  ssr: "SSR",
  cli: "CLI",
  ws: "WS",
};
const MAIN_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "head",
  "trunk",
]);
const TYPE_PREFIX =
  /^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|doc|test|tests|perf|style|ci|build|wip|spike|release)$/i;

/** "feat/cont-839-sso-login" -> "SSO login"; null for main/empty/ref-only. */
export function humanizeBranch(
  branch: string | null | undefined,
): string | null {
  const b = clean(branch);
  if (!b || MAIN_BRANCHES.has(b.toLowerCase())) return null;
  const segs = b.split("/").filter(Boolean);
  // drop a type prefix ("feat/") or a leading user segment ("zio/")
  if (segs.length > 1 && TYPE_PREFIX.test(segs[0])) segs.shift();
  else if (segs.length > 1 && segs[0].length <= 12) segs.shift();
  if (segs.length > 1 && TYPE_PREFIX.test(segs[0])) segs.shift();
  const rest = stripRefs(stripRefs(segs.join(" ")).replace(/[-_.]+/g, " "));
  const words = rest.split(" ").filter(Boolean);
  if (words.length === 0 || !meaningful(rest)) return null;
  const mapped = words.map((w, i) => {
    const a = ACRONYMS[w.toLowerCase()];
    if (a) return a;
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  });
  return mapped.join(" ");
}

// ---------------------------------------------------------------------------
// Noise filtering (focus lines that are not a useful description)
// ---------------------------------------------------------------------------

const SHELL_START =
  /^(\$|>|sudo\b|cd\b|ls\b|git\b|npm\b|npx\b|pnpm\b|yarn\b|bun\b|bunx\b|uv\b|uvx\b|make\b|python3?\b|pip\b|pytest\b|vitest\b|cargo\b|go\b|docker\b|kubectl\b|curl\b|cat\b|grep\b|rg\b|sed\b|node\b|tsc\b|eslint\b|ruff\b|bash\b|sh\b|echo\b|rm\b|mv\b|cp\b|mkdir\b|gh\b)(\s|$)/i;
const PROMPT_START =
  /^(please|pls|can you|could you|would you|will you|let'?s|lets|do you|are we|are you|is it|is this|did you|have you|what|why|how|where|when|ok(ay)?|yes|no|thanks|thank you|continue|go on|proceed|looks good|lgtm)\b/i;

/** Tag-ish markup, shell commands: never a headline. */
export function looksLikeMarkupOrShell(s: string): boolean {
  const t = s.trim();
  if (/^<[A-Za-z/!?]/.test(t)) return true;
  if (/<(agent-message|system|command|task|user)[\s>-]/i.test(t)) return true;
  return SHELL_START.test(t);
}

/** A raw user prompt / chatty question rather than a work description. */
export function looksLikeUserPrompt(s: string): boolean {
  const t = s.trim();
  if (/\?\s*$/.test(t) && t.length <= 80) return true;
  return PROMPT_START.test(t) && t.length <= 60;
}

/** Focus text safe to show as a headline, else null. */
export function sanitizeFocus(s: string | null | undefined): string | null {
  const v = clean(s);
  if (!v) return null;
  if (looksLikeMarkupOrShell(v) || looksLikeUserPrompt(v)) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * One-line "what is this session building":
 * summary -> objective (refs stripped, must keep a real word) -> humanized branch -> null.
 */
export function sessionSummary(cs: CampusSession): string | null {
  const s = clean(cs.summary);
  if (s) return s;
  const o = clean(cs.objective);
  if (o && !looksLikeMarkupOrShell(o)) {
    const stripped = stripRefs(o);
    if (meaningful(stripped) && !looksLikeUserPrompt(stripped)) return stripped;
  }
  return humanizeBranch(cs.gitBranch);
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

const ACTIVE_AGENT_STATES = new Set(["completed", "leaving"]);

function activityPhase(
  text: string,
): { kind: SessionPhaseKind; detail: string | null } | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  const rest = t.replace(/^[A-Za-z_]+:\s*/, "");
  if (/^(bash|run|shell|command)\b/i.test(t) || /^\$/.test(t)) {
    if (
      /\b(pytest|vitest|jest|mocha|go test|cargo test|npm (run )?test|bun (run )?test|make test|rspec|playwright)\b/i.test(
        t,
      )
    )
      return { kind: "testing", detail: rest };
    if (
      /\b(git (commit|push|pull|merge|rebase|checkout|stash|status|diff)|gh (pr|issue))\b/i.test(
        t,
      )
    )
      return { kind: "git", detail: rest };
    if (
      /\b(build|tsc|typecheck|lint|eslint|ruff|mypy|checkall|compile|next build|webpack|vite)\b/i.test(
        t,
      )
    )
      return { kind: "building", detail: rest };
    return { kind: "running", detail: rest };
  }
  if (/^(edit|write|multiedit|notebookedit|apply)/i.test(lower))
    return { kind: "coding", detail: rest };
  if (/^(read|grep|glob|ls|find|search)/i.test(lower))
    return { kind: "exploring", detail: rest };
  if (/^(websearch|webfetch|fetch|web)/i.test(lower))
    return { kind: "researching", detail: rest };
  if (/^(task|agent)/i.test(lower)) return { kind: "delegating", detail: rest };
  if (/^(todowrite|plan|exitplanmode)/i.test(lower))
    return { kind: "planning", detail: null };
  return null;
}

/** Backend phase when present and valid, else derived from boss state + latest activity. */
export function sessionPhase(cs: CampusSession): SessionPhase {
  const given = cs.phase;
  if (given && typeof given.kind === "string" && !cs.ended) {
    return {
      ...given,
      detail: clean(given.detail),
      label:
        clean(given.label) ??
        (isPhaseKind(given.kind) ? PHASE_LABEL_EN[given.kind] : given.kind),
    };
  }
  if (cs.ended) return { kind: "ended", label: "Ended" };
  if (cs.boss?.state === "waiting_permission")
    return { kind: "needs_approval", label: "Waiting for your approval" };
  if (cs.bucket === "needs_you")
    return { kind: "needs_approval", label: "Waiting for your approval" };
  if (cs.boss?.state === "idle" || cs.bucket === "done")
    return { kind: "waiting_user", label: "Waiting for your reply" };
  const agents = (cs.agents ?? []).filter(
    (a) => !ACTIVE_AGENT_STATES.has(a.state),
  );
  const last = cs.recentActivity?.[cs.recentActivity.length - 1];
  const fromActivity =
    last && last.agentId === "main" ? activityPhase(last.summary) : null;
  if (cs.boss?.state === "delegating" || (agents.length > 0 && !fromActivity))
    return {
      kind: "delegating",
      label: PHASE_LABEL_EN.delegating,
      detail: null,
    };
  if (fromActivity)
    return {
      kind: fromActivity.kind,
      label: PHASE_LABEL_EN[fromActivity.kind],
      detail: clean(fromActivity.detail),
    };
  return {
    kind: "running",
    label: "Working",
    detail: sanitizeFocus(cs.focus) ?? sanitizeFocus(cs.boss?.currentTask),
  };
}

/** "45s" / "2m" / "1h"; null when `since` is missing, invalid or in the future. */
export function formatElapsed(
  since: string | null | undefined,
  nowMs: number,
): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t) || t > nowMs + 1000) return null;
  const s = Math.floor((nowMs - t) / 1000);
  if (s < 60) return s < 10 ? null : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
