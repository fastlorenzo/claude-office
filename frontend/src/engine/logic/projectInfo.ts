/**
 * Pure: rows of the project info screen beside each team-room door.
 *
 * The LED panel over the door owns project name + session count + aggregate
 * status; this screen owns the per-session detail and never repeats those:
 * session name, plain-language summary, phase + elapsed, context % + tokens,
 * model / effort, cost. Missing telemetry shows "—".
 */
import type {
  CampusSession,
  RoomStatus,
  SessionPhaseKind,
} from "@/engine/contracts";
import {
  formatElapsed,
  looksLikeMarkupOrShell,
  looksLikeUserPrompt,
  sessionPhase,
  sessionSummary,
} from "@/engine/logic/sessionInfo";
import { roomStatus } from "@/engine/logic/status";

export const DASH = "—";

export interface InfoRow {
  sessionId: string;
  name: string;
  summary: string;
  status: RoomStatus;
  phaseKind: SessionPhaseKind;
  /** "Running tests · 2m" */
  phase: string;
  /** 0–100, or null when unknown. */
  ctxPct: number | null;
  /** "190k / 1M" or "—". */
  tokens: string;
  /** "Opus 5.5 · high" or "—". */
  model: string;
  /** "$42.75" or "—". */
  cost: string;
}

export function formatTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

const usdFormats = new Map<string, Intl.NumberFormat>();

/** "$42.75" (locale-aware separators; default en-US). */
export function formatCost(
  usd: number | null | undefined,
  locale = "en-US",
): string {
  if (usd == null || !Number.isFinite(usd)) return DASH;
  let f = usdFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    usdFormats.set(locale, f);
  }
  return f.format(usd);
}

function cleanSummary(s: string | null): string | null {
  if (!s || looksLikeUserPrompt(s) || looksLikeMarkupOrShell(s)) return null;
  return s;
}

export function infoRow(
  cs: CampusSession,
  label: string | undefined,
  nowMs: number,
): InfoRow {
  const t = cs.telemetry ?? null;
  const phase = sessionPhase(cs);
  const elapsed = formatElapsed(phase.since, nowMs);
  const used = formatTokens(t?.contextTokens);
  const win = formatTokens(t?.contextWindow);
  const pct =
    t?.contextUsedPct != null && Number.isFinite(t.contextUsedPct)
      ? Math.max(0, Math.min(100, t.contextUsedPct))
      : null;
  const model = [t?.model?.trim(), t?.effort?.trim()]
    .filter(Boolean)
    .join(" · ");
  return {
    sessionId: cs.sessionId,
    name:
      cs.sessionName?.trim() ||
      label?.trim() ||
      cs.gitBranch?.trim() ||
      cs.sessionId.slice(0, 8),
    summary: cleanSummary(sessionSummary(cs)) ?? DASH,
    status: roomStatus(cs),
    phaseKind: phase.kind,
    phase: elapsed ? `${phase.label} · ${elapsed}` : phase.label,
    ctxPct: pct,
    tokens: used ? (win ? `${used} / ${win}` : used) : DASH,
    model: model || DASH,
    cost: formatCost(t?.costUsd),
  };
}

const STATUS_ORDER: Record<RoomStatus, number> = {
  needs_you: 0,
  working: 1,
  done: 2,
  ended: 3,
};

/** Rows in pod order (stable), needs-you never hidden past the visible cap. */
export function infoRows(
  sessions: readonly CampusSession[],
  labels: ReadonlyMap<string, string>,
  nowMs: number,
  max = 6,
): { rows: InfoRow[]; more: number } {
  const rows = sessions.map((cs) =>
    infoRow(cs, labels.get(cs.sessionId), nowMs),
  );
  if (rows.length <= max) return { rows, more: 0 };
  const keep = [...rows]
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.r.status] - STATUS_ORDER[b.r.status] || a.i - b.i,
    )
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.r);
  return { rows: keep, more: rows.length - max };
}

/** Change key (the screen redraws only when this changes). */
export function infoKey(rows: readonly InfoRow[], more: number): string {
  return JSON.stringify([rows, more]);
}
