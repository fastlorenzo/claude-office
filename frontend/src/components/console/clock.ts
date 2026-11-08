"use client";

/**
 * One shared 1 Hz ticker for every running row (spec 3.6: no per-row
 * intervals), plus a context that pins "now" for fixtures and tests.
 */

import { createContext, useContext, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noop = () => () => {};

/** A fixed "now" (ms) for fixture pages and tests; null = live clock. */
export const ConsoleClockContext = createContext<number | null>(null);

/**
 * Current time in ms. Only subscribes to the 1 Hz ticker while `live` is
 * true, so finished rows never re-render on the tick.
 */
export function useConsoleNow(live: boolean): number {
  const fixed = useContext(ConsoleClockContext);
  const ticking = live && fixed === null;
  const t = useSyncExternalStore(
    ticking ? subscribe : noop,
    () => now,
    () => now,
  );
  return fixed ?? t;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `HH:mm:ss` local time of an ISO timestamp ("" if unparsable). */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Milliseconds between an ISO start and `nowMs` (0 if unparsable). */
export function elapsedMs(
  iso: string | null | undefined,
  nowMs: number,
): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, nowMs - t);
}
