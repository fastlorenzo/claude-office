/**
 * PBR material factory — "Scandinavian-futurist tech HQ" palette.
 *
 * Every surface is a `PBRMaterial` that starts as a tuned flat colour (so the
 * office looks finished with no downloaded assets) and is upgraded in place
 * with the curated ambientCG set (`assets/materials2.ts`: albedo + OpenGL
 * normal + packed ORM, R = AO, G = roughness, B = metal) once
 * `loadTextures()` confirms the files exist. Textures are projected in world
 * metres (`applyWorldUVs`), so `uScale = 1 / tileMeters` gives true scale.
 *
 * Anti-CG measures:
 *  - a long-period procedural detail map (albedo / roughness / normal) on
 *    floors, walls and ceilings breaks tiling and adds wax / wear variation
 *    to reflections;
 *  - per-piece albedo jitter comes from vertex colours (ArtBatcher) and
 *    per-instance colours (AssetLibrary);
 *  - specular anti-aliasing stays on for every material.
 *
 * Surface materials per zone:
 *   lobby   terrazzo floor, plaster + graphite concrete walls, oak slats, moss
 *   hall    microcement floor, plaster walls, felt panels, oak slats
 *   rooms   charcoal carpet tiles, oak lounge floor, felt feature wall
 *   control dark microcement, graphite walls, black acoustic ceiling
 *
 * ---------------------------------------------------------------------------
 * Graphics API (wired by GraphicsController):
 *   setAnisotropy(n)          anisotropic filtering of every tiled texture (1–16)
 *   setTextureQuality(q)      "low" | "medium" | "high" → max texture edge
 *                             256 / 512 / native (512–1024 by tile size,
 *                             `textureEdge`); reloads the maps in place
 *                             (the shown map stays until the new one lands).
 *                             glTF model / character textures loaded later
 *                             are capped at 512 / 512 / 1024 (textureCap)
 *
 * Texture loading (robust by construction): every tiled map is a stable
 * `Texture` bound to the materials that starts on a neutral 1x1 internal
 * texture (mean albedo / flat normal / neutral ORM), so the material is ready
 * at once and a surface can never vanish while a map loads, fails, is
 * swapped for another quality or is re-uploaded after a WebGL context loss.
 * Loads retry with backoff (textureLoader.ts); a final failure is reported
 * (readiness.ts: console.warn once, `__worldStats.texFail`) and the neutral
 * map stays. Babylon's own context-restore path re-fetches URL textures and,
 * when that fetch fails, leaves them not ready forever (every mesh using them
 * is skipped): the maps here re-upload a neutral pixel instead and reload
 * through the retrying loader.
 * ---------------------------------------------------------------------------
 */
import {
  Color3,
  Constants,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  Vector3,
  VertexBuffer,
  type BaseTexture,
  type InternalTexture,
  type Observer,
} from "@/engine/babylon";
import {
  fetchImage,
  neutralPixel,
  type FetchImageOptions,
  type MapKind,
} from "./textureLoader";
import { noteTextureFailure, noteTextureRecovered } from "./readiness";
import {
  MATERIALS2,
  material2Path,
  MATERIAL_CANDIDATES,
  textureEdge,
  type MaterialRole,
  type PbrMaterialAsset,
} from "@/engine/assets/materials2";
import { capTextureUploads, modelTextureCap } from "@/engine/assets/textureCap";
import {
  createDetailMap,
  createMossTextures,
  createSandwichPanelNormal,
} from "@/engine/art/proceduralTextures";

/** Gamma hex → linear Color3 (PBR colours are linear). */
export function lin(hex: string): Color3 {
  return Color3.FromHexString(hex).toLinearSpace();
}

export const PALETTE = {
  claude: "#D97757",
  claudeDeep: "#B85C3E",
  charcoal: "#2A2C30",
  graphite: "#3A3D42",
  plaster: "#E9E6E0",
  ceiling: "#F1EFEB",
  oak: "#C6A47F",
  oakDark: "#7A5A40",
  sage: "#7E9A82",
  fabric: "#77746F",
  fabricWarm: "#A39587",
  aluminium: "#C8CBCF",
} as const;

export type TextureQuality = "low" | "medium" | "high";

export type SurfaceKey =
  // floors
  | "floorHall" // microcement
  | "floorLobby" // terrazzo
  | "floorRoom" // charcoal carpet tiles
  | "floorOak" // light oak boards (room lounge zone)
  | "floorDark" // dark microcement (control room)
  | "rug"
  // walls / ceilings
  | "wall" // white plaster
  | "wallAccent" // graphite concrete feature
  | "wallFeature" // alias of wallAccent (lobby logo wall)
  | "wallFelt" // acoustic felt (neutral; tinted per room via `felt()`)
  | "wallDark" // control room walls
  | "wallAccentWarm" // Claude orange (used sparingly)
  | "moss" // preserved moss wall
  | "ceiling" // smooth plaster ceiling
  | "ceilingDark" // black acoustic ceiling (control room)
  | "shadowGap" // black reveal / shadow-gap detail
  // timber
  | "wood" // oak veneer (alias of oak, legacy name)
  | "oak" // light oak furniture veneer
  | "oakSlat" // oak slats (walls / ceiling raft)
  | "oakDark" // smoked oak
  // metals
  | "metal" // brushed metal (legacy name)
  | "aluminium" // brushed aluminium trims / mullions
  | "chrome"
  | "blackMetal" // black powder coat (mullions, frames, fixtures)
  | "charcoal" // charcoal powder coat (furniture frames)
  | "skirting"
  // soft
  | "fabric"
  | "fabricWarm"
  | "fabricAccent"
  | "fabricDark"
  | "mesh" // task-chair mesh back
  | "leather"
  | "rubber"
  // misc
  | "glass"
  | "glassExterior"
  | "glassFrosted"
  | "glassTint"
  | "plantLeaf"
  | "plantLeafDark"
  | "soil"
  | "ceramic"
  | "planter" // matte fibre-clay planters
  | "quartz" // white solid surface (reception, counters)
  | "paint" // white matte base: colour comes from vertex paint (books, mugs)
  | "paintGloss" // white glossy base for vertex-painted objects
  | "lampShade" // glowing linen shade
  | "paving" // exterior plaza paving
  | "screenOff"
  | "lightPanel" // warm-white (3500 K) diffuser
  | "lightPanelCool"
  | "lightPanelDim" // dim cool (control room)
  | "ledBlue"
  | "ledWarm" // warm cove / toe-kick LED
  | "ledClaude" // orange logo halo
  | "nocGloss" // control-room console / screen surround
  // software factory (plant shell)
  | "floorEpoxy" // satin grey epoxy floor coat
  | "galvanised" // galvanised steel (treads, trays, decks, roof deck)
  | "steelPainted" // RAL 7016 painted steel (columns, trusses, stringers)
  | "concreteSoffit" // fair-faced concrete (slab soffits, wall plinth)
  | "cladding"; // profiled sandwich-panel cladding, light grey powder coat

interface SurfaceSpec {
  color: string;
  roughness: number;
  metallic?: number;
  /** ambientCG role to texture this surface with. */
  role?: MaterialRole;
  /** Override the role's pick (any MATERIAL_CANDIDATES id). */
  asset?: string;
  /** Albedo multiplier applied over the texture (linear factors as hex "gain"). */
  tint?: [number, number, number];
  /** Roughness factor multiplied with the ORM green channel. */
  roughFactor?: number;
  /** Metallic factor (ORM blue is baked 0/1 by the pipeline). */
  metalFactor?: number;
  bumpLevel?: number;
  /** Override tile size (metres). */
  tile?: number;
  /** Long-period detail map: period in metres. */
  detail?: number;
  emissive?: { color: string; intensity: number };
  alpha?: number;
  /** IBL multiplier (dark NOC surfaces must not mirror the warm interior HDRI). */
  env?: number;
  /** Sealed / lacquered top coat (second, sharp specular lobe). */
  clearCoat?: { intensity: number; roughness: number };
  /** Detail-map rotation (radians): breaks alignment with the base tiling. */
  detailAngle?: number;
  /** Strong grime detail (dirt, scuffs, roughness contrast) instead of wax. */
  grime?: boolean;
  /** Constant roughness (ignore the ORM green channel). */
  flatRough?: boolean;
  /** Keep the flat albedo colour (only normal + ORM from the role's set). */
  noAlbedoMap?: boolean;
  /** Procedural normal map instead of the set's (sandwich-panel profile). */
  normal?: "sandwichPanel";
}

const SURFACES: Record<SurfaceKey, SurfaceSpec> = {
  // ---- floors ----
  floorHall: {
    color: "#97948F",
    roughness: 0.34,
    role: "floorMain",
    tint: [0.66, 0.63, 0.6],
    roughFactor: 0.78, // satin: LED reflections read as soft streaks
    bumpLevel: 0.12,
    detail: 6,
  },
  floorLobby: {
    // Polished terrazzo under a sealer: chips at real scale, glossy top coat.
    color: "#C9C5BE",
    roughness: 0.26,
    role: "floorTerrazzo",
    tile: 0.5, // 2–4 cm chips
    tint: [0.72, 0.78, 0.79],
    roughFactor: 0.95,
    bumpLevel: 0.25,
    detail: 7,
    clearCoat: { intensity: 0.55, roughness: 0.12 },
  },

  floorRoom: {
    color: "#5A5B5E",
    roughness: 0.95,
    role: "floorCarpet",
    tint: [1.0, 0.98, 0.98],
    roughFactor: 1.12,
    bumpLevel: 0.9,
  },
  floorOak: {
    color: "#C2A07C",
    roughness: 0.42,
    role: "floorWarm",
    tint: [0.92, 0.9, 0.86],
    roughFactor: 0.78,
    bumpLevel: 0.4,
    detail: 5,
  },
  floorDark: {
    // Control room: navy resin.
    color: "#1C2B4A",
    roughness: 0.3,
    role: "floorMain",
    tint: [0.07, 0.11, 0.22],
    roughFactor: 0.55,
    bumpLevel: 0.3,
    detail: 6,
    env: 0.5,
    clearCoat: { intensity: 0.55, roughness: 0.12 },
  },
  rug: {
    color: "#6E6A64",
    roughness: 1,
    role: "floorCarpet",
    asset: "Carpet016",
    tint: [0.62, 0.6, 0.57],
    roughFactor: 1.2,
    bumpLevel: 1,
    tile: 0.5,
  },
  // ---- walls / ceilings ----
  wall: {
    color: PALETTE.plaster,
    roughness: 0.88,
    role: "wallMain",
    tint: [1.0, 0.985, 0.955],
    roughFactor: 1.55,
    bumpLevel: 0.22,
    // 3.5 m repeat + a rotated detail map: no visible 2 m grid on 6 m walls.
    tile: 3.5,
    detail: 5,
    detailAngle: 1.13,
  },
  wallAccent: {
    color: "#55575A",
    roughness: 0.8,
    role: "wallFeature",
    tint: [1.0, 1.0, 1.0],
    roughFactor: 1.15,
    bumpLevel: 0.55,
    detail: 5,
  },
  wallFeature: {
    color: "#55575A",
    roughness: 0.8,
    role: "wallFeature",
    tint: [0.72, 0.72, 0.72],
    roughFactor: 1.15,
    bumpLevel: 0.6,
    detail: 5,
  },
  wallFelt: {
    color: "#77797B",
    roughness: 1,
    role: "wallFelt",
    tint: [1, 1, 1],
    roughFactor: 1.3,
    bumpLevel: 0.7,
    tile: 0.6,
  },
  wallDark: {
    color: "#1E2024",
    roughness: 0.85,
    role: "wallFeature",
    tint: [0.32, 0.33, 0.35],
    roughFactor: 1.2,
    bumpLevel: 0.5,
    detail: 5,
    env: 0.15,
  },
  wallAccentWarm: { color: PALETTE.claude, roughness: 0.85 },
  moss: { color: "#4F6B34", roughness: 1 },
  ceiling: {
    color: PALETTE.ceiling,
    roughness: 0.95,
    role: "ceiling",
    asset: "Plaster001",
    tint: [1.0, 0.99, 0.97],
    roughFactor: 1.25,
    bumpLevel: 0.08,
  },
  ceilingDark: {
    color: "#141518",
    roughness: 0.95,
    role: "wallFelt",
    tint: [0.18, 0.18, 0.19],
    roughFactor: 1.3,
    bumpLevel: 0.6,
    tile: 0.8,
    env: 0.15,
  },
  shadowGap: { color: "#0E0F11", roughness: 0.7 },
  // ---- timber ----
  wood: {
    color: PALETTE.oak,
    roughness: 0.45,
    role: "woodFurniture",
    asset: "Wood050",
    tint: [0.84, 0.83, 0.67],
    roughFactor: 0.85,
    bumpLevel: 0.25,
  },
  oak: {
    color: PALETTE.oak,
    roughness: 0.45,
    role: "woodFurniture",
    asset: "Wood050",
    tint: [0.84, 0.83, 0.67],
    roughFactor: 0.85,
    bumpLevel: 0.25,
  },
  oakSlat: {
    color: "#C29B72",
    roughness: 0.55,
    role: "floorWarm",
    tint: [0.86, 0.82, 0.8],
    roughFactor: 0.95,
    bumpLevel: 0.3,
    tile: 1.2,
  },
  oakDark: {
    color: PALETTE.oakDark,
    roughness: 0.5,
    role: "woodFurniture",
    asset: "Wood050",
    tint: [0.3, 0.24, 0.18],
    roughFactor: 0.9,
    bumpLevel: 0.25,
  },
  // ---- metals ----
  metal: {
    // Brushed steel (Metal011 graded to aluminium F0; steel a touch darker).
    color: "#A5A8AC",
    roughness: 0.4,
    metallic: 1,
    role: "metalBrushed",
    tint: [0.9, 0.9, 0.9],
    roughFactor: 0.8,
    metalFactor: 1,
    bumpLevel: 0.2,
  },

  aluminium: {
    color: PALETTE.aluminium,
    roughness: 0.36,
    metallic: 1,
    role: "metalBrushed",
    // Brushed grain (normal map) only: Metal011's albedo / roughness carry
    // 20-30 cm stains that read as a blotchy smear on the large door leaves
    // (factory door, lift doors); trims are too small to show them anyway.
    noAlbedoMap: true,
    flatRough: true,
    // ≥ 0.4: brushed, and keeps SSR from speckling on large door leaves.
    roughFactor: 0.42,
    metalFactor: 1,
    bumpLevel: 0.15,
  },

  chrome: { color: "#E8EAEC", roughness: 0.1, metallic: 1 },
  blackMetal: {
    // Black powder coat (dielectric): Metal030's ORM for the satin texture.
    color: "#18191B",
    roughness: 0.42,
    role: "metalDark",
    tint: [0.3, 0.27, 0.25],
    roughFactor: 1.15,
    metalFactor: 0,
    bumpLevel: 0.1,
  },

  charcoal: {
    // Charcoal powder coat (dielectric).
    color: PALETTE.charcoal,
    roughness: 0.5,
    role: "metalDark",
    tint: [1.0, 0.92, 0.85],
    roughFactor: 1.4,
    metalFactor: 0,
    bumpLevel: 0.12,
  },

  skirting: { color: "#141517", roughness: 0.5 },
  // ---- soft ----
  fabric: {
    color: PALETTE.fabric,
    roughness: 0.95,
    role: "fabricUpholstery",
    tint: [0.92, 0.92, 0.94],
    roughFactor: 1.15,
    bumpLevel: 0.8,
  },
  fabricWarm: {
    color: PALETTE.fabricWarm,
    roughness: 0.95,
    role: "fabricUpholstery",
    asset: "Fabric036",
    tint: [0.82, 0.73, 0.64],
    roughFactor: 1.15,
    bumpLevel: 0.8,
  },

  fabricAccent: {
    color: "#B4694C",
    roughness: 0.95,
    role: "fabricUpholstery",
    asset: "Fabric036",
    tint: [0.9, 0.33, 0.21],
    roughFactor: 1.15,
    bumpLevel: 0.8,
  },

  fabricDark: {
    color: "#3A3C40",
    roughness: 0.95,
    role: "fabricUpholstery",
    tint: [0.22, 0.23, 0.25],
    roughFactor: 1.15,
    bumpLevel: 0.8,
  },
  mesh: {
    color: "#2A2B2E",
    roughness: 0.85,
    role: "wallFelt",
    asset: "Fabric036",
    tint: [0.1, 0.1, 0.105],
    roughFactor: 1.1,
    bumpLevel: 1.2,
    tile: 0.12,
  },
  leather: {
    color: "#2B2622",
    roughness: 0.5,
    role: "leather",
    tint: [1.0, 0.95, 0.9],
    roughFactor: 1.1,
    bumpLevel: 0.6,
  },

  rubber: {
    color: "#1C1D20",
    roughness: 0.8,
    role: "rubberMat",
    roughFactor: 1.3,
    bumpLevel: 0.5,
  },
  // ---- misc ----
  // Faint green edge tint of float glass; reflections come from the zone
  // probe (Lighting.attachToProbe) at env 0.7 — "something is there".
  glass: { color: "#E4F0EC", roughness: 0.04, alpha: 0.1, env: 0.7 },
  glassExterior: { color: "#E8EEF0", roughness: 0.03, alpha: 0.12 },
  glassFrosted: { color: "#F4F6F6", roughness: 0.4, alpha: 0.62 },
  glassTint: { color: "#2E3842", roughness: 0.05, alpha: 0.42, env: 0.6 },
  plantLeaf: { color: "#4E7A45", roughness: 0.65 },
  plantLeafDark: { color: "#2F5A32", roughness: 0.6 },
  soil: { color: "#3A2C22", roughness: 1 },
  ceramic: { color: "#E6E3DE", roughness: 0.32 },
  planter: {
    color: "#3B3C3E",
    roughness: 0.8,
    role: "wallFeature",
    tint: [0.6, 0.6, 0.6],
    roughFactor: 1.1,
    bumpLevel: 0.6,
    tile: 0.8,
  },
  quartz: {
    color: "#EFEDE9",
    roughness: 0.2,
    role: "floorTerrazzo",
    tint: [0.93, 1.0, 1.0],
    roughFactor: 0.7,
    bumpLevel: 0.12,
    tile: 0.4,
  },

  paint: { color: "#FFFFFF", roughness: 0.72 },
  paintGloss: { color: "#FFFFFF", roughness: 0.28 },
  lampShade: {
    color: "#EFE7DA",
    roughness: 0.9,
    emissive: { color: "#FFD9A6", intensity: 0.9 },
  },
  paving: {
    color: "#A9A59E",
    roughness: 0.85,
    role: "floorMain",
    tint: [0.44, 0.46, 0.42],
    roughFactor: 1.6,
    bumpLevel: 0.6,
    tile: 3,
    detail: 9,
  },

  screenOff: { color: "#0B0D10", roughness: 0.15 },
  lightPanel: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#FFF1E0", intensity: 3.4 },
  },
  lightPanelCool: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#EAF1FF", intensity: 3 },
  },
  lightPanelDim: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#BCD2FF", intensity: 1.4 },
  },
  ledBlue: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#3B82F6", intensity: 2.4 },
  },
  ledWarm: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#FFD9A8", intensity: 2.2 },
  },
  nocGloss: { color: "#0E0F11", roughness: 0.3, env: 0.1 },
  ledClaude: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#D97757", intensity: 2.6 },
  },
  // ---- software factory ----
  floorEpoxy: {
    // Grey epoxy over smooth concrete: satin base, sharp clear top coat.
    color: "#8E9294",
    roughness: 0.45,
    role: "floorEpoxy",
    tint: [0.44, 0.46, 0.61],
    roughFactor: 0.95,
    bumpLevel: 0.08,
    detail: 8,
    clearCoat: { intensity: 0.5, roughness: 0.16 },
  },

  galvanised: {
    // Satin galvanised steel (#B4B8BB), brushed ORM: treads, trays, decks.
    color: "#B4B8BB",
    roughness: 0.42,
    metallic: 1,
    role: "metalBrushed",
    tint: [0.667, 0.684, 0.683],
    roughFactor: 0.85,
    metalFactor: 1,
    bumpLevel: 0.08,
  },

  steelPainted: {
    // RAL 7016 anthracite paint, satin (dielectric).
    color: "#383E42",
    roughness: 0.5,
    role: "metalDark",
    tint: [0.5, 0.53, 0.52],
    roughFactor: 1.2,
    metalFactor: 0,
    bumpLevel: 0.05,
  },

  concreteSoffit: {
    color: "#A6A49F",
    roughness: 0.9,
    role: "concreteSoffit",
    tint: [0.63, 0.6, 0.71],
    roughFactor: 1.25,
    bumpLevel: 0.45,
    detail: 7,
  },
  cladding: {
    // Profiled sandwich panels (1.2 m, horizontal), polyester coat over
    // steel: dielectric, satin; the colour is the vertex paint × this.
    color: "#E6E6E6",
    roughness: 0.5,
    role: "metalDark",
    noAlbedoMap: true,
    normal: "sandwichPanel",
    roughFactor: 1.9, // ≈ 0.75: satin, and out of SSR (no wall smears)
    metalFactor: 0,
    bumpLevel: 1,
    tile: 1.2,
    grime: true,
  },
};

/**
 * Surface audit data for tests (WS5): every key with its metallic value and
 * the albedo gain applied over a texture (null when the surface is flat).
 */
export function surfaceAudit(): {
  key: SurfaceKey;
  metallic: number;
  textured: boolean;
  tint: readonly number[] | null;
}[] {
  return (Object.keys(SURFACES) as SurfaceKey[]).map((key) => {
    const s = SURFACES[key];
    return {
      key,
      metallic: s.role ? (s.metalFactor ?? s.metallic ?? 0) : (s.metallic ?? 0),
      textured: !!s.role && !s.noAlbedoMap,
      tint: s.role && !s.noAlbedoMap ? (s.tint ?? [1, 1, 1]) : null,
    };
  });
}

/** Texture edge cap per quality (ORM maps: half). High = the shipped edge. */
const MAX_SIZE: Record<TextureQuality, number> = {
  low: 256,
  medium: 512,
  high: 4096,
};

interface TexSlot {
  /** Stable texture bound to the materials; its internal texture is swapped. */
  tex: Texture;
  file: string;
  kind: MapKind;
  srgb: boolean;
  scale: number;
  /** Shipped edge of the file (px). */
  native: number;
  /** Neutral pixel shown until (and whenever) the real map is missing. */
  neutral: Uint8Array;
  /** Load generation: only the latest request may install its result. */
  gen: number;
  /** Edge of the internal texture shown (0 = neutral). */
  edge: number;
  /** Edge requested by the latest load. */
  want: number;
  pending: Promise<void> | null;
}

export class Materials {
  private static readonly registry = new WeakMap<Scene, Materials>();

  /**
   * The scene's material factory (modules built without one — factory pools,
   * dock — reuse its textured surfaces). Null before the world creates it.
   */
  static of(scene: Scene): Materials | null {
    return Materials.registry.get(scene) ?? null;
  }

  private readonly cache = new Map<string, PBRMaterial>();
  private disposed = false;
  private restoreObs: Observer<unknown> | null = null;
  /** Test hook: retry delays of the texture loader. */
  loaderOptions: Pick<FetchImageOptions, "delays"> = {};
  /** Derived specs (tinted / vertex-coloured) re-textured on load. */
  private readonly derived = new Map<string, SurfaceSpec>();
  private grime: BaseTexture | null = null;
  private panelNormal: Texture | null = null;
  private readonly textures: Texture[] = [];
  private readonly slots = new Map<string, TexSlot>();
  private readonly ownedTextures: BaseTexture[] = [];
  private env: BaseTexture | null = null;
  private exteriorEnv: BaseTexture | null = null;
  private anisotropy = 16;
  private quality: TextureQuality = "high";
  private detail: BaseTexture | null = null;
  private available: Set<string> | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly assetBase: string,
  ) {
    Materials.registry.set(scene, this);
    // glTF characters / props: 1024² at high, 512² below (WS5b P12).
    this.uncap = capTextureUploads(scene.getEngine(), (url, label) =>
      modelTextureCap(url, label, this.quality),
    );
    // After a context restore every map re-uploaded a neutral pixel (see
    // `trackInternal`): reload them through the retrying loader.
    this.restoreObs = scene
      .getEngine()
      .onContextRestoredObservable.add(() =>
        this.reloadAll(true),
      ) as Observer<unknown>;
  }

  private readonly uncap: () => void;

  /** Shared material for a surface. */
  get(key: SurfaceKey): PBRMaterial {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mat = this.build(key, SURFACES[key]);
    this.remember(key, mat);
    return mat;
  }

  /** Cache a shared material; frozen at once when created after `freezeAll`. */
  private remember(k: string, mat: PBRMaterial): void {
    this.cache.set(k, mat);
    if (this.frozenAll) mat.freeze();
  }

  private frozenAll = false;

  /**
   * A surface re-tinted to a colour (felt panels per room, accent fabrics).
   * Same textures, own material; cached per (key, colour).
   */
  tinted(key: SurfaceKey, hex: string): PBRMaterial {
    const k = `t:${key}:${hex}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const base = SURFACES[key];
    const target = lin(hex);
    const mean = this.meanAlbedo(base);
    const spec: SurfaceSpec = {
      ...base,
      color: hex,
      tint: mean
        ? [target.r / mean[0], target.g / mean[1], target.b / mean[2]]
        : base.tint,
    };
    const mat = this.build(k, spec);
    this.derived.set(k, spec);
    if (this.available) this.applyTextures(mat, spec);
    this.remember(k, mat);
    return mat;
  }

  /**
   * A textured surface for vertex-coloured merged meshes (dock shell, plant
   * walls): the surface's normal + ORM (+ detail / grime) at world scale, but
   * the albedo is `albedo` × the vertex colour (no albedo map, no tint > 1).
   * Meshes need world-metre UVs (`applyWorldUVs`). Cached per key + albedo.
   */
  forVertexColors(
    key: SurfaceKey,
    opts: {
      albedo?: number;
      grime?: boolean;
      env?: number;
      roughFactor?: number;
      /** Constant roughness = roughFactor (no ORM roughness variation). */
      flatRough?: boolean;
      bumpLevel?: number;
      /** false: no normal / ORM maps from the role's set (grime only). */
      relief?: boolean;
    } = {},
  ): PBRMaterial {
    const albedo = opts.albedo ?? 0.8;
    const k = `vc:${key}:${albedo}:${JSON.stringify(opts)}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const base = SURFACES[key];
    const g = Math.round(Math.min(1, albedo) * 255)
      .toString(16)
      .padStart(2, "0");
    const spec: SurfaceSpec = {
      ...base,
      color: `#${g}${g}${g}`,
      noAlbedoMap: true,
      tint: undefined,
      env: opts.env ?? base.env,
      roughFactor: opts.roughFactor ?? base.roughFactor,
      bumpLevel: opts.bumpLevel ?? base.bumpLevel,
      flatRough: opts.flatRough,
      grime: opts.grime,
      ...(opts.relief === false ? { role: undefined } : {}),
    };
    const mat = this.build(k, spec);
    this.derived.set(k, spec);
    if (this.available) this.applyTextures(mat, spec);
    this.remember(k, mat);
    return mat;
  }

  /** Acoustic felt in a given colour. */
  felt(hex: string): PBRMaterial {
    return this.tinted("wallFelt", hex);
  }

  /** Solid colour material (cached by colour + options). */
  color(hex: string, roughness = 0.6, metallic = 0): PBRMaterial {
    const k = `c:${hex}:${roughness}:${metallic}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const mat = this.build(k, { color: hex, roughness, metallic });
    this.remember(k, mat);
    return mat;
  }

  /** Emissive material (signage, reveals): static, shared, frozen. */
  emissive(name: string, hex: string, intensity = 2): PBRMaterial {
    const k = `e:${name}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const mat = this.build(k, {
      color: "#000000",
      roughness: 1,
      emissive: { color: hex, intensity },
    });
    this.remember(k, mat);
    return mat;
  }

  /** A unique (un-cached) emissive material the caller owns (animated lamps). */
  createEmissive(name: string, hex: string, intensity = 2): PBRMaterial {
    return this.build(name, {
      color: "#000000",
      roughness: 1,
      emissive: { color: hex, intensity },
    });
  }

  setEnvironment(env: BaseTexture | null): void {
    this.env = env;
  }

  /**
   * Exterior HDRI cube: exterior glass reflects the city instead of the
   * interior IBL. Applied in place (the glass material is never frozen).
   */
  setExteriorReflection(tex: BaseTexture | null): void {
    this.exteriorEnv = tex;
    const g = this.cache.get("glassExterior");
    if (g) {
      const frozen = g.isFrozen;
      if (frozen) g.unfreeze();
      g.reflectionTexture = tex;
      g.environmentIntensity = tex ? 0.9 : 0.35;
      if (frozen) g.freeze();
    }
  }

  /** Override a surface's reflection (box-projected probes). Null restores IBL. */
  setReflection(key: SurfaceKey, tex: BaseTexture | null): void {
    const m = this.cache.get(key);
    if (!m) return;
    const frozen = m.isFrozen;
    if (frozen) m.unfreeze();
    m.reflectionTexture = tex;
    if (frozen) m.freeze();
  }

  private build(name: string, spec: SurfaceSpec): PBRMaterial {
    const mat = new PBRMaterial(`mat:${name}`, this.scene);
    mat.albedoColor = lin(spec.color);
    mat.metallic = spec.metallic ?? 0;
    mat.roughness = spec.roughness;
    mat.environmentIntensity = spec.env ?? 1;
    mat.maxSimultaneousLights = 6;
    // Scene fog is exterior-only (opt-in, see Exterior.enableFog).
    mat.fogEnabled = false;
    // Stops glossy normal-mapped surfaces from shimmering.
    mat.enableSpecularAntiAliasing = true;
    mat.useHorizonOcclusion = true;
    mat.useRadianceOcclusion = true;
    if (spec.clearCoat) {
      mat.clearCoat.isEnabled = true;
      mat.clearCoat.intensity = spec.clearCoat.intensity;
      mat.clearCoat.roughness = spec.clearCoat.roughness;
      mat.clearCoat.indexOfRefraction = 1.5;
    }
    if (spec.emissive) {
      mat.emissiveColor = lin(spec.emissive.color);
      mat.emissiveIntensity = spec.emissive.intensity;
      mat.disableLighting = true;
      mat.environmentIntensity = 0;
    }
    if (name === "moss") this.applyMoss(mat);
    if (spec.alpha !== undefined) {
      mat.alpha = spec.alpha;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      mat.backFaceCulling = false;
      // Keep reflections at full strength on transparent glass.
      mat.useRadianceOverAlpha = true;
      mat.useSpecularOverAlpha = true;
      mat.indexOfRefraction = 1.5;
      mat.metallicF0Factor = 1;
      // Thin glass never writes depth: panes behind panes must still blend.
      mat.disableDepthWrite = true;
      mat.needDepthPrePass = false;
      mat.environmentIntensity = spec.env ?? 0.3;
      if (name === "glassFrosted") {
        // Solid satin-etched band (reads cleanly at any distance).
        mat.alpha = 0.55;
        mat.environmentIntensity = 0.15;
        mat.useRadianceOverAlpha = false;
        mat.useSpecularOverAlpha = false;
      }
      if (name === "glassExterior" && this.exteriorEnv) {
        mat.reflectionTexture = this.exteriorEnv;
        mat.environmentIntensity = 0.9;
      }
    }
    return mat;
  }

  private applyMoss(mat: PBRMaterial): void {
    const { albedo, normal } = createMossTextures(this.scene);
    const s = 1 / 1.1;
    for (const t of [albedo, normal]) {
      t.uScale = s;
      t.vScale = s;
    }
    mat.albedoTexture = albedo;
    mat.albedoColor = Color3.White();
    mat.bumpTexture = normal;
    normal.level = 1.4;
    mat.roughness = 1;
    mat.environmentIntensity = 0.5;
    this.ownedTextures.push(albedo, normal);
  }

  private detailMap(grime = false): BaseTexture {
    if (grime) {
      if (!this.grime) {
        this.grime = createDetailMap(this.scene, 11, 512, 1.6);
        this.ownedTextures.push(this.grime);
      }
      return this.grime;
    }
    if (!this.detail) {
      this.detail = createDetailMap(this.scene);
      this.ownedTextures.push(this.detail);
    }
    return this.detail;
  }

  private sandwichNormal(): Texture {
    if (!this.panelNormal) {
      this.panelNormal = createSandwichPanelNormal(this.scene);
      this.ownedTextures.push(this.panelNormal);
    }
    return this.panelNormal;
  }

  private assetFor(spec: SurfaceSpec): PbrMaterialAsset | null {
    if (!spec.role) return null;
    if (spec.asset) {
      for (const list of Object.values(MATERIAL_CANDIDATES)) {
        const hit = list.find((a) => a.id === spec.asset);
        if (hit) return hit;
      }
    }
    return MATERIALS2[spec.role];
  }

  private meanAlbedo(spec: SurfaceSpec): [number, number, number] | null {
    const a = this.assetFor(spec);
    return a ? (MEAN_ALBEDO[a.id] ?? null) : null;
  }

  /**
   * Probe the materials2 files and upgrade every textured surface in place.
   * Missing files are skipped silently (flat colours remain).
   */
  async loadTextures(): Promise<void> {
    const ids = new Set<string>();
    for (const spec of Object.values(SURFACES)) {
      const a = this.assetFor(spec);
      if (a) ids.add(a.id);
    }
    const ok = await Promise.all(
      [...ids].map(async (id) => ({
        id,
        ok: await urlExists(
          this.url(`${id}/albedo.webp`),
          this.loaderOptions.delays,
        ),
      })),
    );
    this.available = new Set(ok.filter((r) => r.ok).map((r) => r.id));
    for (const key of Object.keys(SURFACES) as SurfaceKey[]) {
      const spec = SURFACES[key];
      if (!spec.role) {
        // Flat surfaces still get the detail map where requested.
        if (spec.detail) this.applyDetail(this.get(key), spec);
        continue;
      }
      this.applyTextures(this.get(key), spec);
    }
    for (const [k, spec] of this.derived) {
      const mat = this.cache.get(k);
      if (mat) this.applyTextures(mat, spec);
    }
    await this.whenTexturesReady();
  }

  private url(file: string): string {
    // materials2 lives under the asset base (default "/assets/materials2").
    const base = this.assetBase.replace(/\/$/, "");
    return material2Path(file).replace(/^\/assets/, base);
  }

  private applyTextures(mat: PBRMaterial, spec: SurfaceSpec): void {
    const asset = this.assetFor(spec);
    if (!asset || !this.available?.has(asset.id)) {
      if (spec.detail || spec.grime) this.applyDetail(mat, spec);
      return;
    }
    const tile = spec.tile ?? asset.tileMeters;
    const scale = 1 / tile;
    const frozen = mat.isFrozen;
    if (frozen) mat.unfreeze();
    if (spec.noAlbedoMap) {
      mat.albedoTexture = null;
      mat.albedoColor = lin(spec.color);
    } else {
      mat.albedoTexture = this.tex(asset, "albedo", true, scale);
      const t = spec.tint ?? [1, 1, 1];
      mat.albedoColor = new Color3(t[0], t[1], t[2]);
    }
    // Per-material bump level: a slot per (map, scale, level), never a clone
    // (a clone of a map that is still loading never becomes ready).
    const level = spec.bumpLevel ?? 1;
    let bump: Texture;
    if (spec.normal === "sandwichPanel") {
      bump = this.sandwichNormal().clone();
      bump.uScale = scale;
      bump.vScale = scale;
      bump.level = level;
      this.ownedTextures.push(bump);
    } else bump = this.tex(asset, "normal", false, scale, level);
    mat.bumpTexture = bump;
    // ambientCG ships OpenGL (+Y) normal maps; Babylon's left-handed frame wants DirectX.
    mat.invertNormalMapY = true;
    mat.metallicTexture = this.tex(asset, "orm", false, scale);
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen = !spec.flatRough;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.roughness = spec.roughFactor ?? 1;
    mat.metallic = spec.metalFactor ?? spec.metallic ?? 0;
    if (spec.detail || spec.grime) this.applyDetail(mat, spec);
    if (frozen) mat.freeze();
  }

  private applyDetail(mat: PBRMaterial, spec: SurfaceSpec): void {
    // Grime: 4 m dirt / scuff patches with strong roughness contrast.
    const period = spec.grime ? 4 : (spec.detail ?? 6);
    const d = this.detailMap(!!spec.grime).clone() as Texture;
    d.uScale = 1 / period;
    d.vScale = 1 / period;
    d.uAng = 0;
    d.wAng = spec.detailAngle ?? 0.61;
    this.ownedTextures.push(d);
    mat.detailMap.texture = d;
    mat.detailMap.isEnabled = true;
    // Grime darkens and roughens; it must never polish a patch to a mirror.
    mat.detailMap.diffuseBlendLevel = spec.grime ? 0.5 : 0.6;
    mat.detailMap.roughnessBlendLevel = spec.grime ? 0.45 : 0.8;
    mat.detailMap.bumpLevel = 0.12;
  }

  private tex(
    asset: PbrMaterialAsset,
    kind: MapKind,
    srgb: boolean,
    scale: number,
    level = 1,
  ): Texture {
    const file = asset.files[kind];
    const lv = Math.abs(level - 1) > 1e-3 ? level : 1;
    const key = `${file}@${scale.toFixed(4)}@${lv.toFixed(3)}`;
    const hit = this.slots.get(key);
    if (hit) return hit.tex;
    const neutral = neutralPixel(
      kind,
      MEAN_ALBEDO[asset.id] ?? null,
      !!asset.forceMetal || /^Metal011/.test(asset.id),
    );
    const tex = new Texture(null, this.scene, {
      noMipmap: false,
      invertY: true,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      gammaSpace: srgb,
      internalTexture: this.neutralInternal(neutral),
    });
    tex.name = `mat2:${file}`;
    tex.uScale = scale;
    tex.vScale = scale;
    tex.level = lv;
    tex.anisotropicFilteringLevel = this.anisotropy;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.textures.push(tex);
    const slot: TexSlot = {
      tex,
      file,
      kind,
      srgb,
      scale,
      native: textureEdge(asset, kind),
      neutral,
      gen: 0,
      edge: 0,
      want: 0,
      pending: null,
    };
    this.slots.set(key, slot);
    this.load(slot);
    return tex;
  }

  /** A 1x1 internal texture holding `px` (ready at once, rebuilt from data). */
  private neutralInternal(px: Uint8Array): InternalTexture {
    const it = this.scene
      .getEngine()
      .createRawTexture(
        px,
        1,
        1,
        Constants.TEXTUREFORMAT_RGBA,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      );
    it.isReady = true; // NullEngine leaves raw textures unflagged
    return it;
  }

  /** Edge (px) the current quality wants for a slot's map. */
  private edgeFor(slot: TexSlot): number {
    const cap = MAX_SIZE[this.quality];
    const max = slot.kind === "orm" ? Math.max(128, cap / 2) : cap;
    return Math.min(max, slot.native);
  }

  /**
   * Load the slot's map at the current quality and install it in place. The
   * texture keeps showing what it has (neutral or the previous quality) until
   * the new map is uploaded; a final failure keeps it and is reported.
   */
  private load(slot: TexSlot): Promise<void> {
    const gen = ++slot.gen;
    const edge = this.edgeFor(slot);
    slot.want = edge;
    const url = this.url(slot.file);
    const full = edge >= slot.native;
    // Distinct cache keys per edge: Babylon shares internal textures by URL.
    const key = full ? url : `${url}#${edge}`;
    const stale = () => this.disposed || gen !== slot.gen;
    const p = this.decode(url, key, full ? undefined : edge)
      .then((bmp) => (stale() ? undefined : this.upload(slot, key, bmp, gen)))
      .then(
        () => {
          if (!stale()) noteTextureRecovered(url);
        },
        (err: unknown) => {
          if (!stale()) noteTextureFailure(url, err);
        },
      )
      .finally(() => {
        if (slot.pending === p) slot.pending = null;
      });
    slot.pending = p;
    return p;
  }

  /** One fetch + decode per (url, edge) in flight, shared by its slots. */
  private readonly decoding = new Map<string, Promise<ImageBitmap>>();

  private decode(
    url: string,
    key: string,
    edge: number | undefined,
  ): Promise<ImageBitmap> {
    const hit = this.decoding.get(key);
    if (hit) return hit;
    // Shared by every slot of this (url, edge): only disposal cancels it.
    const p: Promise<ImageBitmap> = fetchImage(url, {
      edge,
      delays: this.loaderOptions.delays,
      cancelled: () => this.disposed,
    }).finally(() => {
      // Keep the entry until the slots of this tick have taken the bitmap.
      setTimeout(() => {
        if (this.decoding.get(key) === p) this.decoding.delete(key);
      }, 0);
    });
    this.decoding.set(key, p);
    return p;
  }

  /** Upload a decoded map and swap it into the slot's texture. */
  private upload(
    slot: TexSlot,
    key: string,
    bmp: ImageBitmap,
    gen: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Babylon may call onLoad / onError synchronously from the constructor
      // (an ImageBitmap upload is immediate): record, then settle once the
      // probe exists.
      let probe: Texture | null = null;
      let loaded = false;
      let error: string | null = null;
      let settled = false;
      const settle = () => {
        if (settled || !probe || (!loaded && error === null)) return;
        settled = true;
        clearTimeout(timer);
        if (loaded) {
          this.install(slot, probe, gen);
          resolve();
        } else {
          probe.dispose();
          reject(new Error(error ?? "upload failed"));
        }
      };
      const timer = setTimeout(() => {
        error = "upload timed out";
        settle();
      }, 20000);
      probe = new Texture(key, this.scene, {
        noMipmap: false,
        invertY: true,
        samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
        gammaSpace: slot.srgb,
        buffer: bmp,
        onLoad: () => {
          loaded = true;
          settle();
        },
        onError: (message?: string) => {
          error = message || "upload failed";
          settle();
        },
      });
      settle();
    });
  }

  private install(slot: TexSlot, probe: Texture, gen: number): void {
    const internal = probe.getInternalTexture();
    if (!internal || this.disposed || gen !== slot.gen) {
      probe.dispose();
      return;
    }
    this.trackInternal(internal, slot.neutral);
    const prev = slot.tex._texture;
    // Hand the probe's reference to the slot texture (no refcount change).
    slot.tex._texture = internal;
    probe._texture = null;
    probe.dispose();
    // Drops the slot's old reference (when the cache handed back the same
    // internal texture, this drops the probe's extra reference instead).
    prev?.dispose();
    slot.edge = slot.want;
  }

  /**
   * Context loss: Babylon rebuilds a URL texture by fetching it again and,
   * when that fetch fails, never flags it ready again (the materials, and
   * every mesh using them, are then skipped). Rebuild with the neutral pixel
   * instead (ready at once; the URL is retired so no later load reuses it)
   * and let `onContextRestored` reload the real maps through the loader.
   */
  private trackInternal(it: InternalTexture, neutral: Uint8Array): void {
    // Decoded bitmaps are not kept for a rebuild (memory): the loader reloads.
    it._buffer = null;
    it.onRebuildCallback = () => {
      it.url = `${it.url}#lost`;
      return {
        proxy: this.neutralInternal(neutral),
        isReady: true,
        isAsync: false,
      };
    };
  }

  /** Reload every map (quality change: only those whose edge changes). */
  private reloadAll(force: boolean): void {
    if (this.disposed) return;
    for (const slot of this.slots.values())
      if (force || this.edgeFor(slot) !== slot.want) this.load(slot);
  }

  private whenTexturesReady(): Promise<void> {
    const pending = [...this.slots.values()]
      .map((s) => s.pending)
      .filter((p): p is Promise<void> => !!p);
    if (pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      void Promise.allSettled(pending).then(() => resolve());
      // Never block the world on a slow texture (the neutral map shows).
      setTimeout(resolve, 8000);
    });
  }

  /** Anisotropic filtering for the tiled surface textures (16 high, 4 low). */
  setAnisotropy(level: number): void {
    this.anisotropy = level;
    for (const t of this.textures) t.anisotropicFilteringLevel = level;
  }

  /**
   * Max texture edge (see MAX_SIZE). Reloads the maps whose edge changes in
   * place; each keeps showing its current map until the new one is uploaded.
   */
  setTextureQuality(q: TextureQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.reloadAll(false);
  }

  /** Diagnostics: slots still loading / showing the neutral map. */
  textureStats(): { slots: number; loading: number; neutral: number } {
    let loading = 0;
    let neutral = 0;
    for (const s of this.slots.values()) {
      if (s.pending) loading += 1;
      if (s.edge === 0) neutral += 1;
    }
    return { slots: this.slots.size, loading, neutral };
  }

  /**
   * Freeze every cached material (none animates: reflection / texture swaps
   * thaw and re-freeze in place). Materials cached later freeze on creation.
   */
  freezeAll(): void {
    this.frozenAll = true;
    for (const m of this.cache.values()) m.freeze();
  }

  dispose(): void {
    this.disposed = true;
    if (this.restoreObs)
      this.scene
        .getEngine()
        .onContextRestoredObservable.remove(this.restoreObs);
    this.restoreObs = null;
    this.decoding.clear();
    this.uncap();
    for (const m of this.cache.values()) m.dispose(false, false);
    for (const t of this.textures) t.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.cache.clear();
    this.derived.clear();
    this.slots.clear();
    this.textures.length = 0;
    this.ownedTextures.length = 0;
    this.env = null;
    this.exteriorEnv = null;
    this.detail = null;
    this.grime = null;
    this.panelNormal = null;
    if (Materials.registry.get(this.scene) === this)
      Materials.registry.delete(this.scene);
  }
}

/** Linear mean albedo of the ambientCG maps (precomputed; used by `tinted`). */
const MEAN_ALBEDO: Record<string, [number, number, number]> = {
  Concrete034: [0.484, 0.484, 0.484],
  Concrete032: [0.09, 0.091, 0.088],
  Concrete046: [0.609, 0.617, 0.487],
  Wood095: [0.595, 0.397, 0.258],
  Wood050: [0.675, 0.496, 0.391],
  Carpet012: [0.097, 0.099, 0.102],
  Carpet016: [0.257, 0.258, 0.249],
  Terrazzo006: [0.755, 0.688, 0.627],
  Plaster002: [0.767, 0.762, 0.749],
  Plaster001: [0.847, 0.839, 0.825],
  Fabric030: [0.143, 0.141, 0.143],
  Fabric061: [0.261, 0.248, 0.235],
  Fabric036: [0.492, 0.492, 0.492],
  Metal011: [0.684, 0.7, 0.728],
  Metal030: [0.079, 0.091, 0.103],
  Leather026: [0.023, 0.022, 0.022],
  Rubber004: [0.023, 0.025, 0.031],
};

/**
 * HEAD probe with the loader's retries: a 404 is a definite "missing" (flat
 * colour stays); network / server errors are retried, then reported.
 */
async function urlExists(
  url: string,
  delays: readonly number[] = [400, 1200],
): Promise<boolean> {
  let last: unknown = null;
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delays[i - 1]));
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.ok) return true;
      if (r.status === 404) return false;
      last = new Error(`HTTP ${r.status}`);
    } catch (err) {
      last = err;
    }
  }
  noteTextureFailure(url, last);
  return false;
}

// ---------------------------------------------------------------------------
// UV helpers
// ---------------------------------------------------------------------------

const tmpP = new Vector3();
const tmpN = new Vector3();

/**
 * Box-project UVs from world-space positions (metres): each vertex takes the
 * two axes perpendicular to its dominant normal. With `uScale = 1/tile` on the
 * texture, tiling is uniform across meshes of any size and continuous across
 * neighbouring panels. Call after the mesh is positioned (before merging).
 */
export function applyWorldUVs(mesh: Mesh, offset = 0): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nor) return;
  const wm = mesh.computeWorldMatrix(true);
  const uvs = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      pos[i],
      pos[i + 1],
      pos[i + 2],
      wm,
      tmpP,
    );
    Vector3.TransformNormalFromFloatsToRef(
      nor[i],
      nor[i + 1],
      nor[i + 2],
      wm,
      tmpN,
    );
    const ax = Math.abs(tmpN.x);
    const ay = Math.abs(tmpN.y);
    const az = Math.abs(tmpN.z);
    if (ay >= ax && ay >= az) {
      uvs[j] = tmpP.x + offset;
      uvs[j + 1] = tmpP.z + offset;
    } else if (ax >= az) {
      uvs[j] = tmpP.z + offset;
      uvs[j + 1] = tmpP.y;
    } else {
      uvs[j] = tmpP.x + offset;
      uvs[j + 1] = tmpP.y;
    }
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
}
