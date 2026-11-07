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
 *                             512 / 1024 / 2048 (reloads the maps in place)
 * ---------------------------------------------------------------------------
 */
import {
  Color3,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  Vector3,
  VertexBuffer,
  type BaseTexture,
} from "@/engine/babylon";
import {
  MATERIALS2,
  material2Path,
  MATERIAL_CANDIDATES,
  type MaterialRole,
  type PbrMaterialAsset,
} from "@/engine/assets/materials2";
import {
  createDetailMap,
  createMossTextures,
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
  | "nocGloss"; // control-room console / screen surround

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
}

const SURFACES: Record<SurfaceKey, SurfaceSpec> = {
  // ---- floors ----
  floorHall: {
    color: "#97948F",
    roughness: 0.34,
    role: "floorMain",
    tint: [0.66, 0.63, 0.6],
    roughFactor: 0.66,
    bumpLevel: 0.12,
    detail: 6,
  },
  floorLobby: {
    color: "#C9C5BE",
    roughness: 0.26,
    role: "floorTerrazzo",
    tile: 0.6,
    tint: [0.8, 0.74, 0.69],
    roughFactor: 0.46,
    bumpLevel: 0.25,
    detail: 7,
  },
  floorRoom: {
    color: "#5A5B5E",
    roughness: 0.95,
    role: "floorCarpet",
    tint: [1.02, 1.0, 1.0],
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
    color: "#2A2C30",
    roughness: 0.3,
    role: "floorMain",
    tint: [0.11, 0.115, 0.125],
    roughFactor: 0.55,
    bumpLevel: 0.3,
    detail: 6,
    env: 0.5,
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
    detail: 5,
  },
  wallAccent: {
    color: "#55575A",
    roughness: 0.8,
    role: "wallFeature",
    tint: [1.05, 1.04, 1.03],
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
    tint: [1.02, 1.01, 0.99],
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
    color: "#A5A8AC",
    roughness: 0.4,
    metallic: 1,
    role: "metalBrushed",
    tint: [2.3, 2.3, 2.3],
    roughFactor: 0.9,
    metalFactor: 1,
    bumpLevel: 0.2,
  },
  aluminium: {
    color: PALETTE.aluminium,
    roughness: 0.36,
    metallic: 1,
    role: "metalBrushed",
    tint: [2.5, 2.5, 2.45],
    // ≥ 0.4: brushed, and keeps SSR from speckling on large door leaves.
    roughFactor: 0.88,
    metalFactor: 1,
    bumpLevel: 0.15,
  },
  chrome: { color: "#E8EAEC", roughness: 0.1, metallic: 1 },
  blackMetal: {
    color: "#18191B",
    roughness: 0.42,
    role: "metalDark",
    tint: [1.6, 1.6, 1.6],
    roughFactor: 1.4,
    metalFactor: 0,
    bumpLevel: 0.1,
  },
  charcoal: {
    color: PALETTE.charcoal,
    roughness: 0.5,
    role: "metalDark",
    tint: [6.5, 6.6, 7.0],
    roughFactor: 1.6,
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
    tint: [1.45, 1.38, 1.28],
    roughFactor: 1.15,
    bumpLevel: 0.8,
  },
  fabricAccent: {
    color: "#B4694C",
    roughness: 0.95,
    role: "fabricUpholstery",
    tint: [1.6, 0.62, 0.42],
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
    tint: [3.2, 2.7, 2.3],
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
  glass: { color: "#F2F6F6", roughness: 0.04, alpha: 0.08 },
  glassExterior: { color: "#E8EEF0", roughness: 0.03, alpha: 0.12 },
  glassFrosted: { color: "#F4F6F6", roughness: 0.4, alpha: 0.62 },
  glassTint: { color: "#2E3842", roughness: 0.05, alpha: 0.42 },
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
    tint: [1.02, 0.98, 0.95],
    roughFactor: 0.35,
    bumpLevel: 0.12,
    tile: 0.9,
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
    asset: "Concrete019",
    tint: [1.15, 1.08, 1.05],
    roughFactor: 1.0,
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
};

const MAX_SIZE: Record<TextureQuality, number> = {
  low: 512,
  medium: 1024,
  high: 2048,
};

type MapKind = "albedo" | "normal" | "orm";

interface TexSlot {
  tex: Texture;
  file: string;
  srgb: boolean;
  scale: number;
}

export class Materials {
  private readonly cache = new Map<string, PBRMaterial>();
  private readonly textures: Texture[] = [];
  private readonly slots = new Map<string, TexSlot>();
  private readonly ownedTextures: BaseTexture[] = [];
  private env: BaseTexture | null = null;
  private exteriorEnv: BaseTexture | null = null;
  private anisotropy = 16;
  private quality: TextureQuality = "high";
  private loadedQuality: TextureQuality | null = null;
  private detail: BaseTexture | null = null;
  private available: Set<string> | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly assetBase: string,
  ) {}

  /** Shared material for a surface. */
  get(key: SurfaceKey): PBRMaterial {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mat = this.build(key, SURFACES[key]);
    this.cache.set(key, mat);
    return mat;
  }

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
    this.cache.set(k, mat);
    if (this.available) this.applyTextures(mat, spec);
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
    this.cache.set(k, mat);
    return mat;
  }

  /** Emissive material (status lamps, signage). Not frozen: colour animates. */
  emissive(name: string, hex: string, intensity = 2): PBRMaterial {
    const k = `e:${name}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const mat = this.build(k, {
      color: "#000000",
      roughness: 1,
      emissive: { color: hex, intensity },
    });
    this.cache.set(k, mat);
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
      g.reflectionTexture = tex;
      g.environmentIntensity = tex ? 0.9 : 0.35;
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
    // Stops glossy normal-mapped surfaces from shimmering.
    mat.enableSpecularAntiAliasing = true;
    mat.useHorizonOcclusion = true;
    mat.useRadianceOcclusion = true;
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
      mat.environmentIntensity = 0.3;
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

  private detailMap(): BaseTexture {
    if (!this.detail) {
      this.detail = createDetailMap(this.scene);
      this.ownedTextures.push(this.detail);
    }
    return this.detail;
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
        ok: await urlExists(this.url(`${id}/albedo.webp`)),
      })),
    );
    this.available = new Set(ok.filter((r) => r.ok).map((r) => r.id));
    this.loadedQuality = this.quality;
    for (const key of Object.keys(SURFACES) as SurfaceKey[]) {
      const spec = SURFACES[key];
      if (!spec.role) {
        // Flat surfaces still get the detail map where requested.
        if (spec.detail) this.applyDetail(this.get(key), spec.detail);
        continue;
      }
      this.applyTextures(this.get(key), spec);
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
      if (spec.detail) this.applyDetail(mat, spec.detail);
      return;
    }
    const tile = spec.tile ?? asset.tileMeters;
    const scale = 1 / tile;
    const frozen = mat.isFrozen;
    if (frozen) mat.unfreeze();
    mat.albedoTexture = this.tex(asset.files.albedo, true, scale, "albedo");
    const t = spec.tint ?? [1, 1, 1];
    mat.albedoColor = new Color3(t[0], t[1], t[2]);
    const bump = this.tex(asset.files.normal, false, scale, "normal");
    mat.bumpTexture = bump;
    // ambientCG ships OpenGL (+Y) normal maps; Babylon's left-handed frame wants DirectX.
    mat.invertNormalMapY = true;
    mat.metallicTexture = this.tex(asset.files.orm, false, scale, "orm");
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.roughness = spec.roughFactor ?? 1;
    mat.metallic = spec.metalFactor ?? spec.metallic ?? 0;
    // Per-material bump level lives on a per-material texture clone only when
    // it differs from 1 (textures are shared across materials).
    const level = spec.bumpLevel ?? 1;
    if (Math.abs(level - 1) > 1e-3) {
      const b = bump.clone();
      b.level = level;
      this.textures.push(b);
      mat.bumpTexture = b;
    }
    if (spec.detail) this.applyDetail(mat, spec.detail);
    if (frozen) mat.freeze();
  }

  private applyDetail(mat: PBRMaterial, period: number): void {
    const d = this.detailMap().clone() as Texture;
    d.uScale = 1 / period;
    d.vScale = 1 / period;
    d.uAng = 0;
    d.wAng = 0.61;
    this.ownedTextures.push(d);
    mat.detailMap.texture = d;
    mat.detailMap.isEnabled = true;
    mat.detailMap.diffuseBlendLevel = 0.6;
    mat.detailMap.roughnessBlendLevel = 0.8;
    mat.detailMap.bumpLevel = 0.35;
  }

  private tex(
    file: string,
    srgb: boolean,
    scale: number,
    kind: MapKind,
  ): Texture {
    const key = `${file}@${scale.toFixed(4)}`;
    const hit = this.slots.get(key);
    if (hit) return hit.tex;
    const tex = this.createTexture(file, srgb, kind);
    tex.uScale = scale;
    tex.vScale = scale;
    tex.anisotropicFilteringLevel = this.anisotropy;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.textures.push(tex);
    this.slots.set(key, { tex, file, srgb, scale });
    return tex;
  }

  private createTexture(file: string, srgb: boolean, kind: MapKind): Texture {
    const url = this.url(file);
    const max = MAX_SIZE[this.quality];
    // ORM maps ship at 1K; albedo / normal at 2K.
    const native = kind === "orm" ? 1024 : 2048;
    const opts = {
      noMipmap: false,
      invertY: true,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      gammaSpace: srgb,
    };
    if (max >= native || typeof createImageBitmap === "undefined")
      return new Texture(url, this.scene, opts);
    // Downscale on the CPU (ImageBitmap resize) for low / medium texture quality.
    const tex = new Texture(null, this.scene, opts);
    void fetch(url)
      .then((r) => r.blob())
      .then((blob) =>
        createImageBitmap(blob, {
          resizeWidth: max,
          resizeHeight: max,
          resizeQuality: "high",
          imageOrientation: "flipY",
        }),
      )
      .then((bmp) => {
        if (this.scene.isDisposed) return;
        tex.updateURL(url, bmp);
      })
      .catch(() => undefined);
    return tex;
  }

  private whenTexturesReady(): Promise<void> {
    return new Promise((resolve) => {
      const pending = this.textures.filter((t) => !t.isReady());
      if (pending.length === 0) return resolve();
      let left = pending.length;
      const done = () => {
        left -= 1;
        if (left <= 0) resolve();
      };
      for (const t of pending) t.onLoadObservable.addOnce(done);
      // Never block the world on a stuck texture.
      setTimeout(resolve, 8000);
    });
  }

  /** Anisotropic filtering for the tiled surface textures (16 high, 4 low). */
  setAnisotropy(level: number): void {
    this.anisotropy = level;
    for (const t of this.textures) t.anisotropicFilteringLevel = level;
  }

  /** Max texture edge: low 512, medium 1024, high 2048. Reloads maps in place. */
  setTextureQuality(q: TextureQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    if (!this.loadedQuality || this.loadedQuality === q) return;
    this.loadedQuality = q;
    for (const slot of this.slots.values()) {
      const kind: MapKind = slot.file.endsWith("orm.webp")
        ? "orm"
        : slot.file.endsWith("normal.webp")
          ? "normal"
          : "albedo";
      const fresh = this.createTexture(slot.file, slot.srgb, kind);
      const old = slot.tex;
      const swap = () => {
        // Copy the new GPU texture into the existing object (keeps every
        // material / clone binding valid, no material rebuild).
        const internal = fresh.getInternalTexture();
        if (!internal) return;
        old._texture?.dispose();
        old._texture = internal;
        fresh._texture = null;
        fresh.dispose();
      };
      if (fresh.isReady()) swap();
      else fresh.onLoadObservable.addOnce(swap);
    }
  }

  /** Freeze every cached material that does not animate. */
  freezeAll(): void {
    for (const [k, m] of this.cache) {
      if (k.startsWith("e:") || k === "glassExterior") continue;
      m.freeze();
    }
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose(false, false);
    for (const t of this.textures) t.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.cache.clear();
    this.slots.clear();
    this.textures.length = 0;
    this.ownedTextures.length = 0;
    this.env = null;
    this.exteriorEnv = null;
    this.detail = null;
  }
}

/** Linear mean albedo of the ambientCG maps (precomputed; used by `tinted`). */
const MEAN_ALBEDO: Record<string, [number, number, number]> = {
  Concrete034: [0.484, 0.484, 0.484],
  Concrete032: [0.09, 0.091, 0.088],
  Wood095: [0.595, 0.397, 0.258],
  Wood094: [0.405, 0.3, 0.228],
  Wood050: [0.675, 0.496, 0.391],
  Carpet012: [0.097, 0.099, 0.102],
  Carpet016: [0.257, 0.258, 0.249],
  Tiles043: [0.675, 0.722, 0.709],
  Plaster002: [0.767, 0.762, 0.749],
  Plaster001: [0.847, 0.839, 0.825],
  Fabric030: [0.143, 0.141, 0.143],
  Fabric061: [0.261, 0.248, 0.235],
  Fabric036: [0.492, 0.492, 0.492],
  Metal009: [0.289, 0.299, 0.314],
  Metal029: [0.013, 0.016, 0.015],
  Leather026: [0.01, 0.01, 0.009],
  Rubber004: [0.023, 0.025, 0.031],
};

async function urlExists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
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
