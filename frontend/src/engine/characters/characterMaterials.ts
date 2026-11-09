/**
 * Photoreal material tuning for the glTF cast packs (Rocketbox + MPFB).
 * Runs once per loaded container, before any instance exists, so no define
 * change ever lands on a frozen or already-compiled material. Character
 * materials live in the pack containers, not in the frozen `Materials` cache.
 */
import {
  Color3,
  PBRMaterial,
  type AssetContainer,
  type Material,
} from "@babylonjs/core";

export type CharacterMaterialKind =
  | "skin"
  | "eyes"
  | "hair"
  | "lashes"
  | "other";

/**
 * Classify a pack material by name. Rocketbox: `m005_head` (face skin; the
 * `_body` atlas mixes clothes with skin so it stays untouched), `m005_opacity`
 * (hair / lashes cutout). MPFB: `office_m01_skin|hair|brows|lashes|eyes|...`.
 * Teeth, glasses, shoes and clothes are "other".
 */
export function classifyCharacterMaterial(name: string): CharacterMaterialKind {
  const n = name.toLowerCase();
  if (/(^|_)(teeth|tongue|glasses|shoes|clothes?)(_|$)/.test(n)) return "other";
  if (/(^|_)eyes?(_|$)/.test(n)) return "eyes";
  if (/(^|_)(lashes|eyelashes?)(_|$)/.test(n)) return "lashes";
  if (/(^|_)(hair|brows?|eyebrows?|opacity)(_|$)/.test(n)) return "hair";
  if (/(^|_)(skin|head)(_|$)/.test(n)) return "skin";
  return "other";
}

const TUNED = "__characterTuned";

/** Warm blood-under-skin tint for ears / nose / fingers against a light. */
const SKIN_TRANSLUCENCY_TINT = new Color3(1, 0.42, 0.3);

export function tuneCharacterMaterial(mat: Material): boolean {
  if (!(mat instanceof PBRMaterial)) return false;
  const meta = (mat.metadata ??= {}) as Record<string, unknown>;
  if (meta[TUNED]) return false;
  const kind = classifyCharacterMaterial(mat.name);
  meta[TUNED] = true;
  if (kind === "skin") {
    mat.metallic = 0;
    mat.roughness = 0.55;
    mat.indexOfRefraction = 1.4; // F0 = 0.028
    mat.clearCoat.isEnabled = false;
    mat.environmentIntensity = 0.9;
    const ss = mat.subSurface;
    ss.isTranslucencyEnabled = true;
    ss.translucencyIntensity = 0.45;
    ss.tintColor = SKIN_TRANSLUCENCY_TINT;
    ss.minimumThickness = 0.05;
    ss.maximumThickness = 0.9;
    return true;
  }
  if (kind === "eyes") {
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = 1;
    mat.clearCoat.roughness = 0.05;
    return true;
  }
  if (kind === "hair" || kind === "lashes") {
    mat.metallic = 0;
    mat.roughness = Math.max(mat.roughness ?? 0.7, 0.7);
    mat.environmentIntensity = 0.55;
    mat.specularIntensity = 0.5;
    // Cutout cards: hard edge, never sorted blending.
    if (mat.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHABLEND) {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
      mat.alphaCutOff = 0.4;
    }
    return true;
  }
  return false;
}

/** Idempotent: safe to call again on the same container. */
export function tuneCharacterMaterials(container: AssetContainer): number {
  let n = 0;
  for (const m of container.materials) if (tuneCharacterMaterial(m)) n++;
  return n;
}
