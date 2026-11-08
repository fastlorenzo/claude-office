"use client";

/**
 * Session Console (spec 2.3): header, agent tree, timeline and a right pane
 * (Detail · Chat · Todos · Git). One component, three presentations (sheet,
 * dock, compact); the inner layout follows the container width:
 *   >= 1280 px  tree | timeline | right pane
 *   800-1279    timeline (agent chip bar) | right pane
 *   < 800       tabs Timeline · Agents · Chat · Todos · Git, detail pushed
 *
 * `SessionConsoleView` is presentational (takes a `ConsoleSession`);
 * `SessionConsole` connects it to consoleStore, the selected session's live
 * game state and campus PR data.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useSessionConsole } from "@/hooks/useSessionConsole";
import { useCampusStore } from "@/stores/campusStore";
import type { ConsoleSession } from "@/stores/consoleStore";
import {
  selectConversation,
  selectGitStatus,
  selectSessionId,
  selectTodos,
  useGameStore,
} from "@/stores/gameStore";
import type { PullRequestInfo } from "@/engine/contracts";
import type { GroupMode } from "@/utils/console/tree";
import type { AgentNode, ToolCall } from "@/utils/console/types";
import { ConversationView } from "@/components/layout/ConversationHistory";
import { AgentChipBar, AgentTree, nodeState } from "./AgentTree";
import { ConsoleFilters } from "./ConsoleFilters";
import { ConsoleHeader, type CrossLink } from "./ConsoleHeader";
import { GitSection, TodosSection } from "./ConsoleSections";
import { Timeline } from "./Timeline";
import { inputText, ToolCallDetail } from "./ToolCallDetail";
import { CARD } from "./theme";
import { handleConsoleKey, useConsoleUi, type ConsoleUi } from "./useConsoleUi";

export type ConsolePresentation = "sheet" | "dock" | "compact";
type Layout = "three" | "two" | "one" | "compact";
type RightTab = "detail" | "chat" | "todos" | "git";
type MobileTab = "timeline" | "agents" | RightTab;

const RIGHT_TABS: RightTab[] = ["detail", "chat", "todos", "git"];
const MOBILE_TABS: MobileTab[] = ["timeline", "agents", "chat", "todos", "git"];
const GUESS_WIDTH: Record<ConsolePresentation, number> = {
  sheet: 1400,
  dock: 640,
  compact: 420,
};
/** Below this width a selected row pushes a full-height detail view. */
const PUSH_DETAIL_PX = 560;
const NO_AGENTS: ReadonlyMap<string, AgentNode> = new Map();

function layoutFor(p: ConsolePresentation, w: number): Layout {
  if (p === "compact") return "compact";
  if (w >= 1280) return "three";
  if (w >= 800) return "two";
  return "one";
}

/** Container width via ResizeObserver; `fixed` overrides (tests). */
function useWidth(
  ref: React.RefObject<HTMLElement | null>,
  guess: number,
  fixed?: number,
): { width: number; ready: boolean } {
  const [w, setW] = useState(fixed ?? guess);
  const [ready, setReady] = useState(fixed !== undefined);
  useLayoutEffect(() => {
    if (fixed !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setW(width);
    };
    read();
    setReady(true);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fixed]);
  return { width: fixed ?? w, ready: fixed !== undefined || ready };
}

function useCountsOf(session: ConsoleSession | undefined, ui: ConsoleUi) {
  return useMemo(() => {
    const agents = session?.agents ?? NO_AGENTS;
    let running = 0;
    for (const a of agents.values()) if (nodeState(a) === "running") running++;
    return {
      agents: agents.size,
      running,
      calls: ui.totalCalls,
      errors: ui.errorCount,
    };
  }, [session?.agents, ui.totalCalls, ui.errorCount]);
}

function TabBar<T extends string>({
  tabs,
  active,
  onPick,
  label,
  labels,
  touch,
  badges,
}: {
  tabs: readonly T[];
  active: T;
  onPick: (t: T) => void;
  label: string;
  labels: Record<T, string>;
  touch?: boolean;
  badges?: Partial<Record<T, number>>;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-white/[0.06] px-2"
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          onClick={() => onPick(tab)}
          className={`relative shrink-0 px-3 text-xs font-semibold uppercase tracking-[0.1em] transition-colors ${touch ? "min-h-[44px]" : "py-2.5"} ${
            tab === active
              ? "text-slate-50"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          {labels[tab]}
          {badges?.[tab] ? (
            <span className="ml-1.5 rounded-full bg-white/10 px-1.5 text-xs font-medium normal-case tracking-normal text-slate-300">
              {badges[tab]}
            </span>
          ) : null}
          {tab === active && (
            <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-orange-400" />
          )}
        </button>
      ))}
    </div>
  );
}

export interface SessionConsoleViewProps {
  sessionId: string;
  session: ConsoleSession | undefined;
  presentation: ConsolePresentation;
  /** Select and reveal this call on open. */
  focusCallId?: string | null;
  pr?: PullRequestInfo | null;
  onClose?: () => void;
  onEnterRoom?: () => void;
  crossLink?: CrossLink | null;
  onLoadOlder?: () => void;
  /** Compact: open the full console focused on a call (else expand inline). */
  onOpenCall?: (callId: string) => void;
  /** Fixed container width (tests); measured otherwise. */
  width?: number;
  initialMode?: GroupMode;
}

export function SessionConsoleView({
  sessionId,
  session,
  presentation,
  focusCallId,
  pr,
  onClose,
  onEnterRoom,
  crossLink,
  onLoadOlder,
  onOpenCall,
  width: fixedWidth,
  initialMode,
}: SessionConsoleViewProps): ReactNode {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { width, ready } = useWidth(
    rootRef,
    GUESS_WIDTH[presentation],
    fixedWidth,
  );
  const layout = layoutFor(presentation, width);
  const touch = layout === "one" && width < PUSH_DETAIL_PX;
  const ui = useConsoleUi(session, { focusCallId, initialMode });
  const counts = useCountsOf(session, ui);
  const agents = session?.agents ?? NO_AGENTS;
  const [rightTab, setRightTab] = useState<RightTab>("detail");
  const [mobileTab, setMobileTab] = useState<MobileTab>("timeline");
  const [pushed, setPushed] = useState(false);
  const [autoLoadFor, setAutoLoadFor] = useState<string | null>(null);
  const listId = `console-${sessionId.replace(/[^\w-]/g, "_")}-${presentation}`;
  const hasDetailCol = layout === "three" || layout === "two";
  const timelineWidth =
    layout === "three"
      ? width - 280 - Math.min(640, Math.max(480, width * 0.34))
      : layout === "two"
        ? width * 0.56
        : width;

  // Deep link: show the focused call's detail.
  const [shownFocus, setShownFocus] = useState<string | null>(null);
  if (
    ready &&
    focusCallId &&
    focusCallId !== shownFocus &&
    session?.calls.has(focusCallId)
  ) {
    setShownFocus(focusCallId);
    if (touch) setPushed(true);
    else if (hasDetailCol) setRightTab("detail");
    else if (!ui.isTaskRow(focusCallId)) ui.toggleExpand(focusCallId);
  }

  const selected: ToolCall | undefined = ui.selectedId
    ? session?.calls.get(ui.selectedId)
    : undefined;

  const select = ui.select;
  const toggleExpand = ui.toggleExpand;
  const isTaskRow = ui.isTaskRow;

  const activate = useCallback(
    (id: string) => {
      select(id);
      if (layout === "compact") {
        if (onOpenCall) onOpenCall(id);
        else toggleExpand(id);
        return;
      }
      if (isTaskRow(id)) toggleExpand(id);
      if (hasDetailCol) setRightTab("detail");
      else if (touch) setPushed(true);
      else if (!isTaskRow(id)) toggleExpand(id);
    },
    [select, layout, onOpenCall, toggleExpand, isTaskRow, hasDetailCol, touch],
  );

  // A click selects; in pushed / detail layouts it also shows the detail.
  const onRowSelect = useCallback(
    (id: string | null) => {
      select(id);
      if (!id) return;
      if (layout === "compact" && onOpenCall) onOpenCall(id);
      else if (hasDetailCol) setRightTab("detail");
      else if (touch) setPushed(true);
    },
    [select, layout, onOpenCall, hasDetailCol, touch],
  );
  const timelineUi = useMemo(
    () => ({ ...ui, select: onRowSelect }),
    [ui, onRowSelect],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const handled = handleConsoleKey(e.nativeEvent, ui, {
      activate,
      focusSearch: () => searchRef.current?.focus(),
      copyInput: (id) => {
        const c = session?.calls.get(id);
        if (c) void navigator.clipboard?.writeText(inputText(c));
      },
      openFull: (id) => {
        setAutoLoadFor(id);
        if (hasDetailCol) setRightTab("detail");
        else if (touch) setPushed(true);
      },
      setTab:
        layout === "compact"
          ? undefined
          : (i) => {
              if (hasDetailCol) {
                if (RIGHT_TABS[i]) setRightTab(RIGHT_TABS[i]);
              } else if (MOBILE_TABS[i]) {
                setMobileTab(MOBILE_TABS[i]);
                setPushed(false);
              }
            },
      escape: () => {
        if (pushed) {
          setPushed(false);
          return true;
        }
        return false;
      },
      close: onClose,
    });
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const renderInline = useCallback(
    (call: ToolCall) => (
      <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/30">
        <ToolCallDetail
          sessionId={sessionId}
          call={call}
          agents={agents}
          hideHeader
        />
      </div>
    ),
    [sessionId, agents],
  );

  const detailPane = selected ? (
    <ToolCallDetail
      key={selected.id}
      sessionId={sessionId}
      call={selected}
      agents={agents}
      autoLoad={autoLoadFor === selected.id}
    />
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
      <span className="text-[13px] text-slate-400">
        {t("console.selectRow")}
      </span>
      <span className="text-xs text-slate-600">{t("console.keysHint")}</span>
    </div>
  );

  const rightLabels: Record<RightTab, string> = {
    detail: t("console.tab.detail"),
    chat: t("console.tab.chat"),
    todos: t("console.tab.todos"),
    git: t("console.tab.git"),
  };
  const conversation = session?.conversation ?? [];
  const todos = session?.todos ?? [];
  const rightBody = (tab: RightTab) =>
    tab === "detail" ? (
      detailPane
    ) : tab === "chat" ? (
      <div className="flex min-h-0 flex-1 flex-col [&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent">
        <ConversationView
          conversation={conversation}
          agents={agents}
          showHeader={false}
        />
      </div>
    ) : tab === "todos" ? (
      <TodosSection todos={todos} />
    ) : (
      <GitSection git={session?.gitStatus ?? null} />
    );

  const timeline = (density: "full" | "compact") => (
    <Timeline
      ui={timelineUi}
      session={session}
      density={density}
      touch={touch}
      listId={listId}
      label={t("console.timeline")}
      renderBody={
        hasDetailCol || touch || (layout === "compact" && onOpenCall)
          ? undefined
          : renderInline
      }
      narrow={timelineWidth < 720}
      onActivate={activate}
      onMarker={hasDetailCol ? () => setRightTab("chat") : undefined}
      onLoadOlder={onLoadOlder}
    />
  );

  const header =
    layout === "compact" ? null : (
      <ConsoleHeader
        sessionId={sessionId}
        header={session?.header ?? null}
        counts={counts}
        pr={pr}
        compact={layout === "one"}
        touch={touch}
        onErrors={ui.toggleErrors}
        onEnterRoom={onEnterRoom}
        crossLink={crossLink}
        onClose={onClose}
      />
    );

  let body: ReactNode;
  if (session?.status === "missing" || session?.status === "error") {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
        <span className="text-[13px] text-slate-300">
          {session.status === "missing"
            ? t("console.unavailable")
            : t("console.loadFailed")}
        </span>
        <span className="text-xs text-slate-500">
          {session.status === "missing"
            ? t("console.unavailableHint")
            : session.errorMessage}
        </span>
      </div>
    );
  } else if (layout === "three") {
    body = (
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-white/[0.06]">
          <AgentTree
            agents={agents}
            selected={ui.agentRoots}
            onPick={(id, add) => ui.pickAgent(id, add)}
            onLocate={(id) => {
              const sid = agents.get(id)?.spawnToolUseId;
              if (sid) ui.reveal(sid);
            }}
          />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <ConsoleFilters ui={ui} variant="full" searchRef={searchRef} />
          {timeline("full")}
        </section>
        <aside className="flex w-[clamp(480px,34%,640px)] shrink-0 flex-col border-l border-white/[0.06]">
          <TabBar
            tabs={RIGHT_TABS}
            active={rightTab}
            onPick={setRightTab}
            label={t("console.rightPane")}
            labels={rightLabels}
            badges={{ todos: todos.length || undefined }}
          />
          {rightBody(rightTab)}
        </aside>
      </div>
    );
  } else if (layout === "two") {
    body = (
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <AgentChipBar
            agents={agents}
            selected={ui.agentRoots}
            onPick={(id, add) => ui.pickAgent(id, add)}
          />
          <ConsoleFilters ui={ui} variant="full" searchRef={searchRef} />
          {timeline("full")}
        </section>
        <aside className="flex w-[44%] min-w-[340px] max-w-[560px] shrink-0 flex-col border-l border-white/[0.06]">
          <TabBar
            tabs={RIGHT_TABS}
            active={rightTab}
            onPick={setRightTab}
            label={t("console.rightPane")}
            labels={rightLabels}
          />
          {rightBody(rightTab)}
        </aside>
      </div>
    );
  } else if (layout === "one") {
    const mobileLabels: Record<MobileTab, string> = {
      timeline: t("console.tab.timeline"),
      agents: t("console.tab.agents"),
      ...rightLabels,
    };
    body =
      pushed && selected ? (
        <ToolCallDetail
          key={selected.id}
          sessionId={sessionId}
          call={selected}
          agents={agents}
          onBack={() => setPushed(false)}
          autoLoad={autoLoadFor === selected.id}
        />
      ) : (
        <>
          <TabBar
            tabs={MOBILE_TABS.filter((x) => x !== "detail")}
            active={mobileTab}
            onPick={setMobileTab}
            label={t("console.tabs")}
            labels={mobileLabels}
            touch={touch}
          />
          {mobileTab === "timeline" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ConsoleFilters
                ui={ui}
                variant="compact"
                touch={touch}
                searchRef={searchRef}
              />
              {timeline("full")}
            </div>
          ) : mobileTab === "agents" ? (
            <AgentTree
              agents={agents}
              selected={ui.agentRoots}
              onPick={(id, add) => {
                ui.pickAgent(id, add);
                setMobileTab("timeline");
              }}
            />
          ) : (
            rightBody(mobileTab)
          )}
        </>
      );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentChipBar
          agents={agents}
          selected={ui.agentRoots}
          onPick={(id, add) => ui.pickAgent(id, add)}
        />
        <ConsoleFilters ui={ui} variant="compact" searchRef={searchRef} />
        {timeline("compact")}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-hud-keytrap
      data-console-root
      data-layout={layout}
      onKeyDown={onKeyDown}
      className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden text-[13px] text-slate-200 ${
        presentation === "sheet" ? CARD : ""
      }`}
    >
      {header}
      {body}
    </div>
  );
}

/** Open PR of the session's branch, from campus data. */
function usePr(
  sessionId: string,
  branch: string | null | undefined,
): PullRequestInfo | null {
  const projects = useCampusStore((s) => s.projects);
  return useMemo(() => {
    if (!projects || !branch) return null;
    const own = projects.filter((p) => p.sessionIds?.includes(sessionId));
    for (const p of own.length ? own : projects) {
      const pr = p.pullRequests?.find(
        (x) => x.branch === branch && x.state === "open",
      );
      if (pr) return pr;
    }
    return null;
  }, [projects, branch, sessionId]);
}

/**
 * Connected console for any session. For the selected session the
 * conversation, todos and git status come from the live game state.
 */
export function SessionConsole({
  sessionId,
  ...rest
}: Omit<SessionConsoleViewProps, "session" | "pr" | "onLoadOlder"> & {
  sessionId: string;
}): ReactNode {
  const selectedId = useGameStore(selectSessionId);
  const { session, loadOlder } = useSessionConsole(sessionId, selectedId);
  const isSelected = sessionId === selectedId;
  const conversation = useGameStore(selectConversation);
  const todos = useGameStore(selectTodos);
  const git = useGameStore(selectGitStatus);
  const view = useMemo<ConsoleSession | undefined>(() => {
    if (!session || !isSelected) return session;
    return {
      ...session,
      conversation: conversation.length ? conversation : session.conversation,
      todos: todos.length ? todos : session.todos,
      gitStatus: git ?? session.gitStatus,
    };
  }, [session, isSelected, conversation, todos, git]);
  const pr = usePr(sessionId, session?.header?.branch);
  return (
    <SessionConsoleView
      {...rest}
      sessionId={sessionId}
      session={view}
      pr={pr}
      onLoadOlder={() => void loadOlder()}
    />
  );
}
