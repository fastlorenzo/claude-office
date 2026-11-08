"use client";

/**
 * View state of one console or compact timeline: filters, grouping,
 * expansion, selection and live-follow, plus the keyboard map (spec 2.5).
 * Data comes from a `ConsoleSession` (consoleStore); nothing here is shared
 * between mounts.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ConsoleSession } from "@/stores/consoleStore";
import { isUnfiltered, type ConsoleFilters } from "@/utils/console/filters";
import {
  followReducer,
  INITIAL_FOLLOW,
  type FollowEvent,
  type FollowState,
} from "@/utils/console/followScroll";
import type { ToolKind } from "@/utils/console/toolFormat";
import {
  agentWithDescendants,
  flattenVisible,
  type GroupMode,
} from "@/utils/console/tree";
import type { AgentNode, ToolCall } from "@/utils/console/types";
import {
  agentsBySpawn,
  buildDisplayRows,
  markerEntries,
  type DisplayRow,
} from "./displayRows";

const SEARCH_DEBOUNCE_MS = 150;
const NO_AGENTS: ReadonlyMap<string, AgentNode> = new Map();
const NO_CALLS: ReadonlyMap<string, ToolCall> = new Map();

export interface ConsoleUi {
  filters: ConsoleFilters;
  /** Raw search box text (filters.query trails it by 150 ms). */
  queryInput: string;
  setQueryInput: (q: string) => void;
  /** Agent ids picked as filter roots (descendants are implied). */
  agentRoots: readonly string[];
  /** Pick an agent (and its descendants); `additive` = shift-click. Null = all. */
  pickAgent: (id: string | null, additive?: boolean) => void;
  /** `a`: all -> main -> each subagent -> all. */
  cycleAgent: () => void;
  toggleKind: (k: ToolKind) => void;
  toggleErrors: () => void;
  toggleWaiting: () => void;
  clearFilters: () => void;
  mode: GroupMode;
  toggleMode: () => void;
  /** Rows to render (calls, markers, result rows). */
  rows: DisplayRow[];
  /** Total calls held, and how many pass the filters (call rows). */
  totalCalls: number;
  errorCount: number;
  waitingCount: number;
  selectedId: string | null;
  select: (id: string | null) => void;
  /** Select a call and scroll it into view. */
  reveal: (id: string) => void;
  /** Toggle a row: Task rows open/close their block, others expand inline. */
  toggleExpand: (id: string) => void;
  isTaskRow: (id: string) => boolean;
  follow: FollowState;
  followDispatch: (e: FollowEvent) => void;
  /** Bumped to ask the list to scroll the selected row into view. */
  scrollNonce: number;
  /** Move selection by `delta` call rows (j/k). */
  move: (delta: number) => void;
  /** Next/previous error row ([ / ]). */
  jumpError: (dir: 1 | -1) => void;
  /** `←`: collapse the selected row, or jump to its parent Task row. */
  collapseOrParent: () => void;
  /** Jump to first/last row (g / G). */
  jumpEdge: (end: "top" | "bottom") => void;
}

function toggleIn<T>(set: ReadonlySet<T>, v: T): Set<T> {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
}

export function useConsoleUi(
  session: ConsoleSession | undefined,
  opts: { focusCallId?: string | null; initialMode?: GroupMode } = {},
): ConsoleUi {
  const calls = session?.calls ?? NO_CALLS;
  const order = session?.order;
  const agents = session?.agents ?? NO_AGENTS;
  const conversation = session?.conversation;

  const [queryInput, setQueryInputRaw] = useState("");
  const [query, setQuery] = useState("");
  const [agentRoots, setAgentRoots] = useState<string[]>([]);
  const [kinds, setKinds] = useState<ReadonlySet<ToolKind>>(new Set());
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [mode, setMode] = useState<GroupMode>(opts.initialMode ?? "tree");
  const [collapsedTasks, setCollapsedTasks] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, followDispatch] = useReducer(followReducer, INITIAL_FOLLOW);
  const [scrollNonce, setScrollNonce] = useState(0);

  // Debounced search.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setQueryInput = useCallback((q: string) => {
    setQueryInputRaw(q);
    if (timer.current) clearTimeout(timer.current);
    if (q === "") {
      setQuery("");
      return;
    }
    timer.current = setTimeout(() => setQuery(q), SEARCH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const agentIds = useMemo(() => {
    const out = new Set<string>();
    for (const r of agentRoots) {
      for (const id of agentWithDescendants(agents, r)) out.add(id);
    }
    return out;
  }, [agentRoots, agents]);

  const filters = useMemo<ConsoleFilters>(
    () => ({ agentIds, kinds, errorsOnly, waitingOnly, query }),
    [agentIds, kinds, errorsOnly, waitingOnly, query],
  );

  const bySpawn = useMemo(() => agentsBySpawn(agents), [agents]);
  const taskIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of calls.values()) {
      if (c.spawnedAgentId || bySpawn.has(c.id)) s.add(c.id);
    }
    return s;
  }, [calls, bySpawn]);

  const expanded = useMemo(() => {
    const s = new Set(openRows);
    for (const id of taskIds) if (!collapsedTasks.has(id)) s.add(id);
    return s;
  }, [openRows, taskIds, collapsedTasks]);

  const flat = useMemo(
    () =>
      order
        ? flattenVisible(calls, order, agents, expanded, filters, mode)
        : [],
    [calls, order, agents, expanded, filters, mode],
  );

  const markers = useMemo(
    () =>
      conversation && isUnfiltered(filters) ? markerEntries(conversation) : [],
    [conversation, filters],
  );

  const rows = useMemo(
    () => buildDisplayRows(flat, agents, markers, { results: mode === "tree" }),
    [flat, agents, markers, mode],
  );

  const { errorCount, waitingCount } = useMemo(() => {
    let e = 0;
    let w = 0;
    for (const c of calls.values()) {
      if (c.status === "error") e++;
      else if (c.status === "waiting_permission") w++;
    }
    return { errorCount: e, waitingCount: w };
  }, [calls]);

  const callIndex = useMemo(() => {
    const ids: string[] = [];
    for (const r of rows) if (r.kind === "call") ids.push(r.key);
    return ids;
  }, [rows]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) followDispatch({ type: "interact" });
  }, []);

  const selectAndScroll = useCallback(
    (id: string | null) => {
      select(id);
      setScrollNonce((n) => n + 1);
    },
    [select],
  );

  const isTaskRow = useCallback((id: string) => taskIds.has(id), [taskIds]);

  const toggleExpand = useCallback(
    (id: string) => {
      followDispatch({ type: "interact" });
      if (taskIds.has(id)) setCollapsedTasks((s) => toggleIn(s, id));
      else setOpenRows((s) => toggleIn(s, id));
    },
    [taskIds],
  );

  // Focus one call on open (deep link / "open console focused on that call").
  const focusCallId = opts.focusCallId ?? null;
  const [focusedFor, setFocusedFor] = useState<string | null>(null);
  if (focusCallId && focusCallId !== focusedFor && calls.has(focusCallId)) {
    setFocusedFor(focusCallId);
    // Re-open the ancestor Task blocks so the row is visible.
    const target = calls.get(focusCallId)!;
    let agent = agents.get(target.agentId);
    const reopen: string[] = [];
    for (let i = 0; agent && agent.spawnToolUseId && i < 16; i++) {
      reopen.push(agent.spawnToolUseId);
      const spawn = calls.get(agent.spawnToolUseId);
      agent = spawn ? agents.get(spawn.agentId) : undefined;
    }
    if (reopen.some((id) => collapsedTasks.has(id))) {
      const next = new Set(collapsedTasks);
      for (const id of reopen) next.delete(id);
      setCollapsedTasks(next);
    }
    setSelectedId(focusCallId);
    followDispatch({ type: "interact" });
    setScrollNonce((n) => n + 1);
  }

  const move = useCallback(
    (delta: number) => {
      if (callIndex.length === 0) return;
      const i = selectedId ? callIndex.indexOf(selectedId) : -1;
      const next =
        i < 0
          ? delta > 0
            ? 0
            : callIndex.length - 1
          : Math.max(0, Math.min(callIndex.length - 1, i + delta));
      selectAndScroll(callIndex[next]);
    },
    [callIndex, selectedId, selectAndScroll],
  );

  const jumpError = useCallback(
    (dir: 1 | -1) => {
      if (callIndex.length === 0) return;
      const start = selectedId ? callIndex.indexOf(selectedId) : -1;
      const n = callIndex.length;
      for (let step = 1; step <= n; step++) {
        const i =
          start < 0
            ? dir > 0
              ? step - 1
              : n - step
            : (start + dir * step + n * 2) % n;
        if (calls.get(callIndex[i])?.status === "error") {
          selectAndScroll(callIndex[i]);
          return;
        }
      }
    },
    [callIndex, selectedId, calls, selectAndScroll],
  );

  const collapseOrParent = useCallback(() => {
    if (!selectedId) return;
    if (
      expanded.has(selectedId) &&
      (openRows.has(selectedId) || taskIds.has(selectedId))
    ) {
      toggleExpand(selectedId);
      return;
    }
    const call = calls.get(selectedId);
    const spawnId = call ? agents.get(call.agentId)?.spawnToolUseId : null;
    if (spawnId && calls.has(spawnId)) selectAndScroll(spawnId);
  }, [
    selectedId,
    expanded,
    openRows,
    taskIds,
    toggleExpand,
    calls,
    agents,
    selectAndScroll,
  ]);

  const jumpEdge = useCallback(
    (end: "top" | "bottom") => {
      if (callIndex.length === 0) return;
      if (end === "bottom") {
        setSelectedId(callIndex[callIndex.length - 1]);
        followDispatch({ type: "resume" });
        setScrollNonce((n) => n + 1);
      } else {
        selectAndScroll(callIndex[0]);
      }
    },
    [callIndex, selectAndScroll],
  );

  const pickAgent = useCallback((id: string | null, additive = false) => {
    if (id === null) return setAgentRoots([]);
    setAgentRoots((cur) => {
      if (additive) {
        return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      }
      return cur.length === 1 && cur[0] === id ? [] : [id];
    });
  }, []);

  const cycleAgent = useCallback(() => {
    const ids = ["main", ...[...agents.keys()].filter((k) => k !== "main")];
    setAgentRoots((cur) => {
      if (cur.length !== 1) return [ids[0]];
      const i = ids.indexOf(cur[0]);
      return i < 0 || i === ids.length - 1 ? [] : [ids[i + 1]];
    });
  }, [agents]);

  const clearFilters = useCallback(() => {
    setAgentRoots([]);
    setKinds(new Set());
    setErrorsOnly(false);
    setWaitingOnly(false);
    setQueryInput("");
  }, [setQueryInput]);

  return {
    filters,
    queryInput,
    setQueryInput,
    agentRoots,
    pickAgent,
    cycleAgent,
    toggleKind: useCallback(
      (k: ToolKind) => setKinds((s) => toggleIn(s, k)),
      [],
    ),
    toggleErrors: useCallback(() => setErrorsOnly((v) => !v), []),
    toggleWaiting: useCallback(() => setWaitingOnly((v) => !v), []),
    clearFilters,
    mode,
    toggleMode: useCallback(
      () => setMode((m) => (m === "tree" ? "flat" : "tree")),
      [],
    ),
    rows,
    totalCalls: calls.size,
    errorCount,
    waitingCount,
    selectedId,
    select,
    reveal: selectAndScroll,
    toggleExpand,
    isTaskRow,
    follow,
    followDispatch,
    scrollNonce,
    move,
    jumpError,
    collapseOrParent,
    jumpEdge,
  };
}

/** Host hooks the keyboard map needs beyond the timeline itself. */
export interface ConsoleKeyHost {
  /** Enter / → on a row: expand inline or open the Detail tab. */
  activate: (id: string) => void;
  /** `/`. */
  focusSearch: () => void;
  /** `c`: copy the selected row's input. */
  copyInput?: (id: string) => void;
  /** `o`: open the full payload. */
  openFull?: (id: string) => void;
  /** `1`–`5`: right-pane / mobile tabs. */
  setTab?: (index: number) => void;
  /** Esc chain: return true when the host consumed it (closed a detail view). */
  escape?: () => boolean;
  /** Last Esc step: close the console. */
  close?: () => void;
}

/**
 * Handle one keydown inside the console (spec 2.5 keyboard table). Returns
 * true when handled; the caller then prevents default and stops propagation.
 */
export function handleConsoleKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">,
  ui: ConsoleUi,
  host: ConsoleKeyHost,
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const tgt = e.target as HTMLElement | null;
  const typing =
    !!tgt &&
    (tgt.tagName === "INPUT" ||
      tgt.tagName === "TEXTAREA" ||
      tgt.isContentEditable);
  if (typing) return false;
  const sel = ui.selectedId;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      ui.move(1);
      return true;
    case "k":
    case "ArrowUp":
      ui.move(-1);
      return true;
    case "Enter":
    case "ArrowRight":
      if (!sel) return false;
      host.activate(sel);
      return true;
    case "ArrowLeft":
      ui.collapseOrParent();
      return true;
    case "[":
      ui.jumpError(-1);
      return true;
    case "]":
      ui.jumpError(1);
      return true;
    case "/":
      host.focusSearch();
      return true;
    case "e":
      ui.toggleErrors();
      return true;
    case "a":
      ui.cycleAgent();
      return true;
    case "t":
      ui.toggleMode();
      return true;
    case "f":
      ui.followDispatch({ type: "toggle" });
      return true;
    case "g":
      ui.jumpEdge("top");
      return true;
    case "G":
      ui.jumpEdge("bottom");
      return true;
    case "c":
      if (!sel || !host.copyInput) return false;
      host.copyInput(sel);
      return true;
    case "o":
      if (!sel || !host.openFull) return false;
      host.openFull(sel);
      return true;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      if (!host.setTab) return false;
      host.setTab(Number(e.key) - 1);
      return true;
    case "Escape":
      if (host.escape?.()) return true;
      if (sel) {
        ui.select(null);
        return true;
      }
      if (host.close) {
        host.close();
        return true;
      }
      return false;
    default:
      return false;
  }
}
