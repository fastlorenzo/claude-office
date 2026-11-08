/**
 * The factory model the 3D scene is actually showing, published for the HUD.
 *
 * `FactorySync` (the World.sync seam) builds the model with the cells' lane
 * capacities and the previous model (lane stability), so the HUD panels must
 * read this instead of re-deriving a different model from the raw feed (D3).
 * A tiny framework-free store (`useSyncExternalStore` compatible); the engine
 * never imports React or zustand.
 */
import type { CampusProject } from "@/engine/contracts";
import type { FactoryModel, LineModel } from "./factoryModel";

export interface FactoryLiveSnapshot {
  model: FactoryModel;
  /** Projects the model was built from (real, or demo when `demo`). */
  projects: readonly CampusProject[];
  demo: boolean;
}

let current: FactoryLiveSnapshot | null = null;
const listeners = new Set<() => void>();

export function publishFactoryLive(next: FactoryLiveSnapshot | null): void {
  if (
    current === next ||
    (current &&
      next &&
      current.model === next.model &&
      current.projects === next.projects &&
      current.demo === next.demo)
  )
    return;
  current = next;
  for (const l of [...listeners]) l();
}

export function getFactoryLive(): FactoryLiveSnapshot | null {
  return current;
}

export function subscribeFactoryLive(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function liveLine(
  snap: FactoryLiveSnapshot | null,
  projectId: string | null | undefined,
): { project: CampusProject; line: LineModel } | null {
  if (!snap || !projectId) return null;
  const project = snap.projects.find((p) => p.id === projectId);
  const line = snap.model.lines.find((l) => l.projectId === projectId);
  return project && line ? { project, line } : null;
}
