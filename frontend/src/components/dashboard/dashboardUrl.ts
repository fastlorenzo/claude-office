/**
 * URL contract of the /dashboard page:
 * `?tab=ops|sessions|console|factory&session=&project=&pr=&call=&agent=&tool=&err=1&q=`
 * Pure so it can be unit-tested; `token` is carried through every link.
 */

export const DASHBOARD_TABS = [
  "ops",
  "sessions",
  "console",
  "factory",
] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export interface DashboardState {
  tab: DashboardTab;
  session?: string;
  project?: string;
  pr?: string;
  call?: string;
  agent?: string;
  tool?: string;
  err?: boolean;
  q?: string;
}

const STRING_KEYS = [
  "session",
  "project",
  "pr",
  "call",
  "agent",
  "tool",
  "q",
] as const;

export function isDashboardTab(
  v: string | null | undefined,
): v is DashboardTab {
  return !!v && (DASHBOARD_TABS as readonly string[]).includes(v);
}

export function parseDashboardUrl(search: string): DashboardState & {
  token?: string;
} {
  const p = new URLSearchParams(search);
  const tab = p.get("tab");
  const out: DashboardState & { token?: string } = {
    tab: isDashboardTab(tab) ? tab : "ops",
  };
  for (const k of STRING_KEYS) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  if (p.get("err") === "1") out.err = true;
  const token = p.get("token");
  if (token) out.token = token;
  return out;
}

/** Search string (with leading `?`) for a state; `token` is appended when given. */
export function buildDashboardSearch(
  state: DashboardState,
  token?: string | null,
): string {
  const p = new URLSearchParams();
  p.set("tab", state.tab);
  for (const k of STRING_KEYS) {
    const v = state[k];
    if (v) p.set(k, v);
  }
  if (state.err) p.set("err", "1");
  if (token) p.set("token", token);
  return `?${p.toString()}`;
}

export function dashboardHref(
  state: DashboardState,
  token?: string | null,
): string {
  return `/dashboard${buildDashboardSearch(state, token)}`;
}

/** Link to the 3D renderer with the session preselected (`/?session=`). */
export function threeDHref(
  sessionId?: string | null,
  token?: string | null,
): string {
  const p = new URLSearchParams();
  if (sessionId) p.set("session", sessionId);
  if (token) p.set("token", token);
  const qs = p.toString();
  return qs ? `/?${qs}` : "/";
}
