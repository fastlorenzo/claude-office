/**
 * Remember the player's last pose across reloads (localStorage).
 * Pure helpers (serialise / parse / freshness / validation) plus guarded
 * storage access; every storage call is try/catch'd (private mode, blocked).
 */

export const POSE_KEY = "co.playerPose.v1";
export const POSE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Window after init in which a not-yet-valid pose may still be applied once. */
export const POSE_RETRY_MS = 5000;
export const POSE_SAVE_INTERVAL_MS = 1000;

export interface SavedPose {
  v: 1;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mode: "fp" | "tp";
  t: number;
}

export function serializePose(
  p: Omit<SavedPose, "v" | "t">,
  now: number,
): string {
  const s: SavedPose = { ...p, v: 1, t: now };
  return JSON.stringify(s);
}

const fin = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/** Parse and sanity-check a stored value; null when malformed. */
export function parsePose(raw: string | null | undefined): SavedPose | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<SavedPose> | null;
    if (!o || o.v !== 1) return null;
    if (
      !fin(o.x) ||
      !fin(o.y) ||
      !fin(o.z) ||
      !fin(o.yaw) ||
      !fin(o.pitch) ||
      !fin(o.t)
    )
      return null;
    if (o.mode !== "fp" && o.mode !== "tp") return null;
    return {
      v: 1,
      x: o.x,
      y: o.y,
      z: o.z,
      yaw: o.yaw,
      pitch: o.pitch,
      mode: o.mode,
      t: o.t,
    };
  } catch {
    return null;
  }
}

/** Fresh = not from the future (beyond 1 min of skew) and not older than maxAge. */
export function isFresh(
  p: Pick<SavedPose, "t">,
  now: number,
  maxAgeMs = POSE_MAX_AGE_MS,
): boolean {
  const age = now - p.t;
  return age >= -60_000 && age <= maxAgeMs;
}

/** True when the URL asks for deterministic output (`shot=1` or `cam=`). */
export function restoreSuppressed(search: string): boolean {
  try {
    const q = new URLSearchParams(search);
    return q.get("shot") === "1" || q.has("cam");
  } catch {
    return false;
  }
}

export function loadPose(now = Date.now()): SavedPose | null {
  try {
    if (typeof window === "undefined") return null;
    if (restoreSuppressed(window.location.search)) return null;
    const p = parsePose(window.localStorage.getItem(POSE_KEY));
    return p && isFresh(p, now) ? p : null;
  } catch {
    return null;
  }
}

export function savePose(
  p: Omit<SavedPose, "v" | "t">,
  now = Date.now(),
): void {
  try {
    if (typeof window === "undefined") return;
    if (restoreSuppressed(window.location.search)) return;
    window.localStorage.setItem(POSE_KEY, serializePose(p, now));
  } catch {
    /* storage unavailable: ignore */
  }
}

/** Feet below this are out of the world (factory floor is at -6). */
export const FALL_Y = -10;
/** Never persist a pose below this (e.g. mid-fall). */
export const SAVE_MIN_Y = -7;
/** Airborne over the "outside" zone for this long counts as falling. */
export const FALL_OUTSIDE_S = 1.5;

/** Only grounded poses above the void are worth remembering. */
export function canSavePose(s: { grounded: boolean; y: number }): boolean {
  return s.grounded && Number.isFinite(s.y) && s.y >= SAVE_MIN_Y;
}

/** True when the player has fallen out of the world. */
export function isFallen(s: { y: number; airborneOutsideS: number }): boolean {
  return (
    !Number.isFinite(s.y) || s.y < FALL_Y || s.airborneOutsideS > FALL_OUTSIDE_S
  );
}

export function clearPose(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(POSE_KEY);
  } catch {
    /* ignore */
  }
}
