/**
 * Pure cast selection (no Babylon): which character pack a rig should use for
 * a given cast setting and role, in fallback order, and deterministic picks.
 *
 *   mixed      boss: Rocketbox (the close-up hero) → MPFB; agents: MPFB → Rocketbox
 *   rocketbox  Rocketbox → MPFB
 *   mpfb       MPFB → Rocketbox
 *   custom     custom pack → MPFB → Rocketbox
 *
 * The procedural mannequin is the implicit last resort (packs not fetched, CI).
 */

import type { CharacterCast } from "../fx/graphicsSettings";
import { hashString } from "./identity";

export type PackKind = "rocketbox" | "mpfb" | "custom";
export type CastRole = "boss" | "agent";

export function castChain(cast: CharacterCast, role: CastRole): PackKind[] {
  switch (cast) {
    case "rocketbox":
      return ["rocketbox", "mpfb"];
    case "mpfb":
      return ["mpfb", "rocketbox"];
    case "custom":
      return ["custom", "mpfb", "rocketbox"];
    case "mixed":
    default:
      return role === "boss" ? ["rocketbox", "mpfb"] : ["mpfb", "rocketbox"];
  }
}

/** Pack availability as known so far. */
export type PackState = "unknown" | "ready" | "missing";

/**
 * First pack of the chain that is (or may still become) usable. Returns
 * `{ kind, wait }`: wait = true when an earlier preferred pack is still
 * probing (callers keep what they show and ask again when it settles).
 */
export function resolvePack(
  chain: readonly PackKind[],
  state: (k: PackKind) => PackState,
): { kind: PackKind | null; wait: boolean } {
  for (const k of chain) {
    const s = state(k);
    if (s === "ready") return { kind: k, wait: false };
    if (s === "unknown") return { kind: null, wait: true };
  }
  return { kind: null, wait: false };
}

/**
 * Stable pick from a list by id (FNV-1a), so a character keeps its look across
 * reloads. `salt` decorrelates picks made from the same id for different packs.
 */
export function pickStable<T>(id: string, list: readonly T[], salt = ""): T {
  if (list.length === 0) throw new Error("pickStable: empty list");
  return list[hashString(salt + id) % list.length] as T;
}

/**
 * Pick for a room member: the boss always gets `bossId` when present; agents
 * pick stably from the rest of the list (so nobody looks like the boss).
 */
export function pickCastMember<T extends { id: string }>(
  id: string,
  list: readonly T[],
  opts: { boss: boolean; bossId?: string; salt?: string },
): T {
  if (opts.boss && opts.bossId) {
    const b = list.find((a) => a.id === opts.bossId);
    if (b) return b;
  }
  const pool =
    !opts.boss && opts.bossId && list.length > 1
      ? list.filter((a) => a.id !== opts.bossId)
      : list;
  return pickStable(id, pool, opts.salt);
}
