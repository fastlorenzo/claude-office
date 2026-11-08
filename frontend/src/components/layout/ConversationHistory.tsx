/**
 * ConversationHistory - Chat-style view of user prompts, Claude responses,
 * thinking blocks, and tool calls.
 *
 * `ConversationView` is the presentational part, reused as the Session
 * Console's Chat tab. Every assistant / thinking / tool entry carries its
 * agent's identity (colour, icon, name) from the agent tree, so the main
 * agent and each subagent are told apart at a glance. Live-follow pauses
 * when you scroll up (same behaviour as the timeline).
 */

"use client";

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useGameStore, selectConversation } from "@/stores/gameStore";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Maximize2,
  MessageSquare,
  User,
  Wrench,
  X,
} from "lucide-react";
import type { ConversationEntry } from "@/types";
import type { AgentNode } from "@/utils/console/types";
import { useTranslation } from "@/hooks/useTranslation";
import { followReducer, INITIAL_FOLLOW } from "@/utils/console/followScroll";
import { clockTime } from "@/components/console/clock";
import { FollowPill } from "@/components/console/FollowPill";
import { Markdown } from "@/components/console/renderers/Markdown";
import { useSelectedAgents } from "@/components/console/selectedAgents";
import { agentVisual, type AgentVisual } from "@/components/console/theme";
import { AgentChip, ToolGlyph } from "@/components/console/TimelineRow";

type Identify = (agentId: string) => AgentVisual;

function ThinkingEntry({
  entry,
  who,
}: {
  entry: ConversationEntry;
  who: AgentVisual;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isLong = entry.text.length > 240;
  const preview = isLong ? entry.text.slice(0, 240) + "…" : entry.text;
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/[0.07] px-2.5 py-1.5"
      style={{ borderLeft: `3px solid ${who.color}` }}
    >
      <Brain size={14} className="mt-0.5 shrink-0 text-indigo-300" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
            {t("conversation.thinking")}
          </span>
          {who.kind !== "main" && <AgentChip v={who} />}
        </div>
        <p className="whitespace-pre-wrap break-words text-[13px] italic leading-relaxed text-indigo-100/70">
          {expanded ? entry.text : preview}
        </p>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 flex items-center gap-1 text-xs text-indigo-300 transition-colors hover:text-indigo-200"
          >
            {expanded ? (
              <>
                <ChevronDown size={12} /> {t("conversation.collapse")}
              </>
            ) : (
              <>
                <ChevronRight size={12} /> {t("conversation.showMore")}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolEntry({
  entry,
  who,
}: {
  entry: ConversationEntry;
  who: AgentVisual;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1"
      style={{ borderLeft: `3px solid ${who.color}` }}
      title={who.name}
    >
      <who.Icon size={13} className="shrink-0" style={{ color: who.color }} />
      <ToolGlyph
        name={entry.toolName ?? ""}
        className="h-[13px] w-[13px] shrink-0 text-slate-400"
      />
      <span className="shrink-0 text-xs font-semibold text-slate-200">
        {entry.toolName}
      </span>
      <span className="truncate font-mono text-xs text-slate-400">
        {entry.text}
      </span>
    </div>
  );
}

function UserEntry({ entry }: { entry: ConversationEntry }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%]">
        <div className="mb-1 flex items-center justify-end gap-1.5 text-xs">
          <span className="text-slate-500">{clockTime(entry.timestamp)}</span>
          <span className="inline-flex items-center gap-1 font-semibold text-cyan-300">
            <User size={12} />
            {t("console.you")}
          </span>
        </div>
        <div className="rounded-xl rounded-tr-sm border border-cyan-400/30 bg-cyan-500/[0.12] px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-cyan-50">
            {entry.text}
          </p>
        </div>
      </div>
    </div>
  );
}

function AssistantEntry({
  entry,
  who,
}: {
  entry: ConversationEntry;
  who: AgentVisual;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isLong = entry.text.length > 1200;
  const preview = isLong ? entry.text.slice(0, 1200) + "…" : entry.text;
  return (
    <div className="flex w-full max-w-[94%] flex-col items-start">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <AgentChip v={who} max="max-w-[16rem]" />
        {who.type && <span className="text-slate-500">{who.type}</span>}
        <span className="text-slate-500">{clockTime(entry.timestamp)}</span>
      </div>
      <div
        className="w-full rounded-xl rounded-tl-sm border border-white/[0.07] bg-white/[0.035] px-3 py-2"
        style={{ borderLeft: `3px solid ${who.color}` }}
      >
        <Markdown text={expanded ? entry.text : preview} />
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-200"
          >
            {expanded ? (
              <>
                <ChevronDown size={12} /> {t("conversation.collapse")}
              </>
            ) : (
              <>
                <ChevronRight size={12} /> {t("conversation.showFullResponse")}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function Entries({
  visible,
  identify,
}: {
  visible: readonly ConversationEntry[];
  identify: Identify;
}) {
  return (
    <>
      {visible.map((entry) => {
        switch (entry.role) {
          case "user":
            return <UserEntry key={entry.id} entry={entry} />;
          case "assistant":
            return (
              <AssistantEntry
                key={entry.id}
                entry={entry}
                who={identify(entry.agentId)}
              />
            );
          case "thinking":
            return (
              <ThinkingEntry
                key={entry.id}
                entry={entry}
                who={identify(entry.agentId)}
              />
            );
          case "tool":
            return (
              <ToolEntry
                key={entry.id}
                entry={entry}
                who={identify(entry.agentId)}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** Scrollable, live-following list of entries. */
function FollowList({
  visible,
  identify,
  emptyText,
}: {
  visible: readonly ConversationEntry[];
  identify: Identify;
  emptyText: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const [follow, dispatch] = useReducer(followReducer, INITIAL_FOLLOW);
  const count = visible.length;
  const prev = useRef(count);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || follow.mode !== "following") return;
    const target = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - target) > 1) {
      programmatic.current = true;
      el.scrollTop = target;
    }
  }, [count, follow.mode]);

  useEffect(() => {
    const d = count - prev.current;
    prev.current = count;
    if (d > 0) dispatch({ type: "rows", count: d });
  }, [count]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        className="h-full space-y-2.5 overflow-y-auto p-3"
        onScroll={() => {
          const el = ref.current;
          if (!el) return;
          const user = !programmatic.current;
          programmatic.current = false;
          dispatch({
            type: "scroll",
            distanceFromBottom:
              el.scrollHeight - el.scrollTop - el.clientHeight,
            userInitiated: user,
          });
        }}
        onWheel={() => (programmatic.current = false)}
        onTouchStart={() => (programmatic.current = false)}
      >
        {count === 0 ? (
          <div className="p-4 text-center text-[13px] italic text-slate-500">
            {emptyText}
          </div>
        ) : (
          <Entries visible={visible} identify={identify} />
        )}
      </div>
      <FollowPill
        follow={follow}
        onResume={() => dispatch({ type: "resume" })}
      />
    </div>
  );
}

/**
 * Presentational conversation: header (count, tool toggle, optional expand)
 * and the live-following entry list.
 */
export function ConversationView({
  conversation,
  agents,
  onExpand,
  onClose,
  showHeader = true,
}: {
  conversation: readonly ConversationEntry[];
  agents: ReadonlyMap<string, AgentNode>;
  onExpand?: () => void;
  onClose?: () => void;
  showHeader?: boolean;
}) {
  const { t } = useTranslation();
  const [showTools, setShowTools] = useState(false);
  const mainLabel = t("console.mainAgent");
  const identify = useMemo<Identify>(
    () => (id: string) =>
      agentVisual(id || "main", agents.get(id || "main"), mainLabel),
    [agents, mainLabel],
  );

  const toolCount = conversation.filter((e) => e.role === "tool").length;
  const messageCount = conversation.filter(
    (e) => e.role === "user" || e.role === "assistant",
  ).length;
  const visible = useMemo(
    () =>
      showTools ? conversation : conversation.filter((e) => e.role !== "tool"),
    [conversation, showTools],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-xs">
      {showHeader && (
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-slate-900/80 px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
            <MessageSquare size={14} className="text-cyan-400" />
            {t("conversation.title")}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">
              {t("conversation.msgs", { count: messageCount })}
            </span>
            <button
              onClick={() => setShowTools(!showTools)}
              aria-pressed={showTools}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-bold transition-colors ${
                showTools
                  ? "border-amber-500/40 bg-amber-500/20 text-amber-300"
                  : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200"
              }`}
              title={
                showTools
                  ? t("conversation.hideToolCalls")
                  : t("conversation.showToolCalls")
              }
            >
              <Wrench size={12} />
              {toolCount}
            </button>
            {onExpand && (
              <button
                onClick={onExpand}
                className="rounded p-0.5 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                title={t("conversation.expandConversation")}
                aria-label={t("conversation.expandConversation")}
              >
                <Maximize2 size={14} />
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="rounded p-0.5 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                title={t("conversation.close")}
                aria-label={t("conversation.close")}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      <FollowList
        visible={visible}
        identify={identify}
        emptyText={t("conversation.noConversation")}
      />
    </div>
  );
}

/** Connected conversation of the selected session (C panel, 2D sidebar). */
export function ConversationHistory() {
  const conversation = useGameStore(selectConversation);
  const agents = useSelectedAgents();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [expanded]);

  return (
    <>
      <ConversationView
        conversation={conversation}
        agents={agents}
        onExpand={() => setExpanded(true)}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex overflow-hidden rounded-xl shadow-2xl"
            style={{ width: "min(900px, 92vw)", height: "85vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <ConversationView
              conversation={conversation}
              agents={agents}
              onClose={() => setExpanded(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
