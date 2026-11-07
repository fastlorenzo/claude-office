/**
 * Builds the realistic office cast from Microsoft Rocketbox (MIT).
 *
 *   download FBX + TGA  ->  FBX2glTF  ->  gltf-transform (textures, materials)
 *   ->  public/assets/characters/<id>.glb  +  animations_{m,f}.glb  +  manifest.json
 *
 * Usage: bun scripts/fetch-characters.ts [--force]
 *
 * Idempotent: existing outputs are kept unless --force is given. The
 * manifest is always regenerated from the files on disk. Exits non-zero on
 * any failure.
 *
 * Source: https://github.com/microsoft/Microsoft-Rocketbox (pinned commit).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Accessor,
  type Animation,
  Document,
  NodeIO,
  PropertyType,
  type Node as GltfNode,
} from "@gltf-transform/core";
import { EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, getBounds, prune, resample } from "@gltf-transform/functions";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "assets", "characters");
const CACHE = join(ROOT, "node_modules", ".cache", "rocketbox");
const FORCE = process.argv.includes("--force");

const ROCKETBOX_SHA = "0943055db6ec570bcef9f2c8b41c9e5467c808f9";
const RAW = `https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/${ROCKETBOX_SHA}`;
const FBX2GLTF_VERSION = "0.9.7-p1";
const FBX2GLTF_INTEGRITY =
  "sha512-8S5rtp8fWCFjyHEQDTtrtXZOgvlzqkx3P1QsCptzvt9Ev3oRxRIaZ1XcXAQnfLoy1w3l/H8qhHdzDqZmVyhd9w==";

const ROUGHNESS: Record<string, number> = {
  body: 0.7,
  head: 0.62,
  opacity: 0.8,
};
const TEX_SIZE = { body: 1024, head: 1024, opacity: 1024, normal: 1024 };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface AvatarSpec {
  id: string;
  folder: string;
  group: "Professions" | "Adults";
  gender: "m" | "f";
  style: "business" | "casual";
}

const avatar = (
  name: string,
  group: AvatarSpec["group"],
  gender: "m" | "f",
  style: AvatarSpec["style"],
): AvatarSpec => ({
  id: name.toLowerCase(),
  folder: name,
  group,
  gender,
  style,
});

const AVATARS: AvatarSpec[] = [
  ...[1, 2, 3, 4, 5, 6, 7].map((i) =>
    avatar(`Business_Male_0${i}`, "Professions", "m", "business"),
  ),
  ...[1, 2, 3, 4].map((i) =>
    avatar(`Business_Female_0${i}`, "Professions", "f", "business"),
  ),
  avatar("Male_Adult_08", "Adults", "m", "casual"),
  avatar("Male_Adult_12", "Adults", "m", "casual"),
  avatar("Female_Adult_01", "Adults", "f", "casual"),
  avatar("Female_Adult_08", "Adults", "f", "casual"),
];

type Folder = "static" | "xy";
interface ClipSpec {
  /** normalised clip name in the library */
  name: string;
  /** Rocketbox file stem without the gender prefix and ".max.fbx" */
  stem: string;
  folder: Folder;
  /** strip horizontal root drift so the clip plays in place */
  inPlace?: boolean;
  /** play once and hold the last pose (otherwise loops) */
  loop: boolean;
  /** keep only the part of the clip up to the moment a hand is fully raised */
  trimToRaisedHand?: boolean;
  /** add procedural finger/wrist motion on top of the source clip (seated typing) */
  typing?: boolean;
}

const CLIPS: ClipSpec[] = [
  { name: "idle", stem: "idle_neutral_01", folder: "static", loop: true },
  {
    name: "idleLook",
    stem: "idle_look_around_01",
    folder: "static",
    loop: true,
  },
  {
    name: "walk",
    stem: "walk_neutral_01",
    folder: "xy",
    inPlace: true,
    loop: true,
  },
  {
    name: "sitIdle",
    stem: "sit_table_breathe_01",
    folder: "static",
    loop: true,
  },
  {
    name: "sitIdle2",
    stem: "sit_table_idle_roll_head",
    folder: "static",
    loop: true,
  },
  {
    name: "sitLook",
    stem: "sit_table_idle_look_around",
    folder: "static",
    loop: true,
  },
  {
    name: "sitThinking",
    stem: "sit_table_gestic_thoughtful",
    folder: "static",
    loop: true,
  },
  // No seated typing clip exists in Rocketbox: synthesised from the seated breathing pose.
  {
    name: "type",
    stem: "sit_table_breathe_01",
    folder: "static",
    loop: true,
    typing: true,
  },
  // Standing work-at-counter pose (hands forward at 0.9 m), real mocap.
  { name: "standWork", stem: "work_table", folder: "static", loop: true },
  {
    name: "thinking",
    stem: "gestic_thoughtful_01",
    folder: "static",
    loop: true,
  },
  {
    name: "talk",
    stem: "gestic_talk_neutral_01",
    folder: "static",
    loop: true,
  },
  { name: "wave", stem: "wave_01", folder: "static", loop: false },
  { name: "cheer", stem: "cheer_04", folder: "static", loop: true },
  // First half of wave_01: arm goes up and stays up. Play once, hold last pose.
  {
    name: "raiseHand",
    stem: "wave_01",
    folder: "static",
    loop: false,
    trimToRaisedHand: true,
  },
];

const ANIM_DIR: Record<Folder, string> = {
  static: "all_animations_max_motextr_static",
  xy: "all_animations_max_motextr_xy",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[characters] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[characters] ERROR: ${msg}`);
  process.exit(1);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function download(url: string, retries = 3): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === retries)
        throw new Error(`download ${url}: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return null;
}

async function cachedDownload(url: string, cachePath: string): Promise<string> {
  if ((await fileSize(cachePath)) === null) {
    const buf = await download(url);
    if (!buf) throw new Error(`not found: ${url}`);
    if (buf.subarray(0, 20).toString("latin1").includes("git-lfs")) {
      throw new Error(`LFS pointer returned for ${url}`);
    }
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, buf);
  }
  return cachePath;
}

// --- FBX2glTF binary --------------------------------------------------------

async function ensureFbx2gltf(): Promise<string> {
  const override = process.env.FBX2GLTF;
  if (override) return override;
  const platformDir =
    process.platform === "darwin"
      ? "Darwin"
      : process.platform === "win32"
        ? "Windows_NT"
        : "Linux";
  const exe = join(
    CACHE,
    "fbx2gltf",
    "package",
    "bin",
    platformDir,
    process.platform === "win32" ? "FBX2glTF.exe" : "FBX2glTF",
  );
  if (existsSync(exe)) return exe;
  log(`downloading fbx2gltf@${FBX2GLTF_VERSION} binary`);
  const tgz = await download(
    `https://registry.npmjs.org/fbx2gltf/-/fbx2gltf-${FBX2GLTF_VERSION}.tgz`,
  );
  if (!tgz) fail("fbx2gltf tarball not found on npm");
  const digest = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  if (digest !== FBX2GLTF_INTEGRITY)
    fail("fbx2gltf tarball integrity mismatch");
  const dir = join(CACHE, "fbx2gltf");
  await mkdir(dir, { recursive: true });
  const tgzPath = join(dir, "fbx2gltf.tgz");
  await writeFile(tgzPath, tgz);
  const res = spawnSync("tar", ["-xzf", tgzPath, "-C", dir], {
    stdio: "inherit",
  });
  if (res.status !== 0)
    fail("failed to extract fbx2gltf tarball (tar required)");
  if (!existsSync(exe)) fail(`fbx2gltf binary missing for ${platformDir}`);
  spawnSync("chmod", ["+x", exe]);
  return exe;
}

function convertFbx(exe: string, fbx: string, outGlb: string): void {
  const res = spawnSync(
    exe,
    ["--binary", "--input", fbx, "--output", outGlb.replace(/\.glb$/, "")],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !existsSync(outGlb)) {
    throw new Error(`FBX2glTF failed for ${fbx}: ${res.stderr || res.stdout}`);
  }
}

// --- TGA decoding -------------------------------------------------------------

interface Raster {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Buffer;
}

/** Decodes uncompressed / RLE true-colour TGA into a top-down RGB(A) raster. */
function decodeTga(buf: Buffer): Raster {
  const idLen = buf[0] ?? 0;
  const cmapType = buf[1] ?? 0;
  const type = buf[2] ?? 0;
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16] ?? 0;
  const desc = buf[17] ?? 0;
  if (cmapType !== 0 || (type !== 2 && type !== 10)) {
    throw new Error(`unsupported TGA type ${type}`);
  }
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported TGA depth ${bpp}`);
  const bytes = bpp / 8;
  const channels = bytes as 3 | 4;
  const pixels = width * height;
  const raw = Buffer.alloc(pixels * bytes);
  let pos = 18 + idLen;
  if (type === 2) {
    buf.copy(raw, 0, pos, pos + raw.length);
  } else {
    let out = 0;
    while (out < raw.length) {
      const header = buf[pos++] ?? 0;
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let i = 0; i < count; i++)
          buf.copy(raw, out + i * bytes, pos, pos + bytes);
        pos += bytes;
      } else {
        buf.copy(raw, out, pos, pos + count * bytes);
        pos += count * bytes;
      }
      out += count * bytes;
    }
  }
  const topDown = (desc & 0x20) !== 0;
  const data = Buffer.alloc(raw.length);
  const rowBytes = width * bytes;
  for (let y = 0; y < height; y++) {
    const src = (topDown ? y : height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const s = src + x * bytes;
      const d = y * rowBytes + x * bytes;
      data[d] = raw[s + 2] ?? 0; // BGR -> RGB
      data[d + 1] = raw[s + 1] ?? 0;
      data[d + 2] = raw[s] ?? 0;
      if (bytes === 4) data[d + 3] = raw[s + 3] ?? 255;
    }
  }
  return { width, height, channels, data };
}

async function tgaToWebp(
  url: string,
  size: number,
  quality: number,
): Promise<{ webp: Buffer; hasAlpha: boolean } | null> {
  const buf = await download(url);
  if (!buf) return null;
  const tga = decodeTga(buf);
  let hasAlpha = false;
  if (tga.channels === 4) {
    for (let i = 3; i < tga.data.length; i += 4) {
      if (tga.data[i] !== 255) {
        hasAlpha = true;
        break;
      }
    }
  }
  const img = sharp(tga.data, {
    raw: { width: tga.width, height: tga.height, channels: tga.channels },
  });
  const resized = img.resize(size, size, {
    fit: "inside",
    withoutEnlargement: true,
    kernel: "lanczos3",
  });
  const webp = await (hasAlpha ? resized : resized.removeAlpha())
    .webp({ quality, alphaQuality: 90, effort: 5, exact: true })
    .toBuffer();
  return { webp, hasAlpha };
}

// --- glTF helpers ---------------------------------------------------------------

function makeIO(): NodeIO {
  return new NodeIO().registerExtensions([EXTTextureWebP]);
}

function triangleCount(doc: Document): number {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx
        ? idx.getCount()
        : (prim.getAttribute("POSITION")?.getCount() ?? 0);
      tris += Math.floor(count / 3);
    }
  }
  return tris;
}

function nodeByName(doc: Document): Map<string, GltfNode> {
  const map = new Map<string, GltfNode>();
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (map.has(name) && name.startsWith("Bip01")) {
      throw new Error(`duplicate bone name ${name}`);
    }
    map.set(name, node);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

async function buildAvatar(spec: AvatarSpec, exe: string): Promise<void> {
  const outPath = join(OUT, `${spec.id}.glb`);
  if (!FORCE && (await fileSize(outPath)) !== null) {
    log(`skip ${spec.id} (exists)`);
    return;
  }
  log(`build ${spec.id}`);
  const base = `${RAW}/Assets/Avatars/${spec.group}/${spec.folder}`;
  const fbx = await cachedDownload(
    `${base}/Export/${spec.folder}.fbx`,
    join(CACHE, "fbx", `${spec.folder}.fbx`),
  );
  const rawGlb = join(CACHE, "glb", `${spec.folder}.glb`);
  await mkdir(dirname(rawGlb), { recursive: true });
  convertFbx(exe, fbx, rawGlb);

  const io = makeIO();
  const doc = await io.read(rawGlb);
  doc.createExtension(EXTTextureWebP).setRequired(true);

  for (const mat of doc.getRoot().listMaterials()) {
    const kind = mat.getName().split("_").pop() ?? "";
    mat.setBaseColorFactor([1, 1, 1, 1]);
    mat.setMetallicFactor(0);
    mat.setRoughnessFactor(ROUGHNESS[kind] ?? 0.7);
    mat.setEmissiveFactor([0, 0, 0]);
    mat.setBaseColorTexture(null);
    mat.setNormalTexture(null);

    const size =
      kind === "body" || kind === "head" || kind === "opacity"
        ? TEX_SIZE[kind]
        : 1024;
    const colorUrl = `${base}/Textures/${mat.getName()}_color.tga`;
    const glassUrl = `${base}/Textures/${mat.getName()}_opacity_color.tga`;
    const normalUrl = `${base}/Textures/${mat.getName()}_normal.tga`;
    const isGlass = kind === "glasses";
    const color =
      (await tgaToWebp(colorUrl, size, 82)) ??
      (await tgaToWebp(glassUrl, size, 85));
    if (color) {
      const tex = doc
        .createTexture(`${mat.getName()}_color`)
        .setImage(new Uint8Array(color.webp))
        .setMimeType("image/webp");
      mat.setBaseColorTexture(tex);
      if (isGlass) {
        // lenses: translucent
        mat.setAlphaMode("BLEND").setDoubleSided(true);
      } else if (color.hasAlpha || kind === "opacity") {
        // hair / eyelashes / lashes: alpha-tested cards
        mat.setAlphaMode("MASK").setAlphaCutoff(0.5).setDoubleSided(true);
      } else {
        mat.setAlphaMode("OPAQUE");
      }
    } else if (kind === "opacity") {
      log(`  ${spec.id}: no ${mat.getName()}_color.tga (no hair cards)`);
    } else {
      throw new Error(`${spec.id}: missing ${colorUrl}`);
    }
    const normal = await tgaToWebp(normalUrl, TEX_SIZE.normal, 90);
    if (normal) {
      const tex = doc
        .createTexture(`${mat.getName()}_normal`)
        .setImage(new Uint8Array(normal.webp))
        .setMimeType("image/webp");
      mat.setNormalTexture(tex);
    }
  }

  await doc.transform(prune(), dedup());
  // prune removes the FBX2glTF 1x1 placeholder textures; make sure extension is kept
  if (doc.getRoot().listTextures().length === 0) {
    throw new Error(`${spec.id}: no textures survived`);
  }
  await mkdir(OUT, { recursive: true });
  await io.write(outPath, doc);
}

// ---------------------------------------------------------------------------
// Animation libraries
// ---------------------------------------------------------------------------

type Quat = [number, number, number, number];

function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qAxis(axis: 0 | 1 | 2, angle: number): Quat {
  const q: Quat = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = Math.sin(angle / 2);
  return q;
}

function copyAccessor(dst: Document, src: Accessor, keep?: number): Accessor {
  const arr = src.getArray();
  if (!arr) throw new Error("accessor without array");
  const size = src.getElementSize();
  const sliced = keep === undefined ? arr.slice() : arr.slice(0, keep * size);
  return dst
    .createAccessor(src.getName())
    .setType(src.getType())
    .setArray(sliced as Float32Array<ArrayBuffer>);
}

/** Removes the average horizontal velocity (x/z) of the root so a clip plays in place. */
function makeInPlace(anim: Animation): void {
  for (const ch of anim.listChannels()) {
    if (
      ch.getTargetNode()?.getName() !== "Bip01" ||
      ch.getTargetPath() !== "translation"
    )
      continue;
    const sampler = ch.getSampler();
    const times = sampler?.getInput()?.getArray();
    const out = sampler?.getOutput();
    const arr = out?.getArray();
    if (!times || !arr || !out) continue;
    const n = times.length;
    const t0 = times[0] ?? 0;
    const span = (times[n - 1] ?? 0) - t0;
    for (const axis of [0, 2]) {
      const v0 = arr[axis] ?? 0;
      const vN = arr[(n - 1) * 3 + axis] ?? 0;
      for (let i = 0; i < n; i++) {
        const k = span > 0 ? ((times[i] ?? 0) - t0) / span : 0;
        arr[i * 3 + axis] = (arr[i * 3 + axis] ?? 0) - (vN - v0) * k;
      }
    }
    out.setArray(arr);
  }
}

/** Largest pose difference between first and last key over all channels (root x/z ignored). */
function loopSeamError(anim: Animation): number {
  let worst = 0;
  for (const ch of anim.listChannels()) {
    const out = ch.getSampler()?.getOutput();
    const arr = out?.getArray();
    if (!out || !arr) continue;
    const size = out.getElementSize();
    const n = out.getCount();
    const isRoot =
      ch.getTargetNode()?.getName() === "Bip01" &&
      ch.getTargetPath() === "translation";
    for (let c = 0; c < size; c++) {
      if (isRoot && c !== 1) continue;
      worst = Math.max(
        worst,
        Math.abs((arr[(n - 1) * size + c] ?? 0) - (arr[c] ?? 0)),
      );
    }
  }
  return worst;
}

/** Drops the last key of every channel (duplicate of the first key in a seamless loop). */
function dropLastKey(doc: Document, anim: Animation): void {
  const done = new Set<Accessor>();
  for (const s of anim.listSamplers()) {
    for (const acc of [s.getInput(), s.getOutput()]) {
      if (!acc || done.has(acc)) continue;
      done.add(acc);
      const arr = acc.getArray();
      if (!arr) continue;
      acc.setArray(
        arr.slice(
          0,
          arr.length - acc.getElementSize(),
        ) as Float32Array<ArrayBuffer>,
      );
    }
  }
  void doc;
}

/** Layers procedural wrist / finger motion onto a seated pose to read as typing. */
function addTyping(anim: Animation, duration: number): void {
  const fingerRe = /^Bip01 [LR] Finger[1-4]1?$/;
  let seed = 0;
  for (const ch of anim.listChannels()) {
    const name = ch.getTargetNode()?.getName() ?? "";
    if (ch.getTargetPath() !== "rotation") continue;
    const isFinger = fingerRe.test(name);
    const isHand = /^Bip01 [LR] Hand$/.test(name);
    const isForearm = /^Bip01 [LR] Forearm$/.test(name);
    if (!isFinger && !isHand && !isForearm) continue;
    seed++;
    const sampler = ch.getSampler();
    const times = sampler?.getInput()?.getArray();
    const out = sampler?.getOutput();
    const arr = out?.getArray();
    if (!times || !arr || !out) continue;
    // integer cycles per clip so the clip still loops seamlessly
    const baseHz = isFinger
      ? 3.2 + (seed % 5) * 0.55
      : isHand
        ? 1.1 + (seed % 3) * 0.4
        : 0.5;
    const cycles = Math.max(1, Math.round(baseHz * duration));
    const phase = (seed * 2.399) % (Math.PI * 2);
    const amp = (isFinger ? 9 : isHand ? 3.5 : 1.5) * (Math.PI / 180);
    const n = times.length;
    for (let i = 0; i < n; i++) {
      const t = times[i] ?? 0;
      const s = Math.sin((2 * Math.PI * cycles * t) / duration + phase);
      const s2 = Math.sin(
        (2 * Math.PI * Math.max(1, Math.round(cycles * 0.6)) * t) / duration +
          phase * 1.7,
      );
      // flex (local Z) for fingers & wrist, small deviation (Y), forearm roll (X)
      const dq = isForearm
        ? qAxis(0, amp * s)
        : qMul(
            qAxis(
              2,
              amp * (0.5 + 0.5 * s) * (isFinger ? 1 : 2) -
                (isFinger ? amp * 0.3 : amp),
            ),
            qAxis(1, amp * 0.5 * s2),
          );
      const q: Quat = [
        arr[i * 4] ?? 0,
        arr[i * 4 + 1] ?? 0,
        arr[i * 4 + 2] ?? 0,
        arr[i * 4 + 3] ?? 1,
      ];
      const r = qMul(q, dq);
      arr[i * 4] = r[0];
      arr[i * 4 + 1] = r[1];
      arr[i * 4 + 2] = r[2];
      arr[i * 4 + 3] = r[3];
    }
    out.setArray(arr);
  }
}

/** Time at which the highest hand first reaches 98% of its peak height in the source clip. */
function raisedHandTime(src: Document, anim: Animation): number {
  const root = src.getRoot();
  const nodes = root.listNodes();
  const rest = new Map(
    nodes.map((n) => [n, { t: n.getTranslation(), r: n.getRotation() }]),
  );
  const hands = ["Bip01 L Hand", "Bip01 R Hand"].map((nm) =>
    nodes.find((n) => n.getName() === nm),
  );
  const times = anim.listSamplers()[0]?.getInput()?.getArray();
  if (!times || hands.some((h) => !h))
    throw new Error("raisedHandTime: missing data");
  const heights: number[] = [];
  for (let i = 0; i < times.length; i++) {
    for (const n of nodes) {
      const r = rest.get(n);
      if (r) {
        n.setTranslation(r.t);
        n.setRotation(r.r);
      }
    }
    for (const ch of anim.listChannels()) {
      const out = ch.getSampler()?.getOutput();
      const target = ch.getTargetNode();
      if (!out || !target) continue;
      const idx = Math.min(i, out.getCount() - 1);
      if (ch.getTargetPath() === "translation")
        target.setTranslation(
          out.getElement(idx, [0, 0, 0]) as [number, number, number],
        );
      if (ch.getTargetPath() === "rotation")
        target.setRotation(out.getElement(idx, [0, 0, 0, 1]) as Quat);
    }
    heights.push(
      Math.max(...hands.map((h) => h?.getWorldTranslation()[1] ?? 0)),
    );
  }
  const peak = Math.max(...heights);
  const first = heights.findIndex((h) => h >= peak - 0.02);
  return times[first] ?? 0;
}

interface ClipInfo {
  name: string;
  source: string;
  duration: number;
  loop: boolean;
  synthetic: boolean;
  /** Bip01 translation at t=0, metres (x right, y up, z forward in glTF space) */
  rootStart: [number, number, number];
  /** horizontal distance travelled by the root in the source clip (before in-place) */
  sourceTravelM: number;
  inPlace: boolean;
  /** max pose delta between first and last key (0 = perfectly seamless loop) */
  loopSeamError: number;
}

const SKIP_BONE = /Nub$|^MotionExtractionHelper$/;

async function buildAnimationLibrary(
  gender: "m" | "f",
  exe: string,
): Promise<void> {
  const outPath = join(OUT, `animations_${gender}.glb`);
  if (!FORCE && (await fileSize(outPath)) !== null) {
    log(`skip animations_${gender} (exists)`);
    return;
  }
  log(`build animations_${gender}`);
  const io = makeIO();
  let lib: Document | null = null;
  let libNodes = new Map<string, GltfNode>();
  let originals: Animation[] = [];
  const infos: ClipInfo[] = [];

  for (const clip of CLIPS) {
    const file = `${gender}_${clip.stem}.max.fbx`;
    const fbx = await cachedDownload(
      `${RAW}/Assets/Animations/${ANIM_DIR[clip.folder]}/${file}`,
      join(CACHE, "anim", clip.folder, file),
    );
    const glb = join(CACHE, "anim-glb", clip.folder, `${file}.glb`);
    await mkdir(dirname(glb), { recursive: true });
    convertFbx(exe, fbx, glb);
    const src = await io.read(glb);
    const srcAnim = src.getRoot().listAnimations()[0];
    if (!srcAnim) throw new Error(`${file}: no animation`);

    if (!lib) {
      // the first clip's skeleton (nodes only) becomes the library skeleton
      lib = src;
      originals = src.getRoot().listAnimations();
      libNodes = nodeByName(lib);
    }
    const tEnd = clip.trimToRaisedHand
      ? raisedHandTime(src, srcAnim)
      : Infinity;
    const dstAnim = lib.createAnimation(clip.name);
    const inputs = new Map<Accessor, Accessor>();
    let duration = 0;
    let start: [number, number, number] = [0, 0, 0];
    let travel = 0;
    for (const ch of srcAnim.listChannels()) {
      const target = ch.getTargetNode();
      const sampler = ch.getSampler();
      const path = ch.getTargetPath();
      if (!target || !sampler || !path) continue;
      if (SKIP_BONE.test(target.getName())) continue;
      const node = libNodes.get(target.getName());
      if (!node)
        throw new Error(
          `${file}: bone ${target.getName()} missing in skeleton`,
        );
      const sIn = sampler.getInput();
      const sOut = sampler.getOutput();
      const inArr = sIn?.getArray();
      if (!sIn || !sOut || !inArr) continue;
      let keep = inArr.length;
      if (tEnd !== Infinity) {
        keep = 0;
        while (keep < inArr.length && (inArr[keep] ?? 0) <= tEnd + 1e-6) keep++;
        keep = Math.max(keep, 2);
      }
      let dIn = inputs.get(sIn);
      if (!dIn) {
        dIn = copyAccessor(lib, sIn, keep);
        inputs.set(sIn, dIn);
      }
      const dOut = copyAccessor(lib, sOut, keep);
      const dSampler = lib
        .createAnimationSampler()
        .setInput(dIn)
        .setOutput(dOut)
        .setInterpolation(sampler.getInterpolation());
      const dChannel = lib
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath(path)
        .setSampler(dSampler);
      dstAnim.addSampler(dSampler).addChannel(dChannel);
      duration = Math.max(duration, inArr[keep - 1] ?? 0);
      if (target.getName() === "Bip01" && path === "translation") {
        const a = sOut.getArray();
        if (a) {
          start = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
          const last = (keep - 1) * 3;
          travel = Math.hypot(
            (a[last] ?? 0) - (a[0] ?? 0),
            (a[last + 2] ?? 0) - (a[2] ?? 0),
          );
        }
      }
    }
    if (clip.inPlace) makeInPlace(dstAnim);
    const seam = loopSeamError(dstAnim);
    if (clip.loop && seam < 0.02) {
      // seamless loop: first and last pose coincide, drop the duplicate to avoid a stall
      dropLastKey(lib, dstAnim);
      const t = dstAnim.listSamplers()[0]?.getInput();
      const arr = t?.getArray();
      if (arr) duration = arr[arr.length - 1] ?? duration;
    }
    if (clip.typing) addTyping(dstAnim, duration);
    infos.push({
      name: clip.name,
      source: file,
      duration: Number(duration.toFixed(4)),
      loop: clip.loop,
      synthetic: clip.typing === true,
      rootStart: start.map((v) => Number(v.toFixed(4))) as [
        number,
        number,
        number,
      ],
      sourceTravelM: Number(travel.toFixed(4)),
      inPlace: clip.inPlace === true,
      loopSeamError: Number(seam.toFixed(4)),
    });
  }
  if (!lib) throw new Error("no clips");
  for (const a of originals) a.dispose();
  await lib.transform(
    resample(),
    dedup({ propertyTypes: [PropertyType.ACCESSOR] }),
  );
  lib
    .getRoot()
    .setExtras({ clips: infos as unknown as Record<string, unknown>[] });
  await mkdir(OUT, { recursive: true });
  await io.write(outPath, lib);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function worldY(node: GltfNode | undefined): number {
  return node ? node.getWorldTranslation()[1] : 0;
}

async function writeManifest(): Promise<void> {
  const io = makeIO();
  const avatars = [];
  let total = 0;
  for (const spec of AVATARS) {
    const file = `${spec.id}.glb`;
    const path = join(OUT, file);
    const bytes = await fileSize(path);
    if (bytes === null) throw new Error(`missing output ${file}`);
    const doc = await io.read(path);
    const scene =
      doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    if (!scene) throw new Error(`${file}: no scene`);
    const bounds = getBounds(scene);
    const nodes = nodeByName(doc);
    total += bytes;
    avatars.push({
      id: spec.id,
      file,
      gender: spec.gender,
      style: spec.style,
      source: `Assets/Avatars/${spec.group}/${spec.folder}`,
      triangles: triangleCount(doc),
      heightM: Number((bounds.max[1] - bounds.min[1]).toFixed(3)),
      footY: Number(bounds.min[1].toFixed(4)),
      hipHeightM: Number(worldY(nodes.get("Bip01 Pelvis")).toFixed(4)),
      bytes,
      joints: doc.getRoot().listSkins()[0]?.listJoints().length ?? 0,
    });
  }

  const animations: Record<string, unknown> = {};
  for (const gender of ["m", "f"] as const) {
    const file = `animations_${gender}.glb`;
    const path = join(OUT, file);
    const bytes = await fileSize(path);
    if (bytes === null) throw new Error(`missing output ${file}`);
    total += bytes;
    const doc = await io.read(path);
    const libNodes = nodeByName(doc);
    // bone-name check: every skin joint of every avatar of this gender must be in the library
    const missing = new Set<string>();
    for (const spec of AVATARS.filter((a) => a.gender === gender)) {
      const av = await io.read(join(OUT, `${spec.id}.glb`));
      for (const j of av.getRoot().listSkins()[0]?.listJoints() ?? []) {
        if (!libNodes.has(j.getName())) missing.add(j.getName());
      }
    }
    if (missing.size > 0) {
      throw new Error(
        `animations_${gender}: bones missing: ${[...missing].join(", ")}`,
      );
    }
    const clips = (doc.getRoot().getExtras().clips ??
      []) as unknown as ClipInfo[];
    const names = doc
      .getRoot()
      .listAnimations()
      .map((a) => a.getName());
    animations[gender] = {
      file,
      bytes,
      hipHeightM: Number(worldY(libNodes.get("Bip01 Pelvis")).toFixed(4)),
      clipNames: names,
      clips,
    };
  }

  const manifest = {
    generatedBy: "scripts/fetch-characters.ts",
    source: "https://github.com/microsoft/Microsoft-Rocketbox",
    sourceCommit: ROCKETBOX_SHA,
    license: "MIT (Copyright (c) 2020 Microsoft)",
    units: "metres, Y-up, glTF right-handed; models face +Z in glTF space",
    totalBytes: total,
    avatars,
    animations,
  };
  await writeFile(
    join(OUT, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log(`manifest.json written (${(total / 1e6).toFixed(2)} MB total)`);
}

async function writeLicense(): Promise<void> {
  const text = await download(`${RAW}/LICENSE.md`);
  const body = text
    ? text.toString("utf8")
    : "MIT License, Copyright (c) 2020 Microsoft";
  const md = `# Microsoft Rocketbox Avatar Library

Character models and animations in this directory are derived from the
Microsoft Rocketbox library (https://github.com/microsoft/Microsoft-Rocketbox),
converted from FBX to glTF with resized WebP textures.

${body.trim()}
`;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "LICENSE-ROCKETBOX.md"), md);
}

async function main(): Promise<void> {
  await mkdir(CACHE, { recursive: true });
  if (FORCE) await rm(join(CACHE, "glb"), { recursive: true, force: true });
  const exe = await ensureFbx2gltf();
  for (const spec of AVATARS) await buildAvatar(spec, exe);
  for (const g of ["m", "f"] as const) await buildAnimationLibrary(g, exe);
  await writeLicense();
  await writeManifest();
}

main().catch((err: unknown) => {
  console.error(
    `[characters] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
