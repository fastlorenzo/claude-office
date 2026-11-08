/**
 * Ops dashboard data layer — ONE pure model shared by the control-room video
 * wall (canvas → DynamicTexture) and the DOM "Ops dashboard" overlay.
 *
 *   buildOpsModel(campus, stats, nowMs, labels?) → OpsModel
 *
 * Sorting (needs-you first), alerts, usage projections and every formatter
 * (tokens "191k", spans "3h24m", currency "$100.20") live here so both views
 * read identically. Every telemetry / activity / stats field is optional on
 * the wire (older backends), so each value degrades to null / [] and the
 * views render "—" or derive a fallback from data that has always existed.
 * No React, no Babylon.
 */

import { MUTED_GREY } from "./statusPalette";
import {
  STATUS_COLORS,
  type CampusSession,
  type CampusStats,
  type RateLimitWindow,
  type RoomStatus,
  type SessionPhaseKind,
} from "../contracts";
import { roomStatus } from "./status";
import {
  formatElapsed,
  sessionPhase,
  sessionRefs,
  sessionSummary,
} from "./sessionInfo";

// ============================================================================
// FORMATTERS
// ============================================================================

const DASH = "—";

let numLocale = "en-US";
const mkNum = (tag: string) =>
  new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
const mkUsd = (tag: string) =>
  new Intl.NumberFormat(tag, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  });
const mkClock = (tag: string) =>
  new Intl.DateTimeFormat(tag, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
let nf1 = mkNum(numLocale);
let usd = mkUsd(numLocale);
let clock = mkClock(numLocale);

/** @public BCP-47 tag for every number/time format below (UI language). */
export function setNumberLocale(tag: string): void {
  if (tag === numLocale) return;
  numLocale = tag;
  nf1 = mkNum(tag);
  usd = mkUsd(tag);
  clock = mkClock(tag);
}

/** One-decimal number in the UI locale ("9.5"; "1" for 1.0). */
const dec1 = (v: number): string => nf1.format(v);

/** Token counts: 950 → "950", 9_500 → "9.5k", 191_000 → "191k", 1_000_000 → "1M". */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 10_000) return `${dec1(v / 1000)}k`;
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  if (v < 10_000_000) return `${dec1(v / 1e6)}M`;
  return `${Math.round(v / 1e6)}M`;
}

/** Compact counts (lines, events): 1777 → "1.8k", 16902 → "16.9k", 120 → "120". */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v < 1000) return `${sign}${Math.round(v)}`;
  if (v < 100_000) return `${sign}${dec1(v / 1000)}k`;
  if (v < 1e6) return `${sign}${Math.round(v / 1000)}k`;
  return `${sign}${dec1(v / 1e6)}M`;
}

/** Durations: 45s · 12m · 3h24m · 3d2h (status-line style, no spaces). */
export function fmtSpan(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/** Currency: "$0.42", "$100.20", "$1.2k". */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  if (Math.abs(n) >= 10_000)
    return `${usd.formatToParts(0).find((x) => x.type === "currency")?.value ?? "$"}${dec1(n / 1000)}k`;
  return usd.format(n);
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${Math.round(n)}%`;
}

/** "14:05" local wall-clock time of an ISO timestamp ("" when invalid). */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return clock.format(new Date(t));
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// ============================================================================
// MODEL TYPES
// ============================================================================

export interface OpsRow {
  sessionId: string;
  status: RoomStatus;
  project: string;
  summary: string | null;
  refs: string[];
  branch: string | null;
  phaseKind: SessionPhaseKind;
  phaseLabel: string;
  phaseDetail: string | null;
  /** "2m" since the phase started (null when unknown / < 10 s). */
  phaseElapsed: string | null;
  /** 0-100, from telemetry, else office.contextUtilization. */
  contextPct: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  model: string | null;
  effort: string | null;
  /** Session wall time in ms (telemetry) . */
  durationMs: number | null;
  /** Prompt-cache minutes left (null when unknown, 0 when cold/expired). */
  cacheMinsLeft: number | null;
  subagents: number;
  todoDone: number;
  todoTotal: number;
  /** Process alive and not ended. */
  alive: boolean;
  /** "12m" since the last event (null when < 1 min or unknown). */
  idleFor: string | null;
  /** Events per minute, last 30 min, oldest first ([] when unknown). */
  spark: number[];
  testFailures: number | null;
  errors: number | null;
  /** True when telemetry (status line) has reported for this session. */
  hasTelemetry: boolean;
}

export type OpsAlertKind =
  "approval" | "tests" | "context" | "cache" | "limit5h" | "limit7d";

export interface OpsAlert {
  id: string;
  kind: OpsAlertKind;
  severity: "high" | "medium";
  sessionId: string | null;
  project: string | null;
  /** Kind-specific value: pct / count / minutes. */
  value: number | null;
  /** Free text detail (permission request, failing test summary). */
  detail: string | null;
}

export interface OpsWindow {
  usedPct: number;
  projectedPct: number | null;
  resetsInMs: number | null;
}

export interface OpsUsage {
  fiveHour: OpsWindow | null;
  sevenDay: OpsWindow | null;
  costTodayUsd: number | null;
  burnUsdPerHour: number | null;
  /** Cost per 5-minute bucket, last 3 h ([] when unknown). */
  costSeries: number[];
  linesAddedToday: number | null;
  linesRemovedToday: number | null;
  /** Sum of live sessions' costs (telemetry). */
  sessionsCostUsd: number | null;
}

export interface OpsToolSlice {
  kind: SessionPhaseKind;
  count: number;
}

export interface OpsActivity {
  /** Building events per minute, oldest first (60 from stats, else 30 summed from sessions). */
  eventsPerMin: number[];
  eventsLastMin: number | null;
  peakPerMin: number;
  toolMix: OpsToolSlice[];
  toolCalls: number | null;
  testRuns: number | null;
  testFailures: number | null;
  errors: number | null;
  subagentsSpawned: number | null;
}

export interface OpsTickerItem {
  key: string;
  timeMs: number;
  clock: string;
  sessionId: string;
  project: string;
  status: RoomStatus;
  actor: string;
  text: string;
}

export interface OpsCounts {
  needs_you: number;
  working: number;
  done: number;
  ended: number;
  live: number;
  subagents: number;
}

export interface OpsModel {
  rows: OpsRow[];
  alerts: OpsAlert[];
  usage: OpsUsage;
  activity: OpsActivity;
  ticker: OpsTickerItem[];
  counts: OpsCounts;
  /** True when the backend sent CampusState.stats. */
  hasStats: boolean;
  nowMs: number;
}

// ============================================================================
// ROWS
// ============================================================================

const RANK: Record<RoomStatus, number> = {
  needs_you: 0,
  working: 1,
  done: 2,
  ended: 3,
};

/** Same set as the backend's `_INACTIVE_AGENT_STATES` (campus.py) — keep in sync. */
const INACTIVE_AGENT = new Set([
  "completed",
  "leaving",
  "reporting_done",
  "in_elevator",
]);

function projectOf(cs: CampusSession, labels?: ReadonlyMap<string, string>) {
  const p = cs.project?.trim();
  return p || labels?.get(cs.sessionId) || cs.sessionId.slice(0, 8);
}

export function buildRow(
  cs: CampusSession,
  nowMs: number,
  labels?: ReadonlyMap<string, string>,
): OpsRow {
  const status = roomStatus(cs);
  const tel = cs.telemetry ?? null;
  const act = cs.activity ?? null;
  const phase = sessionPhase(cs);
  const ctxPct =
    num(tel?.contextUsedPct) ??
    (num(cs.office?.contextUtilization) != null
      ? (cs.office.contextUtilization as number) * 100
      : null);
  const expires = ms(tel?.cacheExpiresAt);
  const cacheMinsLeft =
    tel?.cacheWarm === false
      ? 0
      : expires != null
        ? Math.max(0, Math.floor((expires - nowMs) / 60_000))
        : null;
  const todos = cs.todos ?? [];
  const last = ms(cs.lastEventAt) ?? ms(cs.lastUpdated);
  const idleMs = last != null ? nowMs - last : null;
  const ended = cs.ended || status === "ended";
  return {
    sessionId: cs.sessionId,
    status,
    project: projectOf(cs, labels),
    summary: sessionSummary(cs),
    refs: sessionRefs(cs, 2),
    branch: cs.gitBranch?.trim() || null,
    phaseKind: phase.kind,
    phaseLabel: phase.label,
    phaseDetail: phase.detail ?? null,
    phaseElapsed: ended ? null : formatElapsed(phase.since, nowMs),
    contextPct: ctxPct != null ? clamp(ctxPct, 0, 100) : null,
    contextTokens: num(tel?.contextTokens),
    contextWindow: num(tel?.contextWindow),
    costUsd: num(tel?.costUsd),
    linesAdded: num(tel?.linesAdded),
    linesRemoved: num(tel?.linesRemoved),
    model: tel?.model?.trim() || null,
    effort: tel?.effort?.trim() || null,
    durationMs: num(tel?.durationMs),
    cacheMinsLeft,
    // Running right now: the backend's liveness count (transcript-aware) when
    // present, else the crew list.
    subagents:
      num(cs.activity?.subagentsRunning) ??
      (cs.agents ?? []).filter((a) => !INACTIVE_AGENT.has(a.state)).length,
    todoDone: todos.filter((t) => t.status === "completed").length,
    todoTotal: todos.length,
    alive: !ended && cs.alive !== false,
    idleFor:
      idleMs != null && idleMs >= 60_000 && !ended ? fmtSpan(idleMs) : null,
    spark: Array.isArray(act?.eventsPerMin) ? act.eventsPerMin.slice(-30) : [],
    testFailures: num(act?.testFailures) ?? failingFromDetail(phase.detail),
    errors: num(act?.errors),
    hasTelemetry: tel != null,
  };
}

function failingFromDetail(detail: string | null | undefined): number | null {
  const m = detail ? /(\d+)\s+fail/i.exec(detail) : null;
  return m ? Number(m[1]) : null;
}

/** needs_you → working → done → ended; newest activity first within a rank. */
export function sortRows<T extends { status: RoomStatus; sessionId: string }>(
  rows: readonly T[],
  lastMs: (r: T) => number = () => 0,
): T[] {
  return [...rows].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    const t = lastMs(b) - lastMs(a);
    return t !== 0 ? t : a.sessionId.localeCompare(b.sessionId);
  });
}

// ============================================================================
// USAGE
// ============================================================================

const FIVE_H = 5 * 3600_000;
const SEVEN_D = 7 * 24 * 3600_000;
const MIN_PACE_ELAPSED = 0.02;
/** A projection is only alert-worthy once a tenth of the window has elapsed. */
const ALERT_MIN_ELAPSED = 0.1;

function paceTrusted(w: OpsWindow, windowMs: number): boolean {
  return (
    w.resetsInMs != null && 1 - w.resetsInMs / windowMs >= ALERT_MIN_ELAPSED
  );
}

/**
 * Backend projection when present, else the status line's pace: used divided
 * by the share of the window already elapsed (none in the first 2 %).
 */
export function projectWindow(
  w: RateLimitWindow | null | undefined,
  windowMs: number,
  nowMs: number,
): OpsWindow | null {
  if (!w || num(w.usedPct) == null) return null;
  const used = clamp(w.usedPct, 0, 1000);
  const reset = ms(w.resetsAt);
  const resetsInMs = reset != null ? Math.max(0, reset - nowMs) : null;
  let projected = num(w.projectedPct);
  if (projected == null && resetsInMs != null) {
    const elapsed = windowMs - resetsInMs;
    if (elapsed >= windowMs * MIN_PACE_ELAPSED)
      projected = (used * windowMs) / elapsed;
  }
  return {
    usedPct: used,
    projectedPct: projected != null ? Math.max(used, projected) : null,
    resetsInMs,
  };
}

function sum(list: Array<number | null>): number | null {
  let s = 0;
  let any = false;
  for (const v of list)
    if (v != null) {
      s += v;
      any = true;
    }
  return any ? s : null;
}

function buildUsage(
  stats: CampusStats | null,
  rows: OpsRow[],
  nowMs: number,
): OpsUsage {
  const sessionsCost = sum(rows.map((r) => r.costUsd));
  return {
    fiveHour: projectWindow(stats?.fiveHour, FIVE_H, nowMs),
    sevenDay: projectWindow(stats?.sevenDay, SEVEN_D, nowMs),
    costTodayUsd: num(stats?.costTodayUsd) ?? sessionsCost,
    burnUsdPerHour: num(stats?.burnUsdPerHour),
    costSeries: Array.isArray(stats?.costSeries) ? stats.costSeries : [],
    linesAddedToday:
      num(stats?.linesAddedToday) ?? sum(rows.map((r) => r.linesAdded)),
    linesRemovedToday:
      num(stats?.linesRemovedToday) ?? sum(rows.map((r) => r.linesRemoved)),
    sessionsCostUsd: sessionsCost,
  };
}

// ============================================================================
// ACTIVITY
// ============================================================================

/** Element-wise sum of right-aligned series (oldest first). */
export function sumSeries(series: number[][], len: number): number[] {
  const out = new Array<number>(len).fill(0);
  for (const s of series) {
    const off = len - s.length;
    for (let i = Math.max(0, -off); i < s.length; i++) {
      const v = s[i];
      if (Number.isFinite(v)) out[i + off] += v;
    }
  }
  return out;
}

function buildActivity(
  stats: CampusStats | null,
  campus: CampusSession[],
): OpsActivity {
  const acts = campus
    .map((c) => c.activity)
    .filter((a): a is NonNullable<CampusSession["activity"]> => !!a);
  let epm: number[] = [];
  if (Array.isArray(stats?.eventsPerMin) && stats.eventsPerMin.length)
    epm = stats.eventsPerMin.slice(-60);
  else {
    const series = acts
      .map((a) => a.eventsPerMin)
      .filter((s): s is number[] => Array.isArray(s) && s.length > 0);
    if (series.length) epm = sumSeries(series, 30);
  }
  const mix = new Map<SessionPhaseKind, number>();
  for (const a of acts)
    for (const [k, v] of Object.entries(a.toolMix ?? {}))
      if (typeof v === "number" && v > 0)
        mix.set(
          k as SessionPhaseKind,
          (mix.get(k as SessionPhaseKind) ?? 0) + v,
        );
  const toolMix = [...mix.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const pick = (f: (a: (typeof acts)[number]) => number | undefined) =>
    acts.length ? sum(acts.map((a) => num(f(a)))) : null;
  return {
    eventsPerMin: epm,
    eventsLastMin: epm.length ? epm[epm.length - 1] : null,
    peakPerMin: epm.reduce((m, v) => Math.max(m, v), 0),
    toolMix,
    toolCalls: pick((a) => a.toolCalls),
    testRuns: pick((a) => a.testRuns),
    testFailures: pick((a) => a.testFailures),
    errors: pick((a) => a.errors),
    subagentsSpawned: pick((a) => a.subagentsSpawned),
  };
}

// ============================================================================
// ALERTS
// ============================================================================

export const ALERT_CONTEXT_PCT = 80;
export const ALERT_CACHE_MINS = 5;

export function buildAlerts(
  rows: OpsRow[],
  usage: OpsUsage,
  campus: CampusSession[],
): OpsAlert[] {
  const out: OpsAlert[] = [];
  const byId = new Map(campus.map((c) => [c.sessionId, c]));
  for (const r of rows) {
    if (r.status === "ended") continue;
    if (r.status === "needs_you" || r.phaseKind === "needs_approval") {
      const cs = byId.get(r.sessionId);
      out.push({
        id: `approval:${r.sessionId}`,
        kind: "approval",
        severity: "high",
        sessionId: r.sessionId,
        project: r.project,
        value: null,
        detail:
          r.phaseKind === "needs_approval"
            ? r.phaseDetail
            : (cs?.boss?.bubble?.text ?? null),
      });
    }
    if (r.testFailures != null && r.testFailures > 0)
      out.push({
        id: `tests:${r.sessionId}`,
        kind: "tests",
        severity: "medium",
        sessionId: r.sessionId,
        project: r.project,
        value: r.testFailures,
        detail: r.phaseKind === "testing" ? r.phaseDetail : null,
      });
    if (r.contextPct != null && r.contextPct >= ALERT_CONTEXT_PCT)
      out.push({
        id: `context:${r.sessionId}`,
        kind: "context",
        severity: r.contextPct >= 90 ? "high" : "medium",
        sessionId: r.sessionId,
        project: r.project,
        value: Math.round(r.contextPct),
        detail: null,
      });
    if (
      r.cacheMinsLeft != null &&
      r.cacheMinsLeft > 0 &&
      r.cacheMinsLeft <= ALERT_CACHE_MINS &&
      r.alive
    )
      out.push({
        id: `cache:${r.sessionId}`,
        kind: "cache",
        severity: "medium",
        sessionId: r.sessionId,
        project: r.project,
        value: r.cacheMinsLeft,
        detail: null,
      });
  }
  const five = usage.fiveHour;
  if (
    five &&
    ((paceTrusted(five, FIVE_H) && (five.projectedPct ?? 0) > 100) ||
      five.usedPct >= 90)
  )
    out.push({
      id: "limit5h",
      kind: "limit5h",
      severity: "high",
      sessionId: null,
      project: null,
      value: Math.round(
        Math.max(
          paceTrusted(five, FIVE_H) ? (five.projectedPct ?? 0) : 0,
          five.usedPct,
        ),
      ),
      detail: null,
    });
  const seven = usage.sevenDay;
  if (
    seven &&
    ((paceTrusted(seven, SEVEN_D) && (seven.projectedPct ?? 0) > 100) ||
      seven.usedPct >= 90)
  )
    out.push({
      id: "limit7d",
      kind: "limit7d",
      severity: "medium",
      sessionId: null,
      project: null,
      value: Math.round(
        Math.max(
          paceTrusted(seven, SEVEN_D) ? (seven.projectedPct ?? 0) : 0,
          seven.usedPct,
        ),
      ),
      detail: null,
    });
  return out.sort(
    (a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1),
  );
}

/** English one-liner for an alert (canvas wall; the DOM overlay translates). */
export function alertText(a: OpsAlert): string {
  const who = a.project ? `${a.project}: ` : "";
  switch (a.kind) {
    case "approval":
      return `${who}waiting for your approval${a.detail ? ` · ${a.detail}` : ""}`;
    case "tests":
      return `${who}${a.value} failing test${a.value === 1 ? "" : "s"}`;
    case "context":
      return `${who}context ${a.value}% full`;
    case "cache":
      return `${who}prompt cache expires in ${a.value}m`;
    case "limit5h":
      return `5-hour limit on pace for ${a.value}%`;
    case "limit7d":
      return `7-day limit on pace for ${a.value}%`;
  }
}

// ============================================================================
// TICKER
// ============================================================================

function actorOf(cs: CampusSession, agentId: string): string {
  if (agentId === "main" || agentId === "boss") return "boss";
  const a = (cs.agents ?? []).find((x) => x.id === agentId);
  if (a?.number != null) return `agent ${a.number}`;
  return a?.name?.toLowerCase() ?? "agent";
}

export function buildTicker(
  campus: CampusSession[],
  labels: ReadonlyMap<string, string> | undefined,
  max = 40,
): OpsTickerItem[] {
  const out: OpsTickerItem[] = [];
  for (const cs of campus) {
    const project = projectOf(cs, labels);
    const status = roomStatus(cs);
    (cs.recentActivity ?? []).forEach((a, i) => {
      const t = ms(a.timestamp);
      if (t == null || !a.summary) return;
      out.push({
        key: `${cs.sessionId}:${a.timestamp}:${i}`,
        timeMs: t,
        clock: fmtClock(a.timestamp),
        sessionId: cs.sessionId,
        project,
        status,
        actor: actorOf(cs, a.agentId),
        text: a.summary.replace(/\s+/g, " ").trim(),
      });
    });
  }
  return out
    .sort((a, b) => b.timeMs - a.timeMs || a.key.localeCompare(b.key))
    .slice(0, max);
}

// ============================================================================
// MODEL
// ============================================================================

export function buildOpsModel(
  campus: readonly CampusSession[],
  stats: CampusStats | null | undefined,
  nowMs: number,
  labels?: ReadonlyMap<string, string>,
): OpsModel {
  const list = [...campus];
  const lastMs = new Map(
    list.map((c) => [c.sessionId, ms(c.lastEventAt) ?? ms(c.lastUpdated) ?? 0]),
  );
  const rows = sortRows(
    list.map((c) => buildRow(c, nowMs, labels)),
    (r) => lastMs.get(r.sessionId) ?? 0,
  );
  const st = stats ?? null;
  const usage = buildUsage(st, rows, nowMs);
  const counts: OpsCounts = {
    needs_you: 0,
    working: 0,
    done: 0,
    ended: 0,
    live: 0,
    subagents: 0,
  };
  for (const r of rows) {
    counts[r.status] += 1;
    if (r.status !== "ended") {
      counts.live += 1;
      // Ended sessions do not count (the backend total skips them too).
      counts.subagents += r.subagents;
    }
  }
  if (st && num(st.activeSubagents) != null)
    counts.subagents = st.activeSubagents;
  return {
    rows,
    alerts: buildAlerts(rows, usage, list),
    usage,
    activity: buildActivity(st, list),
    ticker: buildTicker(list, labels),
    counts,
    hasStats: st != null,
    nowMs,
  };
}

// ============================================================================
// VIEW HELPERS (shared colour logic)
// ============================================================================

/** Context bar colour: calm → amber at 70 % → red at 90 %. */
export function contextTone(pct: number | null): "ok" | "warn" | "bad" {
  if (pct == null || pct < 70) return "ok";
  return pct < 90 ? "warn" : "bad";
}

/** Rate-limit gauge colour from the projected (or used) share. */
export function limitTone(w: OpsWindow | null): "ok" | "warn" | "bad" {
  if (!w) return "ok";
  const p = Math.max(w.usedPct, w.projectedPct ?? 0);
  if (p > 100 || w.usedPct >= 90) return "bad";
  return p >= 80 ? "warn" : "ok";
}

/** Coarse tool-mix palette (by phase kind). */
export const KIND_COLORS: Partial<Record<SessionPhaseKind, string>> = {
  coding: "#60A5FA",
  exploring: "#A78BFA",
  testing: "#34D399",
  building: "#F472B6",
  running: "#94A3B8",
  git: "#FB923C",
  researching: "#22D3EE",
  delegating: "#FBBF24",
  planning: "#C084FC",
  compacting: MUTED_GREY,
};

export function kindColor(k: SessionPhaseKind): string {
  return KIND_COLORS[k] ?? MUTED_GREY;
}

const PHASE_TONE: Partial<Record<SessionPhaseKind, string>> = {
  needs_approval: STATUS_COLORS.needs_you,
  waiting_user: STATUS_COLORS.done,
  idle: MUTED_GREY,
  ended: STATUS_COLORS.ended,
};

/** Phase dot colour: attention states by status colour, work by tool kind. */
export function phaseColor(k: SessionPhaseKind): string {
  return PHASE_TONE[k] ?? kindColor(k);
}

/** Stable short content key (redraw only when what is shown changes). */
export function opsKey(v: unknown): string {
  return JSON.stringify(v);
}
