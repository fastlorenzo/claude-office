/**
 * Runtime baked lighting: Blender Cycles irradiance lightmaps for the
 * layout-invariant architecture (room modules, lobby, entrance, control
 * room), produced by tools/lightmaps into `public/lightmaps/`.
 *
 *   manifest.json   { version: 1, sets: { <set>: { image, encoding: "rgbd",
 *                   size, gain, sun, frame, uv2, parts: { <part>: { hash,
 *                   vertexCount, uv2Offset } } } } }
 *   <set>.png       RGBD irradiance (no albedo), Babylon encoding
 *   <set>_uv2.bin   float32 LE UV2 per part (uv2Offset = float index)
 *
 * `BakedLighting.load` runs BEFORE the world is built (all material / light
 * changes then happen before `Materials.freezeAll`): it fetches the manifest,
 * every set's UV2 and lightmap, and installs itself as the scene's bake
 * applier (engine/bake/parts.ts). `MeshBatcher.build({ bake })` then offers
 * every merged part; a part takes the bake only when its quantised geometry
 * hash (engine/bake/hash.ts) equals the manifest's:
 *   - UV2 from the set's uv2.bin,
 *   - the material's baked variant (`Materials.baked` + LightmapPlugin),
 *   - `Lighting.bakeExclude` (fill, fixtures, zone lights, sun if baked in).
 * Anything else (no manifest, a missing file, a hash mismatch, an emissive /
 * glass part) keeps the realtime path untouched; problems are reported once
 * on the console and in `__worldStats.bakes`.
 *
 * Dev fixture (`?bakeFixture=1`): every bakeable part of every set takes a
 * synthetic lightmap (UV2 from normal / height, procedural irradiance) to
 * exercise the runtime path without a real bake.
 */
import {
  Constants,
  Texture,
  VertexBuffer,
  type InternalTexture,
  type Material,
  type Observer,
  type PBRMaterial,
  type Scene,
} from "@/engine/babylon";
import { partHash, topologyHash } from "@/engine/bake/hash";
import {
  BAKE_SETS,
  setBakeApplier,
  bakeApplier,
  type BakeApplier,
  type BakePart,
  type BakeSetId,
} from "@/engine/bake/parts";
import type { Lighting } from "@/engine/fx/Lighting";
import { LightmapPlugin } from "@/engine/materials/LightmapPlugin";
import type { Materials } from "@/engine/materials/Materials";

export interface ManifestPart {
  hash: string;
  /** Topology-only hash (sets with `verify: "topology"`). */
  topoHash?: string;
  /** Set-frame bounds [minX, minY, minZ, maxX, maxY, maxZ] (optional check). */
  bbox?: number[];
  vertexCount: number;
  /** Float32 element index of the part's first UV in the set's uv2.bin. */
  uv2Offset: number;
}

export interface ManifestSet {
  image: string;
  encoding: "rgbd";
  size: number;
  gain?: number;
  /** Fraction of the realtime IBL diffuse kept on baked surfaces. */
  iblScale?: number;
  /** Daylight baked in (the realtime sun is then excluded). */
  sun: boolean;
  frame?: string;
  /**
   * "position" (default): the quantised geometry hash must match.
   * "topology": vertex count + indices only (+ `bbox` when given) — the
   * control room's world-space float32 data moves with the hall length and
   * flips the 0.1 mm quantisation on some vertices between layouts.
   */
  verify?: "position" | "topology";
  uv2: string;
  parts: Record<string, ManifestPart>;
}

export interface LightmapManifest {
  version: number;
  sets: Partial<Record<BakeSetId, ManifestSet>>;
}

/** RGBA8 pixels, row 0 = v 0 (GL order). */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export type LightmapImage = ImageBitmap | RawImage;

/** I/O (tests inject their own). Null = definitely missing (HTTP 404). */
export interface BakeIO {
  json(url: string): Promise<unknown>;
  binary(url: string): Promise<ArrayBuffer | null>;
  image(url: string): Promise<LightmapImage>;
}

export interface BakeStats {
  /** Sets with at least one lightmapped part. */
  active: string[];
  /** `set:part` whose geometry hash / size did not match the manifest. */
  mismatched: string[];
  /** No manifest, or a set's files failed to load. */
  missing: boolean;
  /** Lightmapped parts (merged meshes). */
  parts: number;
  fixture?: boolean;
}

export interface BakeLoadOptions {
  /** URL base of the lightmaps (default "/lightmaps"). */
  base?: string;
  /** Skip lightmaps entirely (`?bakes=0`). */
  disabled?: boolean;
  /** Synthetic lightmaps for every set (`?bakeFixture=1`, dev only). */
  fixture?: boolean;
  /** Multiplier on every set's gain (tuning, `?bakeGain=`). */
  gainScale?: number;
  /** Override of every set's iblScale (tuning, `?bakeIbl=`). */
  iblScale?: number;
  io?: Partial<BakeIO>;
  /** Give up on the manifest / files after this long (ms). */
  timeoutMs?: number;
}

/** Realtime IBL diffuse kept on baked surfaces (the bake has the bounce). */
export const DEFAULT_IBL_SCALE = 0.25;
const NEUTRAL_RGBD = new Uint8Array([186, 186, 186, 255]);

interface LiveSet {
  id: BakeSetId;
  spec: ManifestSet;
  uv2: Float32Array | null;
  texture: Texture;
  gain: number;
  iblScale: number;
  image: string;
}

const registry = new WeakMap<Scene, BakedLighting>();

export class BakedLighting implements BakeApplier {
  /** The scene's baked lighting (null before `load` / when disposed). */
  static of(scene: Scene): BakedLighting | null {
    return registry.get(scene) ?? null;
  }

  /**
   * Fetch the manifest + every set's files and install the applier. Never
   * throws: any failure leaves the realtime path (and reports it).
   */
  static async load(
    scene: Scene,
    materials: Materials,
    lighting: Lighting,
    opts: BakeLoadOptions = {},
  ): Promise<BakedLighting> {
    const bl = new BakedLighting(scene, materials, lighting, opts);
    if (opts.disabled) return bl;
    if (opts.fixture) {
      bl.installFixture();
      return bl;
    }
    const timeout = opts.timeoutMs ?? 12000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ok = await Promise.race([
      bl.fetchAll().then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeout);
      }),
    ]).catch(() => false);
    if (timer) clearTimeout(timer);
    if (!ok) {
      bl.missing = true;
      bl.sets.clear();
      bl.warn("lightmaps did not load in time: realtime lighting");
    }
    if (bl.sets.size > 0) setBakeApplier(scene, bl);
    return bl;
  }

  private readonly sets = new Map<BakeSetId, LiveSet>();
  private readonly io: BakeIO;
  private readonly base: string;
  private missing = false;
  private fixture = false;
  private readonly mismatched: string[] = [];
  private readonly applied = new Map<BakeSetId, Set<string>>();
  private warned = false;
  private disposed = false;
  private restoreObs: Observer<unknown> | null = null;

  private constructor(
    private readonly scene: Scene,
    private readonly materials: Materials,
    private readonly lighting: Lighting,
    private readonly opts: BakeLoadOptions,
  ) {
    this.base = (opts.base ?? "/lightmaps").replace(/\/$/, "");
    this.io = { ...defaultIO(), ...opts.io };
    registry.set(scene, this);
    // Context restore: the bitmaps were not kept (the textures came back
    // neutral, see `track`): load them again.
    this.restoreObs = scene
      .getEngine()
      .onContextRestoredObservable.add(() =>
        this.reloadImages(),
      ) as Observer<unknown>;
  }

  /** `__worldStats.bakes`. */
  stats(): BakeStats {
    const active = BAKE_SETS.filter(
      (s) => (this.applied.get(s)?.size ?? 0) > 0,
    );
    let parts = 0;
    for (const s of this.applied.values()) parts += s.size;
    return {
      active,
      mismatched: [...this.mismatched],
      missing: this.missing,
      parts,
      ...(this.fixture ? { fixture: true } : {}),
    };
  }

  /** Sets whose files loaded (candidates; `stats().active` = applied). */
  get loadedSets(): BakeSetId[] {
    return [...this.sets.keys()];
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async fetchAll(): Promise<void> {
    let manifest: LightmapManifest | null = null;
    try {
      manifest = parseManifest(
        await this.io.json(`${this.base}/manifest.json`),
      );
    } catch {
      manifest = null;
    }
    if (!manifest) {
      this.missing = true;
      console.info("[bake] no lightmap manifest: realtime lighting");
      return;
    }
    const entries = BAKE_SETS.flatMap((id) => {
      const spec = manifest.sets[id];
      return spec ? [[id, spec] as const] : [];
    });
    await Promise.all(
      entries.map(async ([id, spec]) => {
        const imgUrl = `${this.base}/${spec.image}`;
        try {
          const [bin, img] = await Promise.all([
            this.io.binary(`${this.base}/${spec.uv2}`),
            this.io.image(imgUrl),
          ]);
          if (!bin) throw new Error(`${spec.uv2} missing`);
          if (this.disposed) return;
          const live = this.makeSet(id, spec, new Float32Array(bin), imgUrl);
          this.install(live.texture, img, imgUrl);
          this.sets.set(id, live);
        } catch (err) {
          this.missing = true;
          this.warn(
            `lightmap set "${id}" failed to load (${
              err instanceof Error ? err.message : String(err)
            }): realtime lighting`,
          );
        }
      }),
    );
  }

  private makeSet(
    id: BakeSetId,
    spec: ManifestSet,
    uv2: Float32Array | null,
    image: string,
  ): LiveSet {
    const texture = new Texture(null, this.scene, {
      noMipmap: true,
      invertY: true,
      samplingMode: Texture.BILINEAR_SAMPLINGMODE,
      gammaSpace: false,
      internalTexture: this.neutralInternal(),
    });
    texture.name = `lightmap:${id}`;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return {
      id,
      spec,
      uv2,
      texture,
      gain: (spec.gain ?? 1) * (this.opts.gainScale ?? 1),
      iblScale: this.opts.iblScale ?? spec.iblScale ?? DEFAULT_IBL_SCALE,
      image,
    };
  }

  /** 1×1 RGBD placeholder (ready at once, rebuilt from its data). */
  private neutralInternal(): InternalTexture {
    return this.rawInternal(NEUTRAL_RGBD, 1, 1);
  }

  private rawInternal(data: Uint8Array, w: number, h: number): InternalTexture {
    const it = this.scene
      .getEngine()
      .createRawTexture(
        data,
        w,
        h,
        Constants.TEXTUREFORMAT_RGBA,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      );
    it.isReady = true; // NullEngine leaves raw textures unflagged
    return it;
  }

  /** Swap a loaded lightmap into the set's texture (same object: no recompiles). */
  private install(tex: Texture, img: LightmapImage, url: string): void {
    if (this.disposed) return;
    if (isRaw(img)) {
      this.swap(tex, this.rawInternal(img.data, img.width, img.height));
      return;
    }
    let probe: Texture | null = null;
    const done = () => {
      const p = probe;
      if (!p) return;
      const internal = p.getInternalTexture();
      if (!internal || this.disposed) {
        p.dispose();
        return;
      }
      this.track(internal);
      p._texture = null;
      p.dispose();
      this.swap(tex, internal);
    };
    let loaded = false;
    probe = new Texture(`${url}#lm`, this.scene, {
      noMipmap: true,
      invertY: true,
      samplingMode: Texture.BILINEAR_SAMPLINGMODE,
      gammaSpace: false,
      buffer: img,
      onLoad: () => {
        loaded = true;
        if (probe) done();
      },
      onError: (message?: string) =>
        this.warn(`lightmap ${url} upload failed: ${message ?? "error"}`),
    });
    // Babylon may call onLoad synchronously from the constructor.
    if (loaded) done();
  }

  private swap(tex: Texture, internal: InternalTexture): void {
    const prev = tex._texture;
    tex._texture = internal;
    prev?.dispose();
  }

  /**
   * Context loss: rebuild with the neutral pixel (ready at once) instead of
   * re-fetching the URL (which, on failure, is never flagged ready again);
   * `reloadImages` brings the real map back.
   */
  private track(it: InternalTexture): void {
    it._buffer = null;
    it.onRebuildCallback = () => {
      it.url = `${it.url}#lost`;
      return {
        proxy: this.neutralInternal(),
        isReady: true,
        isAsync: false,
      };
    };
  }

  private reloadImages(): void {
    if (this.disposed || this.fixture) return;
    for (const set of this.sets.values())
      void this.io.image(set.image).then(
        (img) => this.install(set.texture, img, set.image),
        (err: unknown) =>
          this.warn(`lightmap ${set.image} reload failed: ${String(err)}`),
      );
  }

  // -------------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------------

  apply(part: BakePart): boolean {
    if (this.disposed) return false;
    const set = this.sets.get(part.set);
    if (!set) return false;
    const mesh = part.mesh;
    const mat = mesh.material;
    if (!bakeable(mat)) return false;
    let uv: Float32Array;
    if (this.fixture) {
      const f = fixtureUV2(mesh);
      if (!f) return false;
      uv = f;
    } else {
      const entry = set.spec.parts[part.name];
      const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
      const idx = mesh.getIndices();
      const nv = mesh.getTotalVertices();
      const why = !entry
        ? "not in the manifest"
        : !pos || !idx
          ? "no geometry"
          : entry.vertexCount !== nv
            ? `vertexCount ${nv} ≠ ${entry.vertexCount}`
            : !set.uv2 ||
                entry.uv2Offset < 0 ||
                entry.uv2Offset + nv * 2 > set.uv2.length
              ? "uv2 out of range"
              : !geometryMatches(set.spec, entry, pos, idx, part.origin)
                ? "geometry hash"
                : null;
      if (why) {
        this.mismatch(part, why);
        return false;
      }
      uv = set.uv2!.slice(entry!.uv2Offset, entry!.uv2Offset + nv * 2);
    }
    const variant = this.materials.baked(mat!, set.id, (m) => {
      // The plugin attaches before the variant is cached (frozen).
      new LightmapPlugin(m, set.texture, {
        gain: set.gain,
        iblScale: set.iblScale,
      });
    });
    if (!variant) return false;
    mesh.setVerticesData(VertexBuffer.UV2Kind, uv, false);
    mesh.material = variant;
    this.lighting.addMaterialVariant(mat as PBRMaterial, variant);
    this.lighting.bakeExclude([mesh], { sun: set.spec.sun });
    let names = this.applied.get(set.id);
    if (!names) {
      names = new Set();
      this.applied.set(set.id, names);
    }
    names.add(part.name);
    return true;
  }

  private mismatch(part: BakePart, why: string): void {
    const key = `${part.set}:${part.name}`;
    if (!this.mismatched.includes(key)) this.mismatched.push(key);
    this.warn(
      `lightmap part "${key}" does not match the bake (${why}): realtime lighting for it (re-run make bake-lightmaps)`,
    );
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[bake] ${msg}`);
  }

  // -------------------------------------------------------------------------
  // Dev fixture
  // -------------------------------------------------------------------------

  private installFixture(): void {
    this.fixture = true;
    const img = fixtureImage();
    for (const id of BAKE_SETS) {
      const spec: ManifestSet = {
        image: "fixture",
        encoding: "rgbd",
        size: img.width,
        sun: id === "lobby" || id === "entrance",
        uv2: "",
        parts: {},
      };
      const live = this.makeSet(id, spec, null, "fixture");
      this.install(live.texture, img, "fixture");
      this.sets.set(id, live);
    }
    setBakeApplier(this.scene, this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (bakeApplier(this.scene) === this) setBakeApplier(this.scene, null);
    if (registry.get(this.scene) === this) registry.delete(this.scene);
    if (this.restoreObs)
      this.scene
        .getEngine()
        .onContextRestoredObservable.remove(this.restoreObs);
    this.restoreObs = null;
    for (const s of this.sets.values()) s.texture.dispose();
    this.sets.clear();
  }
}

/** Bounds tolerance (m) of the topology check. */
const BBOX_TOL = 2e-3;

function geometryMatches(
  set: ManifestSet,
  entry: ManifestPart,
  pos: ArrayLike<number>,
  idx: ArrayLike<number>,
  origin: BakePart["origin"],
): boolean {
  if (set.verify !== "topology")
    return partHash(pos, idx, origin) === entry.hash;
  if (!entry.topoHash || topologyHash(pos.length / 3, idx) !== entry.topoHash)
    return false;
  const b = entry.bbox;
  if (!b || b.length !== 6) return true;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const o = [origin.x, origin.y, origin.z];
  for (let i = 0; i < pos.length; i++) {
    const v = pos[i] - o[i % 3];
    if (v < lo[i % 3]) lo[i % 3] = v;
    if (v > hi[i % 3]) hi[i % 3] = v;
  }
  for (let k = 0; k < 3; k++)
    if (
      Math.abs(lo[k] - b[k]) > BBOX_TOL ||
      Math.abs(hi[k] - b[k + 3]) > BBOX_TOL
    )
      return false;
  return true;
}

function isRaw(img: LightmapImage): img is RawImage {
  return (img as RawImage).data instanceof Uint8Array;
}

/** Lit, opaque PBR: emissive / unlit and alpha-blended parts stay realtime. */
function bakeable(mat: Material | null): boolean {
  if (!mat) return false;
  const pbr = mat as PBRMaterial;
  if (pbr.disableLighting || pbr.unlit) return false;
  return !mat.needAlphaBlending();
}

export function parseManifest(raw: unknown): LightmapManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<LightmapManifest>;
  if (m.version !== 1 || !m.sets || typeof m.sets !== "object") return null;
  const sets: LightmapManifest["sets"] = {};
  for (const id of BAKE_SETS) {
    const s = m.sets[id];
    if (
      s &&
      s.encoding === "rgbd" &&
      typeof s.image === "string" &&
      typeof s.uv2 === "string" &&
      s.parts &&
      typeof s.parts === "object"
    )
      sets[id] = {
        ...s,
        sun: !!s.sun,
        verify: s.verify === "topology" ? "topology" : "position",
      };
  }
  return { version: 1, sets };
}

// ---------------------------------------------------------------------------
// Default I/O (browser)
// ---------------------------------------------------------------------------

const DELAYS = [300, 1000];

async function retry<T>(f: () => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i <= DELAYS.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAYS[i - 1]));
    try {
      return await f();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

class Missing extends Error {}

function defaultIO(): BakeIO {
  const get = async (url: string): Promise<Response | null> => {
    try {
      return await retry(async () => {
        const r = await fetch(url);
        if (r.status === 404) throw new Missing(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      });
    } catch (err) {
      if (err instanceof Missing) return null;
      throw err;
    }
  };
  return {
    async json(url) {
      const r = await get(url).catch(() => null);
      // A dev server may answer an absent file with the app's HTML.
      if (!r || !(r.headers.get("content-type") ?? "").includes("json"))
        return null;
      return r.json();
    },
    async binary(url) {
      const r = await get(url);
      return r ? r.arrayBuffer() : null;
    },
    async image(url) {
      return retry(async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // RGBD keeps the exponent in alpha: never premultiplied or
        // colour-managed. flipY: WebGL ignores UNPACK_FLIP_Y for bitmaps.
        return createImageBitmap(await r.blob(), {
          imageOrientation: "flipY",
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: synthetic lightmap (UV2 = facing × height)
// ---------------------------------------------------------------------------

const FIXTURE_SIZE = 32;

/** Babylon's toRGBD for one linear colour (exported for tests). */
export function encodeRGBD(r: number, g: number, b: number): number[] {
  const m = Math.max(r, g, b, 1e-6);
  let d = Math.max(255 / m, 1);
  d = Math.min(1, Math.max(0, Math.floor(d) / 255));
  const enc = (c: number) =>
    Math.round(255 * Math.min(1, Math.max(0, c * d)) ** (1 / 2.2));
  return [enc(r), enc(g), enc(b), Math.round(d * 255)];
}

/** u: facing (0 ceiling, 0.5 wall, 1 floor) · v: height 0–4 m. */
function fixtureImage(): RawImage {
  const n = FIXTURE_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      // Floors get the luminaires, walls brighten toward the ceiling
      // (bounce), ceilings and undersides stay dim.
      const e = (0.35 + 1.0 * u) * (0.85 + 0.35 * v);
      const px = encodeRGBD(e, e * 0.96, e * 0.9);
      data.set(px, (y * n + x) * 4);
    }
  return { data, width: n, height: n };
}

function fixtureUV2(mesh: BakePart["mesh"]): Float32Array | null {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nor) return null;
  const n = pos.length / 3;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ny = nor[i * 3 + 1];
    uv[i * 2] = Math.min(0.98, Math.max(0.02, 0.5 + 0.48 * ny));
    uv[i * 2 + 1] = Math.min(0.98, Math.max(0.02, pos[i * 3 + 1] / 4));
  }
  return uv;
}
