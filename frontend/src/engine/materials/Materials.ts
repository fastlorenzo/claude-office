/**
 * PBR material factory.
 *
 * Every surface material is a `PBRMaterial` that starts with a tasteful flat
 * colour (so the office looks finished with no downloaded assets) and is
 * upgraded in place with the Poly Haven texture set for its role once
 * `loadTextures()` confirms the files exist. Textures are projected in world
 * metres (see `applyWorldUVs`), so `uScale = 1 / tileMeters` gives a uniform
 * real-world scale on every mesh regardless of its size.
 *
 * Palette: modern Scandinavian tech office — warm light oak, white / light
 * grey plaster, charcoal accents, Claude orange (#D97757) as brand accent.
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
  ASSET_MANIFEST,
  texturePath,
  type TextureAsset,
  type TextureRole,
} from "@/engine/assets/manifest";

/** Gamma hex → linear Color3 (PBR colours are linear). */
export function lin(hex: string): Color3 {
  return Color3.FromHexString(hex).toLinearSpace();
}

export const PALETTE = {
  claude: "#D97757",
  claudeDeep: "#B85C3E",
  charcoal: "#2B2D31",
  graphite: "#3A3D42",
  plaster: "#ECEAE5",
  plasterCool: "#E4E5E6",
  ceiling: "#F3F2EF",
  oak: "#C9A27A",
  oakDark: "#8C6646",
  sage: "#7E9A82",
  fabric: "#6F737A",
  fabricWarm: "#A5978A",
  aluminium: "#C8CBCF",
} as const;

export type SurfaceKey =
  | TextureRole
  | "wallAccentWarm" // Claude orange feature wall (lobby / signage)
  | "wallDark" // charcoal feature wall (control room)
  | "oak" // light oak furniture (flat, satin)
  | "oakDark"
  | "charcoal" // powder-coated charcoal metal
  | "aluminium" // brushed aluminium frames / mullions
  | "chrome"
  | "glass"
  | "glassFrosted"
  | "fabric"
  | "fabricWarm"
  | "fabricAccent"
  | "leather"
  | "plantLeaf"
  | "plantLeafDark"
  | "soil"
  | "ceramic"
  | "rubber"
  | "screenOff"
  | "lightPanel" // emissive ceiling panel (warm white)
  | "lightPanelCool"
  | "skirting"
  | "glassTint" // smoked glass (control room partition)
  | "floorDark"
  | "ceilingDark"
  | "lightPanelDim" // cool, dim linear lights (control room)
  | "ledBlue" // emissive accent strip
  | "quartz" // white stone counter tops
  | "rug";

interface SurfaceSpec {
  color: string;
  roughness: number;
  metallic?: number;
  /** Use the role texture's diffuse map (false → flat colour with texture normal/ARM detail). */
  useDiffuse?: boolean;
  /** Tint multiplied with the diffuse map. */
  tint?: string;
  bumpLevel?: number;
  emissive?: { color: string; intensity: number };
  alpha?: number;
}

const SURFACES: Record<SurfaceKey, SurfaceSpec> = {
  // laminate_floor_02 — warm light wood plank floor in the rooms
  floorRoom: {
    color: "#A8896A",
    roughness: 0.55,
    useDiffuse: true,
    tint: "#FFFFFF",
    bumpLevel: 0.5,
  },
  // grey_tiles — normal/ARM only: polished warm-grey large-format tiles
  floorHall: {
    color: "#95928D",
    roughness: 0.3,
    useDiffuse: false,
    bumpLevel: 0.6,
  },
  // herringbone_parquet — lobby
  floorLobby: {
    color: "#9C7A56",
    roughness: 0.5,
    useDiffuse: true,
    tint: "#DCD3CA",
    bumpLevel: 0.6,
  },
  // painted_plaster_wall — flat white paint over the texture's relief
  wall: {
    color: PALETTE.plaster,
    roughness: 0.9,
    useDiffuse: false,
    bumpLevel: 0.35,
  },
  wallAccent: {
    color: "#9A9893",
    roughness: 0.85,
    useDiffuse: true,
    tint: "#F2EFEA",
    bumpLevel: 0.7,
  },
  // white_stucco
  ceiling: {
    color: PALETTE.ceiling,
    roughness: 0.95,
    useDiffuse: false,
    bumpLevel: 0.2,
  },
  // walnut_veneer_02 — reception, slat walls
  wood: {
    color: "#A98972",
    roughness: 0.5,
    useDiffuse: true,
    tint: "#FFFFFF",
    bumpLevel: 0.4,
  },
  metal: {
    color: "#7F8286",
    roughness: 0.5,
    metallic: 0.6,
    useDiffuse: true,
    tint: "#FFFFFF",
    bumpLevel: 0.3,
  },
  wallAccentWarm: { color: PALETTE.claude, roughness: 0.85 },
  wallDark: { color: "#1E2126", roughness: 0.7 },
  oak: { color: PALETTE.oak, roughness: 0.46 },
  oakDark: { color: PALETTE.oakDark, roughness: 0.5 },
  charcoal: { color: PALETTE.charcoal, roughness: 0.55, metallic: 0.3 },
  aluminium: { color: PALETTE.aluminium, roughness: 0.32, metallic: 1 },
  chrome: { color: "#E8EAEC", roughness: 0.12, metallic: 1 },
  glass: { color: "#F4F8F8", roughness: 0.06, alpha: 0.1 },
  glassFrosted: { color: "#F4F6F6", roughness: 0.35, alpha: 0.55 },
  fabric: { color: PALETTE.fabric, roughness: 0.95 },
  fabricWarm: { color: PALETTE.fabricWarm, roughness: 0.95 },
  fabricAccent: { color: PALETTE.claude, roughness: 0.92 },
  leather: { color: "#3B342F", roughness: 0.55 },
  plantLeaf: { color: "#4E7A45", roughness: 0.65 },
  plantLeafDark: { color: "#2F5A32", roughness: 0.6 },
  soil: { color: "#3A2C22", roughness: 1 },
  ceramic: { color: "#E9E6E1", roughness: 0.3 },
  rubber: { color: "#1C1D20", roughness: 0.85 },
  screenOff: { color: "#0B0D10", roughness: 0.18 },
  lightPanel: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#FFF4E6", intensity: 3.2 },
  },
  lightPanelCool: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#E2ECFF", intensity: 2.6 },
  },
  skirting: { color: "#D9D6D0", roughness: 0.6 },
  glassTint: { color: "#3A4652", roughness: 0.06, alpha: 0.5 },
  floorDark: {
    color: "#25272B",
    roughness: 0.38,
    useDiffuse: false,
    bumpLevel: 0.4,
  },
  ceilingDark: { color: "#1B1D21", roughness: 0.9 },
  lightPanelDim: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#BFD4FF", intensity: 1.3 },
  },
  ledBlue: {
    color: "#000000",
    roughness: 1,
    emissive: { color: "#3B82F6", intensity: 2.4 },
  },
  quartz: { color: "#F1EFEB", roughness: 0.22 },
  rug: { color: "#5E6168", roughness: 1 },
};

/** Roles whose surfaces map to a manifest texture set. */
const TEXTURE_ROLE_OF: Partial<Record<SurfaceKey, TextureRole>> = {
  floorRoom: "floorRoom",
  floorHall: "floorHall",
  floorDark: "floorHall",
  floorLobby: "floorLobby",
  wall: "wall",
  wallAccent: "wallAccent",
  ceiling: "ceiling",
  wood: "wood",
  metal: "metal",
};

export class Materials {
  private readonly cache = new Map<string, PBRMaterial>();
  private readonly textures: Texture[] = [];
  private env: BaseTexture | null = null;
  private anisotropy = 16;

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

  private build(name: string, spec: SurfaceSpec): PBRMaterial {
    const mat = new PBRMaterial(`mat:${name}`, this.scene);
    mat.albedoColor = lin(spec.color);
    mat.metallic = spec.metallic ?? 0;
    mat.roughness = spec.roughness;
    mat.environmentIntensity = 1;
    mat.maxSimultaneousLights = 4;
    // Stops glossy normal-mapped surfaces from shimmering.
    mat.enableSpecularAntiAliasing = true;
    if (spec.emissive) {
      mat.emissiveColor = lin(spec.emissive.color);
      mat.emissiveIntensity = spec.emissive.intensity;
      mat.disableLighting = true;
      mat.environmentIntensity = 0;
    }
    if (spec.alpha !== undefined) {
      mat.alpha = spec.alpha;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      mat.backFaceCulling = false;
      // Keep IBL reflections at full strength on transparent glass.
      mat.useRadianceOverAlpha = true;
      mat.useSpecularOverAlpha = true;
      mat.indexOfRefraction = 1.5;
      mat.metallicF0Factor = 1;
      // Thin glass never writes depth: panes behind panes must still blend.
      mat.disableDepthWrite = true;
      mat.needDepthPrePass = false;
      // The HDRI is an interior: keep its reflection subtle so glass reads clear, not smeared.
      mat.environmentIntensity = 0.35;
    }
    return mat;
  }

  /**
   * Probe the manifest textures and upgrade the role materials in place.
   * Missing files are skipped silently (flat colours remain).
   */
  async loadTextures(): Promise<void> {
    const results = await Promise.all(
      ASSET_MANIFEST.textures.map(async (t) => ({
        t,
        ok: await urlExists(texturePath(t.id, "diff", this.assetBase)),
      })),
    );
    const byRole = new Map<TextureRole, TextureAsset>();
    for (const r of results) if (r.ok) byRole.set(r.t.role, r.t);

    for (const [key, role] of Object.entries(TEXTURE_ROLE_OF) as [
      SurfaceKey,
      TextureRole,
    ][]) {
      const asset = byRole.get(role);
      if (!asset) continue;
      const mat = this.get(key);
      this.applyTextureSet(mat, asset, SURFACES[key]);
    }
    await this.whenTexturesReady();
  }

  private applyTextureSet(
    mat: PBRMaterial,
    asset: TextureAsset,
    spec: SurfaceSpec,
  ): void {
    const scale = 1 / asset.tileMeters;
    const mk = (map: "diff" | "nor_gl" | "arm", srgb: boolean) => {
      const tex = new Texture(
        texturePath(asset.id, map, this.assetBase),
        this.scene,
        {
          noMipmap: false,
          invertY: true,
          samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
          gammaSpace: srgb,
        },
      );
      tex.uScale = scale;
      tex.vScale = scale;
      tex.anisotropicFilteringLevel = this.anisotropy;
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.textures.push(tex);
      return tex;
    };
    mat.unfreeze();
    if (asset.maps.includes("diff") && spec.useDiffuse) {
      mat.albedoTexture = mk("diff", true);
      mat.albedoColor = lin(spec.tint ?? "#FFFFFF");
    }
    if (asset.maps.includes("nor_gl")) {
      const bump = mk("nor_gl", false);
      bump.level = spec.bumpLevel ?? 1;
      mat.bumpTexture = bump;
      // Poly Haven ships OpenGL (+Y) normal maps; Babylon's left-handed frame wants DirectX.
      mat.invertNormalMapY = true;
    }
    if (asset.maps.includes("arm")) {
      mat.metallicTexture = mk("arm", false);
      mat.useAmbientOcclusionFromMetallicTextureRed = true;
      mat.useRoughnessFromMetallicTextureGreen = true;
      mat.useMetallnessFromMetallicTextureBlue = true;
      // Texture values are multiplied by these factors.
      mat.roughness = Math.min(1, spec.roughness * 1.35);
      mat.metallic = spec.metallic ?? 0;
    }
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
      for (const t of pending) {
        const obs = t.onLoadObservable.addOnce(done);
        void obs;
      }
      // Never block the world on a stuck texture.
      setTimeout(resolve, 8000);
    });
  }

  /** Anisotropic filtering for the tiled surface textures (16 high, 8 low). */
  setAnisotropy(level: number): void {
    this.anisotropy = level;
    for (const t of this.textures) t.anisotropicFilteringLevel = level;
  }

  /** Freeze every cached material that does not animate. */
  freezeAll(): void {
    for (const [k, m] of this.cache) {
      if (k.startsWith("e:")) continue;
      m.freeze();
    }
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose(false, false);
    for (const t of this.textures) t.dispose();
    this.cache.clear();
    this.textures.length = 0;
    this.env = null;
  }
}

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
