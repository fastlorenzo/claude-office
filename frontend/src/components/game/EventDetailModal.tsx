/**
 * EventDetailModal - full details of one legacy event-log entry.
 *
 * Used by the legacy event log (backends without the console API). Tool
 * calls from the console open `ToolCallDetail` instead. The agent shows as a
 * coloured chip with its name (main agent vs subagent), never a raw id.
 */

"use client";

import { useEffect, useCallback, type ReactNode } from "react";
import { X } from "lucide-react";
import { format } from "date-fns";
import type { EventLogEntry } from "@/stores/gameStore";
import type { AgentNode } from "@/utils/console/types";
import { useTranslation } from "@/hooks/useTranslation";
import { getEventTypeBadgeClasses } from "@/utils/event-type-styles";
import { CodeLines } from "@/components/console/renderers/code";
import { agentVisual } from "@/components/console/theme";
import { AgentChip } from "@/components/console/TimelineRow";

interface EventDetailModalProps {
  event: EventLogEntry;
  /** Agent nodes for names/colours (falls back to id-derived identity). */
  agents?: ReadonlyMap<string, AgentNode>;
  onClose: () => void;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}

export function EventDetailModal({
  event,
  agents,
  onClose,
}: EventDetailModalProps) {
  const { t } = useTranslation();
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const detail = event.detail ?? {};
  const hasDetail = Object.keys(detail).length > 0;
  const who = event.agentId
    ? agentVisual(
        event.agentId,
        agents?.get(event.agentId),
        t("console.mainAgent"),
      )
    : null;
  const text = "whitespace-pre-wrap break-words text-[13px] leading-relaxed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${event.type.replace(/_/g, " ")} — ${event.summary}`}
        className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B111B]/95 text-xs shadow-2xl shadow-black/60"
      >
        <div
          className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-white/[0.06] px-4 py-3"
          style={who ? { borderLeft: `3px solid ${who.color}` } : undefined}
        >
          <span
            className={`rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${getEventTypeBadgeClasses(event.type)}`}
          >
            {event.type.replace(/_/g, " ")}
          </span>
          <span className="font-mono text-xs text-slate-400">
            {format(event.timestamp, "HH:mm:ss.SSS")}
          </span>
          {who && <AgentChip v={who} max="max-w-[16rem]" />}
          {who?.type && (
            <span className="rounded bg-white/[0.06] px-1.5 leading-5 text-slate-300">
              {who.type}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={t("modal.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-grow space-y-3 overflow-y-auto p-4">
          <Field label={t("eventDetail.summary")}>
            <div className={`${text} text-slate-100`}>{event.summary}</div>
          </Field>
          {hasDetail ? (
            <>
              {detail.toolName && (
                <Field label={t("eventDetail.tool")}>
                  <div className="font-mono text-[13px] text-amber-300">
                    {String(detail.toolName)}
                  </div>
                </Field>
              )}
              {detail.agentName && (
                <Field label={t("eventDetail.agentName")}>
                  <div className="text-[13px]" style={{ color: who?.color }}>
                    {String(detail.agentName)}
                  </div>
                </Field>
              )}
              {detail.taskDescription && (
                <Field label={t("eventDetail.taskDescription")}>
                  <div className={`${text} text-slate-200`}>
                    {String(detail.taskDescription)}
                  </div>
                </Field>
              )}
              {detail.prompt && (
                <Field label={t("eventDetail.userPrompt")}>
                  <div
                    className={`${text} rounded-lg border border-cyan-400/25 bg-cyan-500/[0.08] p-2.5 text-cyan-50`}
                  >
                    {String(detail.prompt)}
                  </div>
                </Field>
              )}
              {detail.thinking && (
                <Field label={t("eventDetail.thinking")}>
                  <div
                    className={`${text} rounded-lg border border-indigo-400/20 bg-indigo-500/[0.07] p-2.5 italic text-indigo-100/80`}
                  >
                    {String(detail.thinking)}
                  </div>
                </Field>
              )}
              {detail.message && (
                <Field label={t("eventDetail.message")}>
                  <div className={`${text} text-slate-200`}>
                    {String(detail.message)}
                  </div>
                </Field>
              )}
              {detail.resultSummary && (
                <Field label={t("eventDetail.resultSummary")}>
                  <div className={`${text} text-emerald-300`}>
                    {String(detail.resultSummary)}
                  </div>
                </Field>
              )}
              {detail.errorType && (
                <Field label={t("eventDetail.errorType")}>
                  <div className="text-[13px] text-rose-300">
                    {String(detail.errorType)}
                  </div>
                </Field>
              )}
              {detail.toolInput && (
                <Field label={t("eventDetail.toolInput")}>
                  <CodeLines
                    text={JSON.stringify(detail.toolInput, null, 2)}
                    lang="json"
                    numbered={false}
                  />
                </Field>
              )}
            </>
          ) : (
            <div className="py-4 text-center text-[13px] italic text-slate-500">
              {t("eventDetail.noDetail")}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-white/[0.06] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.05] px-4 py-1.5 text-xs font-bold text-slate-200 transition-colors hover:bg-white/10"
          >
            {t("modal.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
