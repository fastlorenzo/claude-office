/**
 * Zone-based culling of whole session rooms.
 *
 * `computeVisibility` is pure: from the player's zone, eye position and view
 * direction it decides which rooms can possibly be seen and at which detail
 *   full      normal
 *   impostor  farther than IMPOSTOR_M: no skinned characters, labels or live
 *             screens (actors / monitors fall to their cheapest tier)
 *   hidden    cannot be seen: the whole subtree is disabled
 *
 * Visibility rules (the building is a straight glazed hall with rooms on both
 * sides, a lobby at one end and the control room at the other):
 *   - inside room X : X + the opposite-side rooms seen through X's glass front
 *                     and the hall; same-side neighbours are behind solid walls
 *   - in the hall   : every room whose glass front intersects the view cone
 *   - lobby/control : rooms seen through the hall opening (a portal test)
 *   - outside       : view cone + distance only
 *
 * `VisibilityController` applies the result at ~5 Hz (rooms, screens, actors)
 * with a short grace period before hiding, so quick turns never pop.
 */

import type { TransformNode, Vector3 } from "@/engine/babylon";
import type { Zone } from "@/engine/contracts";
import type { ActorHub } from "@/engine/characters/ActorHub";
import type { RoomDetail, ScreenHub } from "@/engine/screens/ScreenHub";

export type { RoomDetail };

export const IMPOSTOR_M = 30;
export const MAX_VIEW_M = 48;
/** Rooms closer than this are always kept (fast turns next to the glass). */
export const ALWAYS_M = 4;
export const HIDE_GRACE_MS = 700;
export const VISIBILITY_HZ = 5;

export interface VisRoom {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  side: "east" | "west";
}

export interface VisInput {
  eye: { x: number; y: number; z: number };
  /** Yaw: forward = (sin yaw, cos yaw). */
  yaw: number;
  /** Horizontal half field of view (rad), including a safety margin. */
  halfFov: number;
  zone: Zone;
  rooms: readonly VisRoom[];
  hallLength: number;
  hallHalfWidth: number;
}

const frontX = (r: VisRoom): number => (r.side === "east" ? r.minX : r.maxX);

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Distance from a point to the room footprint (0 inside). */
export function footprintDistance(
  p: { x: number; z: number },
  r: VisRoom,
): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
  return Math.hypot(dx, dz);
}

const SAMPLES = 9;

/** Does any point of the room's glass front fall in the cone (and portal)? */
function frontVisible(
  inp: VisInput,
  r: VisRoom,
  portal: ((px: number, pz: number) => boolean) | null,
): boolean {
  const fx = frontX(r);
  for (let i = 0; i < SAMPLES; i++) {
    const pz = r.minZ + ((r.maxZ - r.minZ) * i) / (SAMPLES - 1);
    const dx = fx - inp.eye.x;
    const dz = pz - inp.eye.z;
    if (Math.hypot(dx, dz) > MAX_VIEW_M) continue;
    const ang = wrapAngle(Math.atan2(dx, dz) - inp.yaw);
    if (Math.abs(ang) > inp.halfFov) continue;
    if (portal && !portal(fx, pz)) continue;
    return true;
  }
  return false;
}

export function computeVisibility(inp: VisInput): Map<string, RoomDetail> {
  const out = new Map<string, RoomDetail>();
  const { eye, zone } = inp;
  const own = zone.kind === "room" ? zone.sessionId : null;
  const ownRoom = own ? inp.rooms.find((r) => r.id === own) : undefined;

  for (const r of inp.rooms) {
    const near = footprintDistance(eye, r);
    let visible = false;
    if (r.id === own) {
      visible = true;
    } else if (zone.kind === "room") {
      // Only opposite-side rooms, through our glass front.
      if (ownRoom && r.side !== ownRoom.side) {
        const ox = frontX(ownRoom);
        visible = frontVisible(inp, r, (px, pz) => {
          const t = (ox - eye.x) / (px - eye.x);
          if (!(t > 0)) return false;
          const zAt = eye.z + t * (pz - eye.z);
          return zAt >= ownRoom.minZ - 0.3 && zAt <= ownRoom.maxZ + 0.3;
        });
      }
    } else if (zone.kind === "hall") {
      visible = near < ALWAYS_M || frontVisible(inp, r, null);
    } else if (zone.kind === "lobby" || zone.kind === "control") {
      const planeZ = zone.kind === "lobby" ? 0 : inp.hallLength;
      visible = frontVisible(inp, r, (px, pz) => {
        const t = (planeZ - eye.z) / (pz - eye.z);
        if (!(t > 0 && t < 1)) return false;
        const xAt = eye.x + t * (px - eye.x);
        return Math.abs(xAt) <= inp.hallHalfWidth + 0.3;
      });
    } else {
      visible = near < ALWAYS_M || frontVisible(inp, r, null);
    }
    out.set(
      r.id,
      !visible ? "hidden" : near > IMPOSTOR_M ? "impostor" : "full",
    );
  }
  return out;
}

/** Horizontal half-FOV (with margin) from a vertical fov and aspect ratio. */
export function halfFovFor(
  verticalFov: number,
  aspect: number,
  margin = 0.3,
): number {
  return Math.min(
    Math.PI,
    Math.atan(Math.tan(verticalFov / 2) * Math.max(0.5, aspect)) + margin,
  );
}

export interface VisRoomHandle {
  readonly root: TransformNode;
}

export interface VisibilityDeps {
  screens: ScreenHub;
  actors: ActorHub;
}

export class VisibilityController {
  private last = -Infinity;
  private readonly applied = new Map<string, RoomDetail>();
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly deps: VisibilityDeps) {}

  /** Force a re-evaluation on the next `update` (rooms created / removed). */
  invalidate(): void {
    this.last = -Infinity;
  }

  /** Detail currently applied to a room (debug / tests). */
  detailOf(id: string): RoomDetail {
    return this.applied.get(id) ?? "full";
  }

  update(
    nowMs: number,
    rooms: ReadonlyMap<string, VisRoomHandle>,
    inp: Omit<VisInput, "rooms"> & { rooms: readonly VisRoom[] },
    feedMode: boolean,
  ): void {
    if (nowMs - this.last < 1000 / VISIBILITY_HZ) return;
    this.last = nowMs;
    const result = feedMode
      ? new Map(inp.rooms.map((r) => [r.id, "full" as RoomDetail]))
      : computeVisibility(inp);
    for (const id of [...this.applied.keys()])
      if (!rooms.has(id)) {
        this.applied.delete(id);
        this.lastSeen.delete(id);
        this.deps.screens.forgetRoom(id);
        this.deps.actors.forgetRoom(id);
      }
    for (const [id, handle] of rooms) {
      let want = result.get(id) ?? "full";
      if (want !== "hidden") this.lastSeen.set(id, nowMs);
      else if (nowMs - (this.lastSeen.get(id) ?? -Infinity) < HIDE_GRACE_MS)
        want = this.applied.get(id) ?? "full";
      if (this.applied.get(id) === want) continue;
      this.applied.set(id, want);
      handle.root.setEnabled(want !== "hidden");
      this.deps.screens.setRoomDetail(id, want);
      this.deps.actors.setRoomDetail(id, want);
    }
  }
}

/** Plain-data view of room layouts for `computeVisibility`. */
export function visRoomsOf(
  layouts: readonly {
    sessionId: string;
    slot: { side: "east" | "west" };
    bounds: { min: { x: number; z: number }; max: { x: number; z: number } };
  }[],
): VisRoom[] {
  return layouts.map((l) => ({
    id: l.sessionId,
    minX: l.bounds.min.x,
    maxX: l.bounds.max.x,
    minZ: l.bounds.min.z,
    maxZ: l.bounds.max.z,
    side: l.slot.side,
  }));
}

/** Eye position helper for the controller call-site. */
export type EyeLike = Pick<Vector3, "x" | "y" | "z">;
