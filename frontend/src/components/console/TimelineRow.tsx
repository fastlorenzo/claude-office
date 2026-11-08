"use client";

/**
 * One timeline row (spec 2.5): a tool call (with its agent rail, icons,
 * target, stat, duration and status), a conversation marker, or the result
 * row that closes a subagent block.
 */

import { createElement, memo, type ReactNode } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CornerDownRight,
  MessageSquare,
  Pause,
  Square,
  User,
  X,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { formatDuration, summarizeCall } from "@/utils/console/toolFormat";
import type { TimelineRow as TreeRow } from "@/utils/console/tree";
import type {
  AgentNode,
  ConversationEntry,
  ToolCall,
  ToolCallStatus,
} from "@/utils/console/types";
import { clockTime, elapsedMs, useConsoleNow } from "./clock";
import {
  agentVisual,
  INDENT_PX,
  isLive,
  MAIN_COLOR,
  STATUS_STYLE,
  toolIcon,
  type AgentVisual,
} from "./theme";

export type RowDensity = "full" | "compact";

/** Lucide icon of a tool (spec 2.2 tool icon table). */
export function ToolGlyph({
  name,
  className = "h-3.5 w-3.5 text-slate-400",
}: {
  name: string;
  className?: string;
}): ReactNode {
  return createElement(toolIcon(name), { className, "aria-hidden": true });
}

/** `…/claude_office_hooks/event_mapper.py`: keep the file name, drop leading dirs. */
export function shortenPath(path: string, max: number): string {
  if (path.length <= max || !path.includes("/")) return path;
  const parts = path.split("/");
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

/** Status glyph (spec 2.2 status table). */
export function StatusGlyph({
  status,
  className = "h-3.5 w-3.5",
}: {
  status: ToolCallStatus;
  className?: string;
}): ReactNode {
  const st = STATUS_STYLE[status];
  switch (status) {
    case "running":
    case "spawned":
      return (
        <span
          className={`relative inline-flex ${className} items-center justify-center`}
        >
          <span className="absolute h-2 w-2 rounded-full bg-sky-400/60 motion-safe:animate-ping" />
          <span className="h-2 w-2 rounded-full bg-sky-400" />
        </span>
      );
    case "waiting_permission":
      return <Pause className={`${className} ${st.text}`} />;
    case "ok":
      return <Check className={`${className} ${st.text}`} strokeWidth={3} />;
    case "error":
      return <X className={`${className} ${st.text}`} strokeWidth={3} />;
    case "denied":
      return <Ban className={`${className} ${st.text}`} />;
    case "interrupted":
      return <Square className={`${className} ${st.text}`} />;
  }
}

/** Live or final duration label for a call. */
function useDurationLabel(call: ToolCall): string | null {
  const live = isLive(call.status);
  const now = useConsoleNow(live);
  if (live) {
    const since =
      call.status === "waiting_permission"
        ? (call.permissionRequestedAt ?? call.startedAt)
        : call.startedAt;
    return formatDuration(elapsedMs(since, now));
  }
  return call.durationMs != null ? formatDuration(call.durationMs) : null;
}

/** Rails and guides that show ownership: 3 px agent rail + block guides. */
function Rails({
  depth,
  color,
  error,
}: {
  depth: number;
  color: string;
  error: boolean;
}): ReactNode {
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: color }}
      />
      {error && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-[3px] w-[2px] bg-rose-400/80"
        />
      )}
      {depth > 0 && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-[2px] rounded-full"
          style={{
            left: 10 + (depth - 1) * INDENT_PX + 5,
            background: `${color}66`,
          }}
        />
      )}
    </>
  );
}

/** Small coloured chip naming a (sub)agent. */
export function AgentChip({
  v,
  max = "max-w-[12rem]",
}: {
  v: AgentVisual;
  max?: string;
}): ReactNode {
  return (
    <span
      className={`inline-flex min-w-0 shrink items-center gap-1 rounded px-1.5 text-xs font-semibold leading-5 ${max}`}
      style={{ color: v.color, background: `${v.color}1f` }}
      title={[v.name, v.type, v.shortId].filter(Boolean).join(" · ")}
    >
      <v.Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{v.name}</span>
    </span>
  );
}

export interface CallRowProps {
  row: TreeRow;
  agents: ReadonlyMap<string, AgentNode>;
  /** Agent the call spawned (Task rows). */
  spawned?: AgentNode;
  density: RowDensity;
  touch: boolean;
  selected: boolean;
  /** Show the owning agent's name chip (flat mode, compact). */
  showAgentChip: boolean;
  /** Row can expand (inline body or Task block). */
  expandable: boolean;
  domId: string;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onToggle: (id: string) => void;
  /** Inline expanded body (no Detail column). */
  body?: ReactNode;
  /** Narrow timeline column: drop secondary chips, shorten paths. */
  narrow?: boolean;
}

export const CallRow = memo(function CallRow({
  row,
  agents,
  spawned,
  density,
  touch,
  selected,
  showAgentChip,
  expandable,
  domId,
  onSelect,
  onActivate,
  onToggle,
  body,
  narrow = false,
}: CallRowProps): ReactNode {
  const { t } = useTranslation();
  const call = row.call;
  const mainLabel = t("console.mainAgent");
  const v = agentVisual(call.agentId, agents.get(call.agentId), mainLabel);
  const sv = spawned ? agentVisual(spawned.id, spawned, mainLabel) : null;
  const sum = summarizeCall(call);
  const st = STATUS_STYLE[call.status];
  const dur = useDurationLabel(call);
  const compact = density === "compact";
  const tight = compact || narrow;
  const target =
    sum.renderer === "diff" ||
    sum.renderer === "write" ||
    sum.renderer === "read"
      ? shortenPath(sum.target, tight ? 34 : 90)
      : sum.target;
  const time = clockTime(call.startedAt);
  const isTask = sum.renderer === "task";
  const waiting = call.status === "waiting_permission";
  const statusLabel = t(st.labelKey);
  const label = [v.name, sum.label, sum.target, statusLabel, dur ?? ""]
    .filter(Boolean)
    .join(", ");
  const errLine =
    call.status === "error" && call.error ? call.error.split("\n")[0] : null;
  const pad = 10 + row.depth * INDENT_PX;

  return (
    // Spec 2.5: listbox options expose their expansion state (aria-expanded).
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      aria-expanded={expandable ? row.expanded : undefined}
      aria-label={label}
      data-call-id={call.id}
      className={`group relative cursor-pointer select-none ${st.tint} ${
        selected
          ? "bg-sky-400/[0.13] ring-1 ring-inset ring-sky-400/40"
          : "hover:bg-white/[0.04]"
      }`}
      onClick={() => onSelect(call.id)}
      onDoubleClick={() => onActivate(call.id)}
    >
      <Rails
        depth={row.depth}
        color={v.color}
        error={call.status === "error"}
      />
      <div
        className={`flex items-center gap-2 pr-2.5 ${touch ? "min-h-[44px]" : "min-h-[30px]"}`}
        style={{ paddingLeft: pad }}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={
              row.expanded ? t("console.collapse") : t("console.expand")
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggle(call.id);
            }}
            className={`-ml-1 flex shrink-0 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200 ${touch ? "h-8 w-8" : "h-5 w-5"}`}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${row.expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className={`-ml-1 shrink-0 ${touch ? "w-8" : "w-5"}`} />
        )}
        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
          {compact ? time.slice(0, 5) : time}
        </span>
        <span
          title={[v.name, v.type].filter(Boolean).join(" · ")}
          className="shrink-0"
        >
          <v.Icon
            className="h-3.5 w-3.5"
            style={{ color: v.color }}
            aria-hidden
          />
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <ToolGlyph
            name={call.toolName}
            className="h-3.5 w-3.5 text-slate-400"
          />
          <span
            className={`text-[13px] font-semibold text-slate-100 ${compact ? "" : "min-w-[3.5rem]"}`}
          >
            {sum.label}
          </span>
        </span>
        {showAgentChip && v.kind !== "main" && !compact && <AgentChip v={v} />}
        {isTask && sv ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className="inline-flex min-w-0 items-center gap-1 truncate text-[13px] font-semibold"
              style={{ color: sv.color }}
              title={spawned?.taskPreview ?? sv.name}
            >
              <sv.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{sv.name}</span>
            </span>
            {sv.type && !tight && (
              <span className="shrink-0 rounded bg-white/[0.06] px-1.5 text-xs leading-5 text-slate-300">
                {sv.type}
              </span>
            )}
            {sv.shortId && !tight && !touch && (
              <span className="shrink-0 font-mono text-xs text-slate-500">
                {sv.shortId}
              </span>
            )}
            {row.childCount > 0 && (
              <span className="shrink-0 text-xs text-slate-400">
                {t("console.nCalls", { count: row.childCount })}
              </span>
            )}
            {row.hiddenCount > 0 && (
              <span className="shrink-0 rounded bg-white/[0.06] px-1.5 text-xs leading-5 text-slate-400">
                {t("console.nHidden", { count: row.hiddenCount })}
              </span>
            )}
          </span>
        ) : (
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[13px] ${
              call.status === "denied"
                ? "text-slate-500 line-through"
                : "text-slate-300"
            }`}
            title={sum.target}
          >
            {target}
            {sum.suffix && <span className="text-slate-500">{sum.suffix}</span>}
          </span>
        )}
        {showAgentChip && v.kind !== "main" && compact && (
          <AgentChip v={v} max="max-w-[7rem]" />
        )}
        {sum.stat && !compact && (
          <span className="shrink-0 font-mono text-xs tabular-nums">
            {sum.stat.startsWith("+") ? (
              <>
                <span className="text-emerald-400">
                  {sum.stat.split(" ")[0]}
                </span>{" "}
                <span className="text-rose-400">{sum.stat.split(" ")[1]}</span>
              </>
            ) : (
              <span className="text-slate-400">{sum.stat}</span>
            )}
          </span>
        )}
        {waiting && (
          <span className="shrink-0 text-xs font-semibold text-amber-300">
            {compact ? t("console.waitingShort") : t("console.waitingForYou")}
          </span>
        )}
        {!compact &&
          (call.status === "denied" || call.status === "interrupted") && (
            <span
              className="shrink-0 text-xs text-slate-500"
              title={
                call.status === "denied" ? t("console.deniedHint") : undefined
              }
            >
              {statusLabel}
            </span>
          )}
        {dur && (
          <span
            className={`shrink-0 text-right font-mono text-xs tabular-nums ${
              waiting ? "text-amber-300" : "text-slate-400"
            } ${compact ? "" : "min-w-[3rem]"}`}
          >
            {dur}
          </span>
        )}
        <span className="flex w-4 shrink-0 justify-center" aria-hidden>
          <StatusGlyph status={call.status} />
        </span>
      </div>
      {errLine && (
        <div
          className="flex items-center gap-1.5 truncate pb-1 pr-3 font-mono text-xs text-rose-300"
          style={{ paddingLeft: pad + (touch ? 40 : 28) }}
          title={call.error ?? undefined}
        >
          <CornerDownRight className="h-3 w-3 shrink-0 text-rose-400/70" />
          <span className="truncate">{errLine}</span>
        </div>
      )}
      {body && (
        <div
          className="cursor-auto pb-2.5 pr-3 pt-0.5"
          style={{ paddingLeft: pad + 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      )}
    </div>
  );
});

/** Conversation marker: "▶ You …" / "◀ Claude …". */
export const MarkerRow = memo(function MarkerRow({
  entry,
  density,
  touch,
  onOpen,
}: {
  entry: ConversationEntry;
  density: RowDensity;
  touch: boolean;
  onOpen?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const user = entry.role === "user";
  const time = clockTime(entry.timestamp);
  const text = entry.text.replace(/\s+/g, " ").trim();
  return (
    <div
      role="presentation"
      onClick={onOpen}
      className={`relative flex items-center gap-2 pr-3 ${touch ? "min-h-[44px]" : "min-h-[30px]"} ${
        user ? "bg-cyan-400/[0.05]" : "bg-orange-400/[0.05]"
      } ${onOpen ? "cursor-pointer hover:bg-white/[0.05]" : ""}`}
      style={{ paddingLeft: touch ? 42 : 30 }}
      title={entry.text.slice(0, 600)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: user ? "#22D3EE" : MAIN_COLOR }}
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
        {density === "compact" ? time.slice(0, 5) : time}
      </span>
      {user ? (
        <User className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />
      ) : (
        <MessageSquare
          className="h-3.5 w-3.5 shrink-0 text-orange-300"
          aria-hidden
        />
      )}
      <span
        className={`shrink-0 text-[13px] font-semibold ${user ? "text-cyan-200" : "text-orange-200"}`}
      >
        {user ? t("console.you") : t("conversation.claude")}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-slate-300">
        {text}
      </span>
    </div>
  );
});

/** Closes an open subagent block: "↩ result …  3m12s". */
export const ResultRow = memo(function ResultRow({
  agent,
  depth,
  touch,
  onSelect,
}: {
  agent: AgentNode;
  depth: number;
  touch: boolean;
  onSelect?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const v = agentVisual(agent.id, agent, t("console.mainAgent"));
  const pad = 10 + depth * INDENT_PX;
  const dur =
    agent.startedAt && agent.endedAt
      ? formatDuration(Date.parse(agent.endedAt) - Date.parse(agent.startedAt))
      : null;
  const zombie = agent.state === "zombie";
  return (
    <div
      role="presentation"
      onClick={onSelect}
      className={`relative flex items-center gap-2 pr-3 ${touch ? "min-h-[44px]" : "min-h-[30px]"} ${onSelect ? "cursor-pointer hover:bg-white/[0.04]" : ""}`}
      style={{ paddingLeft: pad }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: v.color }}
      />
      <span
        aria-hidden
        className="absolute top-0 h-1/2 w-[2px] rounded-b-full"
        style={{
          left: 10 + (depth - 1) * INDENT_PX + 5,
          background: `${v.color}66`,
        }}
      />
      <span className={`-ml-1 shrink-0 ${touch ? "w-8" : "w-5"}`} />
      <CornerDownRight
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: v.color }}
        aria-hidden
      />
      <span
        className="shrink-0 text-xs font-semibold"
        style={{ color: v.color }}
      >
        {zombie ? t("console.zombie") : t("console.result")}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[13px] text-slate-300"
        title={agent.resultPreview ?? undefined}
      >
        {agent.resultPreview?.replace(/\s+/g, " ") ?? ""}
      </span>
      {dur && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
          {dur}
        </span>
      )}
    </div>
  );
});
