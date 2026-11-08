/**
 * The one status palette. Session state (needs you / working / done / ended)
 * and CI state (pass / fail / running / queued / cancelled) are separate on
 * purpose: green means "done" for a session and "passed" for CI, but amber
 * (needs you) should not double as "queued" (see CI_COLORS).
 */
import {
  CHECK_COLORS,
  STATUS_COLORS,
  type CheckState,
  type RoomStatus,
} from "@/engine/contracts";

/** Session colours (RoomSign, DoorSign, HUD dots, minimap). */
export const SESSION_COLORS: Readonly<Record<RoomStatus, string>> =
  STATUS_COLORS;

/** Queued CI: neutral grey (amber is reserved for "needs you"). */
export const NEUTRAL_GREY = "#94a3b8";
export const QUEUED_GREY = NEUTRAL_GREY;

/** CI colours: pass green, fail red, running blue, queued grey, cancelled slate. */
export const CI_COLORS: Readonly<Record<CheckState, string>> = {
  success: CHECK_COLORS.done,
  failure: CHECK_COLORS.failure,
  running: CHECK_COLORS.working,
  queued: QUEUED_GREY,
  cancelled: CHECK_COLORS.ended,
  none: CHECK_COLORS.ended,
};

/** Text mark that backs the colour (not colour alone): pass ✓, fail ✗, running ◌, queued ○. */
export const CI_MARKS: Readonly<Record<CheckState, string>> = {
  success: "✓",
  failure: "✗",
  running: "◌",
  queued: "○",
  cancelled: "–",
  none: "·",
};

/** Muted foreground used for "ended" / secondary text on signs. */
export const MUTED_GREY = "#64748B";

/** Gauge / health tone colours (rate limits, ops health). */
export const TONE_COLORS = {
  ok: "#38BDF8",
  warn: SESSION_COLORS.needs_you,
  bad: CHECK_COLORS.failure,
} as const;

/** Dim "no data" fill for inactive plan elements. */
export const INACTIVE_SLATE = SESSION_COLORS.ended;

/** Merged PR purple. */
export const MERGED_COLOR = CHECK_COLORS.merged;
