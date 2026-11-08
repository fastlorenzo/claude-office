"use client";

import {
  CI_COLORS,
  CI_MARKS,
  NEUTRAL_GREY,
} from "@/engine/logic/statusPalette";
import type { ReactNode } from "react";
import { DoorOpen, ExternalLink } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n/en";
import type { CheckState } from "@/engine/contracts";
import { stateColor } from "@/engine/logic/factoryModel";
import { enterSession } from "../../enterSession";
import { LABEL } from "../glass";
import { TONE_COLOR, type Ago, type Tone } from "./factoryPanelModel";

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-t border-white/10 px-4 py-3">
      <h3 className={`${LABEL} mb-2`}>{title}</h3>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="p-6 text-center text-sm text-slate-400">{children}</p>;
}

export function StateDot({
  state,
  color,
}: {
  state?: CheckState;
  color?: string;
}): ReactNode {
  const c = color ?? stateColor(state ?? "none");
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: c, boxShadow: `0 0 8px ${c}88` }}
    />
  );
}

export function Chip({
  children,
  color = NEUTRAL_GREY,
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider"
      style={{ color, borderColor: `${color}66`, background: `${color}1a` }}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

export function ToneChip({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}): ReactNode {
  return <Chip color={TONE_COLOR[tone]}>{children}</Chip>;
}

export function StateChip({ state }: { state: CheckState }): ReactNode {
  const { t } = useTranslation();
  return (
    <Chip color={stateColor(state)}>
      {t(`factory.state.${state}` as TranslationKey)}
    </Chip>
  );
}

export function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: ReactNode;
  color?: string;
}): ReactNode {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <div className={LABEL}>{label}</div>
      <div
        className="mt-0.5 truncate text-lg font-bold text-white"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function AgoText({ ago }: { ago: Ago | null }): ReactNode {
  const { t } = useTranslation();
  if (!ago) return null;
  return <>{t(ago.key, { n: ago.n })}</>;
}

export function GithubLink({ url }: { url: string | null }): ReactNode {
  const { t } = useTranslation();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 transition-colors hover:bg-white/10"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t("factory.github")}
    </a>
  );
}

/** Icon-only link to a CI run (opens GitHub); renders nothing without a safe URL. */
export function RunLink({ url }: { url: string | null }): ReactNode {
  const { t } = useTranslation();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("factory.github")}
      title={t("factory.github")}
      className="shrink-0 text-slate-400 hover:text-white"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

const LEGEND_STATES: CheckState[] = ["success", "failure", "running", "queued"];

/** What the CI colours mean (separate from the session palette). */
export function CiLegend(): ReactNode {
  const { t } = useTranslation();
  return (
    <ul
      aria-label={t("factory.legend")}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300"
    >
      {LEGEND_STATES.map((s) => (
        <li key={s} className="flex items-center gap-1">
          <span style={{ color: CI_COLORS[s] }} aria-hidden>
            {CI_MARKS[s]}
          </span>
          {t(`factory.state.${s}` as TranslationKey)}
        </li>
      ))}
    </ul>
  );
}

export function EnterButton({ sessionId }: { sessionId: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => {
        void enterSession(sessionId);
      }}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#D97757] px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-[#e58a6b]"
    >
      <DoorOpen className="h-3.5 w-3.5" />
      {t("world.action.enter")}
    </button>
  );
}
