/**
 * Runtime manifest of the realistic office cast (Microsoft Rocketbox, MIT).
 * Plain data, no Babylon imports. The files are produced by
 * `bun run characters` (scripts/fetch-characters.ts) into
 * public/assets/characters/ together with a detailed manifest.json.
 *
 * Facts about the GLBs (verified by a headless Babylon 9.31 render):
 * - metres, Y-up, feet at y = 0, ~1.73 m (f) / ~1.81 m (m) tall
 * - skeleton is the 3ds Max "Bip01 ..." biped, identical bone names in every
 *   avatar and in the animation libraries, so clips retarget by node name
 *   (e.g. "Bip01 Pelvis", "Bip01 L UpperArm", "Bip01 R Hand")
 * - with Babylon's default glTF loader (left-handed scene) the models face +Z
 *   at yaw 0, so no extra yaw is needed (CHARACTER_FACING_YAW_OFFSET = 0)
 * - animation libraries contain only the skeleton nodes + named clips
 */

export const CHARACTER_ASSET_DIR = "/assets/characters";

export type CharacterClip =
  | "idle"
  | "walk"
  | "sitIdle"
  | "type"
  | "thinking"
  | "talk"
  | "wave"
  | "cheer"
  | "raiseHand";

/** Additional clips present in the animation libraries. */
export type CharacterExtraClip =
  "idleLook" | "sitIdle2" | "sitLook" | "sitThinking" | "standWork";

export interface CharacterAvatar {
  id: string;
  /** file name inside CHARACTER_ASSET_DIR */
  file: string;
  gender: "m" | "f";
  /** standing height in metres (rest pose, feet on y = 0) */
  heightM: number;
  style: "business" | "casual";
  /** material name that could be tinted for shirt colour (none: clothes share the body atlas) */
  shirtMaterial?: string;
}

export const CHARACTER_AVATARS: CharacterAvatar[] = [
  {
    id: "business_male_01",
    file: "business_male_01.glb",
    gender: "m",
    heightM: 1.806,
    style: "business",
  },
  {
    id: "business_male_02",
    file: "business_male_02.glb",
    gender: "m",
    heightM: 1.823,
    style: "business",
  },
  {
    id: "business_male_03",
    file: "business_male_03.glb",
    gender: "m",
    heightM: 1.819,
    style: "business",
  },
  {
    id: "business_male_04",
    file: "business_male_04.glb",
    gender: "m",
    heightM: 1.801,
    style: "business",
  },
  {
    id: "business_male_05",
    file: "business_male_05.glb",
    gender: "m",
    heightM: 1.802,
    style: "business",
  },
  {
    id: "business_male_06",
    file: "business_male_06.glb",
    gender: "m",
    heightM: 1.81,
    style: "business",
  },
  {
    id: "business_male_07",
    file: "business_male_07.glb",
    gender: "m",
    heightM: 1.796,
    style: "business",
  },
  {
    id: "business_female_01",
    file: "business_female_01.glb",
    gender: "f",
    heightM: 1.74,
    style: "business",
  },
  {
    id: "business_female_02",
    file: "business_female_02.glb",
    gender: "f",
    heightM: 1.729,
    style: "business",
  },
  {
    id: "business_female_03",
    file: "business_female_03.glb",
    gender: "f",
    heightM: 1.743,
    style: "business",
  },
  {
    id: "business_female_04",
    file: "business_female_04.glb",
    gender: "f",
    heightM: 1.733,
    style: "business",
  },
  {
    id: "male_adult_08",
    file: "male_adult_08.glb",
    gender: "m",
    heightM: 1.826,
    style: "casual",
  },
  {
    id: "male_adult_12",
    file: "male_adult_12.glb",
    gender: "m",
    heightM: 1.807,
    style: "casual",
  },
  {
    id: "female_adult_01",
    file: "female_adult_01.glb",
    gender: "f",
    heightM: 1.743,
    style: "casual",
  },
  {
    id: "female_adult_08",
    file: "female_adult_08.glb",
    gender: "f",
    heightM: 1.735,
    style: "casual",
  },
];

/** Sharp black suit with red tie. */
export const BOSS_AVATAR_ID = "business_male_01";

export interface CharacterAnimationSet {
  /** file name inside CHARACTER_ASSET_DIR */
  file: string;
  /** normalised clip -> animation group name inside the GLB (identical) */
  clips: Record<CharacterClip, string>;
  extraClips: Record<CharacterExtraClip, string>;
}

const CLIP_NAMES: Record<CharacterClip, string> = {
  idle: "idle",
  walk: "walk",
  sitIdle: "sitIdle",
  type: "type",
  thinking: "thinking",
  talk: "talk",
  wave: "wave",
  cheer: "cheer",
  raiseHand: "raiseHand",
};

const EXTRA_CLIP_NAMES: Record<CharacterExtraClip, string> = {
  idleLook: "idleLook",
  sitIdle2: "sitIdle2",
  sitLook: "sitLook",
  sitThinking: "sitThinking",
  standWork: "standWork",
};

export const CHARACTER_ANIMATIONS: Record<"m" | "f", CharacterAnimationSet> = {
  m: {
    file: "animations_m.glb",
    clips: CLIP_NAMES,
    extraClips: EXTRA_CLIP_NAMES,
  },
  f: {
    file: "animations_f.glb",
    clips: CLIP_NAMES,
    extraClips: EXTRA_CLIP_NAMES,
  },
};

/** Clips that should play once and hold the last pose (everything else loops). */
export const CHARACTER_ONE_SHOT_CLIPS: ReadonlySet<CharacterClip> =
  new Set<CharacterClip>(["wave", "raiseHand"]);

/**
 * Root speed baked into the in-place walk clip (m/s at speedRatio 1); set the
 * animation speedRatio to actualSpeed / CHARACTER_WALK_SPEED.
 */
export const CHARACTER_WALK_SPEED: Record<"m" | "f", number> = {
  m: 1.018,
  f: 1.21,
};

/**
 * Seated clips (sitIdle, type, ...) keep the pelvis ("Bip01") 0.58 m (m) /
 * 0.61 m (f) above the character origin with the feet ~0.5 m in front of it
 * (+Z): place the character origin so the pelvis lands on the seat, i.e.
 * origin.y = seatTopY + 0.08 - pelvis height, origin at the seat centre.
 */
export const CHARACTER_SIT_PELVIS_HEIGHT: Record<"m" | "f", number> = {
  m: 0.579,
  f: 0.611,
};

/** Radians to add to a character's yaw so that yaw 0 looks toward +Z. */
export const CHARACTER_FACING_YAW_OFFSET = 0;

/** FNV-1a hash -> stable, well-distributed avatar choice per agent id. */
export function pickAvatar(
  agentId: string,
  avatars: CharacterAvatar[] = CHARACTER_AVATARS,
): CharacterAvatar {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const avatar = avatars[(h >>> 0) % avatars.length];
  if (!avatar) throw new Error("pickAvatar: empty avatar list");
  return avatar;
}
