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
 *  - additionally writes <id>.ktx2.glb (KHR_texture_basisu: colour ETC1S sRGB, normals UASTC
 *    linear, alpha-tested cards UASTC; same texture sizes, image names preserved) encoded from
 *    the lossless processed pixels with the pinned `ktx` CLI (frontend/scripts/lib/ktx.ts);
 *    skipped with a warning when unavailable or with --no-ktx. WebP stays the fallback.
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
import { ALL_EXTENSIONS, EXTTextureWebP, KHRTextureBasisu } from "@gltf-transform/extensions";
import {
  dedup,
  getBounds,
  prune,
  quantize,
  resample,
} from "@gltf-transform/functions";
import sharp from "sharp";
import { ensureKtx, ktx2ifyDocument, withHeavyLock } from "../../frontend/scripts/lib/ktx";

const [rawDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const QUANTIZE = process.argv.includes("--quantize");
const NO_KTX = process.argv.includes("--no-ktx");
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

/** Greyscale + scale so the (alpha-weighted) mean luminance hits `target` (sRGB 0..1). */
async function neutralise(s: sharp.Sharp, target: number, alpha: boolean): Promise<sharp.Sharp> {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const w = alpha ? data[i + 3]! / 255 : 1;
    const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    sum += l * w;
    wsum += w;
  }
  const mean = wsum > 0 ? sum / wsum / 255 : 0.5;
  const k = target / Math.max(0.02, mean);
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    const v = Math.min(255, Math.round(l * k));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, EXTTextureWebP]);
  const files = (await readdir(rawDir)).filter((f) => f.endsWith(".glb")).sort();
  const avatars: unknown[] = [];
  let totalBytes = 0;
  const ktxOk = !NO_KTX && !!(await ensureKtx());
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
    // Tinted textures -> neutral luminance (target mean, sRGB 0..1). glTF multiplies
    // baseColorFactor with the texture, so a coloured source (the toigo_female_suit_2
    // diffuse is magenta; MakeHuman hair diffuses are already dark brown) can't be
    // re-coloured by the factor alone: f05's sage suit rendered purple and every hair
    // tint came out near-black. Greyscale + normalise makes the factor the colour.
    const texTint = new Map<Texture, number>();
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
      const bcTex = m.getBaseColorTexture();
      if (tint && bcTex) texTint.set(bcTex, kind === "clothes" ? 0.82 : spec.hair_desat ? 0.85 : 0.7);
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
    const pngSources = new Map<Texture, Uint8Array>();
    for (const t of root.listTextures()) {
      const img = t.getImage();
      if (!img) continue;
      const kind = texKind.get(t) ?? "clothes";
      let s = sharp(Buffer.from(img));
      const meta = await s.metadata();
      const max = MAX_TEX[kind];
      if ((meta.width ?? 0) > max || (meta.height ?? 0) > max)
        s = s.resize(max, max, { fit: "inside", kernel: "lanczos3" });
      const tintTarget = texTint.get(t);
      if (tintTarget !== undefined) s = await neutralise(s, tintTarget, texAlpha.has(t));
      if (!texAlpha.has(t)) s = s.removeAlpha();
      if (ktxOk) pngSources.set(t, new Uint8Array(await s.clone().png().toBuffer()));
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

    // --- KTX2 variant (mutates doc; written last)
    let ktx2Bytes: number | undefined;
    if (ktxOk) {
      const n = await ktx2ifyDocument(doc, { extension: KHRTextureBasisu, maxEdge: 2048, sources: pngSources });
      if (n > 0) {
        const kout = join(outDir, `${id}.ktx2.glb`);
        await io.write(kout, doc);
        ktx2Bytes = (await stat(kout)).size;
      }
    }

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
      ...(ktx2Bytes !== undefined ? { ktx2File: `${id}.ktx2.glb`, ktx2Bytes } : {}),
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
        ktx2: "avatars[].ktx2File (when present) is the KHR_texture_basisu variant of avatars[].file; WebP stays the fallback",
        totalBytes,
        avatars,
      },
      null,
      2,
    ),
  );
}
await withHeavyLock(main);
