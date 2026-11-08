"use client";

import { memo, useMemo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { deployView, type DeployView } from "./factoryPanelModel";
import { PipelineList } from "./LinePanel";
import { AgoText, Chip, Empty, Section, StateChip } from "./parts";
import type { InteractionTarget } from "@/engine/contracts";
import { useFactoryData } from "./useFactoryData";
import { SESSION_COLORS } from "@/engine/logic/statusPalette";

export const DeployPanelView = memo(function DeployPanelView({
  v,
}: {
  v: DeployView;
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
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-white">
            {v.name}
          </h3>
          {v.deploying ? (
            <Chip color={SESSION_COLORS.working}>
              {t("factory.deploy.deploying")}
            </Chip>
          ) : (
            <StateChip state={v.state} />
          )}
        </div>
        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            {t("factory.deploy.lastShip")}
          </div>
          {v.lastShip ? (
            <div className="mt-0.5 flex items-baseline gap-2 text-white">
              <span className="font-mono text-lg font-bold">
                {v.lastShip.label}
              </span>
              <span className="text-xs text-slate-400">
                <AgoText ago={v.lastShip.ago} />
              </span>
            </div>
          ) : (
            <div className="mt-0.5 text-sm text-slate-500">
              {t("factory.deploy.never")}
            </div>
          )}
        </div>
      </div>
      <Section title={`${t("factory.deploy.releases")} (${v.releases.length})`}>
        {v.releases.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("factory.deploy.noReleases")}
          </p>
        ) : (
          <ul className="space-y-1">
            {v.releases.map((r) => (
              <li
                key={r.tag}
                className="flex items-center gap-2 text-xs text-slate-200"
              >
                <span className="font-mono font-semibold">{r.tag}</span>
                {r.prerelease && (
                  <Chip color={SESSION_COLORS.needs_you}>
                    {t("factory.deploy.prerelease")}
                  </Chip>
                )}
                <span className="min-w-0 flex-1 truncate text-slate-400">
                  {r.name}
                </span>
                <span className="text-xs text-slate-500">
                  <AgoText ago={r.ago} />
                </span>
                {r.url && /^https?:\/\//i.test(r.url) && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("factory.github")}
                    className="text-slate-400 hover:text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("factory.deploy.pipelines")}>
        {v.pipelines.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("factory.deploy.noPipelines")}
          </p>
        ) : (
          <PipelineList rows={v.pipelines} />
        )}
      </Section>
    </div>
  );
});

export function DeployPanel({
  target: explicit,
}: {
  target?: InteractionTarget | null;
}): ReactNode {
  const { t } = useTranslation();
  const { data } = useFactoryData(explicit);
  const view = useMemo(
    () => (data ? deployView(data.project, data.line, data.now) : null),
    [data],
  );
  if (!view) return <Empty>{t("factory.none")}</Empty>;
  return <DeployPanelView v={view} />;
}
