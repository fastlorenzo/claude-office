/**
 * Room door signage: phase colours and the project-room LED line
 * (PROJECT · N SESSIONS · STATUS IN WORDS). Colours: amber needs you,
 * blue working, green idle, grey ended.
 */
import type { RoomStatus, SessionPhaseKind } from "@/engine/contracts";
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

/**
 * Project room door LED (one line, no ticker): PROJECT · N SESSIONS · STATUS.
 * Status in words: "1 NEEDS YOU" (amber) when any session needs the user,
 * else "WORKING" (blue) when any works, "IDLE" (green), "ENDED" (grey).
 * Session details live on the info screen beside the door, never here.
 */
export function projectLedContent(
  name: string,
  statuses: readonly RoomStatus[],
): LedContent {
  const needs = statuses.filter((s) => s === "needs_you").length;
  const working = statuses.some((s) => s === "working");
  const live = statuses.filter((s) => s !== "ended").length;
  const st =
    needs > 0
      ? { text: `${needs} NEEDS YOU`, color: "#F5A524" }
      : working
        ? { text: "WORKING", color: "#5B9DFF" }
        : live > 0
          ? { text: "IDLE", color: "#34D399" }
          : { text: "ENDED", color: "#7C7A76" };
  const n = statuses.length;
  const sep = { text: "  ·  ", color: "#6E6A64" };
  return {
    dot: st.color,
    line: [
      { text: name.toUpperCase(), color: "#FFFFFF" },
      sep,
      { text: `${n} SESSION${n === 1 ? "" : "S"}`, color: "#B8B2A8" },
      sep,
      { text: st.text, color: st.color },
    ],
    ticker: null,
  };
}
