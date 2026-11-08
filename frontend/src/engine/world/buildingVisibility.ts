/**
 * Sightline gating of the static building parts (lobby, entrance hall, factory
 * shell, exterior). Their merged meshes have huge bounds, so frustum culling
 * keeps them all active even from inside a project room that cannot see them.
 *
 * From INSIDE a project room the only openings are the glass front (onto the
 * hall) and the outer glazing; the side walls are solid. A part is kept when a
 * sample of it lies in the view cone AND the ray crosses one of those windows:
 *   lobby    : through the front window and the hall opening (z = 0), or
 *              through the outer glazing
 *   entrance : as the lobby (the stair well opens into it), or outer glazing
 *   factory / exterior : either window in the cone (floor glass strip and the
 *              hall are seen through the front, the park through the back)
 * Every other zone keeps everything enabled (hall, lobby, balcony, factory
 * floor, control room and outside have broad sightlines).
 */
import { FACTORY_EYE_Y, HIDE_GRACE_MS, MAX_VIEW_M } from "./Visibility";
import type { VisInput } from "./Visibility";

export interface BuildingVis {
  lobby: boolean;
  entrance: boolean;
  factory: boolean;
  exterior: boolean;
}

export type BuildingPart = keyof BuildingVis;

export interface BuildingGateInput {
  vis: VisInput;
  /** Lobby footprint (world x / z), the entrance hall lies below it. */
  lobbyRect: { x0: number; x1: number; z0: number; z1: number };
}

const ALL: BuildingVis = {
  lobby: true,
  entrance: true,
  factory: true,
  exterior: true,
};

const N = 7;
const WIN_PAD = 0.3;

function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

export function computeBuildingVisibility(inp: BuildingGateInput): BuildingVis {
  const { vis } = inp;
  const { eye, zone } = vis;
  if (zone.kind !== "room" || eye.y < FACTORY_EYE_Y) return { ...ALL };
  const own = zone.projectId ?? zone.sessionId;
  const room = vis.rooms.find((r) => r.id === own);
  if (!room) return { ...ALL };

  const east = room.side === "east";
  const frontX = east ? room.minX : room.maxX;
  const backX = east ? room.maxX : room.minX;

  const inCone = (px: number, pz: number): boolean => {
    const dx = px - eye.x;
    const dz = pz - eye.z;
    if (Math.hypot(dx, dz) > MAX_VIEW_M) return false;
    return Math.abs(wrap(Math.atan2(dx, dz) - vis.yaw)) <= vis.halfFov;
  };
  /**
   * Ray eye -> (px, pz) crosses the plane x = wx inside the room's z range
   * (the target must lie clearly beyond it: points on the plane, such as the
   * lobby corner flush with the outer wall, are not seen through it).
   */
  const through = (wx: number, px: number, pz: number): boolean => {
    const t = (wx - eye.x) / (px - eye.x);
    if (!(t > 0 && t < 0.99)) return false;
    const zAt = eye.z + t * (pz - eye.z);
    return zAt >= room.minZ - WIN_PAD && zAt <= room.maxZ + WIN_PAD;
  };
  const windowSeen = (wx: number): boolean => {
    for (let i = 0; i < N; i++) {
      const pz = room.minZ + ((room.maxZ - room.minZ) * i) / (N - 1);
      if (inCone(wx, pz)) return true;
    }
    return false;
  };

  const { lobbyRect: lr } = inp;
  const footprintSeen = (via: number): boolean => {
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const px = lr.x0 + ((lr.x1 - lr.x0) * i) / (N - 1);
        const pz = lr.z0 + ((lr.z1 - lr.z0) * j) / (N - 1);
        if (inCone(px, pz) && through(via, px, pz)) return true;
      }
    return false;
  };
  // Through the front window and the hall opening (z = 0, |x| <= half width).
  let viaHall = false;
  for (let i = 0; i < N && !viaHall; i++) {
    const px = -vis.hallHalfWidth + (2 * vis.hallHalfWidth * i) / (N - 1);
    viaHall = eye.z > 0 && inCone(px, 0) && through(frontX, px, 0);
  }
  const viaOuter = footprintSeen(backX);
  const lobby = viaHall || viaOuter;
  const sky = windowSeen(frontX) || windowSeen(backX);
  return {
    lobby,
    entrance: lobby,
    factory: sky,
    exterior: sky || lobby,
  };
}

interface PartHandle {
  setEnabled(v: boolean): void;
}

/** Applies `computeBuildingVisibility` with the rooms' hide grace period. */
export class BuildingGate {
  private readonly applied = new Map<BuildingPart, boolean>();
  private readonly lastSeen = new Map<BuildingPart, number>();

  apply(
    nowMs: number,
    want: BuildingVis,
    parts: Partial<Record<BuildingPart, PartHandle>>,
  ): void {
    for (const k of Object.keys(want) as BuildingPart[]) {
      const h = parts[k];
      if (!h) continue;
      let on = want[k];
      if (on) this.lastSeen.set(k, nowMs);
      else if (nowMs - (this.lastSeen.get(k) ?? -Infinity) < HIDE_GRACE_MS)
        on = this.applied.get(k) ?? true;
      if (this.applied.get(k) === on) continue;
      this.applied.set(k, on);
      h.setEnabled(on);
    }
  }

  /** Re-enable everything (feed mode, LOD bypass). */
  reset(parts: Partial<Record<BuildingPart, PartHandle>>): void {
    for (const [k, on] of this.applied) if (!on) parts[k]?.setEnabled(true);
    this.applied.clear();
  }
}
