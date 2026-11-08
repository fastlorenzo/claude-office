"use client";

import { memo, useMemo, type ReactNode } from "react";
import { ArrowRight, Bot, GitBranch } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n/en";
import { CHECK_COLORS } from "@/engine/contracts";
import { stateColor } from "@/engine/logic/factoryModel";
import {
  mergeTone,
  prView,
  reviewTone,
  type PrView,
} from "./factoryPanelModel";
import {
  AgoText,
  Chip,
  Empty,
  EnterButton,
  GithubLink,
  Section,
  StateChip,
  StateDot,
  ToneChip,
} from "./parts";
import type { InteractionTarget } from "@/engine/contracts";
import { useFactoryData } from "./useFactoryData";
import {
  MUTED_GREY,
  NEUTRAL_GREY,
  SESSION_COLORS,
} from "@/engine/logic/statusPalette";

export const PrPanelView = memo(function PrPanelView({
  v,
}: {
  v: PrView;
}): ReactNode {
  const { t } = useTranslation();
  const statusColor =
    v.prState === "merged"
      ? CHECK_COLORS.merged
      : v.prState === "closed"
        ? CHECK_COLORS.ended
        : stateColor(v.rolled);
  return (
    <div className="flex flex-col">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-start gap-2.5">
          <span
            className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: statusColor,
              boxShadow: `0 0 10px ${statusColor}`,
            }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-snug text-white">
              <span className="mr-1.5 font-mono text-slate-400">
                #{v.number}
              </span>
              {v.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-xs text-slate-300">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{v.branch}</span>
              {v.base && (
                <>
                  <ArrowRight className="h-3 w-3 shrink-0 text-slate-500" />
                  <span className="truncate">{v.base}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Chip color={statusColor}>
            {t(`factory.state.${v.prState}` as TranslationKey)}
          </Chip>
          {v.draft && <Chip>{t("factory.draft")}</Chip>}
          {v.bot && (
            <Chip color={SESSION_COLORS.working}>
              <Bot className="mr-0.5 inline h-3 w-3" />
              {t("factory.bot")}
            </Chip>
          )}
          <ToneChip tone={reviewTone(v.review)}>
            {t(`factory.review.${v.review ?? "none"}` as TranslationKey)}
          </ToneChip>
          {v.mergeable && v.mergeable !== "unknown" && (
            <ToneChip tone={mergeTone(v.mergeable)}>
              {t(`factory.merge.${v.mergeable}` as TranslationKey)}
            </ToneChip>
          )}
          <Chip color={NEUTRAL_GREY} title={t("factory.size")}>
            {v.sizeClass}
          </Chip>
          {v.lane !== null ? (
            <Chip color="#D97757">{t("factory.lane", { n: v.lane })}</Chip>
          ) : v.queue !== null ? (
            <Chip color={CHECK_COLORS.needs_you}>
              {t("factory.queued", { n: v.queue })}
            </Chip>
          ) : (
            <Chip>{t("factory.noLane")}</Chip>
          )}
        </div>

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {v.author && (
            <>
              <dt className="text-slate-500">{t("factory.author")}</dt>
              <dd className="truncate text-slate-200">{v.author}</dd>
            </>
          )}
          <dt className="text-slate-500">{t("factory.size")}</dt>
          <dd className="text-slate-200">
            <span className="text-emerald-400">+{v.additions ?? 0}</span>{" "}
            <span className="text-red-400">-{v.deletions ?? 0}</span>
            {v.files !== null && (
              <span className="text-slate-500">
                {" · "}
                {t("factory.files", { n: v.files })}
              </span>
            )}
          </dd>
          {v.updated && (
            <>
              <dt className="text-slate-500">&nbsp;</dt>
              <dd className="text-xs text-slate-500">
                <AgoText ago={v.updated} />
              </dd>
            </>
          )}
        </dl>

        {v.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {v.labels.map((l) => (
              <Chip key={l.name} color={l.color ?? MUTED_GREY}>
                {l.name}
              </Chip>
            ))}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          {v.sessionId && <EnterButton sessionId={v.sessionId} />}
          <GithubLink url={v.url} />
        </div>
        {!v.sessionId && (
          <p className="mt-2 text-xs text-slate-500">
            {t("factory.noSession")}
          </p>
        )}
      </div>

      <Section title={t("factory.checks", { n: v.checks.length })}>
        {v.checks.length === 0 ? (
          <p className="text-sm text-slate-500">{t("factory.noChecks")}</p>
        ) : (
          <ul className="space-y-1">
            {v.checks.map((c) => (
              <li
                key={c.name}
                className="flex items-center gap-2 text-xs text-slate-200"
              >
                <StateDot color={c.color} />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {c.name}
                </span>
                {c.attempt && (
                  <span className="text-xs text-amber-400">
                    {t("factory.attempt", { n: c.attempt })}
                  </span>
                )}
                <span className="w-14 text-right tabular-nums text-slate-400">
                  {c.duration}
                </span>
                <StateChip state={c.state} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
});

export function PrPanel({
  target: explicit,
}: {
  target?: InteractionTarget | null;
}): ReactNode {
  const { t } = useTranslation();
  const { target, data } = useFactoryData(explicit);
  const view = useMemo(
    () =>
      target && data ? prView(data.project, data.line, target, data.now) : null,
    [target, data],
  );
  if (!view) return <Empty>{t("factory.none")}</Empty>;
  return <PrPanelView v={view} />;
}
