/**
 * Per-scene character pack registry: the cast setting, pack availability
 * probes, cached AssetContainers / clip templates, and RigSpec builders for
 * the three packs (Rocketbox, MPFB, custom). CastRig (one per actor) asks it
 * for specs and listens for cast changes.
 *
 * Availability:
 *   rocketbox  both per-gender animation libraries load
 *   mpfb       /assets/characters-mpfb/manifest.json exists
 *   custom     /assets/characters-custom/manifest.json exists and validates
 * A missing pack resolves "missing" quietly (CI has no assets).
 */

import {
  Animation,
  configureKtx2,
  AnimationGroup,
  AssetContainer,
  LoadAssetContainerAsync,
  Node,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "../babylon";
import type { CharacterCast } from "../fx/graphicsSettings";
import {
  BOSS_AVATAR_ID,
  CHARACTER_ANIMATIONS,
  CHARACTER_ASSET_DIR,
  CHARACTER_AVATARS,
  CHARACTER_FACING_YAW_OFFSET,
  CHARACTER_ONE_SHOT_CLIPS,
  CHARACTER_SIT_PELVIS_HEIGHT,
  CHARACTER_WALK_SPEED,
} from "../assets/characters";
import {
  MPFB_BOSS_AVATAR_ID,
  MPFB_CHARACTER_ASSET_DIR,
  MPFB_CHARACTER_AVATARS,
  MPFB_CHARACTER_FACING_YAW_OFFSET,
  MPFB_CHARACTER_ONE_SHOT_CLIPS,
  type MpfbCharacterAvatar,
} from "../assets/charactersMpfb";
import {
  CUSTOM_CHARACTER_ASSET_DIR,
  isPlayable,
  resolveClipSources,
  validateCustomPack,
  type CustomCharacter,
  type CustomPackManifest,
} from "../assets/customPack";
import { BONE_MAPS, mapToCanonical, type SkeletonScheme } from "./boneMaps";
import {
  castChain,
  pickCastMember,
  type PackKind,
  type PackState,
} from "./castPlan";
import {
  isGenericUpperBone,
  isUpperBodyBone,
  MPFB_POSE_LAYERS,
  MPFB_SEATED_CLIPS,
  POSE_LAYERS,
  SEATED_CLIPS,
  type RigClip,
} from "./gltfLayers";
import { tuneCharacterMaterials } from "./characterMaterials";
import type { ClipTemplates, RigSpec, TemplateClip } from "./GltfRig";
import type { MannequinOptions } from "./MannequinRig";
import {
  retargetClip,
  type Joint,
  type Quat,
  type Track,
  type V3,
} from "./retarget";

export interface CastListener {
  refresh(): void;
}

export interface PackRegistry {
  readonly scene: Scene;
  cast: CharacterCast;
  readonly rigs: Set<CastListener>;
  state(kind: PackKind): PackState;
  probe(kind: PackKind): Promise<boolean>;
  spec(kind: PackKind, opts: MannequinOptions): Promise<RigSpec | null>;
}

/** Test seams: replace network loading. */
export interface PackIo {
  loadContainer(url: string, scene: Scene): Promise<AssetContainer | null>;
  fetchJson(url: string): Promise<unknown>;
}

/**
 * KTX2 variant of a character GLB (`office_f01.ktx2.glb`; textures are
 * GPU-compressed Basis, KHR_texture_basisu REQUIRED), or null when KTX2 is
 * unusable here, the file is an animation library (no textures) or already
 * the variant.
 */
export function ktx2VariantUrl(url: string): string | null {
  if (!/\.glb$/.test(url) || /\.ktx2\.glb$/.test(url)) return null;
  if (/\/animations_[mf]\.glb$/.test(url)) return null;
  return url.replace(/\.glb$/, ".ktx2.glb");
}

async function loadGlb(url: string, scene: Scene): Promise<AssetContainer> {
  const c = await LoadAssetContainerAsync(url, scene, {
    // Don't auto-play the first clip: nodes must stay at their rest pose
    // (retargeting reads it) and nothing should tick inside containers.
    pluginOptions: { gltf: { animationStartMode: 0 } as never },
  });
  for (const g of c.animationGroups) g.stop();
  tuneCharacterMaterials(c);
  return c;
}

const defaultIo: PackIo = {
  loadContainer: async (url, scene) => {
    // KTX2 variant first; the plain GLB is the fallback (absent, transcoder
    // unavailable, or a load error).
    const ktx = ktx2VariantUrl(url);
    if (ktx && typeof fetch === "function" && configureKtx2()) {
      try {
        const head = await fetch(ktx, { method: "HEAD" });
        const html = (head.headers.get("content-type") ?? "").includes("html");
        if (head.ok && !html) return await loadGlb(ktx, scene);
      } catch (err) {
        if (scene.isDisposed) return null;
        console.warn(`[characters] KTX2 ${ktx} failed, using GLB`, err);
      }
    }
    try {
      return await loadGlb(url, scene);
    } catch (err) {
      // A page teardown mid-download is not worth a warning.
      if (!scene.isDisposed)
        console.warn(`[characters] failed to load ${url}`, err);
      return null;
    }
  },
  fetchJson: async (url) => {
    if (typeof fetch !== "function") return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const type = r.headers.get("content-type") ?? "";
      // Static hosts may answer a missing file with the app's HTML.
      if (type.includes("html")) return null;
      return await r.json();
    } catch {
      return null;
    }
  },
};

const registries = new WeakMap<Scene, Registry>();

/** Registry for a scene, or null when the scene never opted in. */
export function getPackRegistry(scene: Scene): PackRegistry | null {
  return registries.get(scene) ?? null;
}

/** Opt a scene into realistic characters (idempotent). */
export function enablePacks(scene: Scene, io?: Partial<PackIo>): PackRegistry {
  let r = registries.get(scene);
  if (!r) {
    r = new Registry(scene, { ...defaultIo, ...io });
    registries.set(scene, r);
    scene.onDisposeObservable.addOnce(() => registries.delete(scene));
  }
  return r;
}

/** Change the cast live: every CastRig re-resolves and swaps when ready. */
export function setCharacterCast(scene: Scene, cast: CharacterCast): void {
  const r = registries.get(scene);
  if (!r) return;
  if (r.cast === cast) return;
  r.cast = cast;
  for (const rig of [...r.rigs]) rig.refresh();
}

/**
 * Opt a scene into realistic characters and warm up the packs the current
 * cast prefers (boss + agent first choices). Actors created after this call
 * use CastRig. Resolves true when at least one preferred pack is usable.
 */
export async function preloadCharacterPack(
  scene: Scene,
  cast?: CharacterCast,
): Promise<boolean> {
  const r = enablePacks(scene);
  if (cast) setCharacterCast(scene, cast);
  const first = new Set<PackKind>([
    castChain(r.cast, "boss")[0],
    castChain(r.cast, "agent")[0],
  ]);
  const results = await Promise.all(
    [...first].map(async (k) => {
      const ok = await r.probe(k);
      // Warm the boss avatar so the hero appears first.
      if (ok && k === castChain(r.cast, "boss")[0])
        await r
          .spec(k, { id: "boss", boss: true, color: "#D97757" })
          .then((s) => s?.avatar);
      return ok;
    }),
  );
  return results.some(Boolean);
}

// ---------------------------------------------------------------------------

class Registry implements PackRegistry {
  cast: CharacterCast = "mixed";
  readonly rigs = new Set<CastListener>();
  private readonly states = new Map<PackKind, PackState>();
  private readonly probes = new Map<PackKind, Promise<boolean>>();
  private readonly containers = new Map<
    string,
    Promise<AssetContainer | null>
  >();
  private readonly templates = new Map<string, Promise<ClipTemplates | null>>();
  private custom: CustomPackManifest | null = null;

  constructor(
    readonly scene: Scene,
    private readonly io: PackIo,
  ) {}

  state(kind: PackKind): PackState {
    return this.states.get(kind) ?? "unknown";
  }

  probe(kind: PackKind): Promise<boolean> {
    let p = this.probes.get(kind);
    if (!p) {
      p = this.runProbe(kind).then(
        (ok) => {
          this.states.set(kind, ok ? "ready" : "missing");
          return ok;
        },
        () => {
          this.states.set(kind, "missing");
          return false;
        },
      );
      this.probes.set(kind, p);
    }
    return p;
  }

  private async runProbe(kind: PackKind): Promise<boolean> {
    if (kind === "rocketbox") {
      const [m, f] = await Promise.all([
        this.container(`${CHARACTER_ASSET_DIR}/${CHARACTER_ANIMATIONS.m.file}`),
        this.container(`${CHARACTER_ASSET_DIR}/${CHARACTER_ANIMATIONS.f.file}`),
      ]);
      return !!m && !!f;
    }
    if (kind === "mpfb") {
      const j = await this.io.fetchJson(
        `${MPFB_CHARACTER_ASSET_DIR}/manifest.json`,
      );
      return !!j && typeof j === "object";
    }
    const raw = await this.io.fetchJson(
      `${CUSTOM_CHARACTER_ASSET_DIR}/manifest.json`,
    );
    if (raw === null || raw === undefined) return false;
    const v = validateCustomPack(raw);
    for (const w of v.warnings) console.info(`[characters] custom pack: ${w}`);
    if (!v.manifest) {
      console.warn(
        `[characters] custom pack manifest invalid, falling back:\n  ${v.errors.join("\n  ")}`,
      );
      return false;
    }
    this.custom = v.manifest;
    return true;
  }

  container(url: string): Promise<AssetContainer | null> {
    let p = this.containers.get(url);
    if (!p) {
      p = this.io.loadContainer(url, this.scene).catch(() => null);
      this.containers.set(url, p);
    }
    return p;
  }

  private cachedTemplates(
    key: string,
    make: () => Promise<ClipTemplates | null>,
  ): Promise<ClipTemplates | null> {
    let p = this.templates.get(key);
    if (!p) {
      p = make().catch((err: unknown) => {
        console.warn(`[characters] ${key}: clips unavailable`, err);
        return null;
      });
      this.templates.set(key, p);
    }
    return p;
  }

  async spec(kind: PackKind, opts: MannequinOptions): Promise<RigSpec | null> {
    if (!(await this.probe(kind))) return null;
    if (kind === "rocketbox") return this.rocketboxSpec(opts);
    if (kind === "mpfb") return this.mpfbSpec(opts);
    return this.customSpec(opts);
  }

  // --- Rocketbox -------------------------------------------------------------

  private rocketboxSpec(opts: MannequinOptions): RigSpec {
    const a = pickCastMember(opts.id, CHARACTER_AVATARS, {
      boss: opts.boss,
      bossId: BOSS_AVATAR_ID,
    });
    const g = a.gender;
    const set = CHARACTER_ANIMATIONS[g];
    const names: Record<string, string> = { ...set.clips, ...set.extraClips };
    return {
      key: `rocketbox:${a.id}`,
      avatar: this.container(`${CHARACTER_ASSET_DIR}/${a.file}`),
      templates: this.cachedTemplates(`rocketbox:anims_${g}`, async () => {
        const c = await this.container(`${CHARACTER_ASSET_DIR}/${set.file}`);
        return c ? templatesFromGroups(c.animationGroups, names) : null;
      }),
      heightM: a.heightM,
      gender: g,
      facingYaw: CHARACTER_FACING_YAW_OFFSET,
      scale: 1,
      headBone: "Bip01 Head",
      badgeBone: "Bip01 Spine2",
      badgeChestZ: g === "f" ? 0.165 : 0.16,
      sitPelvisHeightM: CHARACTER_SIT_PELVIS_HEIGHT[g],
      sitPelvisBackM: 0,
      sitClearanceM: 0.08,
      walkSpeedMps: CHARACTER_WALK_SPEED[g],
      isUpper: isUpperBodyBone,
      poseLayers: POSE_LAYERS,
      seatedClips: SEATED_CLIPS,
      oneShot: CHARACTER_ONE_SHOT_CLIPS as ReadonlySet<RigClip>,
      standFallback: "idle",
      sitFallback: "sitIdle",
    };
  }

  // --- MPFB ------------------------------------------------------------------

  private mpfbSpec(opts: MannequinOptions): RigSpec {
    const a = pickCastMember(opts.id, MPFB_CHARACTER_AVATARS, {
      boss: opts.boss,
      bossId: MPFB_BOSS_AVATAR_ID,
      salt: "mpfb",
    });
    return this.mpfbSpecFor(a);
  }

  private mpfbSpecFor(a: MpfbCharacterAvatar): RigSpec {
    const url = `${MPFB_CHARACTER_ASSET_DIR}/${a.file}`;
    const avatar = this.container(url);
    return {
      key: `mpfb:${a.id}`,
      avatar,
      templates: this.cachedTemplates(`mpfb:${a.id}`, async () => {
        const c = await avatar;
        return c ? templatesFromGroups(c.animationGroups) : null;
      }),
      heightM: a.heightM,
      gender: a.gender,
      facingYaw: MPFB_CHARACTER_FACING_YAW_OFFSET,
      scale: 1,
      headBone: "head",
      badgeBone: "spine_03",
      badgeChestZ: a.gender === "f" ? 0.175 : 0.16,
      badgeHeightFrac: 0.725,
      sitPelvisHeightM: a.sitPelvisHeightM,
      sitPelvisBackM: a.sitPelvisBackM,
      sitClearanceM: 0.09,
      walkSpeedMps: a.walkSpeedMps,
      isUpper: isGenericUpperBone,
      poseLayers: MPFB_POSE_LAYERS,
      seatedClips: MPFB_SEATED_CLIPS,
      oneShot: MPFB_CHARACTER_ONE_SHOT_CLIPS as ReadonlySet<RigClip>,
      standFallback: "idle",
      sitFallback: "sitIdle",
    };
  }

  // --- Custom ----------------------------------------------------------------

  private async customSpec(opts: MannequinOptions): Promise<RigSpec | null> {
    const m = this.custom;
    if (!m) return null;
    const mpfb = m.borrowMpfb ? await this.probe("mpfb") : false;
    const playable = m.characters.filter((c) =>
      isPlayable(resolveClipSources(c, m, mpfb)),
    );
    if (playable.length === 0) return null;
    const role = opts.boss ? "boss" : "agent";
    const preferred = playable.filter((c) => c.role === role);
    const pool = preferred.length
      ? preferred
      : playable.filter((c) => c.role === "any");
    const ch = pickCastMember(opts.id, pool.length ? pool : playable, {
      boss: false,
      salt: "custom",
    });
    return this.customSpecFor(m, ch, mpfb);
  }

  private customSpecFor(
    m: CustomPackManifest,
    ch: CustomCharacter,
    mpfb: boolean,
  ): RigSpec {
    const avatar = this.container(`${CUSTOM_CHARACTER_ASSET_DIR}/${ch.file}`);
    const sources = resolveClipSources(ch, m, mpfb);
    const donor =
      MPFB_CHARACTER_AVATARS.find(
        (a) => a.id === (ch.gender === "f" ? "office_f01" : "office_m01"),
      ) ?? MPFB_CHARACTER_AVATARS[0];
    const borrowedSit = sources.sitIdle?.from === "mpfb";
    const H = ch.heightM;
    const map = BONE_MAPS[ch.skeleton];
    const templates = this.cachedTemplates(`custom:${ch.id}`, async () => {
      const tgt = await avatar;
      if (!tgt) return null;
      const out: ClipTemplates = new Map();
      const tgtJoints = extractJoints(tgt);
      const tgtCanon = mapToCanonical(
        tgtJoints.map((j) => j.name),
        ch.skeleton,
        ch.boneMap,
      );
      for (const [clip, src] of Object.entries(sources) as [
        RigClip,
        NonNullable<(typeof sources)[keyof typeof sources]>,
      ][]) {
        if (src.from === "embedded") {
          const g = tgt.animationGroups.find((x) => x.name === src.name);
          if (g) out.set(clip, templateFromGroup(g));
          else
            console.info(
              `[characters] ${ch.id}: clip "${src.name}" not in GLB`,
            );
          continue;
        }
        let donorC: AssetContainer | null;
        let scheme: SkeletonScheme;
        let overrides: Record<string, string> = {};
        if (src.from === "animation") {
          const set = m.animations.find((s) => s.id === src.set)!;
          donorC = await this.container(
            `${CUSTOM_CHARACTER_ASSET_DIR}/${set.file}`,
          );
          scheme = set.skeleton;
          overrides = set.boneMap;
        } else {
          donorC = await this.container(
            `${MPFB_CHARACTER_ASSET_DIR}/${donor.file}`,
          );
          scheme = "mpfb";
        }
        const g = donorC?.animationGroups.find((x) => x.name === src.name);
        if (!donorC || !g) continue;
        const srcJoints = extractJoints(donorC);
        const srcCanon = mapToCanonical(
          srcJoints.map((j) => j.name),
          scheme,
          overrides,
        );
        const baked = retargetClip({
          src: srcJoints,
          tgt: tgtJoints,
          srcCanon,
          tgtCanon,
          tracks: tracksFromGroup(g),
        });
        if (baked.length) out.set(clip, templateFromTracks(clip, baked));
      }
      return out;
    });
    const headBone = ch.headBone ?? map.head ?? "head";
    return {
      key: `custom:${ch.id}`,
      avatar,
      templates,
      heightM: H,
      gender: ch.gender,
      facingYaw: (ch.yawOffsetDeg * Math.PI) / 180,
      scale: ch.scale,
      headBone: ch.boneMap.head ?? headBone,
      badgeBone: ch.boneMap.spine_03 ?? map.spine_03 ?? null,
      badgeChestZ: 0.14,
      sitPelvisHeightM:
        ch.sitPelvisHeightM ??
        (borrowedSit ? donor.sitPelvisHeightM * (H / donor.heightM) : 0.31 * H),
      sitPelvisBackM:
        ch.sitPelvisBackM ??
        (borrowedSit ? donor.sitPelvisBackM * (H / donor.heightM) : 0),
      sitClearanceM: 0.09,
      walkSpeedMps: donor.walkSpeedMps * (H / donor.heightM),
      isUpper: isGenericUpperBone,
      poseLayers: MPFB_POSE_LAYERS,
      seatedClips: MPFB_SEATED_CLIPS,
      oneShot: MPFB_CHARACTER_ONE_SHOT_CLIPS as ReadonlySet<RigClip>,
      standFallback: "idle",
      sitFallback: "sitIdle",
    };
  }
}

// ---------------------------------------------------------------------------
// Babylon <-> plain data
// ---------------------------------------------------------------------------

function templateFromGroup(g: AnimationGroup): TemplateClip {
  return {
    from: g.from,
    to: g.to,
    tracks: g.targetedAnimations.map((ta) => ({
      target: (ta.target as { name?: string }).name ?? "",
      animation: ta.animation,
    })),
  };
}

/** Templates from animation groups; `names` maps clip → group name (identity when omitted). */
function templatesFromGroups(
  groups: readonly AnimationGroup[],
  names?: Readonly<Record<string, string>>,
): ClipTemplates {
  const out: ClipTemplates = new Map();
  if (names) {
    for (const [clip, gname] of Object.entries(names)) {
      const g = groups.find((x) => x.name === gname);
      if (g) out.set(clip as RigClip, templateFromGroup(g));
    }
  } else {
    for (const g of groups) out.set(g.name as RigClip, templateFromGroup(g));
  }
  return out;
}

/** Skeleton-relevant nodes below the glTF root, parents first (glTF space). */
export function extractJoints(c: AssetContainer): Joint[] {
  const roots: Node[] = [];
  for (const n of [...c.meshes, ...c.transformNodes])
    if (!n.parent) roots.push(n);
  const out: Joint[] = [];
  const visit = (n: Node, parent: number) => {
    if (!(n instanceof TransformNode)) return;
    const q = n.rotationQuaternion ?? Quaternion.FromEulerVector(n.rotation);
    out.push({
      name: n.name,
      parent,
      t: [n.position.x, n.position.y, n.position.z],
      r: [q.x, q.y, q.z, q.w],
      s: n.scaling.x,
    });
    const idx = out.length - 1;
    for (const ch of n.getChildren()) visit(ch, idx);
  };
  for (const r of roots) {
    // Babylon's "__root__" carries the RH→LH conversion: identical for donor and
    // target, so retarget in glTF space below it.
    if (r.name === "__root__") for (const ch of r.getChildren()) visit(ch, -1);
    else visit(r, -1);
  }
  return out;
}

function tracksFromGroup(g: AnimationGroup): Track[] {
  const rot = new Map<string, Track>();
  const pos = new Map<string, Track>();
  for (const ta of g.targetedAnimations) {
    const name = (ta.target as { name?: string }).name ?? "";
    const a = ta.animation;
    const fps = a.framePerSecond || 60;
    const keys = a.getKeys();
    const times = keys.map((k) => (k.frame - g.from) / fps);
    if (a.targetProperty === "rotationQuaternion") {
      rot.set(name, {
        joint: name,
        times,
        rotations: keys.map((k) => {
          const q = k.value as Quaternion;
          return [q.x, q.y, q.z, q.w] as Quat;
        }),
      });
    } else if (a.targetProperty === "position") {
      pos.set(name, {
        joint: name,
        times,
        translations: keys.map((k) => {
          const v = k.value as Vector3;
          return [v.x, v.y, v.z] as V3;
        }),
      });
    }
  }
  // One track per joint: translations resampled onto the rotation times.
  for (const [name, p] of pos) {
    const r = rot.get(name);
    if (r) r.translations = r.times.map((t) => sampleV(p, t));
    else rot.set(name, p);
  }
  return [...rot.values()];
}

function sampleV(tr: Track, t: number): V3 {
  const ts = tr.times;
  const vs = tr.translations!;
  if (t <= ts[0]) return vs[0];
  for (let i = 1; i < ts.length; i++) {
    if (t <= ts[i]) {
      const k = (t - ts[i - 1]) / (ts[i] - ts[i - 1] || 1);
      const a = vs[i - 1];
      const b = vs[i];
      return [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
      ];
    }
  }
  return vs[vs.length - 1];
}

const FPS = 60;

function templateFromTracks(clip: string, tracks: Track[]): TemplateClip {
  let end = 0;
  const out: TemplateClip["tracks"] = [];
  for (const tr of tracks) {
    if (tr.rotations?.length) {
      const a = new Animation(
        `${clip}_${tr.joint}_r`,
        "rotationQuaternion",
        FPS,
        Animation.ANIMATIONTYPE_QUATERNION,
        Animation.ANIMATIONLOOPMODE_CYCLE,
      );
      a.setKeys(
        tr.rotations.map((q, i) => ({
          frame: tr.times[i] * FPS,
          value: new Quaternion(q[0], q[1], q[2], q[3]),
        })),
      );
      out.push({ target: tr.joint, animation: a });
    }
    if (tr.translations?.length) {
      const a = new Animation(
        `${clip}_${tr.joint}_t`,
        "position",
        FPS,
        Animation.ANIMATIONTYPE_VECTOR3,
        Animation.ANIMATIONLOOPMODE_CYCLE,
      );
      a.setKeys(
        tr.translations.map((v, i) => ({
          frame: tr.times[i] * FPS,
          value: new Vector3(v[0], v[1], v[2]),
        })),
      );
      out.push({ target: tr.joint, animation: a });
    }
    end = Math.max(end, tr.times[tr.times.length - 1] ?? 0);
  }
  return { from: 0, to: Math.max(1, end * FPS), tracks: out };
}
