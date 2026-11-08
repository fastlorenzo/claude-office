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

/** CI colours: pass green, fail red, running blue, queued amber, cancelled slate. */
export const CI_COLORS: Readonly<Record<CheckState, string>> = {
  success: CHECK_COLORS.done,
  failure: CHECK_COLORS.failure,
  running: CHECK_COLORS.working,
  // Still amber like the 3D beacons; flipping it to grey needs the beacon
  // tests (factoryAnim / factoryPools) updated together (deferred, WS4/WS9).
  queued: CHECK_COLORS.needs_you,
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
