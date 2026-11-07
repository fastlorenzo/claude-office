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
