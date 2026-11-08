"use client";

/**
 * The virtualized timeline list (spec 2.5): one row per call, markers and
 * block results, chronological with the newest at the bottom, live-follow
 * pinned exactly to the bottom until the user scrolls up, expands or selects.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "@/hooks/useTranslation";
import type { ConsoleSession } from "@/stores/consoleStore";
import type { ToolCall } from "@/utils/console/types";
import { agentsBySpawn, spawnedAgentOf, type DisplayRow } from "./displayRows";
import { FollowPill } from "./FollowPill";
import { CallRow, MarkerRow, ResultRow, type RowDensity } from "./TimelineRow";
import { ROW_H, ROW_H_TOUCH } from "./theme";
import type { ConsoleUi } from "./useConsoleUi";

/** DOM id of a row (for aria-activedescendant). */
export function rowDomId(listId: string, callId: string): string {
  return `${listId}-r-${callId.replace(/[^\w-]/g, "_")}`;
}

const OVERSCAN = 8;
const LOAD_OLDER_PX = 240;

export function Timeline({
  ui,
  session,
  density,
  touch,
  listId,
  label,
  renderBody,
  onActivate,
  onMarker,
  onLoadOlder,
  initialHeight = 800,
  narrow = false,
}: {
  ui: ConsoleUi;
  session: ConsoleSession | undefined;
  density: RowDensity;
  touch: boolean;
  listId: string;
  /** Accessible name of the listbox. */
  label: string;
  /** Inline expanded body for a call; omit when a Detail column shows it. */
  renderBody?: (call: ToolCall) => ReactNode;
  /** Enter / double-click on a row. */
  onActivate: (id: string) => void;
  /** Click on a conversation marker. */
  onMarker?: () => void;
  /** Scrolled near the top while older calls exist. */
  onLoadOlder?: () => void;
  /** Initial viewport height guess before the first measurement. */
  initialHeight?: number;
  /** Narrow column: rows drop secondary chips and shorten paths. */
  narrow?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const rows = ui.rows;
  const agents = session?.agents;
  const bySpawn = useMemo(
    () => (agents ? agentsBySpawn(agents) : new Map()),
    [agents],
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const rowH = touch ? ROW_H_TOUCH : ROW_H;

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is used as documented; rows re-render from `ui.rows`.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (
        r?.kind === "call" &&
        r.row.call.status === "error" &&
        r.row.call.error
      )
        return rowH + 20;
      return rowH;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: OVERSCAN,
    // A hidden panel measures 0: keep the estimate instead of collapsing.
    measureElement: (el, entry, inst) => {
      const h = measureElement(el, entry, inst);
      return h > 0 ? h : rowH;
    },
    initialRect: { width: 600, height: initialHeight },
  });

  const totalSize = virtualizer.getTotalSize();
  const following = ui.follow.mode === "following";

  // Pin to the bottom while following (exact: re-pin on every size change).
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el || !following) return;
    const target = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - target) > 1) {
      programmatic.current = true;
      el.scrollTop = target;
    }
  }, [following, totalSize, rows.length]);

  // Count rows that arrived while paused ("N new").
  const callCount = session?.order.length ?? 0;
  const prevCount = useRef(callCount);
  const followDispatch = ui.followDispatch;
  useEffect(() => {
    const delta = callCount - prevCount.current;
    const initial = prevCount.current === 0;
    prevCount.current = callCount;
    // The first batch (snapshot load) is history, not "new".
    if (delta > 0 && !initial) followDispatch({ type: "rows", count: delta });
  }, [callCount, followDispatch]);

  // Keep the viewport steady when an older page is prepended.
  const firstKey = rows[0]?.key;
  const prevFirst = useRef(firstKey);
  const prevTotal = useRef(totalSize);
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (
      el &&
      !following &&
      firstKey !== prevFirst.current &&
      prevFirst.current
    ) {
      programmatic.current = true;
      el.scrollTop += totalSize - prevTotal.current;
    }
    prevFirst.current = firstKey;
    prevTotal.current = totalSize;
  }, [firstKey, totalSize, following]);

  // Scroll the selection into view when asked (keyboard, focus, deep link).
  const selectedId = ui.selectedId;
  const nonce = ui.scrollNonce;
  useEffect(() => {
    if (!selectedId || nonce === 0) return;
    const i = rows.findIndex((r) => r.key === selectedId);
    if (i >= 0) {
      programmatic.current = true;
      const r = rows[i];
      const tallRow = r.kind === "call" && r.row.expanded && !!renderBody;
      virtualizer.scrollToIndex(i, { align: tallRow ? "start" : "auto" });
    }
    // Only on explicit requests, not on every row update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const user = !programmatic.current;
    programmatic.current = false;
    followDispatch({
      type: "scroll",
      distanceFromBottom: dist,
      userInitiated: user,
    });
    if (el.scrollTop < LOAD_OLDER_PX && session?.hasMore) onLoadOlder?.();
  }, [followDispatch, onLoadOlder, session?.hasMore]);

  const userActivity = useCallback(() => {
    programmatic.current = false;
  }, []);

  const activeId =
    selectedId && rows.some((r) => r.key === selectedId)
      ? rowDomId(listId, selectedId)
      : undefined;

  const onSelect = ui.select;
  const onToggle = ui.toggleExpand;
  const isTaskRow = ui.isTaskRow;
  const showChip = ui.mode === "flat";

  const empty =
    rows.length === 0 ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-slate-500">
        {!session ||
        session.status === "loading" ||
        session.status === "idle" ? (
          <span>{t("console.loading")}</span>
        ) : ui.totalCalls > 0 ? (
          <>
            <span>{t("console.noMatchingCalls")}</span>
            <button
              type="button"
              onClick={ui.clearFilters}
              className="rounded-md border border-white/10 px-2 py-0.5 text-xs text-sky-300 hover:bg-white/5"
            >
              {t("console.clearFilters")}
            </button>
          </>
        ) : (
          <span>{t("console.noCalls")}</span>
        )}
      </div>
    ) : null;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={parentRef}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={activeId}
        onScroll={onScroll}
        onWheel={userActivity}
        onTouchStart={userActivity}
        onPointerDown={userActivity}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400/40"
      >
        {empty ?? (
          <div className="relative w-full" style={{ height: totalSize }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const r: DisplayRow = rows[vi.index];
              let content: ReactNode;
              if (r.kind === "call") {
                const call = r.row.call;
                const task = isTaskRow(call.id);
                const spawned =
                  task && agents
                    ? spawnedAgentOf(call, agents, bySpawn)
                    : undefined;
                const expandable = task ? r.row.childCount > 0 : !!renderBody;
                content = (
                  <CallRow
                    row={r.row}
                    agents={agents ?? new Map()}
                    spawned={spawned}
                    density={density}
                    touch={touch}
                    selected={selectedId === call.id}
                    showAgentChip={showChip}
                    expandable={expandable}
                    domId={rowDomId(listId, call.id)}
                    narrow={narrow}
                    onSelect={onSelect}
                    onActivate={onActivate}
                    onToggle={onToggle}
                    body={
                      renderBody && r.row.expanded && !task
                        ? renderBody(call)
                        : undefined
                    }
                  />
                );
              } else if (r.kind === "marker") {
                content = (
                  <MarkerRow
                    entry={r.entry}
                    density={density}
                    touch={touch}
                    onOpen={onMarker}
                  />
                );
              } else {
                content = (
                  <ResultRow
                    agent={r.agent}
                    depth={r.depth}
                    touch={touch}
                    onSelect={() => onSelect(r.spawnCallId)}
                  />
                );
              }
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-white/[0.035]"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {content}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <FollowPill
        follow={ui.follow}
        onResume={() => followDispatch({ type: "resume" })}
      />
    </div>
  );
}
