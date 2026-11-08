"use client";

/**
 * Session Console fixture page (dev only; no backend needed).
 *
 * Query params:
 *   fixture=subagents|errors|long|mobile   demo session (default subagents)
 *   w=full|dock|compact                    presentation (default full;
 *                                          mobile defaults to the viewport)
 *   call=<tool_use_id> | edit | bash       focus a call (named or raw id)
 *   scroll=up                              scroll the list up after load and
 *                                          stream 12 new rows (paused pill)
 *   mode=flat                              start in Flat grouping
 */

import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ConsoleClockContext } from "@/components/console/clock";
import {
  demoDetail,
  demoLiveCalls,
  demoSession,
  type DemoFixture,
} from "@/components/console/demoFixtures";
import { useTranslation } from "@/hooks/useTranslation";
import { FIXTURE_SESSION_ID } from "@/components/console/fixtures";
import { SessionConsoleView } from "@/components/console/SessionConsole";
import { ConsoleDetailFetcherContext } from "@/components/console/ToolCallDetail";
import { enqueueConsoleFrame, useConsoleStore } from "@/stores/consoleStore";
import type { ToolCall } from "@/utils/console/types";

const noopSubscribe = () => () => {};

const FIXTURES: DemoFixture[] = ["subagents", "errors", "long", "mobile"];

interface Setup {
  fixture: DemoFixture;
  w: "full" | "dock" | "compact";
  call: string | null;
  scrollUp: boolean;
  flat: boolean;
  nowMs: number;
  pr: ReturnType<typeof demoSession>["pr"];
  calls: ReadonlyMap<string, ToolCall>;
}

function init(): Setup & { demo: ReturnType<typeof demoSession> } {
  const q = new URLSearchParams(window.location.search);
  const f = q.get("fixture") as DemoFixture | null;
  const fixture = f && FIXTURES.includes(f) ? f : "subagents";
  const demo = demoSession(fixture);
  const rawCall = q.get("call");
  const w = q.get("w");
  return {
    demo,
    fixture,
    w: w === "dock" || w === "compact" ? w : "full",
    call: rawCall ? (demo.focus[rawCall] ?? rawCall) : null,
    scrollUp: q.get("scroll") === "up",
    flat: q.get("mode") === "flat",
    nowMs: demo.nowMs,
    pr: demo.pr,
    calls: new Map(demo.snap.toolCalls.map((c) => [c.id, c])),
  };
}

export default function ConsoleDebugPage(): ReactNode {
  const { t } = useTranslation();
  // Client-only (reads the URL); the server snapshot renders nothing, so
  // hydration never mismatches.
  const onClient = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const setup = useMemo(() => (onClient ? init() : null), [onClient]);
  // Seed the store with the demo session (no backend on this page).
  useEffect(() => {
    if (!setup) return;
    const store = useConsoleStore.getState();
    store.drop(FIXTURE_SESSION_ID);
    store.beginLoad(FIXTURE_SESSION_ID);
    store.applySnapshot(FIXTURE_SESSION_ID, setup.demo.snap);
    store.setGitStatus(FIXTURE_SESSION_ID, setup.demo.git);
  }, [setup]);
  const session = useConsoleStore((s) => s.sessions[FIXTURE_SESSION_ID]);

  useEffect(() => {
    if (!setup?.scrollUp) return;
    const t1 = setTimeout(() => {
      const list = document.querySelector<HTMLElement>("[role=listbox]");
      if (list)
        list.scrollTop = Math.max(
          0,
          list.scrollHeight - list.clientHeight - 2600,
        );
    }, 400);
    const t2 = setTimeout(() => {
      const snap = useConsoleStore.getState().sessions[FIXTURE_SESSION_ID];
      if (!snap) return;
      const calls = [...snap.calls.values()];
      for (const c of demoLiveCalls(calls, 12)) {
        enqueueConsoleFrame(FIXTURE_SESSION_ID, {
          type: "tool_call",
          toolCall: c,
        });
      }
    }, 900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [setup]);

  if (!setup) return null;
  const presentation =
    setup.w === "dock" ? "dock" : setup.w === "compact" ? "compact" : "sheet";
  const frame =
    setup.w === "dock"
      ? "absolute inset-y-3 right-3 w-[clamp(560px,46vw,980px)] max-w-[calc(100vw-24px)]"
      : setup.w === "compact"
        ? "absolute inset-y-3 right-3 w-[min(420px,calc(100vw-24px))]"
        : "absolute inset-0 p-0 sm:p-3";
  const glass =
    presentation === "sheet"
      ? ""
      : "overflow-hidden rounded-2xl bg-slate-950/80 backdrop-blur-xl border border-white/10 shadow-xl shadow-black/40";

  return (
    <ConsoleClockContext.Provider value={setup.nowMs}>
      <ConsoleDetailFetcherContext.Provider
        value={async (_sid, id) => {
          const c = setup.calls.get(id);
          await new Promise((r) => setTimeout(r, 250));
          return c ? demoDetail(c) : null;
        }}
      >
        <main className="relative h-dvh w-full overflow-hidden bg-[radial-gradient(ellipse_at_top,#1e293b_0%,#020617_70%)]">
          <div className={`${frame} flex flex-col`}>
            <div className={`flex min-h-0 flex-1 flex-col ${glass}`}>
              <SessionConsoleView
                sessionId={FIXTURE_SESSION_ID}
                session={session}
                presentation={presentation}
                focusCallId={setup.call}
                pr={setup.pr}
                initialMode={setup.flat ? "flat" : "tree"}
                onEnterRoom={() => undefined}
                crossLink={{ label: t("dashboard.openIn3d"), href: "#" }}
                onClose={() => undefined}
              />
            </div>
          </div>
        </main>
      </ConsoleDetailFetcherContext.Provider>
    </ConsoleClockContext.Provider>
  );
}
