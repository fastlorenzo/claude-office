/**
 * Stale frozen effects — the "opaque shell vanishes" root cause.
 *
 * A frozen material answers isReadyForSubMesh() from its cache
 * (`_wasPreviouslyReady`) and keeps the effect it compiled for the light set
 * of that moment. When a light that effect uses is disposed (area lights off
 * on a tier step, a fixture pool resize, zone lights rebuilt), the effect
 * still declares that light's uniform block, nothing binds it any more, and
 * WebGL rejects every draw ("used but unbound uniform buffer" /
 * "uniform buffer that is too small"): the meshes are counted as drawn but
 * never appear. Thawing the material (markDirty resets the cache) makes the
 * next frame recompile against the current lights.
 *
 * `staleLights` compares an effect's LIGHT<n> / <TYPE><n> defines with the
 * mesh's current light sources — the diagnostic and the watchdog both use it.
 */
import type { AbstractMesh, Material } from "@/engine/babylon";

/** Light class → the per-index type define Babylon writes for it. */
const TYPE_DEFINE: Record<string, string> = {
  RectAreaLight: "AREALIGHT",
  SpotLight: "SPOTLIGHT",
  PointLight: "POINTLIGHT",
  DirectionalLight: "DIRLIGHT",
  HemisphericLight: "HEMILIGHT",
  ClusteredLightContainer: "CLUSTLIGHT",
};
const TYPES = Object.values(TYPE_DEFINE);
const LIT = new Set([
  "PBRMaterial",
  "StandardMaterial",
  "PBRMetallicRoughnessMaterial",
  "PBRSpecularGlossinessMaterial",
]);
const MAX_SCAN = 16;

interface EffectInfo {
  /** Number of LIGHT<n> defines. */
  n: number;
  /** Type define per index ("" when unknown). */
  types: string[];
}

const infos = new WeakMap<object, EffectInfo>();

function effectInfo(effect: { defines: string }): EffectInfo {
  const hit = infos.get(effect);
  if (hit) return hit;
  const d = `${effect.defines}\n`;
  let n = 0;
  const types: string[] = [];
  for (let i = 0; i < MAX_SCAN; i++) {
    if (!d.includes(`#define LIGHT${i}\n`)) break;
    n = i + 1;
    types.push(TYPES.find((t) => d.includes(`#define ${t}${i}\n`)) ?? "");
  }
  const info = { n, types };
  infos.set(effect, info);
  return info;
}

interface LightLike {
  name: string;
  getClassName(): string;
}

/**
 * Why `effect` no longer matches `mesh`'s lights (null = consistent or not
 * applicable). Only meaningful for lit materials.
 */
export function staleLights(
  mesh: AbstractMesh,
  material: Material,
  effect: { defines?: string } | null | undefined,
): string | null {
  if (!effect || typeof effect.defines !== "string") return null;
  const mat = material as unknown as {
    disableLighting?: boolean;
    unlit?: boolean;
    maxSimultaneousLights?: number;
  };
  if (mat.disableLighting || mat.unlit) return null;
  // Standard / PBR only (their LIGHT<n> defines follow mesh.lightSources).
  if (!LIT.has(material.getClassName())) return null;
  if (mat.maxSimultaneousLights === undefined) return null;
  const info = effectInfo(effect as { defines: string });
  const lights = mesh.lightSources as unknown as LightLike[];
  const n = Math.min(lights.length, mat.maxSimultaneousLights);
  // More lights in the effect than the mesh has: draws are rejected (an
  // unbound light uniform block). Fewer: lights silently ignored — unless
  // the engine clamps the count (WebGPU reports maxUniformBuffersPerShaderStage;
  // WebGL does not, see GetSupportedSimultaneousLights).
  if (info.n > n) return `effect binds ${info.n} lights, mesh has ${n}`;
  if (info.n < n) {
    const caps = mesh.getScene().getEngine().getCaps() as {
      maxUniformBuffersPerShaderStage?: number | null;
    };
    if (caps.maxUniformBuffersPerShaderStage == null)
      return `effect binds ${info.n} lights, mesh has ${n} (ignored)`;
  }
  for (let i = 0; i < info.n; i++) {
    const want = TYPE_DEFINE[lights[i].getClassName()];
    if (want && info.types[i] && info.types[i] !== want)
      return `light ${i}: effect ${info.types[i]}, now ${want} (${lights[i].name})`;
  }
  return null;
}

/** First stale submesh effect of a mesh (frozen materials only by default). */
export function staleMeshEffect(
  mesh: AbstractMesh,
  frozenOnly = true,
): string | null {
  const subs = mesh.subMeshes;
  if (!subs) return null;
  for (const sub of subs) {
    const mat = sub.getMaterial();
    if (!mat || (frozenOnly && !mat.isFrozen)) continue;
    const why = staleLights(mesh, mat, sub.effect);
    if (why) return why;
  }
  return null;
}

/**
 * Thaw + re-freeze every frozen material of the scene that has a stale
 * effect (or all frozen materials with `all`). Returns how many it thawed.
 */
/** Submesh -> the stale effect it was already thawed for (no thrash). */
const thawedFor = new WeakMap<object, object>();

export function refreezeStale(
  scene: { meshes: AbstractMesh[]; materials: Material[] },
  all = false,
  onStale?: (mesh: AbstractMesh, material: Material, why: string) => void,
): number {
  const stale = new Set<Material>();
  if (all) {
    for (const m of scene.materials) if (m.isFrozen) stale.add(m);
  } else
    for (const mesh of scene.meshes) {
      if (mesh.isDisposed() || !mesh.subMeshes) continue;
      for (const sub of mesh.subMeshes) {
        const mat = sub.getMaterial();
        const eff = sub.effect;
        if (!mat || !eff || !mat.isFrozen) continue;
        // Already thawed for this very effect: the recompile is pending
        // (hot swap keeps the old effect meanwhile) or the mesh is not drawn
        // (it recompiles when it is: thawing reset its cache).
        if (thawedFor.get(sub) === eff) continue;
        const why = staleLights(mesh, mat, eff);
        if (!why) continue;
        thawedFor.set(sub, eff);
        if (stale.has(mat)) continue;
        onStale?.(mesh, mat, why);
        stale.add(mat);
      }
    }
  for (const m of stale) {
    m.unfreeze();
    m.freeze();
  }
  return stale.size;
}
