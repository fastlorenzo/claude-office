/**
 * Downloads the CC0 Poly Haven assets listed in src/engine/assets/manifest.ts
 * into public/assets/, copies the Havok wasm, and writes manifest.lock.json +
 * NOTICE.md.
 *
 * Usage: bun scripts/fetch-assets.ts [--force] [--check]
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { ensureKtx, ktx2ifyDocument, withHeavyLock } from "./lib/ktx";
import {
  BASIS_TRANSCODER_FILES,
  BASIS_TRANSCODER_VERSION,
} from "./lib/ktxTiers";
import { fileURLToPath } from "node:url";
import {
  ASSET_MANIFEST,
  hdriPath,
  modelPath,
} from "../src/engine/assets/manifest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "assets");
const API = "https://api.polyhaven.com";
const UA = "claude-office-asset-fetch/1.0";
const CONCURRENCY = 4;

const FORCE = process.argv.includes("--force");
const CHECK = process.argv.includes("--check");
const NO_KTX = process.argv.includes("--no-ktx");

type AssetKind = "model" | "hdri";
interface Job {
  id: string;
  kind: AssetKind;
  rel: string; // path relative to OUT
  url: string;
  size: number;
}
interface Entry {
  id: string;
  kind: AssetKind;
  role: string;
}

class AssetError extends Error {
  constructor(
    public assetId: string,
    msg: string,
  ) {
    super(`[${assetId}] ${msg}`);
  }
}

async function getJson<T>(url: string, id: string): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) throw new AssetError(id, `not found: ${url}`);
      if (!res.ok) {
        lastErr = `HTTP ${res.status} for ${url}`;
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof AssetError) throw e;
      lastErr = String(e);
    }
  }
  throw new AssetError(id, lastErr);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function resolveJobs(entry: Entry): Promise<Job[]> {
  const { id, kind } = entry;
  const files = await getJson<Json>(`${API}/files/${id}`, id);
  const jobs: Job[] = [];
  const need = (v: unknown, what: string) => {
    if (!v) throw new AssetError(id, `missing ${what} in Poly Haven file tree`);
    return v as Json;
  };
  if (kind === "model") {
    const g = need(files.gltf?.["1k"]?.gltf, "gltf 1k");
    const base = modelPath(id, "").replace(/^\//, "");
    jobs.push({ id, kind, rel: base, url: g.url, size: g.size });
    const dir = dirname(base);
    for (const [rel, f] of Object.entries<Json>(g.include ?? {})) {
      jobs.push({ id, kind, rel: `${dir}/${rel}`, url: f.url, size: f.size });
    }
  } else {
    const res =
      entry.role === "exteriorHdri" ? ASSET_MANIFEST.exteriorHdri.res : "1k";
    const f = need(files.hdri?.[res]?.hdr, `hdri ${res} hdr`);
    jobs.push({
      id,
      kind,
      rel: hdriPath(id, "", res).replace(/^\//, ""),
      url: f.url,
      size: f.size,
    });
  }
  return jobs;
}

async function pool<T>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return -1;
  }
}

async function download(job: Job): Promise<"downloaded" | "skipped"> {
  const dest = join(OUT, job.rel);
  if (!FORCE && (await sizeOf(dest)) === job.size) return "skipped";
  await mkdir(dirname(dest), { recursive: true });
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(job.url, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        lastErr = `HTTP ${res.status} ${job.url}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== job.size) {
        lastErr = `size mismatch for ${job.rel}: got ${buf.length}, expected ${job.size}`;
        continue;
      }
      await writeFile(dest, buf);
      return "downloaded";
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new AssetError(job.id, lastErr);
}

async function copyHavok(): Promise<void> {
  const src = join(
    ROOT,
    "node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm",
  );
  const dest = join(ROOT, "public/havok/HavokPhysics.wasm");
  if ((await sizeOf(src)) < 0)
    throw new AssetError("havok", `missing ${src} (run bun install first)`);
  if (!FORCE && (await sizeOf(dest)) === (await sizeOf(src))) return;
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log("copied HavokPhysics.wasm -> public/havok/");
}

/**
 * Self-hosted Basis Universal transcoder for Babylon's KhronosTextureContainer2
 * (KTX2 / KHR_texture_basisu). Fetched from the versioned Babylon CDN
 * (byte-identical to @babylonjs/ktx2decoder@${BASIS_TRANSCODER_VERSION}'s wasm/),
 * sha256-pinned in lib/ktxTiers.ts. Apache-2.0 (Binomial / Basis Universal).
 */
async function fetchTranscoder(): Promise<void> {
  const dir = join(ROOT, "public", "ktx2");
  await mkdir(dir, { recursive: true });
  let got = 0;
  for (const f of BASIS_TRANSCODER_FILES) {
    const dest = join(dir, f.file);
    try {
      if (
        !FORCE &&
        createHash("sha256")
          .update(await readFile(dest))
          .digest("hex") === f.sha256
      )
        continue;
    } catch {
      /* missing -> download */
    }
    const url = `https://cdn.babylonjs.com/v${BASIS_TRANSCODER_VERSION}/${f.cdnPath}`;
    let buf: Buffer | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastErr = String(e);
      }
    }
    if (!buf) throw new AssetError("ktx2", `${url}: ${lastErr}`);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== f.sha256)
      throw new AssetError("ktx2", `sha256 mismatch for ${f.file}: ${sha}`);
    await writeFile(dest, buf);
    got++;
  }
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        generatedBy: "scripts/fetch-assets.ts",
        version: BASIS_TRANSCODER_VERSION,
        license: "Apache-2.0 (Basis Universal / Binomial; Babylon.js wrappers)",
        usage:
          "Set KhronosTextureContainer2.URLConfig[urlConfigKey] = `/ktx2/${file}` for every entry before loading the first KTX2 texture.",
        files: BASIS_TRANSCODER_FILES.map(({ file, urlConfigKey, sha256 }) => ({
          file,
          path: `/ktx2/${file}`,
          urlConfigKey,
          sha256,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Basis transcoder v${BASIS_TRANSCODER_VERSION}: ${BASIS_TRANSCODER_FILES.length} files in public/ktx2/ (${got} downloaded)`,
  );
}

/**
 * Poly Haven props -> <id>/<id>.ktx2.glb (KHR_texture_basisu, max edge 1024).
 * The original .gltf/.bin/textures stay as the fallback. Returns ids written.
 */
async function ktx2Props(
  models: { id: string; rel: string }[],
): Promise<Record<string, string>> {
  const made: Record<string, string> = {};
  if (NO_KTX || !(await ensureKtx())) return made;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await withHeavyLock(async () => {
    for (const m of models) {
      const outName = `${m.id}.ktx2.glb`;
      const out = join(OUT, dirname(m.rel), outName);
      if (!FORCE && (await sizeOf(out)) > 0) {
        made[m.id] = outName;
        continue;
      }
      const doc = await io.read(join(OUT, m.rel));
      const n = await ktx2ifyDocument(doc, {
        extension: KHRTextureBasisu,
        maxEdge: 1024,
      });
      if (n === 0) continue;
      await io.write(out, doc);
      made[m.id] = outName;
      console.log(`  ktx2 ${m.id}: ${n} textures, ${mb(await sizeOf(out))}`);
    }
  });
  return made;
}

interface Info {
  name: string;
  authors: Record<string, string>;
  dimensions?: [number, number, number];
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const entries: Entry[] = [
    ...ASSET_MANIFEST.models.map((m) => ({
      id: m.id,
      kind: "model" as const,
      role: m.role,
    })),
    { id: ASSET_MANIFEST.hdri.id, kind: "hdri" as const, role: "hdri" },
    {
      id: ASSET_MANIFEST.exteriorHdri.id,
      kind: "hdri" as const,
      role: "exteriorHdri",
    },
  ];

  const failures: string[] = [];
  const resolved: { entry: Entry; jobs: Job[]; info: Info }[] = [];
  await pool(entries, CONCURRENCY, async (entry) => {
    try {
      const [jobs, info] = await Promise.all([
        resolveJobs(entry),
        getJson<Info>(`${API}/info/${entry.id}`, entry.id),
      ]);
      resolved.push({ entry, jobs, info });
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  });
  if (failures.length) fail(failures);
  console.log(`validated ${entries.length} asset ids`);
  if (CHECK) return;

  const all = resolved.flatMap((r) => r.jobs);
  let dl = 0;
  let skipped = 0;
  await pool(all, CONCURRENCY, async (job) => {
    try {
      const r = await download(job);
      if (r === "downloaded") dl++;
      else skipped++;
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  });
  if (failures.length) fail(failures);

  await copyHavok();
  await fetchTranscoder();
  const ktx2Glbs = await ktx2Props(
    resolved
      .filter((r) => r.entry.kind === "model")
      .map((r) => ({
        id: r.entry.id,
        rel: r.jobs.find((j) => j.rel.endsWith(".gltf"))!.rel,
      })),
  );

  resolved.sort(
    (a, b) =>
      a.entry.kind.localeCompare(b.entry.kind) ||
      a.entry.id.localeCompare(b.entry.id),
  );

  const lock: Record<string, unknown> = {};
  for (const { entry, jobs, info } of resolved) {
    lock[entry.id] = {
      kind: entry.kind,
      role: entry.role,
      files: Object.fromEntries(jobs.map((j) => [j.rel, j.size])),
      ...(ktx2Glbs[entry.id] ? { ktx2: ktx2Glbs[entry.id] } : {}),
      ...(info.dimensions
        ? {
            dimensionsMeters: info.dimensions.map(
              (d) => +(d / 1000).toFixed(3),
            ),
          }
        : {}),
    };
  }
  await writeFile(
    join(OUT, "manifest.lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );

  const rows = resolved.map(({ entry, info }) => {
    const authors = Object.keys(info.authors ?? {}).join(", ") || "Poly Haven";
    return `| ${info.name} | \`${entry.id}\` | ${entry.kind} | ${authors} | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | https://polyhaven.com/a/${entry.id} |`;
  });
  const notice = `# Asset notice

Generated by \`bun run assets\` (frontend/scripts/fetch-assets.ts). Do not edit by hand.

The models and HDRI below are downloaded from [Poly Haven](https://polyhaven.com)
and released under the CC0 1.0 Universal public-domain dedication. Attribution is not required
but is gratefully given.

| Asset | Id | Type | Authors | License | Source |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

\`HavokPhysics.wasm\` (copied to \`public/havok/\`) is distributed under the license of the
\`@babylonjs/havok\` package.
`;
  await writeFile(join(OUT, "NOTICE.md"), notice);

  let total = 0;
  for (const j of all) total += j.size;
  const havok = Math.max(
    await sizeOf(join(ROOT, "public/havok/HavokPhysics.wasm")),
    0,
  );
  console.log(
    `${all.length} files (${dl} downloaded, ${skipped} up to date): ${mb(total)} assets + ${mb(havok)} havok wasm`,
  );
}

function fail(failures: string[]): never {
  console.error(
    "Asset fetch failed:\n" + failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
