/**
 * Downloads the curated ambientCG (CC0) PBR materials listed in
 * src/engine/assets/materials2.ts, converts them to WebP, packs an ORM texture
 * (R = AO, G = roughness, B = metalness) and writes
 * public/assets/materials2/manifest.json + LICENSE.md.
 *
 * Usage: bun scripts/fetch-materials.ts [--force] [--only=Id,Id] [--prune]
 * Fetches every material listed in MATERIAL_CANDIDATES (each one is used by a
 * surface in Materials.ts). --only limits the run (with --force: re-grade
 * those ids after a `grade` change). --prune deletes folders under
 * public/assets/materials2 that are no longer listed.
 * Idempotent: materials whose outputs already exist are skipped.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import sharp from "sharp";
import {
  MATERIAL_CANDIDATES,
  textureEdge,
  type PbrMaterialAsset,
} from "../src/engine/assets/materials2";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "assets", "materials2");
const UA = "claude-office-material-fetch/1.0";
const CONCURRENCY = 3;
const FORCE = process.argv.includes("--force");
const PRUNE = process.argv.includes("--prune");
const ONLY = new Set(
  (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
    .split(",")
    .filter(Boolean),
);

class AssetError extends Error {
  constructor(
    public assetId: string,
    msg: string,
  ) {
    super(`[${assetId}] ${msg}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(id: string, dest: string): Promise<void> {
  const url = `https://ambientcg.com/get?file=${id}_2K-JPG.zip`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await Bun.write(dest, res);
      return;
    } catch (e) {
      lastErr = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new AssetError(id, `download failed: ${lastErr}`);
}

function unzip(id: string, zip: string, dir: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("unzip", ["-o", "-q", zip, "-d", dir]);
    p.on("error", (e) => rej(new AssetError(id, `unzip: ${e.message}`)));
    p.on("exit", (c) =>
      c === 0 ? res() : rej(new AssetError(id, `unzip exited ${c}`)),
    );
  });
}

async function grey(file: string, size: number): Promise<Buffer> {
  return sharp(file)
    .resize(size, size)
    .greyscale()
    .toColourspace("b-w")
    .raw()
    .toBuffer();
}

async function process_(a: PbrMaterialAsset): Promise<void> {
  const id = a.id;
  const outDir = join(OUT, id);
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), `mat2-${id}-`));
  try {
    const zip = join(work, `${id}.zip`);
    const dir = join(work, "x");
    await download(id, zip);
    await unzip(id, zip, dir);
    const names = await readdir(dir);
    const find = (suffix: string) => {
      const n = names.find((f) => f.endsWith(`_${suffix}.jpg`));
      return n ? join(dir, n) : null;
    };
    const color = find("Color");
    const normal = find("NormalGL");
    const rough = find("Roughness");
    if (!color || !normal || !rough)
      throw new AssetError(id, `missing maps in zip: ${names.join(", ")}`);

    const E = textureEdge(a, "albedo");
    let albedo = sharp(color).resize(E, E);
    if (a.grade)
      albedo = albedo.modulate({
        saturation: a.grade.saturation ?? 1,
        brightness: a.grade.brightness ?? 1,
      });
    await albedo
      .webp({ quality: 88, smartSubsample: true, effort: 5 })
      .toFile(join(outDir, "albedo.webp"));

    await sharp(normal)
      .resize(E, E)
      .webp({ quality: 92, smartSubsample: true, effort: 5 })
      .toFile(join(outDir, "normal.webp"));

    const S = textureEdge(a, "orm");
    const ao = find("AmbientOcclusion");
    const met = find("Metalness");
    const r = await grey(rough, S);
    const aoBuf = ao ? await grey(ao, S) : Buffer.alloc(S * S, 255);
    const mBuf =
      met && !a.forceMetal
        ? await grey(met, S)
        : Buffer.alloc(S * S, a.forceMetal ? 255 : 0);
    const orm = Buffer.alloc(S * S * 3);
    for (let i = 0; i < S * S; i++) {
      orm[i * 3] = aoBuf[i];
      orm[i * 3 + 1] = r[i];
      orm[i * 3 + 2] = mBuf[i];
    }
    // Lossy WebP subsamples chroma, which would bleed the packed channels.
    await sharp(orm, { raw: { width: S, height: S, channels: 3 } })
      .webp({ nearLossless: true, quality: 80, effort: 5 })
      .toFile(join(outDir, "orm.webp"));
  } catch (e) {
    if (e instanceof AssetError) throw e;
    throw new AssetError(id, (e as Error).message);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Existing outputs larger than `textureEdge` (older 2048 / 1024 runs) are
 * downscaled in place — the same result as a fresh fetch, without the
 * download. Returns true when something changed.
 */
async function normalise(a: PbrMaterialAsset): Promise<boolean> {
  let changed = false;
  for (const kind of ["albedo", "normal", "orm"] as const) {
    const file = join(OUT, a.files[kind]);
    if (!(await exists(file))) continue;
    const edge = textureEdge(a, kind);
    const meta = await sharp(file).metadata();
    if ((meta.width ?? 0) <= edge) continue;
    const img = sharp(await readFile(file)).resize(edge, edge);
    const buf =
      kind === "orm"
        ? await img
            .webp({ nearLossless: true, quality: 80, effort: 5 })
            .toBuffer()
        : await img
            .webp({
              quality: kind === "normal" ? 92 : 88,
              smartSubsample: true,
              effort: 5,
            })
            .toBuffer();
    await writeFile(file, buf);
    changed = true;
  }
  return changed;
}

const NOTICE_BEGIN = "<!-- BEGIN MATERIALS2 -->";
const NOTICE_END = "<!-- END MATERIALS2 -->";
const noticeSection = (ids: string[]): string => `${NOTICE_BEGIN}
## materials2 (ambientCG, CC0 1.0)

PBR textures under \`materials2/\` come from [ambientCG](https://ambientcg.com)
and are released under CC0 1.0 Universal (public domain); credit is not
required. Fetched, colour-graded, resized and packed (ORM) by \`bun run materials\`
(\`scripts/fetch-materials.ts\`; the list is \`src/engine/assets/materials2.ts\`):

${ids.map((id) => `- [${id}](https://ambientcg.com/a/${id})`).join("\n")}
${NOTICE_END}
`;

/** Replace or append the delimited section (fetch-assets.ts rewrites NOTICE.md). */
async function upsertNotice(ids: string[]): Promise<void> {
  const section = noticeSection(ids);
  const p = join(ROOT, "public", "assets", "NOTICE.md");
  let cur = "";
  try {
    cur = await readFile(p, "utf8");
  } catch {
    /* no NOTICE yet */
  }
  const a = cur.indexOf(NOTICE_BEGIN);
  const b = cur.indexOf(NOTICE_END);
  if (a >= 0 && b > a) {
    cur =
      cur.slice(0, a) +
      section +
      cur.slice(b + NOTICE_END.length).replace(/^\n/, "");
  } else {
    cur = cur.replace(/\s*$/, "\n\n") + section;
  }
  await writeFile(p, cur);
}

async function main(): Promise<void> {
  const unique = new Map<string, PbrMaterialAsset>();
  for (const a of Object.values(MATERIAL_CANDIDATES).flat())
    if (!unique.has(a.id)) unique.set(a.id, a);

  if (PRUNE) {
    for (const d of await readdir(OUT, { withFileTypes: true }))
      if (d.isDirectory() && !unique.has(d.name)) {
        await rm(join(OUT, d.name), { recursive: true, force: true });
        console.log(`  pruned ${d.name}`);
      }
  }

  const todo: PbrMaterialAsset[] = [];
  for (const a of unique.values()) {
    if (ONLY.size && !ONLY.has(a.id)) continue;
    const done =
      !FORCE &&
      (
        await Promise.all(
          Object.values(a.files).map((f) => exists(join(OUT, f))),
        )
      ).every(Boolean);
    if (!done) todo.push(a);
  }
  console.log(`materials2: ${unique.size} materials, ${todo.length} to fetch`);
  for (const a of unique.values())
    if (!todo.includes(a) && (await normalise(a)))
      console.log(`  size ${a.id}`);

  const queue = [...todo];
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        try {
          await process_(a);
          console.log(`  ok   ${a.id}`);
        } catch (e) {
          failures.push((e as Error).message);
          console.error(`  FAIL ${(e as Error).message}`);
        }
      }
    }),
  );
  if (failures.length) {
    console.error(
      `\n${failures.length} asset(s) failed:\n${failures.join("\n")}`,
    );
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        license: "CC0-1.0 (ambientCG, https://ambientcg.com)",
        orm: "R=AO, G=roughness, B=metalness",
        normal: "OpenGL (+Y)",
        candidates: MATERIAL_CANDIDATES,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(OUT, "LICENSE.md"),
    `# materials2\n\nAll textures in this directory are from ambientCG (https://ambientcg.com), released under CC0 1.0 Universal (public domain). Credit is not required.\n\nMaterial ids:\n\n${[...unique.keys()].map((k) => `- ${k} (https://ambientcg.com/a/${k})`).join("\n")}\n\nAlbedo may have been colour-graded and maps repacked/converted to WebP by scripts/fetch-materials.ts.\n`,
  );
  await upsertNotice([...unique.keys()].sort());
  console.log("materials2: done");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
