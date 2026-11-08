/**
 * Factory sync seam (P2.5), pure: campus projects → `FactoryModel`, with the
 * previous model handed back for lane stability and change detection on
 * `factoryKey`, so the 3D pools see a new model only when something they show
 * changed (zero buffer writes otherwise; `stats.skips` counts those syncs).
 *
 * Data source:
 *   - real `CampusProject[]` from the backend feed (PRs, checks, releases…);
 *   - demo projects (`demoFactory.ts`) only when explicitly asked for
 *     (`demo: true`, world-debug `?demoFactory=1`), or `projects === undefined`
 *     with the dev fallback on. An empty / null feed is REAL data: it renders
 *     empty cells, never demo PRs (D1). The demo templates are re-keyed onto
 *     the cells that exist (one per project room), snapshotted once per cell set and advanced with `demoFactoryTick`.
 */
import type { CampusProject, CampusSession } from "@/engine/contracts";
import {
  demoFactoryProjects,
  demoFactoryTick,
} from "@/engine/demo/demoFactory";
import { publishFactoryLive } from "@/engine/logic/factoryLive";
import {
  buildFactoryModel,
  factoryKey,
  type FactoryModel,
} from "@/engine/logic/factoryModel";

export interface FactorySyncInput {
  projects: readonly CampusProject[] | null | undefined;
  campus: readonly CampusSession[];
  nowMs: number;
  /** Lane capacity per project (from the FactoryLayout cells). */
  lanesFor: (projectId: string) => number;
  /** Project ids that have a cell, in layout order (demo re-keying). */
  cellIds: readonly string[];
  /** Force demo data (world-debug `?demoFactory=1`). */
  demo?: boolean;
  /** Dev only: use demo data when `projects` is `undefined` (feed not wired). */
  devFallback?: boolean;
}

export interface FactorySyncStats {
  /** Models built (every sync). */
  builds: number;
  /** Models handed to the pools (key changed). */
  pushes: number;
  /** Syncs that changed nothing visible (no pool work, no buffer writes). */
  skips: number;
  demo: boolean;
  lines: number;
  pieces: number;
  stations: number;
}

export interface FactorySyncResult {
  /** Non-null only when the key changed (push to the pools). */
  model: FactoryModel | null;
  /** Projects the model was built from (real or demo), for the dock. */
  projects: readonly CampusProject[];
}

/**
 * Demo templates re-keyed onto the given project ids (cycled when there are
 * more cells than templates). Ids stay unique, so pieces stay unique too.
 */
export function rekeyDemo(
  templates: readonly CampusProject[],
  ids: readonly string[],
): CampusProject[] {
  if (templates.length === 0) return [];
  return ids.map((id, i) => {
    const t = templates[i % templates.length];
    return { ...t, id, sessionIds: [] };
  });
}

const EMPTY: readonly CampusProject[] = [];

export class FactorySync {
  private prev: FactoryModel | null = null;
  private key: string | null = null;
  private demoBase: CampusProject[] = [];
  private demoSig = "";
  private lastProjects: readonly CampusProject[] = [];
  private published: readonly CampusProject[] | null = null;
  readonly stats: FactorySyncStats = {
    builds: 0,
    pushes: 0,
    skips: 0,
    demo: false,
    lines: 0,
    pieces: 0,
    stations: 0,
  };

  /** Last model built (null before the first sync). */
  get model(): FactoryModel | null {
    return this.prev;
  }

  /** Projects of the last build (real or demo). */
  get projects(): readonly CampusProject[] {
    return this.lastProjects;
  }

  update(input: FactorySyncInput): FactorySyncResult {
    const demo =
      input.demo === true ||
      (input.projects === undefined && input.devFallback === true);
    const projects = demo
      ? this.demoProjects(input.cellIds, input.campus, input.nowMs)
      : (input.projects ?? EMPTY);
    this.lastProjects = projects;
    const model = buildFactoryModel(projects, input.campus, input.nowMs, {
      lanesFor: input.lanesFor,
      prev: this.prev ?? undefined,
    });
    this.prev = model;
    this.stats.builds++;
    this.stats.demo = demo;
    const key = factoryKey(model);
    // Publish for the HUD only when something it shows can have changed.
    if (key !== this.key || projects !== this.published) {
      this.published = projects;
      publishFactoryLive({ model, projects, demo });
    }
    if (key === this.key) {
      this.stats.skips++;
      return { model: null, projects };
    }
    this.key = key;
    this.stats.pushes++;
    this.stats.lines = model.lines.length;
    this.stats.pieces = model.lines.reduce(
      (n, l) => n + l.workpieces.length,
      0,
    );
    this.stats.stations = model.lines.reduce(
      (n, l) => n + l.stations.length,
      0,
    );
    return { model, projects };
  }

  private demoProjects(
    ids: readonly string[],
    campus: readonly CampusSession[],
    nowMs: number,
  ): CampusProject[] {
    const sig = ids.join("|");
    if (sig !== this.demoSig) {
      this.demoSig = sig;
      const templates = demoFactoryProjects(campus as CampusSession[], nowMs, {
        projects: Math.max(1, Math.min(4, ids.length)),
      });
      this.demoBase = rekeyDemo(templates, ids);
    }
    return demoFactoryTick(this.demoBase, nowMs);
  }
}
