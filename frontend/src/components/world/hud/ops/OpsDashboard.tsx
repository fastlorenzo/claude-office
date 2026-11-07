"use client";

import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LogIn,
  ScanSearch,
  X,
} from "lucide-react";
import { useTranslation, type TranslationKey } from "@/hooks/useTranslation";
import {
  STATUS_COLORS,
  type CampusProject,
  type CampusSession,
  type CampusStats,
} from "@/engine/contracts";
import {
  buildOpsModel,
  contextTone,
  fmtClock,
  fmtCount,
  fmtPct,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  kindColor,
  phaseColor,
  TONE_COLORS,
  type OpsAlert,
  type OpsModel,
  type OpsRow,
} from "@/engine/logic/opsModel";
import { isPhaseKind } from "@/engine/logic/sessionInfo";
import { Keycap } from "../Keycap";
import { Gauge, Sparkline, StackedBar } from "./OpsCharts";
import { OpsProjectMap } from "./OpsProjectMap";

export interface OpsDashboardProps {
  campus: readonly CampusSession[];
  stats: CampusStats | null | undefined;
  /** CampusState.projects (sessions are grouped by `project` when absent). */
  projects?: readonly CampusProject[] | null;
  labels?: ReadonlyMap<string, string>;
  nowMs: number;
  /** Session highlighted on open (console monitor F). */
  focusId?: string | null;
  onClose: () => void;
  onEnter?: (sessionId: string) => void;
  onInspect?: (sessionId: string, label: string) => void;
}

type T = ReturnType<typeof useTranslation>["t"];

const CARD =
  "min-w-0 rounded-2xl border border-white/[0.08] bg-[#0B111B]/90 shadow-lg shadow-black/30";
const H2 =
  "text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400";
const SUB =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500";

/**
 * Full-resolution Ops dashboard (same OpsModel as the control-room wall).
 * Landscape: sessions board left, usage + activity right. Portrait / narrow:
 * everything stacks in one scrolling column.
 */
export function OpsDashboard(props: OpsDashboardProps): ReactNode {
  const { t } = useTranslation();
  const { campus, stats, labels, nowMs } = props;
  const m = useMemo(
    () => buildOpsModel(campus, stats, nowMs, labels),
    [campus, stats, nowMs, labels],
  );
  return (
    <div
      role="dialog"
      aria-label={t("ops.title")}
      className="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-[#04070C]/85 text-slate-100 backdrop-blur-md animate-[hud-sheet-up_180ms_ease-out]"
    >
      <Header m={m} t={t} onClose={props.onClose} />
      <AlertStrip alerts={m.alerts} t={t} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 sm:px-4">
        <div className="grid gap-3 landscape:lg:h-full landscape:lg:grid-cols-[minmax(0,1.9fr)_minmax(320px,1fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            <SessionsBoard m={m} t={t} {...props} />
            <OpsProjectMap
              campus={campus}
              projects={props.projects}
              labels={labels}
              className={`${CARD} shrink-0 pb-2`}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-3 landscape:lg:overflow-y-auto">
            <UsageCard m={m} t={t} />
            <ActivityCard m={m} t={t} />
          </div>
        </div>
      </div>
      <Ticker m={m} t={t} />
    </div>
  );
}

// ----------------------------------------------------------------------------

function Header({
  m,
  t,
  onClose,
}: {
  m: OpsModel;
  t: T;
  onClose: () => void;
}): ReactNode {
  const c = m.counts;
  const chips: Array<[TranslationKey, number, string]> = [
    ["hud.status.needs_you", c.needs_you, STATUS_COLORS.needs_you],
    ["hud.status.working", c.working, STATUS_COLORS.working],
    ["hud.status.done", c.done, STATUS_COLORS.done],
  ];
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-100">
          {t("ops.title")}
        </h2>
        <span className="truncate text-xs text-slate-500">
          {t("ops.live", { n: c.live })} ·{" "}
          {t("ops.subagents", { n: c.subagents })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map(([k, n, col]) => (
          <span
            key={k}
            className="rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold"
            style={{
              color: col,
              background: `${col}1f`,
              border: `1px solid ${col}55`,
            }}
          >
            {n} {t(k)}
          </span>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="font-mono text-sm text-slate-400">
          {fmtClock(new Date(m.nowMs).toISOString())}
        </span>
        <span className="hidden items-center gap-1.5 text-[11px] text-slate-500 sm:flex">
          <Keycap>B</Keycap>/<Keycap>Esc</Keycap>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("hud.close")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

function alertLine(a: OpsAlert, t: T): string {
  const project = a.project ?? "";
  const n = a.value ?? 0;
  const base = t(`ops.alert.${a.kind}` as TranslationKey, { project, n });
  return a.detail && a.kind === "approval" ? `${base} · ${a.detail}` : base;
}

function AlertStrip({ alerts, t }: { alerts: OpsAlert[]; t: T }): ReactNode {
  if (alerts.length === 0)
    return (
      <div className="mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-300 sm:mx-4">
        <CheckCircle2 className="h-4 w-4" />
        {t("ops.allClear")}
      </div>
    );
  const high = alerts.some((a) => a.severity === "high");
  return (
    <div
      className={`mx-3 mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border px-3 py-2 text-sm sm:mx-4 ${
        high
          ? "animate-[ops-pulse_2.4s_ease-in-out_infinite] border-amber-500/50 bg-amber-500/[0.09]"
          : "border-amber-300/25 bg-amber-300/[0.05]"
      }`}
    >
      <span className="flex items-center gap-1.5 rounded-md bg-amber-500 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-950">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t("ops.alerts", { n: alerts.length })}
      </span>
      {alerts.map((a) => (
        <span
          key={a.id}
          className={
            a.severity === "high"
              ? "font-medium text-amber-300"
              : "text-slate-200"
          }
        >
          {alertLine(a, t)}
        </span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sessions board
// ----------------------------------------------------------------------------

const ROW_GRID =
  "landscape:md:grid landscape:md:grid-cols-[minmax(0,2.3fr)_minmax(0,1.5fr)_minmax(0,1.05fr)_minmax(0,0.75fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,0.55fr)] landscape:md:items-center landscape:md:gap-3";

function SessionsBoard({
  m,
  t,
  focusId,
  onEnter,
  onInspect,
}: { m: OpsModel; t: T } & OpsDashboardProps): ReactNode {
  const live = m.rows.filter((r) => r.status !== "ended");
  const ended = m.rows.length - live.length;
  return (
    <section className={`${CARD} flex min-h-0 flex-1 flex-col`}>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h3 className={H2}>{t("ops.sessions")}</h3>
        {ended > 0 && (
          <span className="text-[11px] text-slate-500">
            {t("ops.ended", { n: ended })}
          </span>
        )}
      </div>
      <div
        className={`${ROW_GRID} hidden border-b border-white/[0.06] px-4 pb-1.5 ${SUB}`}
      >
        <span>{t("ops.col.project")}</span>
        <span>{t("ops.col.now")}</span>
        <span>{t("ops.col.context")}</span>
        <span>{t("ops.col.cost")}</span>
        <span>{t("ops.col.lines")}</span>
        <span>{t("ops.col.model")}</span>
        <span>{t("ops.col.crew")}</span>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {live.length === 0 && (
          <li className="px-3 py-10 text-center text-sm text-slate-500">
            {t("ops.noSessions")}
          </li>
        )}
        {live.map((r) => (
          <Row
            key={r.sessionId}
            r={r}
            t={t}
            focused={r.sessionId === focusId}
            onEnter={onEnter}
            onInspect={onInspect}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  r,
  t,
  focused,
  onEnter,
  onInspect,
}: {
  r: OpsRow;
  t: T;
  focused: boolean;
  onEnter?: (id: string) => void;
  onInspect?: (id: string, label: string) => void;
}): ReactNode {
  const sc = STATUS_COLORS[r.status];
  const needs = r.status === "needs_you";
  const pc = phaseColor(r.phaseKind);
  const phaseLabel = isPhaseKind(r.phaseKind)
    ? t(`hud.phase.${r.phaseKind}` as TranslationKey)
    : r.phaseLabel;
  const tone = TONE_COLORS[contextTone(r.contextPct)];
  const sub = [
    r.phaseDetail,
    r.phaseElapsed ? t("ops.for", { span: r.phaseElapsed }) : null,
    r.idleFor && r.status !== "working"
      ? t("ops.idle", { span: r.idleFor })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const cache =
    r.cacheMinsLeft == null
      ? null
      : r.cacheMinsLeft === 0
        ? t("ops.cacheCold")
        : t("ops.cache", { m: r.cacheMinsLeft });
  return (
    <li
      className={`group relative cursor-pointer rounded-xl border py-2.5 pl-4 pr-3 transition-colors ${
        needs
          ? "border-amber-500/40 bg-amber-500/[0.08] hover:bg-amber-500/[0.13]"
          : "border-white/[0.05] bg-[#101826] hover:bg-[#152033]"
      } ${focused ? "ring-2 ring-sky-400/60" : ""} ${ROW_GRID} grid grid-cols-2 gap-x-3 gap-y-2`}
      onClick={() => onEnter?.(r.sessionId)}
      title={t("ops.enter")}
    >
      <span
        className="absolute inset-y-1.5 left-1 w-1 rounded-full"
        style={{ background: sc }}
      />
      {/* Project + summary */}
      <div className="col-span-2 min-w-0 landscape:md:col-span-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${r.alive ? "" : "border border-slate-500"}`}
            style={r.alive ? { background: sc } : undefined}
          />
          <span className="truncate text-[15px] font-semibold text-slate-50">
            {r.project}
          </span>
          {r.refs.map((ref) => (
            <span
              key={ref}
              className="shrink-0 rounded border border-white/10 bg-white/5 px-1 font-mono text-[10px] font-semibold text-slate-300"
            >
              {ref}
            </span>
          ))}
          <span className="ml-auto hidden shrink-0 gap-1 group-hover:flex">
            {onInspect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onInspect(r.sessionId, r.project);
                }}
                className="flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-white/20"
              >
                <ScanSearch className="h-3 w-3" />
                {t("ops.inspect")}
              </button>
            )}
            <span className="flex items-center gap-1 rounded-md bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">
              <LogIn className="h-3 w-3" />
              {t("ops.enter")}
            </span>
          </span>
        </div>
        <p
          className={`mt-0.5 truncate text-[13px] ${r.summary ? "text-slate-400" : "text-slate-600"}`}
        >
          {r.summary ?? r.branch ?? t("hud.overview.noSummary")}
        </p>
      </div>
      {/* Phase */}
      <div className="col-span-2 min-w-0 landscape:md:col-span-1">
        <div
          className="flex items-center gap-1.5 text-[13px] font-semibold"
          style={{ color: needs ? sc : "#E2E8F0" }}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${needs ? "animate-pulse" : ""}`}
            style={{ background: pc }}
          />
          <span className="truncate">{phaseLabel}</span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
          {sub || "—"}
        </p>
      </div>
      {/* Context */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="w-9 shrink-0 font-mono text-[13px] font-bold"
            style={{ color: (r.contextPct ?? 0) >= 70 ? tone : "#E2E8F0" }}
          >
            {fmtPct(r.contextPct)}
          </span>
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-400/15">
            <span
              className="block h-full rounded-full"
              style={{ width: `${r.contextPct ?? 0}%`, background: tone }}
            />
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
          {r.contextTokens != null
            ? `${fmtTokens(r.contextTokens)} / ${fmtTokens(r.contextWindow)}`
            : "—"}
        </p>
      </div>
      {/* Cost + time */}
      <div className="min-w-0">
        <p className="font-mono text-[13px] font-semibold text-slate-100">
          {fmtUsd(r.costUsd)}
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
          {fmtSpan(r.durationMs)}
        </p>
      </div>
      {/* Lines */}
      <div className="min-w-0 font-mono">
        <p className="text-[13px] font-semibold text-emerald-400">
          {r.linesAdded != null ? `+${fmtCount(r.linesAdded)}` : "—"}
        </p>
        <p className="mt-0.5 text-[11px] text-rose-400">
          {r.linesRemoved != null ? `−${fmtCount(r.linesRemoved)}` : ""}
        </p>
      </div>
      {/* Model */}
      <div className="min-w-0">
        <p
          className={`truncate text-[13px] font-semibold ${r.model ? "text-slate-100" : "text-slate-600"}`}
        >
          {r.model ?? "—"}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {[r.effort, cache].filter(Boolean).join(" · ") || "—"}
        </p>
      </div>
      {/* Crew */}
      <div className="min-w-0">
        <p
          className={`font-mono text-[13px] font-bold ${r.subagents ? "text-sky-300" : "text-slate-600"}`}
        >
          {r.subagents}{" "}
          <span className="font-sans text-[10px] font-normal text-slate-500">
            {t("hud.overview.agents")}
          </span>
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
          {r.todoTotal ? `${r.todoDone}/${r.todoTotal}` : ""}
        </p>
      </div>
    </li>
  );
}

// ----------------------------------------------------------------------------
// Usage + activity
// ----------------------------------------------------------------------------

function Kpi({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  color?: string;
}): ReactNode {
  return (
    <div className="min-w-0">
      <p className={SUB}>{label}</p>
      <p
        className="mt-1 truncate font-mono text-xl font-bold"
        style={{ color: color ?? "#EAF0F8" }}
      >
        {value}
      </p>
      {sub && (
        <p className="truncate font-mono text-[11px] text-slate-500">{sub}</p>
      )}
    </div>
  );
}

function UsageCard({ m, t }: { m: OpsModel; t: T }): ReactNode {
  const u = m.usage;
  const pace = (w: typeof u.fiveHour) =>
    w?.projectedPct != null
      ? t("ops.pace", { pct: fmtPct(w.projectedPct) })
      : t("ops.pace", { pct: "—" });
  const reset = (w: typeof u.fiveHour) =>
    w?.resetsInMs != null
      ? t("ops.resetsIn", { span: fmtSpan(w.resetsInMs) })
      : "—";
  const max = u.costSeries.length ? Math.max(...u.costSeries) : 0;
  return (
    <section className={`${CARD} p-4`}>
      <div className="flex items-baseline gap-2">
        <h3 className={H2}>{t("ops.usage")}</h3>
        <span className="text-[11px] text-slate-500">{t("ops.usage.sub")}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Gauge
          w={u.fiveHour}
          label={t("ops.fiveHour")}
          paceLabel={pace(u.fiveHour)}
          resetLabel={reset(u.fiveHour)}
        />
        <Gauge
          w={u.sevenDay}
          label={t("ops.sevenDay")}
          paceLabel={pace(u.sevenDay)}
          resetLabel={reset(u.sevenDay)}
        />
      </div>
      {!u.fiveHour && !u.sevenDay && (
        <p className="text-center text-[11px] text-slate-500">
          {t("ops.noLimits")}
        </p>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Kpi label={t("ops.costToday")} value={fmtUsd(u.costTodayUsd)} />
        <Kpi
          label={t("ops.burn")}
          value={
            u.burnUsdPerHour != null ? `${fmtUsd(u.burnUsdPerHour)}/h` : "—"
          }
          color={
            u.burnUsdPerHour != null && u.burnUsdPerHour > 30
              ? "#F59E0B"
              : undefined
          }
        />
        <Kpi
          label={t("ops.linesToday")}
          value={
            u.linesAddedToday != null ? `+${fmtCount(u.linesAddedToday)}` : "—"
          }
          color="#4ADE80"
          sub={
            u.linesRemovedToday != null ? (
              <span className="text-rose-400">
                −{fmtCount(u.linesRemovedToday)}
              </span>
            ) : undefined
          }
        />
      </div>
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <p className={SUB}>{t("ops.spend")}</p>
          {max > 0 && (
            <span className="font-mono text-[10px] text-slate-500">
              {fmtUsd(max)}
            </span>
          )}
        </div>
        <Sparkline
          data={u.costSeries}
          color="#38BDF8"
          max={max * 1.1}
          className="mt-1 h-16 w-full"
        />
      </div>
    </section>
  );
}

function ActivityCard({ m, t }: { m: OpsModel; t: T }): ReactNode {
  const a = m.activity;
  const rows = m.rows.filter((r) => r.status !== "ended").slice(0, 8);
  const max = Math.max(4, ...rows.flatMap((r) => r.spark));
  const total = a.toolMix.reduce((s, x) => s + x.count, 0);
  const tf = a.testFailures ?? 0;
  return (
    <section className={`${CARD} p-4`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={H2}>{t("ops.activity")}</h3>
        {a.eventsLastMin != null && (
          <span className="font-mono text-[11px] text-slate-400">
            {t("ops.eventsNow", { n: a.eventsLastMin })}
          </span>
        )}
      </div>
      <p className={`${SUB} mt-3`}>{t("ops.eventsPerMin")}</p>
      <Sparkline
        data={a.eventsPerMin}
        color="#60A5FA"
        max={Math.max(4, a.peakPerMin * 1.1)}
        className="mt-1 h-20 w-full"
      />
      <p className={`${SUB} mt-3`}>{t("ops.perSession")}</p>
      <ul className="mt-1 space-y-1">
        {rows.map((r) => (
          <li
            key={r.sessionId}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_3rem] items-center gap-2 text-[12px]"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: STATUS_COLORS[r.status] }}
              />
              <span className="truncate text-slate-200">{r.project}</span>
            </span>
            <Sparkline
              data={r.spark}
              color={STATUS_COLORS[r.status]}
              max={max}
              className="h-5 w-full"
            />
            <span className="text-right font-mono text-[11px] text-slate-400">
              {r.spark.length ? `${r.spark[r.spark.length - 1]}/m` : "—"}
            </span>
          </li>
        ))}
      </ul>
      <p className={`${SUB} mt-4`}>{t("ops.toolMix")}</p>
      <div className="mt-1.5">
        <StackedBar mix={a.toolMix} />
      </div>
      {total > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          {a.toolMix.slice(0, 6).map((x) => (
            <span key={x.kind} className="flex items-center gap-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: kindColor(x.kind) }}
              />
              {isPhaseKind(x.kind)
                ? t(`hud.phase.${x.kind}` as TranslationKey)
                : x.kind}{" "}
              {Math.round((x.count / total) * 100)}%
            </span>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Kpi
          label={t("ops.tests")}
          value={a.testRuns != null ? String(a.testRuns) : "—"}
          sub={
            a.testRuns != null ? (
              tf > 0 ? (
                <span className="text-red-400">
                  {t("ops.failing", { n: tf })}
                </span>
              ) : (
                t("ops.allPassing")
              )
            ) : undefined
          }
        />
        <Kpi
          label={t("ops.errors")}
          value={a.errors != null ? String(a.errors) : "—"}
          color={(a.errors ?? 0) > 0 ? "#F59E0B" : undefined}
        />
        <Kpi
          label={t("ops.toolCalls")}
          value={fmtCount(a.toolCalls)}
          sub={
            a.subagentsSpawned != null
              ? t("ops.subagents", { n: a.subagentsSpawned })
              : undefined
          }
        />
      </div>
    </section>
  );
}

function Ticker({ m, t }: { m: OpsModel; t: T }): ReactNode {
  return (
    <footer className="flex shrink-0 items-center gap-3 overflow-hidden border-t border-white/[0.06] bg-[#05080D]/90 px-4 py-2 text-[12px]">
      <span className="shrink-0 rounded bg-red-500 px-1.5 py-px font-mono text-[10px] font-bold text-white">
        LIVE
      </span>
      <div className="flex min-w-0 flex-1 gap-5 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
        {m.ticker.length === 0 && (
          <span className="text-slate-500">{t("ops.waiting")}</span>
        )}
        {m.ticker.slice(0, 24).map((it) => (
          <span key={it.key} className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-slate-500">{it.clock}</span>
            <span
              className="font-semibold"
              style={{ color: STATUS_COLORS[it.status] }}
            >
              {it.project}
            </span>
            <span className="text-slate-500">{it.actor}</span>
            <span className="max-w-[28rem] truncate text-slate-300">
              {it.text}
            </span>
          </span>
        ))}
      </div>
    </footer>
  );
}
