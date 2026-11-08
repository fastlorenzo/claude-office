/**
 * Runtime manifest of the MPFB cast (MakeHuman / MPFB2, CC0 assets), a drop-in alternative to
 * ./characters.ts (Microsoft Rocketbox). Plain data, no Babylon imports. Files are produced by
 * `tools/mpfb/build.sh` into public/assets/characters-mpfb/ together with a detailed manifest.json
 * (generated; git-ignored like the other downloaded assets).
 *
 * Facts about the GLBs (verified from the exported node hierarchy):
 * - metres, Y-up, feet at y = 0, 1.60 - 1.93 m tall, ~17-20k triangles, 53 joints
 * - ONE canonical skeleton for every avatar: MPFB "game_engine" rig = Unreal-mannequin style names
 *   ("Root", "pelvis", "spine_01..03", "neck_01", "head", "clavicle_l", "upperarm_l", "lowerarm_l",
 *   "hand_l", "index_01_l".."thumb_03_r" finger bones, "thigh_l", "calf_l", "foot_l", "ball_l")
 * - toes point +Z in glTF space (CHARACTER_FACING_YAW_OFFSET = 0, same convention as Rocketbox)
 * - clips are embedded in every avatar GLB (retargeted per body), so there is no separate
 *   animation library; load the avatar and play the animation groups by name
 * - hair, eyebrows and eyelashes are alpha-tested (MASK) double-sided cards
 */

export const MPFB_CHARACTER_ASSET_DIR = "/assets/characters-mpfb";

export type MpfbCharacterClip =
  | "idle"
  | "walk"
  | "sitIdle"
  | "type"
  | "thinking"
  | "talk"
  | "wave"
  | "cheer"
  | "raiseHand";

/** Additional clips embedded in every GLB. */
export type MpfbCharacterExtraClip =
  | "sitTalk"
  | "clap"
  | "nod"
  | "listen"
  | "idleA"
  | "idleSubtle"
  | "walkRelaxed"
  | "walkM2M";

export interface MpfbCharacterAvatar {
  id: string;
  /** file name inside MPFB_CHARACTER_ASSET_DIR */
  file: string;
  gender: "m" | "f";
  /** standing height in metres (rest pose, feet on y = 0, includes hair) */
  heightM: number;
  style: "business" | "casual";
  ageYears: number;
  triangles: number;
  /** rest-pose pelvis ("pelvis" bone) height above the origin, metres */
  pelvisHeightM: number;
  /** pelvis height above the origin while seated (sitIdle/type/...), metres */
  sitPelvisHeightM: number;
  /** pelvis offset behind the origin (towards -Z) while seated, metres (hips sit behind the feet) */
  sitPelvisBackM: number;
  /** in-place walk clip speed in m/s at speedRatio 1 */
  walkSpeedMps: number;
}

type AvatarRow = Omit<MpfbCharacterAvatar, "sitPelvisBackM"> & {
  sitPelvisForwardM: number;
};

const AVATAR_ROWS: AvatarRow[] = [
  {
    id: "office_f01",
    file: "office_f01.glb",
    gender: "f",
    heightM: 1.676,
    style: "business",
    ageYears: 31,
    triangles: 18578,
    pelvisHeightM: 0.8604,
    sitPelvisHeightM: 0.5083,
    sitPelvisForwardM: 0.24,
    walkSpeedMps: 0.808,
  },
  {
    id: "office_f02",
    file: "office_f02.glb",
    gender: "f",
    heightM: 1.602,
    style: "casual",
    ageYears: 44,
    triangles: 19505,
    pelvisHeightM: 0.8183,
    sitPelvisHeightM: 0.4834,
    sitPelvisForwardM: 0.2255,
    walkSpeedMps: 0.765,
  },
  {
    id: "office_f03",
    file: "office_f03.glb",
    gender: "f",
    heightM: 1.681,
    style: "business",
    ageYears: 27,
    triangles: 20132,
    pelvisHeightM: 0.8814,
    sitPelvisHeightM: 0.5207,
    sitPelvisForwardM: 0.2472,
    walkSpeedMps: 0.824,
  },
  {
    id: "office_f04",
    file: "office_f04.glb",
    gender: "f",
    heightM: 1.685,
    style: "business",
    ageYears: 55,
    triangles: 17382,
    pelvisHeightM: 0.845,
    sitPelvisHeightM: 0.4992,
    sitPelvisForwardM: 0.2321,
    walkSpeedMps: 0.787,
  },
  {
    id: "office_f05",
    file: "office_f05.glb",
    gender: "f",
    heightM: 1.732,
    style: "business",
    ageYears: 36,
    triangles: 18579,
    pelvisHeightM: 0.908,
    sitPelvisHeightM: 0.5364,
    sitPelvisForwardM: 0.2536,
    walkSpeedMps: 0.848,
  },
  {
    id: "office_m01",
    file: "office_m01.glb",
    gender: "m",
    heightM: 1.846,
    style: "business",
    ageYears: 34,
    triangles: 19674,
    pelvisHeightM: 0.9759,
    sitPelvisHeightM: 0.5765,
    sitPelvisForwardM: 0.2928,
    walkSpeedMps: 0.907,
  },
  {
    id: "office_m02",
    file: "office_m02.glb",
    gender: "m",
    heightM: 1.766,
    style: "casual",
    ageYears: 47,
    triangles: 17381,
    pelvisHeightM: 0.9389,
    sitPelvisHeightM: 0.5546,
    sitPelvisForwardM: 0.2816,
    walkSpeedMps: 0.887,
  },
  {
    id: "office_m03",
    file: "office_m03.glb",
    gender: "m",
    heightM: 1.697,
    style: "casual",
    ageYears: 29,
    triangles: 18807,
    pelvisHeightM: 0.8894,
    sitPelvisHeightM: 0.5254,
    sitPelvisForwardM: 0.2761,
    walkSpeedMps: 0.846,
  },
  {
    id: "office_m04",
    file: "office_m04.glb",
    gender: "m",
    heightM: 1.794,
    style: "business",
    ageYears: 58,
    triangles: 18254,
    pelvisHeightM: 0.9626,
    sitPelvisHeightM: 0.5686,
    sitPelvisForwardM: 0.2885,
    walkSpeedMps: 0.905,
  },
  {
    id: "office_m05",
    file: "office_m05.glb",
    gender: "m",
    heightM: 1.931,
    style: "business",
    ageYears: 38,
    triangles: 20008,
    pelvisHeightM: 1.0269,
    sitPelvisHeightM: 0.6066,
    sitPelvisForwardM: 0.3077,
    walkSpeedMps: 0.952,
  },
];

export const MPFB_CHARACTER_AVATARS: MpfbCharacterAvatar[] = AVATAR_ROWS.map(
  ({ sitPelvisForwardM, ...rest }) => ({
    ...rest,
    sitPelvisBackM: sitPelvisForwardM,
  }),
);

/** Office boss: oldest man in a navy double-breasted suit. */
export const MPFB_BOSS_AVATAR_ID = "office_m04";

/** Clips that should play once and hold the last pose (everything else loops). */
export const MPFB_CHARACTER_ONE_SHOT_CLIPS: ReadonlySet<MpfbCharacterClip> =
  new Set<MpfbCharacterClip>(["wave", "raiseHand"]);

/** Radians to add to a character's yaw so that yaw 0 looks toward +Z. */
export const MPFB_CHARACTER_FACING_YAW_OFFSET = 0;
