"use client";

import type { ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useWorldUiStore } from "@/stores/worldUiStore";

export function StatsReadout(): ReactNode {
  const { t } = useTranslation();
  const stats = useWorldUiStore((s) => s.stats);
  if (!stats)
    return (
      <p className="px-4 py-2 text-xs text-slate-500">{t("gfx.stats.none")}</p>
    );
  const cells: [string, string][] = [
    [t("gfx.stats.fps"), String(Math.round(stats.fps))],
    [t("gfx.stats.frame"), `${stats.frameMs.toFixed(1)} ms`],
    [t("gfx.stats.draws"), String(stats.drawCalls)],
    [t("gfx.stats.tier"), String(stats.tier)],
  ];
  return (
    <dl
      aria-live="off"
      className="grid grid-cols-4 gap-px bg-white/5 text-center"
    >
      {cells.map(([k, v]) => (
        <div key={k} className="bg-slate-950/60 px-2 py-1.5">
          <dt className="text-xs uppercase tracking-[0.14em] text-slate-500">
            {k}
          </dt>
          <dd className="text-sm font-semibold tabular-nums text-slate-100">
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
