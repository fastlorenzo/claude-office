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
import { worldT } from "@/engine/world/worldLocale";
import type { TranslationKey } from "@/i18n";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

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

/** KPI tiles either side of the feeds (left: sessions/cost, right: activity). */
export function lowerTiles(
  m: OpsModel,
  t: Translate = worldT,
): { left: KpiTile[]; right: KpiTile[] } {
  const noFeed = t("ops.c.kpi.noFeed");
  const us = m.usage;
  const act = m.activity;
  const pct = (w: typeof us.fiveHour) => (w ? fmtPct(w.usedPct) : "—");
  return {
    left: [
      {
        label: t("ops.c.kpi.live"),
        value: String(m.counts.live),
        sub: t("ops.c.kpi.subagents", { n: m.counts.subagents }),
      },
      {
        label: t("ops.c.needsYou"),
        value: String(m.counts.needs_you),
        color: m.counts.needs_you ? OPS_THEME.amber : undefined,
      },
      {
        label: t("ops.costToday"),
        value: fmtUsd(us.costTodayUsd),
        sub: us.costTodayUsd == null ? noFeed : undefined,
      },
      {
        label: t("ops.c.kpi.limit5"),
        value: pct(us.fiveHour),
        sub: us.fiveHour ? undefined : noFeed,
      },
    ],
    right: [
      {
        label: t("ops.c.kpi.events"),
        value: act.eventsLastMin != null ? String(act.eventsLastMin) : "—",
      },
      { label: t("ops.toolCalls"), value: fmtCount(act.toolCalls) },
      {
        label: t("ops.c.kpi.testsFailing"),
        value: act.testFailures != null ? String(act.testFailures) : "—",
        color: (act.testFailures ?? 0) > 0 ? OPS_THEME.red : undefined,
      },
      {
        label: t("ops.c.kpi.limit7"),
        value: pct(us.sevenDay),
        sub: us.sevenDay ? undefined : noFeed,
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
