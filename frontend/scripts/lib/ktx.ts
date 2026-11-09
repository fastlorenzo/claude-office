/**
 * Offline KTX2 (Basis Universal) encoding helpers shared by the asset scripts.
 *
 *  - ensureKtx(): pinned KTX-Software `ktx` CLI (build-time tool, never shipped)
 *  - encodeKtx2(): PNG -> .ktx2 (ETC1S/BasisLZ or UASTC+zstd, mips generated)
 *  - withHeavyLock()/runBatch(): serialise the whole encode batch machine-wide
 *  - ktx2ifyDocument(): swap a glTF Document's textures for KTX2 + KHR_texture_basisu
 *
 * Everything degrades gracefully: when the CLI cannot be obtained ensureKtx()
 * returns null and callers skip their KTX2 outputs (WebP path is unaffected).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { codecFor, fitEdge, type TextureRole } from "./ktxTiers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KTX_VERSION = "4.4.2";
const KTX_URL = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.tar.bz2`;
const KTX_SHA256 =
  "a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245";
const KTX_CACHE = join(ROOT, "node_modules", ".cache", "ktx-software");

export const MAX_ENCODE_CONCURRENCY = 4;
const THREADS_PER_ENCODE = 2;

// ---------------------------------------------------------------------------
// ktx CLI
// ---------------------------------------------------------------------------

interface KtxTool {
  bin: string;
  env: NodeJS.ProcessEnv;
}
let toolPromise: Promise<KtxTool | null> | undefined;

function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env: env ?? process.env });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (out += d));
    p.on("error", (e) => res({ code: -1, out: String(e) }));
    p.on("exit", (code) => res({ code: code ?? -1, out }));
  });
}

function toolFor(bin: string): KtxTool {
  const lib = join(dirname(bin), "..", "lib");
  const env = { ...process.env };
  if (existsSync(lib))
    env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
  return { bin, env };
}

async function downloadKtx(): Promise<KtxTool> {
  const dir = join(KTX_CACHE, KTX_VERSION);
  const bin = join(
    dir,
    `KTX-Software-${KTX_VERSION}-Linux-x86_64`,
    "bin",
    "ktx",
  );
  if (existsSync(bin)) return toolFor(bin);
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      `no pinned ktx build for ${process.platform}/${process.arch}; set KTX_BIN`,
    );
  let buf: Buffer | null = null;
  let lastErr = "";
  for (let i = 1; i <= 3 && !buf; i++) {
    try {
      const res = await fetch(KTX_URL, {
        headers: { "User-Agent": "claude-office-asset-fetch/1.0" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = String(e);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  if (!buf) throw new Error(`download ${KTX_URL}: ${lastErr}`);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== KTX_SHA256)
    throw new Error(`KTX-Software tarball sha256 mismatch: ${sha}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tgz = join(dir, "ktx.tar.bz2");
  await writeFile(tgz, buf);
  const x = await run("tar", ["xjf", tgz, "-C", dir]);
  if (x.code !== 0) throw new Error(`tar: ${x.out}`);
  await rm(tgz, { force: true });
  await chmod(bin, 0o755);
  return toolFor(bin);
}

/** Resolve the `ktx` CLI (KTX_BIN override, else pinned download); null = unavailable. */
export function ensureKtx(): Promise<KtxTool | null> {
  toolPromise ??= (async () => {
    try {
      const tool = process.env.KTX_BIN
        ? toolFor(resolve(process.env.KTX_BIN))
        : await downloadKtx();
      const v = await run(tool.bin, ["--version"], tool.env);
      if (v.code !== 0)
        throw new Error(`ktx --version failed: ${v.out.trim()}`);
      return tool;
    } catch (e) {
      console.warn(
        `[ktx] WARNING: KTX2 encoder unavailable, skipping KTX2 outputs (${e instanceof Error ? e.message : String(e)})`,
      );
      return null;
    }
  })();
  return toolPromise;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  mode: "etc1s" | "uastc";
  srgb: boolean;
  /** RGBA input (4 channels) instead of RGB. */
  alpha?: boolean;
  /** 1-channel input. */
  grey?: boolean;
  /** `ktx create --normal-mode` (X+Y packing; NOT glTF compatible, off by default). */
  normalMap?: boolean;
  /** zstd level for UASTC (default 19). */
  zstd?: number;
  /** UASTC quality 0-4 (default 2). */
  uastcQuality?: number;
  /** Resize so max(w,h) <= maxEdge (ktx resamples). */
  maxEdge?: number;
  /** Generate full mip chain (default true). */
  mips?: boolean;
}

function formatFor(o: EncodeOptions): string {
  const ch = o.grey ? "R8" : o.alpha ? "R8G8B8A8" : "R8G8B8";
  return `${ch}_${o.srgb ? "SRGB" : "UNORM"}`;
}

export async function encodeKtx2(
  inputPng: string,
  outKtx2: string,
  o: EncodeOptions,
): Promise<void> {
  const tool = await ensureKtx();
  if (!tool) throw new Error("ktx unavailable");
  const args = [
    "create",
    "--format",
    formatFor(o),
    "--assign-tf",
    o.srgb ? "srgb" : "linear",
    "--encode",
    o.mode === "etc1s" ? "basis-lz" : "uastc",
    "--threads",
    String(THREADS_PER_ENCODE),
  ];
  if (o.mips !== false) args.push("--generate-mipmap");
  if (o.mode === "etc1s") args.push("--clevel", "2", "--qlevel", "160");
  else {
    args.push("--uastc-quality", String(o.uastcQuality ?? 2));
    args.push("--zstd", String(o.zstd ?? 19));
  }
  if (o.normalMap) args.push("--normal-mode", "--normalize");
  if (o.maxEdge) {
    const m = await sharp(inputPng).metadata();
    const { width, height } = fitEdge(m.width ?? 0, m.height ?? 0, o.maxEdge);
    if (width !== m.width || height !== m.height)
      args.push("--width", String(width), "--height", String(height));
  }
  args.push(inputPng, outKtx2);
  await mkdir(dirname(outKtx2), { recursive: true });
  const r = await run(tool.bin, args, tool.env);
  if (r.code !== 0)
    throw new Error(`ktx create failed (${outKtx2}): ${r.out.trim()}`);
}

// ---------------------------------------------------------------------------
// Heavy lock + batching
// ---------------------------------------------------------------------------

const LOCK_FILE =
  process.env.HEAVY_LOCK ??
  join(homedir(), ".local", "share", "claude-office-shot", ".heavy.lock");
let lockDepth = 0;

/**
 * Hold the machine-wide heavy lock (flock) for `fn`. Reentrant within the
 * process. Do NOT also wrap the script in `flock` on the same file (deadlock);
 * set KTX_NO_LOCK=1 if you already hold it externally.
 */
export async function withHeavyLock<T>(fn: () => Promise<T>): Promise<T> {
  if (
    lockDepth > 0 ||
    process.env.KTX_NO_LOCK === "1" ||
    !existsSync(dirname(LOCK_FILE))
  ) {
    lockDepth++;
    try {
      return await fn();
    } finally {
      lockDepth--;
    }
  }
  // flock holds the lock for as long as its child (`cat`) lives, i.e. until we close stdin.
  const holder = spawn(
    "flock",
    ["-x", LOCK_FILE, "sh", "-c", "echo locked; cat >/dev/null"],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  await new Promise<void>((res, rej) => {
    holder.on("error", rej);
    holder.stdout.once("data", () => res());
    holder.on("exit", () => rej(new Error("flock exited early")));
  }).catch((e: unknown) => {
    console.warn(
      `[ktx] heavy lock unavailable (${String(e)}); continuing unlocked`,
    );
  });
  lockDepth++;
  try {
    return await fn();
  } finally {
    lockDepth--;
    holder.stdin.end();
    await new Promise<void>((r) => holder.once("exit", () => r()));
  }
}

/** Run jobs with bounded concurrency (<= 4). */
export async function pool<T>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(n, MAX_ENCODE_CONCURRENCY, items.length) },
      async () => {
        while (i < items.length) await fn(items[i++]!);
      },
    ),
  );
}

/** Lock once, then run all jobs with limited concurrency. */
export function runBatch(
  jobs: Array<() => Promise<void>>,
  concurrency = MAX_ENCODE_CONCURRENCY,
): Promise<void> {
  return withHeavyLock(() => pool(jobs, concurrency, (j) => j()));
}

// ---------------------------------------------------------------------------
// glTF -> KTX2 (KHR_texture_basisu)
// ---------------------------------------------------------------------------

/* The gltf-transform copy may differ from the caller's (tools/mpfb has its own
 * node_modules), so Document/Texture are typed structurally and the extension
 * class is injected by the caller. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDoc = any;
type AnyTex = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface Ktx2DocOptions {
  /** `KHRTextureBasisu` from the caller's @gltf-transform/extensions. */
  extension: unknown;
  /** Max edge per texture (default 1024). */
  maxEdge?: number | ((tex: AnyTex, role: TextureRole) => number);
  /** Pre-encode source bytes (lossless PNG) overriding the texture's own image. */
  sources?: Map<AnyTex, Uint8Array>;
}

function textureRoles(doc: AnyDoc): Map<AnyTex, TextureRole> {
  const roles = new Map<AnyTex, TextureRole>();
  for (const m of doc.getRoot().listMaterials()) {
    const set = (t: AnyTex | null, r: TextureRole) => {
      if (t && !roles.has(t)) roles.set(t, r);
    };
    set(m.getBaseColorTexture(), "color");
    set(m.getEmissiveTexture(), "color");
    set(m.getNormalTexture(), "normal");
    set(m.getOcclusionTexture(), "data");
    set(m.getMetallicRoughnessTexture(), "data");
  }
  return roles;
}

/**
 * Re-encode every texture of `doc` as KTX2 in place (names preserved), drop
 * EXT_texture_webp and register KHR_texture_basisu (required). The caller
 * writes the document afterwards. Returns the number of textures converted.
 */
export async function ktx2ifyDocument(
  doc: AnyDoc,
  opts: Ktx2DocOptions,
): Promise<number> {
  const tool = await ensureKtx();
  if (!tool) return 0;
  const roles = textureRoles(doc);
  const textures: AnyTex[] = doc.getRoot().listTextures();
  const work = await mkdtemp(join(tmpdir(), "ktx2doc-"));
  try {
    const results = new Map<AnyTex, Uint8Array>();
    await withHeavyLock(() =>
      pool(
        textures.map((t, i) => ({ t, i })),
        MAX_ENCODE_CONCURRENCY,
        async ({ t, i }) => {
          const src = opts.sources?.get(t) ?? t.getImage();
          if (!src) return;
          const role = roles.get(t) ?? "color";
          const meta = await sharp(Buffer.from(src)).metadata();
          const raw = await sharp(Buffer.from(src))
            .ensureAlpha()
            .raw()
            .toBuffer();
          let hasAlpha = false;
          if (meta.hasAlpha)
            for (let p = 3; p < raw.length; p += 4)
              if (raw[p] !== 255) {
                hasAlpha = true;
                break;
              }
          const { mode, srgb } = codecFor(role, hasAlpha);
          const png = join(work, `${i}.png`);
          const out = join(work, `${i}.ktx2`);
          let img = sharp(Buffer.from(src));
          if (!hasAlpha) img = img.removeAlpha();
          await img.png().toFile(png);
          const me =
            typeof opts.maxEdge === "function"
              ? opts.maxEdge(t, role)
              : (opts.maxEdge ?? 1024);
          await encodeKtx2(png, out, {
            mode,
            srgb,
            alpha: hasAlpha,
            maxEdge: me,
          });
          results.set(t, new Uint8Array(await readFile(out)));
        },
      ),
    );
    for (const [t, bytes] of results)
      t.setImage(bytes).setMimeType("image/ktx2");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const e of doc.getRoot().listExtensionsUsed())
    if (e.extensionName === "EXT_texture_webp") e.dispose();
  const ext = doc.createExtension(opts.extension as never) as {
    setRequired(v: boolean): unknown;
  };
  ext.setRequired(true);
  return textures.length;
}
