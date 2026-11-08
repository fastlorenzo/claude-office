"use client";

/**
 * Full view of one tool call: header (tool, target, agent identity, timing,
 * status), the per-tool body, and actions (copy input/output/path, "Open
 * full" which fetches `GET /tool-calls/{id}` once per `(callId, rev)`).
 * Used by the console Detail tab, the mobile pushed view, inline expansion
 * and, where no console can open, a modal.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  X,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { detailKey, useConsoleStore } from "@/stores/consoleStore";
import { fetchToolCallDetail } from "@/utils/consoleApi";
import { formatDuration, summarizeCall } from "@/utils/console/toolFormat";
import type {
  AgentNode,
  ToolCall,
  ToolCallDetail as Detail,
} from "@/utils/console/types";
import { clockTime } from "./clock";
import { ToolBody } from "./renderers/ToolBody";
import { AgentChip, StatusGlyph, ToolGlyph } from "./TimelineRow";
import { agentVisual, BTN, STATUS_STYLE } from "./theme";

/** How full payloads are fetched (fixtures swap this out). */
export type DetailFetcher = (
  sessionId: string,
  callId: string,
) => Promise<Detail | null>;

export const ConsoleDetailFetcherContext = createContext<DetailFetcher>(
  (sessionId, callId) => fetchToolCallDetail(sessionId, callId),
);

type LoadState = "idle" | "loading" | "missing" | "error";

/** Cached full payload for a call, plus a loader that fills the cache. */
export function useCallDetail(
  sessionId: string,
  call: ToolCall | undefined,
): { detail: Detail | undefined; state: LoadState; load: () => void } {
  const fetcher = useContext(ConsoleDetailFetcherContext);
  const key = call ? detailKey(call.id, call.rev) : "";
  const detail = useConsoleStore((s) =>
    key ? s.sessions[sessionId]?.details.get(key) : undefined,
  );
  const [state, setState] = useState<{ key: string; s: LoadState }>({
    key: "",
    s: "idle",
  });
  const load = useCallback(() => {
    if (!call || detail) return;
    const k = key;
    setState({ key: k, s: "loading" });
    fetcher(sessionId, call.id)
      .then((d) => {
        if (d) {
          useConsoleStore
            .getState()
            .putDetail(sessionId, { ...d, call: { ...d.call, rev: call.rev } });
          setState({ key: k, s: "idle" });
        } else setState({ key: k, s: "missing" });
      })
      .catch(() => setState({ key: k, s: "error" }));
  }, [call, detail, fetcher, key, sessionId]);
  return { detail, state: state.key === key ? state.s : "idle", load };
}

function useCopy(): [string | null, (what: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 1200);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = useCallback((what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => undefined,
    );
  }, []);
  return [copied, copy];
}

/** Text used by "Copy input" (also the `c` key). */
export function inputText(call: ToolCall, detail?: Detail): string {
  const input = detail?.input ?? call.inputPreview ?? {};
  const cmd = input.command;
  if (call.toolName === "Bash" && typeof cmd === "string") return cmd;
  return JSON.stringify(input, null, 2);
}

export function ToolCallDetail({
  sessionId,
  call,
  agents,
  onBack,
  onClose,
  autoLoad = false,
  hideHeader = false,
}: {
  sessionId: string;
  call: ToolCall;
  agents: ReadonlyMap<string, AgentNode>;
  /** Mobile pushed view: back arrow. */
  onBack?: () => void;
  /** Inline under its timeline row: the row already shows the header. */
  hideHeader?: boolean;
  /** Modal: close button. */
  onClose?: () => void;
  /** Fetch the full payload on mount. */
  autoLoad?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const { detail, state, load } = useCallDetail(sessionId, call);
  const [copied, copy] = useCopy();
  const sum = summarizeCall(call);
  const v = agentVisual(
    call.agentId,
    agents.get(call.agentId),
    t("console.mainAgent"),
  );
  const st = STATUS_STYLE[call.status];
  const input = detail?.input ?? call.inputPreview ?? null;
  const output = detail
    ? (detail.output ?? null)
    : (call.outputPreview ?? null);
  const truncated = detail ? detail.outputTruncated : !!call.outputTruncated;
  const path = typeof input?.file_path === "string" ? input.file_path : null;

  useEffect(() => {
    if (autoLoad) load();
  }, [autoLoad, load]);

  const canLoad =
    !detail &&
    (call.inputTruncated ||
      call.outputTruncated ||
      (call.outputBytes ?? 0) > (call.outputPreview?.length ?? 0));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`shrink-0 border-b border-white/[0.06] px-4 pb-3 pt-3 ${hideHeader ? "hidden" : ""}`}
      >
        <div className="flex items-start gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("console.back")}
              className="-ml-1.5 mr-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <ToolGlyph
                name={call.toolName}
                className="h-4 w-4 shrink-0 text-slate-300"
              />
              <span className="shrink-0 text-sm font-semibold text-slate-50">
                {sum.label}
              </span>
              <span
                className={`min-w-0 break-all font-mono text-[13px] ${call.status === "denied" ? "text-slate-500 line-through" : "text-slate-200"}`}
              >
                {sum.target}
                {sum.suffix && (
                  <span className="text-slate-500">{sum.suffix}</span>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
              <AgentChip v={v} max="max-w-[16rem]" />
              {v.type && (
                <span className="rounded bg-white/[0.06] px-1.5 leading-5 text-slate-300">
                  {v.type}
                </span>
              )}
              <span className="font-mono tabular-nums">
                {clockTime(call.startedAt)}
              </span>
              {call.durationMs != null && (
                <span className="font-mono tabular-nums">
                  · {formatDuration(call.durationMs)}
                </span>
              )}
              {call.permissionWaitMs != null && (
                <span className="text-amber-300/90">
                  ·{" "}
                  {t("console.waited", {
                    d: formatDuration(call.permissionWaitMs),
                  })}
                </span>
              )}
              <span
                className={`inline-flex items-center gap-1 font-semibold ${st.text}`}
              >
                · <StatusGlyph status={call.status} className="h-3 w-3" />{" "}
                {t(st.labelKey)}
              </span>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("modal.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ToolBody
          call={call}
          input={input}
          output={output}
          outputBytes={detail ? null : (call.outputBytes ?? null)}
          outputTruncated={truncated}
          agents={agents}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-white/[0.06] px-4 py-2.5">
        <button
          type="button"
          className={BTN}
          onClick={() => copy("input", inputText(call, detail))}
        >
          {copied === "input" ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {t("console.copyInput")}
        </button>
        {output && (
          <button
            type="button"
            className={BTN}
            onClick={() => copy("output", output)}
          >
            {copied === "output" ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {t("console.copyOutput")}
          </button>
        )}
        {path && (
          <button
            type="button"
            className={BTN}
            onClick={() => copy("path", path)}
          >
            {copied === "path" ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {t("console.copyPath")}
          </button>
        )}
        <span className="flex-1" />
        {detail ? (
          <span className="text-xs text-slate-500">
            {t("console.fullLoaded", { source: detail.outputSource })}
          </span>
        ) : (
          <button
            type="button"
            className={BTN}
            onClick={load}
            disabled={state === "loading"}
            title={canLoad ? undefined : t("console.openFullHint")}
          >
            {state === "loading" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            {state === "missing"
              ? t("console.fullUnavailable")
              : state === "error"
                ? t("console.fullFailed")
                : t("console.openFull")}
          </button>
        )}
      </div>
    </div>
  );
}

/** ToolCallDetail in a modal: only where no console can open (spec 2.6). */
export function ToolCallDetailModal({
  sessionId,
  call,
  agents,
  onClose,
}: {
  sessionId: string;
  call: ToolCall;
  agents: ReadonlyMap<string, AgentNode>;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("console.callDetail")}
        className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B111B]/95 shadow-2xl shadow-black/60"
      >
        <ToolCallDetail
          sessionId={sessionId}
          call={call}
          agents={agents}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
