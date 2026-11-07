/**
 * Pure clip-layer mapping for the realistic (Rocketbox) rig.
 *
 * Every clip is split into an upper-body layer (spine, clavicles, arms, neck,
 * head: the Biped clavicles hang off the neck and seated clips use different
 * spine frames, so the whole spine chain travels with the gesture) and a
 * lower-body layer (root, pelvis, legs). A pose picks one clip per layer, so
 * seated poses can borrow standing gestures.
 */

import type { CharacterPose } from "../contracts";
import type { CharacterClip, CharacterExtraClip } from "../assets/characters";
import type { MpfbCharacterExtraClip } from "../assets/charactersMpfb";

export type AnyClip = CharacterClip | CharacterExtraClip;

/** Pose → [lower-body clip, upper-body clip]. */
export const POSE_LAYERS: Record<CharacterPose, [AnyClip, AnyClip]> = {
  idle: ["idle", "idle"],
  walking: ["walk", "walk"],
  sitting: ["sitIdle", "sitIdle"],
  typing: ["type", "type"],
  thinking: ["sitThinking", "sitThinking"],
  raiseHand: ["sitIdle", "raiseHand"],
  celebrating: ["sitIdle", "cheer"],
};

/** Clips whose pelvis sits at chair height. */
export const SEATED_CLIPS: ReadonlySet<AnyClip> = new Set<AnyClip>([
  "sitIdle",
  "sitIdle2",
  "sitLook",
  "sitThinking",
  "type",
]);

const UPPER_BONE =
  /(Spine|Clavicle|UpperArm|Forearm|Hand|Finger|Neck|Head|Jaw|Eye|Brow|Lip|Mouth|Cheek|Nose|Tongue|Ponytail)/i;

/** True when a skeleton node belongs to the upper-body (gesture) layer. */
export function isUpperBodyBone(name: string): boolean {
  return UPPER_BONE.test(name);
}

// ---------------------------------------------------------------------------
// MPFB / custom (Unreal-style and other skeletons)
// ---------------------------------------------------------------------------

/** Every clip name a skinned rig may play (Rocketbox + MPFB sets). */
export type RigClip = AnyClip | MpfbCharacterExtraClip;

/**
 * Pose → [lower, upper] for the MPFB clip set (also used by custom packs,
 * whose clips are named / borrowed after it). Seated gestures borrow the
 * standing arm motion over sitIdle legs, like the Rocketbox mapping.
 */
export const MPFB_POSE_LAYERS: Record<CharacterPose, [RigClip, RigClip]> = {
  idle: ["idle", "idle"],
  walking: ["walk", "walk"],
  sitting: ["sitIdle", "sitIdle"],
  typing: ["type", "type"],
  thinking: ["sitIdle", "thinking"],
  raiseHand: ["sitIdle", "raiseHand"],
  celebrating: ["sitIdle", "cheer"],
};

export const MPFB_SEATED_CLIPS: ReadonlySet<RigClip> = new Set<RigClip>([
  "sitIdle",
  "sitTalk",
  "type",
]);

const GENERIC_UPPER =
  /(spine|waist|chest|clavicle|shoulder|upperarm|lowerarm|forearm|arm|elbow|hand|wrist|finger|thumb|index|middle|mid\d|ring|pinky|neck|head|jaw|eye|brow|lip|mouth|cheek|nose|tongue|ponytail)/i;

/**
 * Upper-body (gesture) layer test for non-Biped skeletons (MPFB, Unreal,
 * Mixamo, CC). Hips, root and legs stay in the lower layer.
 */
export function isGenericUpperBone(name: string): boolean {
  if (/armature|root|hip|pelvis|thigh|leg|calf|knee|foot|toe|ball/i.test(name))
    return false;
  return GENERIC_UPPER.test(name);
}
