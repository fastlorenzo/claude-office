/**
 * Room door signage data: what the LED panel over each door says.
 *
 *   PROJECT · STATUS IN WORDS  [session tag]
 *   summary · REFS · phase · detail · elapsed   (ticker)
 *
 * Fallbacks: project → session label; summary must be ≥ 2 real words and
 * never a raw prompt / markup (else it is omitted and the ticker shows the
 * phase only). Colours: amber needs you, blue working, green idle, grey
 * ended; refs in teal.
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
  sessionRefs,
  sessionSummary,
} from "@/engine/logic/sessionInfo";
import type { LedContent } from "@/engine/world/LedPanel";

export const PHASE_COLORS: Record<SessionPhaseKind, string> = {
  needs_approval: "#F59E0B",
  waiting_user: "#F5B547",
  planning: "#60A5FA",
  researching: "#38BDF8",
  exploring: "#7DD3FC",
  coding: "#22C55E",
  testing: "#A78BFA",
  building: "#818CF8",
  running: "#3B82F6",
  git: "#F472B6",
  delegating: "#2DD4BF",
  compacting: "#94A3B8",
  idle: "#94A3B8",
  ended: "#64748B",
};

export interface RoomSignData {
  room: number;
  project: string | null;
  title: string;
  ref: string | null;
  phaseKind: SessionPhaseKind;
  phase: string;
  status: RoomStatus;
  selected?: boolean;
  /** Clean plain-language summary (never a raw prompt), or null. */
  summary?: string | null;
  refs?: string[];
  phaseDetail?: string | null;
  /** "2m" since the phase started. */
  elapsed?: string | null;
  /** Session name when it differs from the project (secondary tag). */
  tag?: string | null;
}

/** A summary is only useful with at least two real words ("and" is not one). */
function usableSummary(s: string | null): string | null {
  if (!s || looksLikeUserPrompt(s) || looksLikeMarkupOrShell(s)) return null;
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 2 ? s : null;
}

/** Pure: campus session → sign strings (with the documented fallbacks). */
export function roomSignData(
  cs: CampusSession | null,
  label: string,
  room: number,
  status: RoomStatus,
  selected = false,
): RoomSignData {
  if (!cs)
    return {
      room,
      project: label,
      title: label,
      ref: null,
      phaseKind: "idle",
      phase: "Idle",
      status,
      selected,
    };
  const phase = sessionPhase(cs);
  const project = cs.project?.trim() || label;
  const summary = usableSummary(sessionSummary(cs));
  const refs = sessionRefs(cs, 3);
  const detail = phase.detail?.trim() || null;
  return {
    room,
    project,
    title: summary ?? label,
    ref: refs[0] ?? null,
    phaseKind: phase.kind,
    phase: phase.label,
    status,
    selected,
    summary,
    refs,
    phaseDetail:
      detail && !looksLikeUserPrompt(detail) && !looksLikeMarkupOrShell(detail)
        ? detail
        : null,
    elapsed: formatElapsed(phase.since, Date.now()),
    tag: label && label.toLowerCase() !== project.toLowerCase() ? label : null,
  };
}

/** Status in words (the LED panel states it; colour only reinforces). */
export function statusWords(d: RoomSignData): { text: string; color: string } {
  switch (d.status) {
    case "needs_you":
      return {
        text:
          d.phaseKind === "waiting_user"
            ? "WAITING FOR YOUR REPLY"
            : "WAITING FOR YOU",
        color: "#F5A524",
      };
    case "working": {
      const p = d.phase.toUpperCase();
      return {
        text: p && p !== "WORKING" ? `WORKING — ${p}` : "WORKING",
        color: "#5B9DFF",
      };
    }
    case "done":
      return { text: "IDLE", color: "#34D399" };
    default:
      return { text: "ENDED", color: "#7C7A76" };
  }
}

/** Dim a hex colour (phase / detail at lower intensity). */
function dim(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) =>
    Math.round(v * k)
      .toString(16)
      .padStart(2, "0");
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

const REF_CYAN = "#2DD4BF";

/**
 * LED panel content for a room door: PROJECT (white) · STATUS (status colour)
 * + session tag; ticker = summary, refs (cyan), phase · detail · elapsed
 * (status colour, dimmer). No summary → phase only. Never raw prompts.
 */
export function ledContent(d: RoomSignData): LedContent {
  const st = statusWords(d);
  const line = [
    { text: (d.project ?? "").toUpperCase(), color: "#FFFFFF" },
    { text: "  ·  ", color: "#6E6A64" },
    { text: st.text, color: st.color },
  ];
  if (d.tag) line.push({ text: `   ${d.tag}`, color: "#8A867F" });
  const sep = { text: "   ·   ", color: "#5C5850" };
  const ticker: { text: string; color: string }[] = [];
  if (d.summary) ticker.push({ text: d.summary, color: "#F2ECE2" });
  for (const r of d.refs ?? []) {
    if (ticker.length) ticker.push(sep);
    ticker.push({ text: r, color: REF_CYAN });
  }
  const phaseBits = [d.phase, d.phaseDetail, d.elapsed]
    .filter(Boolean)
    .join(" · ");
  if (phaseBits) {
    if (ticker.length) ticker.push(sep);
    ticker.push({ text: phaseBits, color: dim(st.color, 0.75) });
  }
  return { dot: st.color, line, ticker: ticker.length ? ticker : null };
}
