/**
 * Asset manifest — shared by `scripts/fetch-assets.ts` (download) and the
 * runtime `AssetLibrary` (load). Plain data, no Babylon imports.
 *
 * All assets are CC0 (Poly Haven) unless noted. Files are downloaded into
 * `frontend/public/assets/` (git-ignored, except NOTICE.md) by `bun run assets`.
 * The runtime tolerates any missing file (procedural fallback), so the app
 * renders without running the script.
 *
 * Path conventions (relative to ASSET_BASE = "/assets"):
 *   models:   models/{id}/{id}_1k.gltf            (+ relative includes kept as Poly Haven ships them)
 *   hdri:     hdri/{id}_{res}.hdr          (interior 1k, exterior 2k)
 */

export const ASSET_BASE = "/assets";

export type ModelRole =
  | "desk"
  | "chair"
  | "sofa"
  | "shelves"
  | "plant"
  | "plantSmall"
  | "plantTall"
  | "coffeeCart"
  | "laptop"
  | "securityCamera"
  | "projectorScreen"
  | "notepads"
  | "fireAlarm"
  | "wetFloorSign";

export interface ModelAsset {
  role: ModelRole;
  id: string; // Poly Haven asset id
  collider: "box" | "cylinder" | "none";
  /** Uniform scale applied after load (Poly Haven models are metre-scaled → 1). */
  scale: number;
}

export interface CharacterPackAsset {
  /** File under characters/, e.g. "office_worker.glb". */
  file: string;
  /** Normalised clip name → animation group name inside the file. */
  clips: Partial<Record<"idle" | "walk" | "sit" | "type" | "wave", string>>;
  /** Material names to retint with the agent colour. */
  outfitMaterials: string[];
}

export type HdriRes = "1k" | "2k" | "4k";

export interface AssetManifest {
  models: ModelAsset[];
  /** Interior HDRI: image-based lighting + generic interior reflections. */
  hdri: { id: string };
  /**
   * Exterior HDRI (urban, daytime): the sky / city seen through every window
   * (skybox at infinity → parallax-correct) and the reflections on glass.
   */
  exteriorHdri: { id: string; res: HdriRes };
  /** Optional, manual drop. Null → procedural mannequins. */
  characters: CharacterPackAsset | null;
}

// Ids verified by scripts/fetch-assets.ts (it fails loudly on a bad id).
export const ASSET_MANIFEST: AssetManifest = {
  models: [
    { role: "desk", id: "metal_office_desk", collider: "box", scale: 1 },
    { role: "plant", id: "potted_plant_01", collider: "cylinder", scale: 1 },
    { role: "plantSmall", id: "potted_plant_04", collider: "none", scale: 1 },
    {
      role: "plantTall",
      id: "potted_plant_02",
      collider: "cylinder",
      scale: 1,
    },
    {
      role: "securityCamera",
      id: "security_camera_01",
      collider: "none",
      scale: 1,
    },
    {
      role: "projectorScreen",
      id: "projector_screen",
      collider: "box",
      scale: 1,
    },
    { role: "notepads", id: "office_notepads", collider: "none", scale: 1 },
    { role: "fireAlarm", id: "fire_alarm", collider: "none", scale: 1 },
  ],
  hdri: { id: "blender_institute" },
  exteriorHdri: { id: "kloofendal_48d_partly_cloudy_puresky", res: "2k" },
  characters: null,
};

export function modelPath(id: string, base = ASSET_BASE): string {
  return `${base}/models/${id}/${id}_1k.gltf`;
}

/** KTX2 (Basis) variant of a prop: one GLB, KHR_texture_basisu textures. */
export function modelKtx2Path(id: string, base = ASSET_BASE): string {
  return `${base}/models/${id}/${id}.ktx2.glb`;
}

export function hdriPath(
  id: string,
  base = ASSET_BASE,
  res: HdriRes = "1k",
): string {
  return `${base}/hdri/${id}_${res}.hdr`;
}
