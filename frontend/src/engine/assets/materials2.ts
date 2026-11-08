/**
 * Curated CC0 PBR material library ("materials2") for the modern office look.
 *
 * Plain data only (no Babylon). Source of truth for both
 * `scripts/fetch-materials.ts` (download + pack) and the runtime.
 *
 * Every entry is an ambientCG asset (CC0, https://ambientcg.com). Textures are
 * generated into `public/assets/materials2/<id>/` by `bun run materials`, at
 * the edge `textureEdge` gives (≈ 512 texels per metre of tile, 512–1024;
 * GPU memory is the budget, WS5 — ≤ 300 MB resident at "high"):
 *   albedo.webp  sRGB colour
 *   normal.webp  OpenGL (+Y) tangent-space normal
 *   orm.webp     R = ambient occlusion, G = roughness, B = metalness (half)
 * Use orm as PBRMaterial.metallicTexture with
 * useAmbientOcclusionFromMetallicTextureRed / useRoughnessFromMetallicTextureGreen
 * / useMetallnessFromMetallicTextureBlue = true.
 */

export type MaterialRole =
  | "floorMain"
  | "floorWarm"
  | "floorCarpet"
  | "floorTerrazzo"
  | "wallMain"
  | "wallSlats"
  | "wallFelt"
  | "wallFeature"
  | "ceiling"
  | "metalBrushed"
  | "metalDark"
  | "woodFurniture"
  | "fabricUpholstery"
  | "leather"
  | "rubberMat"
  // software factory (plant shell under the offices)
  | "floorEpoxy"
  | "concreteSoffit";

export interface PbrMaterialAsset {
  role: MaterialRole;
  /** ambientCG asset id (also the folder name under materials2/). */
  id: string;
  source: "ambientcg" | "polyhaven";
  files: { albedo: string; normal: string; orm: string };
  /** Real-world edge length (metres) covered by one repeat of the texture. */
  tileMeters: number;
  /** Optional albedo multiplier (hex) to be applied by the consumer. */
  tint?: string;
  notes?: string;
  /** Build-time albedo grade baked in by fetch-materials.ts. */
  grade?: { saturation?: number; brightness?: number };
  /** Metalness is forced to 1 everywhere (clean metal; ignores mottled maps). */
  forceMetal?: boolean;
}

export const MATERIALS2_BASE = "/assets/materials2";

/** Texel density the shipped maps aim for (texels per metre of surface). */
const TEXELS_PER_M = 512;

/**
 * Edge (px) of a shipped map: albedo / normal ≈ TEXELS_PER_M × tile,
 * power of two in [512, 1024]; ORM (AO / roughness: low frequency) half of
 * that, at least 256. Shared by the fetch script (output size) and the
 * runtime (whether a quality cap needs a CPU downscale).
 */
export function textureEdge(
  asset: Pick<PbrMaterialAsset, "tileMeters">,
  kind: "albedo" | "normal" | "orm",
): number {
  const want = asset.tileMeters * TEXELS_PER_M;
  const edge = Math.min(
    1024,
    Math.max(512, 2 ** Math.ceil(Math.log2(Math.max(1, want)))),
  );
  return kind === "orm" ? Math.max(256, edge / 2) : edge;
}

export function material2Path(file: string): string {
  return `${MATERIALS2_BASE}/${file}`;
}

function m(
  role: MaterialRole,
  id: string,
  tileMeters: number,
  extra: Partial<
    Pick<PbrMaterialAsset, "tint" | "notes" | "grade" | "forceMetal">
  > = {},
): PbrMaterialAsset {
  return {
    role,
    id,
    source: "ambientcg",
    files: {
      albedo: `${id}/albedo.webp`,
      normal: `${id}/normal.webp`,
      orm: `${id}/orm.webp`,
    },
    tileMeters,
    ...extra,
  };
}

/**
 * First entry of each list is the role's pick; further entries are used by a
 * surface through `asset:` (Materials.ts). Every listed set is fetched and
 * every one is in use — WS5 pruned the 21 alternates that nothing referenced
 * (≈ 54 MB on disk); re-add an entry here before referencing a new id.
 */
export const MATERIAL_CANDIDATES: Record<MaterialRole, PbrMaterialAsset[]> = {
  floorMain: [
    m("floorMain", "Concrete034", 2, {
      notes: "light grey smooth microcement, subtle cloudiness (hall, paving)",
    }),
  ],
  floorWarm: [
    m("floorWarm", "Wood095", 1.5, {
      notes: "clear light oak/ash, seamless wide-board look",
      grade: { saturation: 0.65, brightness: 1.05 },
    }),
  ],
  floorCarpet: [
    m("floorCarpet", "Carpet012", 0.6, {
      notes: "low-pile marl carpet, greyed to charcoal",
      grade: { saturation: 0.1, brightness: 1.5 },
    }),
    m("floorCarpet", "Carpet016", 0.6, {
      notes: "low-pile, greyed to mid grey (rugs)",
      grade: { saturation: 0.05, brightness: 0.8 },
    }),
  ],
  floorTerrazzo: [
    m("floorTerrazzo", "Terrazzo006", 0.5, {
      notes: "polished white terrazzo with sand chips (lobby, quartz tops)",
    }),
  ],
  wallMain: [
    m("wallMain", "Plaster002", 2, {
      notes: "clean white plaster, gentle texture",
      grade: { saturation: 0.3, brightness: 1.05 },
    }),
  ],
  wallSlats: [
    m("wallSlats", "Wood095", 1, {
      notes: "light clear oak/ash",
      grade: { saturation: 0.65, brightness: 1.05 },
    }),
  ],
  wallFelt: [
    m("wallFelt", "Fabric030", 0.5, {
      notes: "mid grey felt-like knit",
      grade: { brightness: 1.15 },
    }),
    m("wallFelt", "Fabric036", 0.5, { notes: "light grey linen weave" }),
  ],
  wallFeature: [
    m("wallFeature", "Concrete032", 2, {
      notes: "dark graphite concrete",
      grade: { saturation: 0.1, brightness: 1.1 },
    }),
  ],
  ceiling: [
    m("ceiling", "Plaster001", 2, {
      notes: "smooth plaster",
      grade: { saturation: 0.3, brightness: 1.1 },
    }),
  ],
  metalBrushed: [
    m("metalBrushed", "Metal011", 1, {
      notes: "brushed aluminium/steel, graded to aluminium F0 (tints <= 1)",
      grade: { saturation: 0.6, brightness: 1.32 },
      forceMetal: true,
    }),
  ],
  metalDark: [
    m("metalDark", "Metal030", 1, {
      notes:
        "dark blue-grey powder coat; dielectric uses (metalFactor 0) for black / charcoal / RAL 7016 paint",
      forceMetal: true,
    }),
  ],
  woodFurniture: [
    m("woodFurniture", "Wood050", 0.8, {
      notes: "plain light oak veneer, bleached",
      grade: { saturation: 0.5, brightness: 1.1 },
    }),
  ],
  fabricUpholstery: [
    m("fabricUpholstery", "Fabric061", 0.4, {
      notes: "grey-taupe tight weave",
      grade: { saturation: 0.6 },
    }),
    m("fabricUpholstery", "Fabric036", 0.4, {
      notes: "light grey linen (warm / accent upholstery tints)",
    }),
  ],
  leather: [
    m("leather", "Leather026", 0.5, {
      notes: "black grained leather, lifted to a dark brown-black (tints <= 1)",
      grade: { brightness: 1.9 },
    }),
  ],
  rubberMat: [m("rubberMat", "Rubber004", 0.8, { notes: "dark fine rubber" })],
  // ---- Software factory ----
  floorEpoxy: [
    m("floorEpoxy", "Concrete046", 3, {
      notes: "smooth off-white concrete under a grey epoxy coat (tinted)",
    }),
  ],
  concreteSoffit: [
    m("concreteSoffit", "Concrete046", 2.5, {
      notes:
        "off-white smooth concrete, greyed for slab soffits / plinths / dock",
    }),
  ],
};

export const MATERIALS2: Record<MaterialRole, PbrMaterialAsset> =
  Object.fromEntries(
    (Object.keys(MATERIAL_CANDIDATES) as MaterialRole[]).map((r) => [
      r,
      MATERIAL_CANDIDATES[r][0],
    ]),
  ) as Record<MaterialRole, PbrMaterialAsset>;
