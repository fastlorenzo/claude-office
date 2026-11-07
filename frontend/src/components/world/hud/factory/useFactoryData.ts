"use client";

import { useEffect, useMemo, useState } from "react";
import type { CampusProject } from "@/engine/contracts";
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
}

/**
 * Live data for the open factory target: the project is selected by id from
 * campusStore (the store bails on identical frames, so this only changes when
 * the project does) and the single-line model is memoised on it.
 */
export function useFactoryData(): {
  target: ReturnType<typeof useWorldUiStore.getState>["factoryTarget"];
  data: FactoryData | null;
} {
  const target = useWorldUiStore((s) => s.factoryTarget);
  const project = useCampusStore((s) =>
    findProject(s.projects, target?.projectId),
  );
  const sessions = useCampusStore((s) => s.sessions);
  const now = useNow();
  const line = useMemo(
    () => lineFor(project, sessions, now),
    [project, sessions, now],
  );
  const data = useMemo(
    () => (project && line ? { project, line, now } : null),
    [project, line, now],
  );
  return { target, data };
}
