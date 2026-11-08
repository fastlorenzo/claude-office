/**
 * Pure content of the control-room lower wall tier (no Babylon): the KPI tiles
 * and the change key that decides when the two ≤ 4096 px lower canvases are
 * redrawn and re-uploaded (with mip regeneration). Everything in the key is
 * minute-granular or event-driven — never a seconds clock or an elapsed time —
 * so an idle wall uploads nothing between clock minutes.
 */
import type { RoomStatus } from "@/engine/contracts";
import {
  fmtClock,
  fmtCount,
  fmtPct,
  fmtUsd,
  opsKey,
  type OpsModel,
} from "@/engine/logic/opsModel";
import { OPS_THEME } from "@/engine/screens/opsCanvas";

export interface KpiTile {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}

/** Caption state of one lower-tier camera feed. */
export interface FeedCaptionKey {
  side: string;
  index: number;
  label: string;
  status: RoomStatus;
  phase: string | null;
}

const NO_FEED = "status line off";

/** KPI tiles either side of the feeds (left: sessions/cost, right: activity). */
export function lowerTiles(m: OpsModel): { left: KpiTile[]; right: KpiTile[] } {
  const us = m.usage;
  const act = m.activity;
  const pct = (w: typeof us.fiveHour) => (w ? fmtPct(w.usedPct) : "—");
  return {
    left: [
      {
        label: "Live sessions",
        value: String(m.counts.live),
        sub: `${m.counts.subagents} subagents`,
      },
      {
        label: "Needs you",
        value: String(m.counts.needs_you),
        color: m.counts.needs_you ? OPS_THEME.amber : undefined,
      },
      {
        label: "Cost today",
        value: fmtUsd(us.costTodayUsd),
        sub: us.costTodayUsd == null ? NO_FEED : undefined,
      },
      {
        label: "5-hour limit",
        value: pct(us.fiveHour),
        sub: us.fiveHour ? undefined : NO_FEED,
      },
    ],
    right: [
      {
        label: "Events / min",
        value: act.eventsLastMin != null ? String(act.eventsLastMin) : "—",
      },
      { label: "Tool calls", value: fmtCount(act.toolCalls) },
      {
        label: "Tests failing",
        value: act.testFailures != null ? String(act.testFailures) : "—",
        color: (act.testFailures ?? 0) > 0 ? OPS_THEME.red : undefined,
      },
      {
        label: "7-day limit",
        value: pct(us.sevenDay),
        sub: us.sevenDay ? undefined : NO_FEED,
      },
    ],
  };
}

/** Wall clock as drawn on the alert strip (HH:MM — the key ticks once a minute). */
export function wallClock(nowMs: number): string {
  return fmtClock(new Date(nowMs).toISOString());
}

/** Change key of the lower tier: redraw + upload only when this changes. */
export function lowerWallKey(
  m: OpsModel,
  clock: string,
  feeds: readonly FeedCaptionKey[],
  tiles: { left: KpiTile[]; right: KpiTile[] } = lowerTiles(m),
): string {
  return opsKey([
    m.alerts,
    clock,
    m.ticker.slice(0, 6).map((t) => t.key),
    feeds.map((f) => [f.side, f.index, f.label, f.status, f.phase]),
    tiles.left,
    tiles.right,
  ]);
}
