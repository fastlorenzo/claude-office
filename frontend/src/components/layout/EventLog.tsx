/**
 * EventLog - the L panel and the 2D sidebar Events tab.
 *
 * Renders the compact Session Console timeline (one row per tool call, agent
 * rails, chip-bar agent filter, errors toggle, follow pill) for the selected
 * session. Falls back to the legacy raw-event log when the backend has no
 * console API (snapshot 404) or no call data yet, so mixed-version setups
 * keep working.
 */

"use client";

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  useGameStore,
  selectEventLog,
  selectSessionId,
  type EventLogEntry,
} from "@/stores/gameStore";
import { ChevronRight, ScrollText } from "lucide-react";
import { EventDetailModal } from "@/components/game/EventDetailModal";
import { useTranslation } from "@/hooks/useTranslation";
import { useSessionConsole } from "@/hooks/useSessionConsole";
import { getEventTypeTextColor } from "@/utils/event-type-styles";
import { followReducer, INITIAL_FOLLOW } from "@/utils/console/followScroll";
import type { AgentNode } from "@/utils/console/types";
import { clockTime } from "@/components/console/clock";
import { FollowPill } from "@/components/console/FollowPill";
import { SessionConsoleView } from "@/components/console/SessionConsole";
import { useSelectedAgents } from "@/components/console/selectedAgents";
import { agentVisual } from "@/components/console/theme";
import { AgentChip } from "@/components/console/TimelineRow";

const isRealSession = (id: string | null | undefined): id is string =>
  !!id && id !== "None";

/** Legacy raw-event list: stable keys, oldest first, live-follow. */
function LegacyEventLog({
  log,
  agents,
}: {
  log: readonly EventLogEntry[];
  agents: ReadonlyMap<string, AgentNode>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<EventLogEntry | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const [follow, dispatch] = useReducer(followReducer, INITIAL_FOLLOW);
  // The store prepends; show chronologically (newest at the bottom).
  const rows = [...log].reverse();
  const count = rows.length;
  const prev = useRef(count);
  const mainLabel = t("console.mainAgent");

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
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={ref}
          className="h-full overflow-y-auto py-1"
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
              {t("eventLog.waiting")}
            </div>
          ) : (
            rows.map((event) => {
              const v = event.agentId
                ? agentVisual(
                    event.agentId,
                    agents.get(event.agentId),
                    mainLabel,
                  )
                : null;
              return (
                <div
                  key={event.id}
                  role="button"
                  tabIndex={0}
                  className="group relative cursor-pointer py-1.5 pl-3 pr-2 hover:bg-white/[0.04]"
                  onClick={() => setSelected(event)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(event);
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{ background: v?.color ?? "#334155" }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
                      {clockTime(event.timestamp.toISOString())}
                    </span>
                    <span
                      className={`shrink-0 text-xs font-bold uppercase ${getEventTypeTextColor(event.type)}`}
                    >
                      {event.type.replace(/_/g, " ")}
                    </span>
                    {v && <AgentChip v={v} max="max-w-[10rem]" />}
                    <ChevronRight
                      size={12}
                      className="ml-auto shrink-0 text-slate-600 group-hover:text-slate-400"
                    />
                  </div>
                  <div
                    className="truncate text-[13px] text-slate-300"
                    title={event.summary}
                  >
                    {event.summary}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <FollowPill
          follow={follow}
          onResume={() => dispatch({ type: "resume" })}
        />
      </div>
      {selected && (
        <EventDetailModal
          event={selected}
          agents={agents}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/**
 * Event log for the selected session.
 *
 * @param onOpenCall open the Session Console focused on a call (3D dock / 2D
 *   sheet). When absent, a row click expands the call inline instead.
 */
export function EventLog({
  onOpenCall,
}: {
  onOpenCall?: (sessionId: string, callId: string) => void;
} = {}) {
  const { t } = useTranslation();
  const sessionId = useGameStore(selectSessionId);
  const real = isRealSession(sessionId);
  const { session } = useSessionConsole(real ? sessionId : null, sessionId);
  const legacyLog = useGameStore(selectEventLog);
  const agents = useSelectedAgents();

  const legacy =
    !real ||
    !session ||
    session.status === "missing" ||
    session.status === "error" ||
    (session.status === "ready" &&
      session.calls.size === 0 &&
      legacyLog.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-xs">
      {legacy ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-1.5 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <ScrollText size={14} className="text-orange-400" />
              {t("eventLog.events", { count: legacyLog.length })}
            </span>
            {real && session && session.status !== "loading" && (
              <span className="rounded bg-white/[0.05] px-1.5">
                {t("eventLog.legacy")}
              </span>
            )}
          </div>
          <LegacyEventLog log={legacyLog} agents={agents} />
        </>
      ) : (
        <SessionConsoleView
          sessionId={sessionId}
          session={session}
          presentation="compact"
          onOpenCall={
            onOpenCall ? (id) => onOpenCall(sessionId, id) : undefined
          }
        />
      )}
    </div>
  );
}
