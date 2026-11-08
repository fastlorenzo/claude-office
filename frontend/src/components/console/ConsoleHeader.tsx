"use client";

/**
 * Console header (spec 2.3 "Header"): project, branch, phase pill, model,
 * cost, tokens, context gauge, duration, line deltas, PR/CI, counts and the
 * host actions (Enter room, cross-link, copy id, close).
 */

import { useCallback, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  DoorOpen,
  GitBranch,
  GitPullRequest,
  Hourglass,
  TriangleExclamationPoint,
  X,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { CI_COLORS, TONE_COLORS } from "@/engine/logic/statusPalette";
import { formatElapsed, isPhaseKind } from "@/engine/logic/sessionInfo";
import type { PullRequestInfo } from "@/engine/contracts";
import { formatDuration } from "@/utils/console/toolFormat";
import type { ConsoleHeader as Header } from "@/utils/console/types";
import { useConsoleNow } from "./clock";
import { BTN, MAIN_COLOR } from "./theme";

const PHASE_COLOR: Record<string, string> = {
  needs_approval: "#FBBF24",
  waiting_user: "#60A5FA",
  planning: "#A78BFA",
  researching: "#38BDF8",
  exploring: "#94A3B8",
  coding: "#4ADE80",
  testing: "#A78BFA",
  building: "#A78BFA",
  running: "#94A3B8",
  git: "#2DD4BF",
  delegating: "#4ADE80",
  compacting: "#94A3B8",
  idle: "#94A3B8",
  ended: "#64748B",
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function Gauge({ pct }: { pct: number }): ReactNode {
  const color =
    pct >= 85 ? TONE_COLORS.bad : pct >= 65 ? TONE_COLORS.warn : TONE_COLORS.ok;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.min(100, Math.max(2, pct))}%`,
            background: color,
          }}
        />
      </span>
      <span className="font-mono tabular-nums" style={{ color }}>
        {Math.round(pct)}%
      </span>
    </span>
  );
}

function Stat({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}): ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-slate-300"
      title={title}
    >
      {children}
    </span>
  );
}

export interface HeaderCounts {
  agents: number;
  running: number;
  calls: number;
  errors: number;
}

export interface CrossLink {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function ConsoleHeader({
  sessionId,
  header,
  counts,
  pr,
  compact = false,
  onErrors,
  onEnterRoom,
  crossLink,
  onClose,
}: {
  sessionId: string;
  header: Header | null;
  counts: HeaderCounts;
  pr?: PullRequestInfo | null;
  /** Narrow (mobile / dock < 800 px): two dense lines. */
  compact?: boolean;
  /** Errors count click: errors-only filter. */
  onErrors?: () => void;
  onEnterRoom?: () => void;
  crossLink?: CrossLink | null;
  onClose?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const now = useConsoleNow(!header?.ended);
  const [copied, setCopied] = useState(false);
  const tel = header?.telemetry ?? null;
  const phase = header?.phase ?? null;
  const kind = phase?.kind ?? (header?.ended ? "ended" : "idle");
  const phaseColor = PHASE_COLOR[kind] ?? "#94A3B8";
  const phaseLabel = isPhaseKind(kind)
    ? t(`hud.phase.${kind}`)
    : (phase?.label ?? kind);
  const since = formatElapsed(phase?.since, now);
  const duration =
    tel?.durationMs != null
      ? tel.durationMs
      : header?.startedAt
        ? now - Date.parse(header.startedAt)
        : null;
  const project = header?.project ?? sessionId.slice(0, 8);
  const copyId = useCallback(() => {
    void navigator.clipboard?.writeText(sessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [sessionId]);
  const checks = pr?.checks;
  const ciColor =
    checks?.state && checks.state !== "none"
      ? (CI_COLORS[
          checks.state === "queued"
            ? "running"
            : (checks.state as keyof typeof CI_COLORS)
        ] ?? "#94A3B8")
      : "#94A3B8";

  const actions = (
    <div className="flex shrink-0 items-center gap-1.5">
      {onEnterRoom && (
        <button
          type="button"
          className={compact ? `${BTN} px-2` : BTN}
          onClick={onEnterRoom}
          aria-label={t("console.enterRoom")}
          title={t("console.enterRoom")}
        >
          <DoorOpen className="h-3.5 w-3.5" />
          {!compact && t("console.enterRoom")}
        </button>
      )}
      {crossLink &&
        (crossLink.href ? (
          <a
            className={compact ? `${BTN} px-2` : BTN}
            href={crossLink.href}
            aria-label={crossLink.label}
            title={crossLink.label}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            {!compact && crossLink.label}
          </a>
        ) : (
          <button
            type="button"
            className={compact ? `${BTN} px-2` : BTN}
            onClick={crossLink.onClick}
            aria-label={crossLink.label}
            title={crossLink.label}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            {!compact && crossLink.label}
          </button>
        ))}
      <button
        type="button"
        className={`${BTN} px-2`}
        onClick={copyId}
        aria-label={t("console.copySessionId")}
        title={t("console.copySessionId")}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      {onClose && (
        <button
          type="button"
          className={`${BTN} px-2`}
          onClick={onClose}
          aria-label={t("console.close")}
          title={t("console.close")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const pill = (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        color: phaseColor,
        background: `${phaseColor}1f`,
        border: `1px solid ${phaseColor}55`,
      }}
      title={[phaseLabel, phase?.detail].filter(Boolean).join(" · ")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${kind === "needs_approval" ? "motion-safe:animate-pulse" : ""}`}
        style={{ background: phaseColor }}
      />
      {phaseLabel}
      {since && <span className="font-normal text-slate-400">· {since}</span>}
    </span>
  );

  const errorsBtn = (
    <button
      type="button"
      onClick={onErrors}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs ${counts.errors > 0 ? "text-rose-300 hover:bg-rose-500/15" : "text-slate-500"}`}
      title={t("console.errorsOnlyHint")}
    >
      <TriangleExclamationPoint className="h-3.5 w-3.5" />
      {t("console.nErrors", { count: counts.errors })}
    </button>
  );

  const telemetry = (
    <>
      {tel?.model && (
        <Stat>
          <span className="font-semibold text-slate-200">{tel.model}</span>
          {tel.effort && <span className="text-slate-500">· {tel.effort}</span>}
        </Stat>
      )}
      {tel?.costUsd != null && (
        <Stat title={t("console.cost")}>${tel.costUsd.toFixed(2)}</Stat>
      )}
      {tel?.contextTokens != null && (
        <Stat title={t("console.contextTokens")}>
          {fmtTokens(tel.contextTokens)} {t("console.tok")}
        </Stat>
      )}
      {tel?.contextUsedPct != null && (
        <Stat title={t("console.context")}>
          <span className="text-slate-500">{t("console.ctx")}</span>
          <Gauge pct={tel.contextUsedPct} />
        </Stat>
      )}
    </>
  );

  const second = (
    <>
      {duration != null && duration > 0 && (
        <Stat title={t("console.duration")}>
          <Hourglass className="h-3.5 w-3.5 text-slate-500" />
          <span className="font-mono tabular-nums">
            {formatDuration(duration)}
          </span>
        </Stat>
      )}
      {(tel?.linesAdded != null || tel?.linesRemoved != null) && (
        <Stat>
          <span className="font-mono text-emerald-400">
            +{tel?.linesAdded ?? 0}
          </span>
          <span className="font-mono text-rose-400">
            −{tel?.linesRemoved ?? 0}
          </span>
        </Stat>
      )}
      {pr && (
        <a
          href={pr.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-xs text-slate-300 hover:bg-white/5"
        >
          <GitPullRequest className="h-3.5 w-3.5 text-violet-300" />
          <span className="font-semibold">#{pr.number}</span>
          {checks?.total ? (
            <span style={{ color: ciColor }}>
              {t("console.checks", {
                passed: checks.passed ?? 0,
                total: checks.total,
              })}
            </span>
          ) : null}
          <ArrowUpRight className="h-3 w-3 text-slate-500" />
        </a>
      )}
      <Stat>
        <span>
          {t("console.agentsSummary", {
            count: counts.agents,
            running: counts.running,
          })}
        </span>
        <span className="text-slate-600">·</span>
        <span>{t("console.nCalls", { count: counts.calls })}</span>
      </Stat>
      {errorsBtn}
    </>
  );

  if (compact) {
    return (
      <div className="shrink-0 border-b border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background:
                header?.alive === false || header?.ended
                  ? "#64748B"
                  : MAIN_COLOR,
            }}
          />
          <span className="min-w-0 truncate text-sm font-semibold text-slate-50">
            {project}
          </span>
          {header?.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-xs text-slate-400">
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{header.branch}</span>
            </span>
          )}
          <span className="flex-1" />
          {actions}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {pill}
          {tel?.costUsd != null && <Stat>${tel.costUsd.toFixed(2)}</Stat>}
          {tel?.contextUsedPct != null && (
            <Stat>
              <span className="text-slate-500">{t("console.ctx")}</span>
              <Gauge pct={tel.contextUsedPct} />
            </Stat>
          )}
          {duration != null && duration > 0 && (
            <Stat>
              <Hourglass className="h-3.5 w-3.5 text-slate-500" />
              <span className="font-mono tabular-nums">
                {formatDuration(duration)}
              </span>
            </Stat>
          )}
          {errorsBtn}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-white/[0.06] px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{
            background:
              header?.alive === false || header?.ended ? "#64748B" : MAIN_COLOR,
            boxShadow: header?.ended ? undefined : `0 0 10px ${MAIN_COLOR}`,
          }}
        />
        <span className="min-w-0 truncate text-base font-semibold text-slate-50">
          {project}
        </span>
        {header?.branch && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-slate-400">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{header.branch}</span>
          </span>
        )}
        {pill}
        <span className="flex-1" />
        {actions}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {telemetry}
        {telemetry && <span className="h-3.5 w-px bg-white/10" aria-hidden />}
        {second}
      </div>
    </div>
  );
}
