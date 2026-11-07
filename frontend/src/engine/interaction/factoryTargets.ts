/**
 * Software-factory interaction targets: construction, tagging helpers for the
 * 3D pools, the thin-instance resolver registry and target -> panel / GitHub
 * mapping. Pure (type-only Babylon imports) so it is unit-testable.
 *
 * Pools call:
 *   tagFactoryMesh(mesh, factoryTarget("lanePlate", {...}))      // plain mesh
 *   registerThinResolver(mesh, (m, i) => target | null)          // thin instances
 * Interaction.ts resolves thin-instance picks through the registry.
 */
import type { AbstractMesh } from "@/engine/babylon";
import type { InteractionKind, InteractionTarget } from "@/engine/contracts";

export type FactoryKind = Extract<
  InteractionKind,
  | "lanePlate"
  | "station"
  | "workpiece"
  | "lineBoard"
  | "dock"
  | "trunk"
  | "mainLine"
>;

export const FACTORY_KINDS: readonly FactoryKind[] = [
  "lanePlate",
  "station",
  "workpiece",
  "lineBoard",
  "dock",
  "trunk",
  "mainLine",
];

export function isFactoryKind(k: string): k is FactoryKind {
  return (FACTORY_KINDS as readonly string[]).includes(k);
}

export function isFactoryTarget(
  t: InteractionTarget | null | undefined,
): boolean {
  return !!t && isFactoryKind(t.kind);
}

export interface FactoryTargetIds {
  projectId: string;
  /** Label shown in the prompt (project name, "#412", check name ...). */
  label: string;
  prNumber?: number;
  checkName?: string;
  /** 0-based lane. */
  lane?: number;
  /** Session linked to the PR (enables Enter). */
  sessionId?: string | null;
  url?: string | null;
}

/** Builds a factory target; undefined ids are omitted so targets compare cleanly. */
export function factoryTarget(
  kind: FactoryKind,
  ids: FactoryTargetIds,
): InteractionTarget {
  const t: InteractionTarget = {
    kind,
    sessionId: ids.sessionId ?? "",
    roomLabel: ids.label,
    projectId: ids.projectId,
  };
  if (ids.prNumber !== undefined) t.prNumber = ids.prNumber;
  if (ids.checkName !== undefined) t.checkName = ids.checkName;
  if (ids.lane !== undefined) t.lane = ids.lane;
  if (ids.url) t.url = ids.url;
  return t;
}

/** Same target identity (used to avoid re-emitting while looking at one thing). */
export function sameFactoryIds(
  a: InteractionTarget,
  b: InteractionTarget,
): boolean {
  return (
    (a.projectId ?? "") === (b.projectId ?? "") &&
    a.prNumber === b.prNumber &&
    (a.checkName ?? "") === (b.checkName ?? "") &&
    a.lane === b.lane
  );
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

export interface TaggableMesh {
  metadata?: unknown;
  isPickable?: boolean;
  thinInstanceEnablePicking?: boolean;
}

function meta(mesh: TaggableMesh): Record<string, unknown> {
  const m = mesh.metadata;
  if (m && typeof m === "object") return m as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  mesh.metadata = fresh;
  return fresh;
}

/**
 * Makes a mesh interactable. Merges into existing metadata (never replaces it)
 * and turns picking on. `range` overrides INTERACT_RANGE (metres).
 */
export function tagFactoryMesh<M extends TaggableMesh>(
  mesh: M,
  target: InteractionTarget,
  opts?: { range?: number; noFocusFrame?: boolean },
): M {
  const md = meta(mesh);
  md.interact = target;
  if (opts?.range !== undefined) md.interactRange = opts.range;
  if (opts?.noFocusFrame) md.noFocusFrame = true;
  mesh.isPickable = true;
  return mesh;
}

/** Removes the tag (pool recycling). */
export function untagFactoryMesh(mesh: TaggableMesh): void {
  const m = mesh.metadata;
  if (m && typeof m === "object") {
    const md = m as Record<string, unknown>;
    delete md.interact;
    delete md.thinInteract;
    delete md.interactRange;
  }
}

// ---------------------------------------------------------------------------
// Thin-instance resolver registry
// ---------------------------------------------------------------------------

export type ThinInstanceResolver = (
  mesh: AbstractMesh,
  thinInstanceIndex: number,
) => InteractionTarget | null;

/**
 * Pools that render many entities as thin instances register one resolver per
 * mesh. The Interaction probe calls it with `pick.thinInstanceIndex`.
 * Returning null means "this instance is not interactable" (pooled / hidden).
 */
export function registerThinResolver<M extends TaggableMesh>(
  mesh: M,
  resolver: ThinInstanceResolver,
  opts?: { range?: number },
): M {
  const md = meta(mesh);
  md.thinInteract = resolver;
  if (opts?.range !== undefined) md.interactRange = opts.range;
  mesh.isPickable = true;
  mesh.thinInstanceEnablePicking = true;
  return mesh;
}

export function unregisterThinResolver(mesh: TaggableMesh): void {
  const m = mesh.metadata;
  if (m && typeof m === "object") {
    delete (m as Record<string, unknown>).thinInteract;
  }
}

export function hasThinResolver(mesh: { metadata?: unknown }): boolean {
  const m = mesh.metadata as { thinInteract?: unknown } | null | undefined;
  return typeof m?.thinInteract === "function";
}

/** Resolves a thin-instance pick; null when unregistered, out of range or declined. */
export function resolveThinTarget(
  mesh: AbstractMesh,
  thinInstanceIndex: number,
): InteractionTarget | null {
  if (!Number.isInteger(thinInstanceIndex) || thinInstanceIndex < 0)
    return null;
  const m = mesh.metadata as { thinInteract?: unknown } | null;
  if (typeof m?.thinInteract !== "function") return null;
  try {
    return (m.thinInteract as ThinInstanceResolver)(mesh, thinInstanceIndex);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Target -> panel / GitHub
// ---------------------------------------------------------------------------

export type FactoryPanelKind = "pr" | "station" | "line" | "deploy";

export function panelKindFor(
  target: InteractionTarget,
): FactoryPanelKind | null {
  switch (target.kind) {
    case "lanePlate":
    case "workpiece":
      return "pr";
    case "station":
      return "station";
    case "lineBoard":
    case "trunk":
    case "mainLine":
      return "line";
    case "dock":
      return "deploy";
    default:
      return null;
  }
}

/** URL for "Open on GitHub", only http(s). */
export function githubUrlOf(target: InteractionTarget): string | null {
  const u = target.url;
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}
