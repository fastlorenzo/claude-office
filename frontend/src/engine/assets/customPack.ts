/**
 * Bring-your-own character pack (Character Creator / MetaHuman / Mixamo /
 * MPFB exports) — manifest types, a pure validator and clip resolution.
 * No Babylon imports. Files live in public/assets/characters-custom/
 * (git-ignored, never committed); see docs/characters.md.
 *
 * Example manifest.json:
 * {
 *   "version": 1,
 *   "characters": [
 *     { "id": "maya", "file": "maya.glb", "heightM": 1.68, "gender": "f",
 *       "role": "boss", "skeleton": "cc",
 *       "clips": { "idle": "Idle_Loop", "walk": "Walk_Loop" } }
 *   ],
 *   "animations": [
 *     { "id": "office-mixamo", "file": "anims/office.glb", "skeleton": "mixamo",
 *       "clips": { "type": "Typing", "sit": "Sitting Idle" } }
 *   ]
 * }
 * Clips not found in the character GLB or a shared animation GLB are borrowed
 * from the MPFB cast (retargeted by bone names) when that pack is installed.
 */

import type { SkeletonScheme } from "../characters/boneMaps";

export const CUSTOM_CHARACTER_ASSET_DIR = "/assets/characters-custom";

/** Office clips a rig can play (the MPFB clip set). */
export const CUSTOM_CLIP_KEYS = [
  "idle",
  "idleSubtle",
  "walk",
  "sitIdle",
  "type",
  "thinking",
  "talk",
  "sitTalk",
  "wave",
  "cheer",
  "clap",
  "nod",
  "listen",
  "raiseHand",
] as const;
export type CustomClipKey = (typeof CUSTOM_CLIP_KEYS)[number];

/** Accepted aliases in manifests. */
const CLIP_ALIASES: Record<string, CustomClipKey> = {
  sit: "sitIdle",
  sitting: "sitIdle",
  typing: "type",
  think: "thinking",
  celebrate: "cheer",
  raise: "raiseHand",
};

/** Clips without which a character can't do office work (sit + type). */
export const REQUIRED_CLIPS: readonly CustomClipKey[] = [
  "idle",
  "walk",
  "sitIdle",
  "type",
];

const SKELETONS: readonly SkeletonScheme[] = [
  "mpfb",
  "rocketbox",
  "mixamo",
  "unreal",
  "cc",
];

export interface CustomCharacter {
  id: string;
  /** GLB path relative to the pack directory */
  file: string;
  /** standing height in metres (used for scale checks and seat placement) */
  heightM: number;
  gender: "m" | "f" | "x";
  role: "boss" | "agent" | "any";
  skeleton: SkeletonScheme;
  /** office clip → animation name embedded in the character GLB */
  clips: Partial<Record<CustomClipKey, string>>;
  /** shared animation set ids to search (in order) for missing clips */
  animations: string[];
  /** uniform scale applied to the model (e.g. 0.01 for a centimetre export) */
  scale: number;
  /** extra yaw so the character faces +Z (degrees) */
  yawOffsetDeg: number;
  /** seated pelvis height above the floor; default ≈ 0.31 × heightM */
  sitPelvisHeightM?: number;
  /** seated pelvis offset behind the origin; default from the clip source */
  sitPelvisBackM?: number;
  /** canonical (MPFB/Unreal) bone → bone name overrides for retargeting */
  boneMap: Record<string, string>;
  /** head bone (nameplate anchor); default from the skeleton scheme */
  headBone?: string;
}

export interface CustomAnimationSet {
  id: string;
  file: string;
  skeleton: SkeletonScheme;
  clips: Partial<Record<CustomClipKey, string>>;
  boneMap: Record<string, string>;
}

export interface CustomPackManifest {
  version: 1;
  characters: CustomCharacter[];
  animations: CustomAnimationSet[];
  /** borrow missing clips from the MPFB cast (default true) */
  borrowMpfb: boolean;
}

export interface ValidationResult {
  manifest: CustomPackManifest | null;
  errors: string[];
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const SAFE_PATH = /^(?!\/)(?!.*\.\.)[\w\-./ ]+\.(glb|gltf)$/i;
const SAFE_ID = /^[\w\-.]{1,64}$/;

function parseClips(
  raw: unknown,
  where: string,
  errors: string[],
  warnings: string[],
): Partial<Record<CustomClipKey, string>> {
  const out: Partial<Record<CustomClipKey, string>> = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    errors.push(`${where}.clips must be an object`);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    const key = (CUSTOM_CLIP_KEYS as readonly string[]).includes(k)
      ? (k as CustomClipKey)
      : CLIP_ALIASES[k];
    if (!key) {
      warnings.push(`${where}.clips.${k}: unknown clip (ignored)`);
      continue;
    }
    if (typeof v !== "string" || !v) {
      errors.push(`${where}.clips.${k} must be a non-empty string`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

function parseBoneMap(
  raw: unknown,
  where: string,
  errors: string[],
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    errors.push(`${where}.boneMap must be an object`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v) out[k] = v;
    else errors.push(`${where}.boneMap.${k} must be a string`);
  }
  return out;
}

function parseSkeleton(
  v: unknown,
  where: string,
  errors: string[],
): SkeletonScheme {
  const s = v === "metahuman" ? "unreal" : v;
  if (typeof s === "string" && (SKELETONS as readonly string[]).includes(s))
    return s as SkeletonScheme;
  errors.push(
    `${where}.skeleton must be one of ${SKELETONS.join(", ")} (got ${JSON.stringify(v)})`,
  );
  return "mpfb";
}

const num = (
  v: unknown,
  lo: number,
  hi: number,
  where: string,
  errors: string[],
): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
    errors.push(`${where} must be a number in [${lo}, ${hi}]`);
    return undefined;
  }
  return v;
};

/** Validate + normalise a parsed manifest.json (unknown keys are ignored). */
export function validateCustomPack(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw))
    return { manifest: null, errors: ["manifest must be an object"], warnings };
  if (raw.version !== undefined && raw.version !== 1)
    errors.push(`version must be 1 (got ${JSON.stringify(raw.version)})`);

  const animations: CustomAnimationSet[] = [];
  const animIds = new Set<string>();
  if (raw.animations !== undefined && !Array.isArray(raw.animations))
    errors.push("animations must be an array");
  for (const [i, a] of (Array.isArray(raw.animations)
    ? raw.animations
    : []
  ).entries()) {
    const where = `animations[${i}]`;
    if (!isObj(a)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const id = typeof a.id === "string" ? a.id : "";
    if (!SAFE_ID.test(id)) errors.push(`${where}.id is missing or invalid`);
    else if (animIds.has(id)) errors.push(`${where}.id "${id}" is duplicated`);
    if (typeof a.file !== "string" || !SAFE_PATH.test(a.file))
      errors.push(`${where}.file must be a relative .glb/.gltf path`);
    const clips = parseClips(a.clips, where, errors, warnings);
    if (Object.keys(clips).length === 0)
      warnings.push(`${where} maps no clips`);
    animIds.add(id);
    animations.push({
      id,
      file: String(a.file ?? ""),
      skeleton: parseSkeleton(a.skeleton, where, errors),
      clips,
      boneMap: parseBoneMap(a.boneMap, where, errors),
    });
  }

  const characters: CustomCharacter[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(raw.characters) || raw.characters.length === 0)
    errors.push("characters must be a non-empty array");
  for (const [i, c] of (Array.isArray(raw.characters)
    ? raw.characters
    : []
  ).entries()) {
    const where = `characters[${i}]`;
    if (!isObj(c)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const id = typeof c.id === "string" ? c.id : "";
    if (!SAFE_ID.test(id)) errors.push(`${where}.id is missing or invalid`);
    else if (ids.has(id)) errors.push(`${where}.id "${id}" is duplicated`);
    ids.add(id);
    if (typeof c.file !== "string" || !SAFE_PATH.test(c.file))
      errors.push(`${where}.file must be a relative .glb/.gltf path`);
    const heightM = num(c.heightM, 1.2, 2.3, `${where}.heightM`, errors);
    if (c.heightM === undefined) errors.push(`${where}.heightM is required`);
    const gender = c.gender === "m" || c.gender === "f" ? c.gender : "x";
    const role =
      c.role === "boss" || c.role === "agent" ? c.role : ("any" as const);
    let anims: string[] = [];
    if (c.animations !== undefined) {
      const list =
        typeof c.animations === "string" ? [c.animations] : c.animations;
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string"))
        errors.push(`${where}.animations must be a string or string array`);
      else anims = list as string[];
      for (const a of anims)
        if (!animIds.has(a))
          errors.push(`${where}.animations: unknown animation set "${a}"`);
    }
    characters.push({
      id,
      file: String(c.file ?? ""),
      heightM: heightM ?? 1.75,
      gender,
      role,
      skeleton: parseSkeleton(c.skeleton, where, errors),
      clips: parseClips(c.clips, where, errors, warnings),
      animations: anims,
      scale: num(c.scale, 0.001, 100, `${where}.scale`, errors) ?? 1,
      yawOffsetDeg:
        num(c.yawOffsetDeg, -360, 360, `${where}.yawOffsetDeg`, errors) ?? 0,
      sitPelvisHeightM: num(
        c.sitPelvisHeightM,
        0.2,
        1,
        `${where}.sitPelvisHeightM`,
        errors,
      ),
      sitPelvisBackM: num(
        c.sitPelvisBackM,
        -0.6,
        0.6,
        `${where}.sitPelvisBackM`,
        errors,
      ),
      boneMap: parseBoneMap(c.boneMap, where, errors),
      headBone: typeof c.headBone === "string" ? c.headBone : undefined,
    });
  }
  const borrowMpfb = raw.borrowMpfb !== false;
  if (errors.length) return { manifest: null, errors, warnings };
  return {
    manifest: { version: 1, characters, animations, borrowMpfb },
    errors,
    warnings,
  };
}

export type ClipSource =
  | { from: "embedded"; name: string }
  | { from: "animation"; set: string; name: string }
  | { from: "mpfb"; name: string };

/**
 * Where each office clip of a character comes from: its own GLB, then its
 * shared animation sets (in order), then the MPFB cast (when available and
 * allowed). Clips with no source are omitted.
 */
export function resolveClipSources(
  ch: CustomCharacter,
  manifest: Pick<CustomPackManifest, "animations" | "borrowMpfb">,
  mpfbAvailable: boolean,
): Partial<Record<CustomClipKey, ClipSource>> {
  const out: Partial<Record<CustomClipKey, ClipSource>> = {};
  const sets = ch.animations
    .map((id) => manifest.animations.find((a) => a.id === id))
    .filter((a): a is CustomAnimationSet => !!a);
  for (const clip of CUSTOM_CLIP_KEYS) {
    const own = ch.clips[clip];
    if (own) {
      out[clip] = { from: "embedded", name: own };
      continue;
    }
    const set = sets.find((s) => s.clips[clip]);
    if (set) {
      out[clip] = { from: "animation", set: set.id, name: set.clips[clip]! };
      continue;
    }
    if (mpfbAvailable && manifest.borrowMpfb)
      out[clip] = { from: "mpfb", name: clip };
  }
  return out;
}

/** True when the character can sit and type (else the cast falls back). */
export function isPlayable(
  sources: Partial<Record<CustomClipKey, ClipSource>>,
): boolean {
  return REQUIRED_CLIPS.every((c) => sources[c]);
}
