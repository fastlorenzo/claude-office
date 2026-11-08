/**
 * Curated CC0 PBR material library ("materials2") for the modern office look.
 *
 * Plain data only (no Babylon). Source of truth for both
 * `scripts/fetch-materials.ts` (download + pack) and the runtime.
 *
 * Every entry is an ambientCG asset (CC0, https://ambientcg.com). Textures are
 * generated into `public/assets/materials2/<id>/` by `bun run materials`:
 *   albedo.webp  sRGB colour, 2048
 *   normal.webp  OpenGL (+Y) tangent-space normal, 2048
 *   orm.webp     R = ambient occlusion, G = roughness, B = metalness, 1024
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

/** First entry of each list is the pick; the rest are alternates. */
export const MATERIAL_CANDIDATES: Record<MaterialRole, PbrMaterialAsset[]> = {
  floorMain: [
    m("floorMain", "Concrete034", 2, {
      notes: "light grey smooth microcement, subtle cloudiness",
    }),
    m("floorMain", "Concrete019", 2, {
      notes: "cool pale grey, smooth, slight cloud variation",
    }),
    m("floorMain", "Concrete046", 2, { notes: "off-white smooth concrete" }),
  ],
  floorWarm: [
    m("floorWarm", "Wood095", 1.5, {
      notes: "clear light oak/ash, seamless wide-board look",
      grade: { saturation: 0.65, brightness: 1.05 },
    }),
    m("floorWarm", "WoodFloor062", 1.2, {
      notes: "fine-grain oak planks, bleached toward light oak",
      grade: { saturation: 0.5, brightness: 1.25 },
    }),
    m("floorWarm", "WoodFloor066A", 1.2, {
      notes: "blonde plank, desaturated",
      grade: { saturation: 0.4, brightness: 0.95 },
    }),
  ],
  floorCarpet: [
    m("floorCarpet", "Carpet012", 0.6, {
      notes: "low-pile marl carpet, greyed to charcoal",
      grade: { saturation: 0.1, brightness: 1.5 },
    }),
    m("floorCarpet", "Carpet016", 0.6, {
      notes: "low-pile, greyed to mid grey",
      grade: { saturation: 0.05, brightness: 0.8 },
    }),
    m("floorCarpet", "Fabric029", 0.6, {
      notes: "dark soft pile, neutralised graphite",
      grade: { saturation: 0.1, brightness: 2.4 },
    }),
  ],
  floorTerrazzo: [
    m("floorTerrazzo", "Tiles043", 1.2, {
      notes: "fine white/grey terrazzo tile, clean",
    }),
    m("floorTerrazzo", "Terrazzo005", 1, {
      notes: "white with grey/black chips",
    }),
    m("floorTerrazzo", "Terrazzo006", 1, { notes: "white with sand chips" }),
  ],
  wallMain: [
    m("wallMain", "Plaster002", 2, {
      notes: "clean white plaster, gentle texture",
      grade: { saturation: 0.3, brightness: 1.05 },
    }),
    m("wallMain", "PaintedPlaster017", 2, {
      notes: "white painted plaster, fine grain",
      grade: { saturation: 0.35 },
    }),
    m("wallMain", "Paint004", 1.5, {
      notes: "white painted wall, streaky",
      grade: { saturation: 0.2, brightness: 1.02 },
    }),
  ],
  wallSlats: [
    m("wallSlats", "WoodFloor039", 1.2, {
      notes: "pale narrow vertical boards; rotate 90 deg for slat feel",
      grade: { saturation: 0.7 },
    }),
    m("wallSlats", "Wood095", 1, {
      notes: "light clear oak/ash",
      grade: { saturation: 0.6, brightness: 1.05 },
    }),
    m("wallSlats", "Wood094", 1, {
      notes: "light beech/ash",
      grade: { saturation: 0.55, brightness: 1.1 },
    }),
  ],
  wallFelt: [
    m("wallFelt", "Fabric030", 0.5, {
      notes: "mid grey felt-like knit",
      grade: { brightness: 1.15 },
    }),
    m("wallFelt", "Fabric066", 0.5, {
      notes: "sage/khaki woven acoustic fabric",
      grade: { saturation: 0.9, brightness: 1.1 },
    }),
    m("wallFelt", "Fabric036", 0.5, { notes: "light grey linen weave" }),
  ],
  wallFeature: [
    m("wallFeature", "Concrete032", 2, {
      notes: "dark graphite concrete",
      grade: { saturation: 0.1, brightness: 1.1 },
    }),
    m("wallFeature", "Concrete033", 2, {
      notes: "dark concrete, softly mottled",
      grade: { saturation: 0.1, brightness: 1.1 },
    }),
    m("wallFeature", "Tiles138", 1.2, {
      notes: "black large-format tile",
      grade: { saturation: 0.3, brightness: 1.2 },
    }),
  ],
  ceiling: [
    m("ceiling", "OfficeCeiling001", 2.4, {
      notes: "mineral-fibre grid tiles, plain",
      grade: { saturation: 0.4 },
    }),
    m("ceiling", "Plaster001", 2, {
      notes: "smooth plaster",
      grade: { saturation: 0.3, brightness: 1.1 },
    }),
    m("ceiling", "OfficeCeiling005", 2.4, {
      notes: "grid with vent/light inserts (busy)",
      grade: { saturation: 0.4 },
    }),
  ],
  metalBrushed: [
    m("metalBrushed", "Metal009", 1, {
      notes: "brushed steel, darker",
      forceMetal: true,
    }),
    m("metalBrushed", "Metal011", 1, {
      notes: "brushed aluminium/steel",
      forceMetal: true,
    }),
    m("metalBrushed", "Metal032", 1, {
      notes: "satin blue-grey metal",
      forceMetal: true,
    }),
  ],
  metalDark: [
    m("metalDark", "Metal029", 1, {
      notes: "black anodised, glossy",
      forceMetal: true,
    }),
    m("metalDark", "Metal028", 1, {
      notes: "black coated metal",
      forceMetal: true,
    }),
    m("metalDark", "Metal030", 1, {
      notes: "dark blue-grey powder coat",
      forceMetal: true,
    }),
  ],
  woodFurniture: [
    m("woodFurniture", "Wood094", 0.8, {
      notes: "light beech/ash veneer",
      grade: { saturation: 0.55, brightness: 1.1 },
    }),
    m("woodFurniture", "Wood050", 0.8, {
      notes: "plain light oak veneer, bleached",
      grade: { saturation: 0.5, brightness: 1.1 },
    }),
    m("woodFurniture", "Wood058", 0.8, {
      notes: "oak veneer fine grain, bleached",
      grade: { saturation: 0.6, brightness: 1.25 },
    }),
  ],
  fabricUpholstery: [
    m("fabricUpholstery", "Fabric061", 0.4, {
      notes: "grey-taupe tight weave",
      grade: { saturation: 0.6 },
    }),
    m("fabricUpholstery", "Fabric036", 0.4, { notes: "light grey linen" }),
    m("fabricUpholstery", "Fabric063", 0.4, {
      notes: "taupe woven upholstery",
      grade: { saturation: 0.6, brightness: 1.3 },
    }),
  ],
  leather: [
    m("leather", "Leather026", 0.5, { notes: "black grained leather" }),
    m("leather", "Leather027", 0.5, { notes: "black smooth leather" }),
    m("leather", "Leather031", 0.5, {
      notes: "very dark green-black leather",
    }),
  ],
  rubberMat: [
    m("rubberMat", "Rubber004", 0.8, { notes: "dark fine rubber" }),
    m("rubberMat", "Rubber001", 0.8, { notes: "black speckle rubber" }),
  ],
  // ---- Software factory: reuse the downloaded set, graded per surface. ----
  floorEpoxy: [
    m("floorEpoxy", "Concrete019", 3, {
      notes: "smooth pale concrete under a grey epoxy coat (tinted + glossed)",
    }),
    m("floorEpoxy", "Concrete046", 3, { notes: "off-white smooth concrete" }),
  ],
  concreteSoffit: [
    m("concreteSoffit", "Concrete046", 2.5, {
      notes: "off-white smooth concrete, greyed for slab soffits / plinths",
    }),
    m("concreteSoffit", "Concrete019", 2.5, { notes: "cool pale grey" }),
  ],
};

export const MATERIALS2: Record<MaterialRole, PbrMaterialAsset> =
  Object.fromEntries(
    (Object.keys(MATERIAL_CANDIDATES) as MaterialRole[]).map((r) => [
      r,
      MATERIAL_CANDIDATES[r][0],
    ]),
  ) as Record<MaterialRole, PbrMaterialAsset>;
