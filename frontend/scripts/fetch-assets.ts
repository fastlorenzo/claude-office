/**
 * Downloads the CC0 Poly Haven assets listed in src/engine/assets/manifest.ts
 * into public/assets/, copies the Havok wasm, and writes manifest.lock.json +
 * NOTICE.md.
 *
 * Usage: bun scripts/fetch-assets.ts [--force] [--check]
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_MANIFEST,
  hdriPath,
  modelPath,
  texturePath,
  type TextureMap,
} from "../src/engine/assets/manifest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "assets");
const API = "https://api.polyhaven.com";
const UA = "claude-office-asset-fetch/1.0";
const CONCURRENCY = 4;

const FORCE = process.argv.includes("--force");
const CHECK = process.argv.includes("--check");

const MAP_KEY: Record<TextureMap, string> = {
  diff: "Diffuse",
  nor_gl: "nor_gl",
  rough: "Rough",
  ao: "AO",
  arm: "arm",
};

type AssetKind = "texture" | "model" | "hdri";
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
  if (kind === "texture") {
    const maps = ASSET_MANIFEST.textures.find((t) => t.id === id)!.maps;
    for (const m of maps) {
      const f = need(files[MAP_KEY[m]]?.["1k"]?.jpg, `${MAP_KEY[m]} 1k jpg`);
      jobs.push({
        id,
        kind,
        rel: texturePath(id, m, "").replace(/^\//, ""),
        url: f.url,
        size: f.size,
      });
    }
  } else if (kind === "model") {
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
    ...ASSET_MANIFEST.textures.map((t) => ({
      id: t.id,
      kind: "texture" as const,
      role: t.role,
    })),
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

The textures, models and HDRI below are downloaded from [Poly Haven](https://polyhaven.com)
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
