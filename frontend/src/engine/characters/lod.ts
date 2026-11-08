/**
 * Pure LOD selection for character actors (no Babylon).
 *
 *   near   full skinned Rocketbox mesh, animated every frame, lanyard on
 *   mid    same mesh, lanyard hidden, animation frozen to ~15 Hz (rig decides)
 *   far    skinned mesh disabled, one shared thin-instanced impostor
 *   hidden room culled by the Visibility pass: nothing drawn at all
 */

export type ActorTier = "near" | "mid" | "far" | "hidden";
export type RoomDetailLevel = "full" | "impostor" | "hidden";

export const TIER_NEAR_M = 9;
export const TIER_MID_M = 16;
/** Only characters within this distance (m) of the player cast shadows. */
export const SHADOW_IN_M = 8;
export const SHADOW_OUT_M = 9.5;
const HYST = 1.5;

export type CharacterDetail = "low" | "medium" | "high";

/** Graphics-setting driven LOD bias: distance scale + skinned-mesh budget. */
export function characterBudget(d: CharacterDetail): {
  scale: number;
  maxSkinned: number;
  /** Of those, how many may be "near" (full detail: lanyard / extras). */
  maxNear: number;
} {
  if (d === "low") return { scale: 0.6, maxSkinned: 6, maxNear: 3 };
  if (d === "medium") return { scale: 0.8, maxSkinned: 8, maxNear: 5 };
  return { scale: 1, maxSkinned: 10, maxNear: 6 };
}

/** Tier from the eye distance, with hysteresis against `prev`. */
export function selectTier(
  prev: ActorTier,
  dist: number,
  detail: RoomDetailLevel,
  scale = 1,
): ActorTier {
  if (detail === "hidden") return "hidden";
  const h = (edge: number, inside: boolean) =>
    edge * scale + (inside ? HYST : 0);
  let tier: ActorTier;
  if (dist < h(TIER_NEAR_M, prev === "near")) tier = "near";
  else if (dist < h(TIER_MID_M, prev === "near" || prev === "mid"))
    tier = "mid";
  else tier = "far";
  // Impostor-level rooms (> ~30 m) never draw the skinned mesh.
  if (detail === "impostor" && tier !== "far") tier = "far";
  return tier;
}

/** Shadow caster decision with hysteresis. */
export function wantsShadow(prev: boolean, dist: number): boolean {
  return dist < (prev ? SHADOW_OUT_M : SHADOW_IN_M);
}
