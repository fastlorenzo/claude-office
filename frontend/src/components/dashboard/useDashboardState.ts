"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildDashboardSearch,
  parseDashboardUrl,
  type DashboardState,
} from "./dashboardUrl";

const EVENT = "claude-office:dashboard-nav";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

/** URL-backed dashboard state (history entries per navigation, no router). */
export function useDashboardState(): {
  state: DashboardState;
  navigate: (
    patch: Partial<DashboardState>,
    opts?: { replace?: boolean },
  ) => void;
} {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
  const state = useMemo<DashboardState>(() => {
    // The token never lives in the address bar (api.ts moves it to
    // sessionStorage), so it is not part of the in-page state.
    const parsed = parseDashboardUrl(search);
    delete parsed.token;
    return parsed;
  }, [search]);

  const navigate = useCallback(
    (patch: Partial<DashboardState>, opts?: { replace?: boolean }) => {
      const cur = parseDashboardUrl(window.location.search);
      delete cur.token;
      const next = { ...cur, ...patch } as DashboardState;
      const url = `${window.location.pathname}${buildDashboardSearch(next)}`;
      if (opts?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
      window.dispatchEvent(new Event(EVENT));
    },
    [],
  );
  return { state, navigate };
}
