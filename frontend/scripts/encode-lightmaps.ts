/**
 * Lightmaps -> KTX2 (tools/lightmaps): encodes every baked RGBD PNG in
 * public/lightmaps as UASTC (+zstd) KTX2 next to it and records it in the
 * manifest (`sets.<set>.ktx2`). GPU-compressed (8 bpp: BC7 / ASTC / ETC2 at
 * upload) instead of RGBA8 (32 bpp): 16 MB -> 4 MB per 2048² set. The PNG
 * stays the fallback (no KTX2 support, transcoder failure, tests).
 *
 *   bun scripts/encode-lightmaps.ts [set ...]      (bake.sh runs it)
 *
 * RGBD keeps its exponent in alpha: linear transfer (never sRGB), no mips
 * (the runtime samples level 0; islands are only 6 px apart), UASTC quality
 * 4 without RDO (smooth irradiance gradients band under RDO). Rows are
 * flipped: a KTX2 upload keeps the file's row order, the PNG path flips at
 * decode (fx/BakedLighting.ts), so both land with v = 0 at the PNG's bottom
 * row (Blender's convention).
 */
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { encodeKtx2, ensureKtx, withHeavyLock } from "./lib/ktx";

const DIR = join(import.meta.dir, "..", "public", "lightmaps");
const MANIFEST = join(DIR, "manifest.json");

interface SetEntry {
  image: string;
  ktx2?: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const raw = await readFile(MANIFEST, "utf8");
  const man = JSON.parse(raw) as {
    sets: Record<string, SetEntry>;
  };
  const want = process.argv.slice(2);
  const sets = Object.keys(man.sets).filter(
    (s) => want.length === 0 || want.includes(s),
  );
  if (!(await ensureKtx())) {
    console.warn("[encode-lightmaps] no ktx CLI: PNG lightmaps only");
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), "lightmaps-"));
  try {
    await withHeavyLock(async () => {
      for (const id of sets) {
        const set = man.sets[id];
        const src = join(DIR, set.image);
        const flipped = join(tmp, `${id}.png`);
        // Raw RGBA bytes, rows flipped; no colour management (RGBD).
        const { data, info } = await sharp(src)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .flip()
          .png({ compressionLevel: 1 })
          .toFile(flipped);
        const name = set.image.replace(/\.png$/i, ".ktx2");
        await encodeKtx2(flipped, join(DIR, name), {
          mode: "uastc",
          srgb: false,
          alpha: true,
          mips: false,
          uastcQuality: 4,
          zstd: 19,
        });
        set.ktx2 = name;
        console.log(`[encode-lightmaps] ${id}: ${name}`);
      }
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // Same layout as bake.py's json.dump(indent=1), same line endings (a
  // Windows Blender writes CRLF).
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text =
    JSON.stringify(man, null, 1).replace(/\n/g, eol) +
    (/\r?\n$/.test(raw) ? eol : "");
  await writeFile(MANIFEST, text);
}

await main();
