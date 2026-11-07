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
 *   textures: textures/{id}/{id}_{map}_1k.jpg     map ∈ diff | nor_gl | rough | ao | arm
 *   models:   models/{id}/{id}_1k.gltf            (+ relative includes kept as Poly Haven ships them)
 *   hdri:     hdri/{id}_1k.hdr
 *   characters (optional, manual drop): characters/{file}.glb
 */

export const ASSET_BASE = "/assets";

export type TextureMap = "diff" | "nor_gl" | "rough" | "ao" | "arm";

export type TextureRole =
  | "floorRoom" // office carpet
  | "floorHall" // polished concrete / tiles
  | "floorLobby" // wood parquet
  | "wall" // painted plaster
  | "wallAccent" // concrete / brick feature wall
  | "ceiling" // acoustic tiles / plaster
  | "wood" // desk tops, reception
  | "metal"; // brushed metal trims

export interface TextureAsset {
  role: TextureRole;
  id: string; // Poly Haven asset id
  maps: TextureMap[];
  /** Real-world size of one texture repeat, metres. */
  tileMeters: number;
}

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

export interface AssetManifest {
  textures: TextureAsset[];
  models: ModelAsset[];
  hdri: { id: string };
  /** Optional, manual drop. Null → procedural mannequins. */
  characters: CharacterPackAsset | null;
}

// Ids verified by scripts/fetch-assets.ts (it fails loudly on a bad id).
export const ASSET_MANIFEST: AssetManifest = {
  textures: [
    {
      role: "floorRoom",
      id: "laminate_floor_02",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 1.7,
    },
    {
      role: "floorHall",
      id: "grey_tiles",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 2.2,
    },
    {
      role: "floorLobby",
      id: "herringbone_parquet",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 3.4,
    },
    {
      role: "wall",
      id: "painted_plaster_wall",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 2,
    },
    {
      role: "wallAccent",
      id: "concrete_wall_001",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 1.5,
    },
    {
      role: "ceiling",
      id: "white_stucco",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 2,
    },
    {
      role: "wood",
      id: "walnut_veneer_02",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 1,
    },
    {
      role: "metal",
      id: "painted_metal_shutter",
      maps: ["diff", "nor_gl", "arm"],
      tileMeters: 2,
    },
  ],
  models: [
    { role: "desk", id: "metal_office_desk", collider: "box", scale: 1 },
    {
      role: "chair",
      id: "modern_arm_chair_01",
      collider: "cylinder",
      scale: 1,
    },
    { role: "sofa", id: "sofa_02", collider: "box", scale: 1 },
    {
      role: "shelves",
      id: "steel_frame_shelves_01",
      collider: "box",
      scale: 1,
    },
    { role: "plant", id: "potted_plant_01", collider: "cylinder", scale: 1 },
    { role: "plantSmall", id: "potted_plant_04", collider: "none", scale: 1 },
    {
      role: "plantTall",
      id: "potted_plant_02",
      collider: "cylinder",
      scale: 1,
    },
    { role: "coffeeCart", id: "CoffeeCart_01", collider: "box", scale: 1 },
    { role: "laptop", id: "classic_laptop", collider: "none", scale: 1 },
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
    { role: "wetFloorSign", id: "WetFloorSign_01", collider: "box", scale: 1 },
  ],
  hdri: { id: "blender_institute" },
  characters: null,
};

export function texturePath(
  id: string,
  map: TextureMap,
  base = ASSET_BASE,
): string {
  return `${base}/textures/${id}/${id}_${map}_1k.jpg`;
}

export function modelPath(id: string, base = ASSET_BASE): string {
  return `${base}/models/${id}/${id}_1k.gltf`;
}

export function hdriPath(id: string, base = ASSET_BASE): string {
  return `${base}/hdri/${id}_1k.hdr`;
}

export function characterPath(file: string, base = ASSET_BASE): string {
  return `${base}/characters/${file}`;
}
