"use client";

import { memo, useMemo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n/en";
import {
  stationView,
  type StationRun,
  type StationView,
} from "./factoryPanelModel";
import {
  Chip,
  CiLegend,
  Empty,
  RunLink,
  Section,
  Stat,
  StateChip,
  StateDot,
} from "./parts";
import type { InteractionTarget } from "@/engine/contracts";
import { useFactoryData } from "./useFactoryData";
import { SESSION_COLORS } from "@/engine/logic/statusPalette";

function RunRow({ r }: { r: StationRun }): ReactNode {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 text-xs text-slate-200">
      <span className="w-12 shrink-0 font-mono text-xs text-slate-500">
        {r.lane !== null ? t("factory.lane", { n: r.lane }) : "—"}
      </span>
      <StateDot color={r.color} />
      <span className="shrink-0 font-mono text-slate-400">#{r.prNumber}</span>
      <span className="min-w-0 flex-1 truncate">{r.title}</span>
      {r.attempt && (
        <span className="text-xs text-amber-400">
          {t("factory.attempt", { n: r.attempt })}
        </span>
      )}
      <span className="w-14 text-right tabular-nums text-slate-400">
        {r.duration}
      </span>
      <RunLink url={r.url} />
    </li>
  );
}

export const StationPanelView = memo(function StationPanelView({
  v,
}: {
  v: StationView;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: v.color,
              boxShadow: `0 0 10px ${v.color}`,
            }}
          />
          <h3 className="min-w-0 flex-1 truncate font-mono text-base font-semibold text-white">
            {v.name}
          </h3>
          <StateChip state={v.state} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat
            label={t("factory.station.kind")}
            value={t(`factory.kind.${v.kind}` as TranslationKey)}
          />
          <Stat label={t("factory.station.occupants")} value={v.occupants} />
          <Stat label={t("factory.station.attempts")} value={v.maxAttempt} />
        </div>
        {v.flaky && (
          <div className="mt-3">
            <Chip color={SESSION_COLORS.needs_you}>
              <TriangleAlert className="mr-0.5 inline h-3 w-3" />
              {t("factory.station.flaky")}
            </Chip>
          </div>
        )}
        {v.grouped.length > 0 && (
          <p className="mt-3 break-words font-mono text-xs text-slate-400">
            {t("factory.station.grouped")}: {v.grouped.join(", ")}
          </p>
        )}
      </div>
      <Section title={`${t("factory.station.runs")} (${v.runs.length})`}>
        {v.runs.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("factory.station.noRuns")}
          </p>
        ) : (
          <ul className="space-y-1">
            {v.runs.map((r) => (
              <RunRow key={`${r.prNumber}:${r.runName}`} r={r} />
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("factory.legend")}>
        <CiLegend />
      </Section>
      <Section title={t("factory.station.failures")}>
        {v.failures.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("factory.station.noFailures")}
          </p>
        ) : (
          <ul className="space-y-1">
            {v.failures.map((r) => (
              <RunRow key={`f${r.prNumber}:${r.runName}`} r={r} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
});

export function StationPanel({
  target: explicit,
}: {
  target?: InteractionTarget | null;
}): ReactNode {
  const { t } = useTranslation();
  const { target, data } = useFactoryData(explicit);
  const view = useMemo(
    () =>
      target && data
        ? stationView(data.project, data.line, target.checkName)
        : null,
    [target, data],
  );
  if (!view) return <Empty>{t("factory.none")}</Empty>;
  return <StationPanelView v={view} />;
}
