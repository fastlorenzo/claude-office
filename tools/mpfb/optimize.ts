/**
 * Post-processes the raw Blender GLBs into web-ready, self-contained
 * character GLBs and writes manifest.json.
 *
 *   bun optimize.ts <rawDir> <outDir>
 *
 *  - materials: hair/brows/lashes -> alphaMode MASK (alpha-tested cards, not blended),
 *    double sided for hair cards; sensible roughness floor/ceiling per material kind
 *  - textures: resized (skin 2048, everything else <= 1024, eyes/brows 512) and
 *    re-encoded as WebP (EXT_texture_webp, same approach as scripts/fetch-characters.ts)
 *  - animations: resampled, constant tracks removed; dedup + prune
 *  - optional --quantize: KHR_mesh_quantization (no custom decoder needed); meshopt is
 *    deliberately NOT used (Babylon needs an external decoder for it)
 */
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  Document,
  NodeIO,
  PropertyType,
  type Material,
  type Texture,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import {
  dedup,
  getBounds,
  prune,
  quantize,
  resample,
} from "@gltf-transform/functions";
import sharp from "sharp";

const [rawDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const QUANTIZE = process.argv.includes("--quantize");
if (!rawDir || !outDir) {
  console.error("usage: bun optimize.ts <rawDir> <outDir> [--quantize]");
  process.exit(2);
}

type Kind = "skin" | "eyes" | "brows" | "lashes" | "hair" | "shoes" | "clothes";
const kindOf = (name: string): Kind => {
  if (name.endsWith("_skin")) return "skin";
  if (name.endsWith("_eyes")) return "eyes";
  if (name.endsWith("_brows")) return "brows";
  if (name.endsWith("_lashes")) return "lashes";
  if (name.endsWith("_hair")) return "hair";
  if (name.endsWith("_shoes")) return "shoes";
  return "clothes";
};
const MAX_TEX: Record<Kind, number> = {
  skin: 2048,
  eyes: 512,
  brows: 512,
  lashes: 512,
  hair: 1024,
  shoes: 1024,
  clothes: 1024,
};
const ROUGH: Record<Kind, [number, number]> = {
  skin: [0.5, 0.58],
  eyes: [0.05, 0.12],
  brows: [0.8, 0.9],
  lashes: [0.8, 0.9],
  hair: [0.5, 0.6],
  shoes: [0.4, 0.55],
  clothes: [0.7, 0.9],
};

async function main() {
  await mkdir(outDir, { recursive: true });
  const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureWebP]);
  const files = (await readdir(rawDir)).filter((f) => f.endsWith(".glb")).sort();
  const avatars: unknown[] = [];
  let totalBytes = 0;
  for (const f of files) {
    const id = basename(f, ".glb");
    const info = JSON.parse(await readFile(join(rawDir, `${id}.info.json`), "utf8"));
    const spec = info.spec as {
      hair_tint?: number[];
      hair_desat?: number[];
      clothes_tint?: number[];
    };
    const doc: Document = await io.read(join(rawDir, f));
    const root = doc.getRoot();
    doc.createExtension(EXTTextureWebP).setRequired(true);

    // --- materials
    const texKind = new Map<Texture, Kind>();
    const texAlpha = new Set<Texture>();
    for (const m of root.listMaterials()) {
      const kind = kindOf(m.getName());
      const alpha = kind === "hair" || kind === "brows" || kind === "lashes";
      if (alpha) {
        m.setAlphaMode("MASK").setAlphaCutoff(kind === "hair" ? 0.45 : 0.4);
        m.setDoubleSided(true);
      } else {
        m.setAlphaMode("OPAQUE");
        m.setDoubleSided(kind === "clothes");
      }
      // Tints are applied as baseColorFactor (glTF multiplies it with the texture)
      const tint = kind === "hair" || kind === "brows" ? spec.hair_tint : kind === "clothes" ? spec.clothes_tint : undefined;
      if (tint) m.setBaseColorFactor([tint[0]!, tint[1]!, tint[2]!, 1]);
      const [lo, hi] = ROUGH[kind];
      m.setRoughnessFactor(Math.min(hi, Math.max(lo, m.getRoughnessFactor())));
      m.setMetallicFactor(0);
      const bc = m.getBaseColorTexture();
      if (bc) {
        texKind.set(bc, kind);
        if (alpha) texAlpha.add(bc);
      }
      const nt = m.getNormalTexture();
      if (nt) texKind.set(nt, kind);
    }

    // --- textures -> WebP
    for (const t of root.listTextures()) {
      const img = t.getImage();
      if (!img) continue;
      const kind = texKind.get(t) ?? "clothes";
      let s = sharp(Buffer.from(img));
      const meta = await s.metadata();
      const max = MAX_TEX[kind];
      if ((meta.width ?? 0) > max || (meta.height ?? 0) > max)
        s = s.resize(max, max, { fit: "inside", kernel: "lanczos3" });
      if (kind === "hair" && spec.hair_desat && texAlpha.has(t))
        s = s.modulate({ saturation: spec.hair_desat[0], brightness: spec.hair_desat[1] });
      if (!texAlpha.has(t)) s = s.removeAlpha();
      const webp = await s
        .webp({ quality: kind === "skin" ? 86 : 80, alphaQuality: 92, effort: 5, exact: true })
        .toBuffer();
      t.setImage(new Uint8Array(webp)).setMimeType("image/webp");
    }

    // --- animations / cleanup
    await doc.transform(
      resample(),
      prune(),
      dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.MATERIAL] }),
      ...(QUANTIZE ? [quantize()] : []),
    );

    const out = join(outDir, `${id}.glb`);
    await io.write(out, doc);
    const bytes = (await stat(out)).size;
    totalBytes += bytes;

    // --- manifest entry
    const bounds = getBounds(doc.getRoot().listScenes()[0]!);
    let triangles = 0;
    for (const mesh of root.listMeshes())
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices();
        triangles += idx ? idx.getCount() / 3 : (prim.getAttribute("POSITION")?.getCount() ?? 0) / 3;
      }
    const skins = root.listSkins();
    avatars.push({
      id,
      file: `${id}.glb`,
      gender: info.spec.sex,
      heightM: +(bounds.max[1] - bounds.min[1]).toFixed(3),
      footY: +bounds.min[1].toFixed(4),
      triangles,
      bytes,
      joints: skins[0]?.listJoints().length ?? 0,
      clips: info.clips,
      sitPelvisHeightM: info.sitPelvisHeightM,
      sitPelvisForwardM: info.sitPelvisForwardM,
      walkSpeedMps: info.walkSpeedMps,
      pelvisHeightM: info.pelvisHeightM,
      parts: info.parts,
      licenses: info.licenses,
      spec: info.spec,
    });
    console.log(`${id}: ${triangles} tris, ${(bytes / 1024).toFixed(0)} KiB, h=${(bounds.max[1] - bounds.min[1]).toFixed(2)}`);
  }
  await writeFile(
    join(resolve(outDir), "manifest.json"),
    JSON.stringify(
      {
        generatedBy: "tools/mpfb/optimize.ts",
        source: "MPFB 2.0.18 + MakeHuman CC0 asset packs; animations Quaternius UAL1 Standard + Mesh2Motion (CC0)",
        license: "CC0 1.0 (all assets); tooling GPL-3.0 (MPFB) is not part of the outputs",
        units: "metres, Y-up, glTF right-handed; models face +Z in glTF space",
        quantized: QUANTIZE,
        totalBytes,
        avatars,
      },
      null,
      2,
    ),
  );
}
await main();
