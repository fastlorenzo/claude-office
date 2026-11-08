"use client";

import { memo, useMemo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n/en";
import { lineView, type LineView, type PipelineRow } from "./factoryPanelModel";
import { AgoText, Chip, Empty, Section, Stat, StateDot } from "./parts";
import type { InteractionTarget } from "@/engine/contracts";
import { useFactoryData } from "./useFactoryData";
import {
  CI_COLORS,
  MERGED_COLOR,
  MUTED_GREY,
  NEUTRAL_GREY,
  SESSION_COLORS,
} from "@/engine/logic/statusPalette";

export function PipelineList({ rows }: { rows: PipelineRow[] }): ReactNode {
  return (
    <ul className="space-y-1">
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex items-center gap-2 text-xs text-slate-200"
        >
          <StateDot color={p.color} />
          <span className="min-w-0 flex-1 truncate font-mono">
            {p.workflow}
          </span>
          <span className="text-xs text-slate-500">
            <AgoText ago={p.ago} />
          </span>
          <span className="w-14 text-right tabular-nums text-slate-400">
            {p.duration}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const LinePanelView = memo(function LinePanelView({
  v,
}: {
  v: LineView;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: v.healthColor,
              boxShadow: `0 0 10px ${v.healthColor}`,
            }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-white">
              {v.name}
            </h3>
            {v.repo && (
              <div className="truncate font-mono text-xs text-slate-500">
                {v.repo}
              </div>
            )}
          </div>
          <Chip color={NEUTRAL_GREY}>
            {t(`factory.line.mode.${v.mode}` as TranslationKey)}
          </Chip>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat
            label={t("factory.line.lanes")}
            value={`${v.lanesInUse} / ${v.lanes}`}
          />
          <Stat label={t("factory.line.queue")} value={v.queued} />
          <Stat
            label={t("factory.line.main")}
            value={t(`factory.state.${v.health}` as TranslationKey)}
            color={v.healthColor}
          />
          <Stat label={t("factory.line.throughput")} value={v.merged24h} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip color={MUTED_GREY}>
            {t("factory.line.open")} {v.open}
          </Chip>
          <Chip color={SESSION_COLORS.working}>
            {t("factory.line.running")} {v.running}
          </Chip>
          <Chip color={CI_COLORS.failure}>
            {t("factory.line.failing")} {v.failing}
          </Chip>
          {v.demo && (
            <span title={t("factory.line.demoHint")}>
              <Chip color={MERGED_COLOR}>{t("factory.line.demo")}</Chip>
            </span>
          )}
          {v.stale && (
            <Chip color={SESSION_COLORS.needs_you}>
              {t("factory.line.stale")}
            </Chip>
          )}
          {v.fetched && (
            <Chip color={MUTED_GREY}>
              {t("factory.line.fetched")} <AgoText ago={v.fetched} />
            </Chip>
          )}
        </div>
        {v.ciError && (
          <p
            className="mt-2 break-words rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 font-mono text-xs text-amber-300"
            title={v.ciError}
          >
            {t("factory.line.ciError")}: {v.ciError}
          </p>
        )}
      </div>
      <Section title={`${t("factory.line.prs")} (${v.prs.length})`}>
        {v.prs.length === 0 ? (
          <p className="text-sm text-slate-500">{t("factory.line.noPrs")}</p>
        ) : (
          <ul className="space-y-1">
            {v.prs.map((p) => (
              <li
                key={p.number}
                className="flex items-center gap-2 text-xs text-slate-200"
              >
                <span className="w-14 shrink-0 font-mono text-xs text-slate-500">
                  {p.lane !== null
                    ? t("factory.lane", { n: p.lane })
                    : p.queue !== null
                      ? `Q${p.queue}`
                      : "—"}
                </span>
                <StateDot color={p.color} />
                <span className="shrink-0 font-mono text-slate-400">
                  #{p.number}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                {p.stamp && (
                  <span className="shrink-0 text-xs uppercase text-slate-500">
                    {p.stamp}
                  </span>
                )}
                {p.url && /^https?:\/\//i.test(p.url) && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("factory.line.openPr", { n: p.number })}
                    title={t("factory.line.openPr", { n: p.number })}
                    className="pointer-events-auto shrink-0 text-slate-500 transition-colors hover:text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("factory.line.pipelines")}>
        {v.pipelines.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("factory.line.noPipelines")}
          </p>
        ) : (
          <PipelineList rows={v.pipelines} />
        )}
      </Section>
    </div>
  );
});

export function LinePanel({
  target: explicit,
}: {
  target?: InteractionTarget | null;
}): ReactNode {
  const { t } = useTranslation();
  const { data } = useFactoryData(explicit);
  const view = useMemo(
    () =>
      data ? lineView(data.project, data.line, data.now, data.demo) : null,
    [data],
  );
  if (!view) return <Empty>{t("factory.none")}</Empty>;
  return <LinePanelView v={view} />;
}
