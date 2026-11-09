/**
 * Bake set membership — the single source of truth shared by the exporter
 * (WS-C: which merged meshes go into which lightmap set) and the runtime
 * (`fx/BakedLighting.ts`: which merged meshes may take a lightmap).
 *
 * `MeshBatcher.build({ bake: { set, origin } })` registers every merged mesh
 * it produces here (with or without a manifest), under its deterministic
 * part name (`<batcher>:<material name>`, see MeshBatcher), then asks the
 * scene's applier (installed by BakedLighting when a manifest loaded) to
 * apply the bake. Without an applier nothing else happens: the realtime path
 * is untouched.
 */
import type { Mesh, Scene } from "@/engine/babylon";

/** A set frame origin (subtracted before hashing). */
export interface BakeOrigin {
  x: number;
  y: number;
  z: number;
}

/** Lightmap sets (manifest `sets` keys). */
export type BakeSetId = "modules" | "lobby" | "entrance" | "control";

export const BAKE_SETS: readonly BakeSetId[] = [
  "modules",
  "lobby",
  "entrance",
  "control",
];

/** `MeshBatcher.build` option. */
export interface BakeOption {
  set: BakeSetId;
  /** Set frame origin, subtracted before hashing (control: drum centre). */
  origin?: BakeOrigin;
}

export interface BakePart {
  set: BakeSetId;
  /** Manifest part key (= merged mesh name at build time). */
  name: string;
  mesh: Mesh;
  origin: BakeOrigin;
}

/** Applies a bake to a freshly merged part; true when it took the lightmap. */
export interface BakeApplier {
  apply(part: BakePart): boolean;
}

const registry = new WeakMap<Scene, BakePart[]>();
const appliers = new WeakMap<Scene, BakeApplier>();

export function registerBakePart(scene: Scene, part: BakePart): void {
  let list = registry.get(scene);
  if (!list) {
    list = [];
    registry.set(scene, list);
  }
  // A rebuilt part (control floor on a bay change) replaces its old entry.
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (p.mesh.isDisposed() || (p.set === part.set && p.name === part.name))
      list.splice(i, 1);
  }
  list.push(part);
}

/** Live (undisposed) parts, optionally of one set, in registration order. */
export function bakeParts(scene: Scene, set?: BakeSetId): BakePart[] {
  return (registry.get(scene) ?? []).filter(
    (p) => !p.mesh.isDisposed() && (!set || p.set === set),
  );
}

export function setBakeApplier(
  scene: Scene,
  applier: BakeApplier | null,
): void {
  if (applier) appliers.set(scene, applier);
  else appliers.delete(scene);
}

export function bakeApplier(scene: Scene): BakeApplier | null {
  return appliers.get(scene) ?? null;
}
