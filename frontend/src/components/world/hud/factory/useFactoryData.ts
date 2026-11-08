"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CampusProject } from "@/engine/contracts";
import {
  getFactoryLive,
  liveLine,
  subscribeFactoryLive,
} from "@/engine/logic/factoryLive";
import type { LineModel } from "@/engine/logic/factoryModel";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { findProject, lineFor } from "./factoryPanelModel";

/** Coarse clock so relative ages refresh without re-rendering every frame. */
function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

export interface FactoryData {
  project: CampusProject;
  line: LineModel;
  now: number;
  /** The scene is showing demo data (not the user's repositories). */
  demo: boolean;
}

/**
 * Live data for the open factory target. The line comes from the model the 3D
 * scene built (`factoryLive`: same lanes, queue and demo data as what is on
 * screen, D3). Without a published model (no world mounted) it falls back to
 * campusStore + a single-project build.
 */
export function useFactoryData(): {
  target: ReturnType<typeof useWorldUiStore.getState>["factoryTarget"];
  data: FactoryData | null;
} {
  const target = useWorldUiStore((s) => s.factoryTarget);
  const storeProject = useCampusStore((s) =>
    findProject(s.projects, target?.projectId),
  );
  const sessions = useCampusStore((s) => s.sessions);
  const snap = useSyncExternalStore(
    subscribeFactoryLive,
    getFactoryLive,
    () => null,
  );
  const now = useNow();
  const live = useMemo(
    () => liveLine(snap, target?.projectId),
    [snap, target?.projectId],
  );
  const fallback = useMemo(
    () => (live ? null : lineFor(storeProject, sessions, now)),
    [live, storeProject, sessions, now],
  );
  const data = useMemo(() => {
    if (live) return { ...live, now, demo: snap?.demo ?? false };
    return storeProject && fallback
      ? { project: storeProject, line: fallback, now, demo: false }
      : null;
  }, [live, snap, storeProject, fallback, now]);
  return { target, data };
}
