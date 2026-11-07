/**
 * Pure building layout: slot allocation, geometry generation, zone lookup.
 * No Babylon / React / DOM. Metres, radians, +Y up, +Z down the hall.
 */

import {
  LAYOUT,
  type BuildingLayout,
  type DeskSlot,
  type RoomLayout,
  type RoomSlot,
  type Vec3,
  type Zone,
} from "../contracts";

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// Desk geometry assumptions (metres).
const DESK_D = 0.7;
const SEAT_BEHIND = 0.55;
const SEAT_Y = 0.5;
const APPROACH_EXTRA = 0.7;
const MONITOR_Y = 1.0;
const MONITOR_INSET = 0.15;

export function slotForIndex(index: number): RoomSlot {
  return {
    index,
    side: index % 2 === 0 ? "east" : "west",
    bay: Math.floor(index / 2),
  };
}

export function allocateSlots(
  prev: ReadonlyMap<string, RoomSlot>,
  sessions: { id: string; createdAt: number }[],
): Map<string, RoomSlot> {
  const sorted = [...sessions].sort(
    (a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const next = new Map<string, RoomSlot>();
  const used = new Set<number>();
  for (const s of sorted) {
    const p = prev.get(s.id);
    if (p && !used.has(p.index)) {
      next.set(s.id, p);
      used.add(p.index);
    }
  }
  let cursor = 0;
  for (const s of sorted) {
    if (next.has(s.id)) continue;
    while (used.has(cursor)) cursor++;
    next.set(s.id, slotForIndex(cursor));
    used.add(cursor);
  }
  return next;
}

interface Frame {
  ox: number;
  oz: number;
  yaw: number;
}

function toWorld(f: Frame, lx: number, y: number, lz: number): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return v3(f.ox + lx * c + lz * s, y, f.oz - lx * s + lz * c);
}

/** Local -> world rotation of a local facing yaw. */
const worldYaw = (f: Frame, localYaw: number): number => f.yaw + localYaw;

function makeDesk(
  f: Frame,
  lx: number,
  lz: number,
  localYaw: number,
  approachOverride?: { lx: number; lz: number },
): DeskSlot {
  // Facing direction in local space (user looks toward it).
  const fx = Math.sin(localYaw);
  const fz = Math.cos(localYaw);
  const seat = toWorld(f, lx - fx * SEAT_BEHIND, SEAT_Y, lz - fz * SEAT_BEHIND);
  const approach = approachOverride
    ? toWorld(f, approachOverride.lx, 0, approachOverride.lz)
    : toWorld(
        f,
        lx - fx * (SEAT_BEHIND + APPROACH_EXTRA),
        0,
        lz - fz * (SEAT_BEHIND + APPROACH_EXTRA),
      );
  const inset = DESK_D / 2 - MONITOR_INSET;
  return {
    position: toWorld(f, lx, 0, lz),
    yaw: worldYaw(f, localYaw),
    seat,
    approach,
    monitor: {
      position: toWorld(f, lx + fx * inset, MONITOR_Y, lz + fz * inset),
      yaw: worldYaw(f, localYaw + Math.PI),
    },
  };
}

function buildRoom(sessionId: string, slot: RoomSlot): RoomLayout {
  const { ROOM_W, ROOM_D, WALL_H, HALL_W, ROOM_GAP, DOOR_W } = LAYOUT;
  const east = slot.side === "east";
  const f: Frame = {
    ox: (east ? 1 : -1) * (HALL_W / 2 + ROOM_D / 2),
    oz: slot.bay * (ROOM_W + ROOM_GAP) + ROOM_W / 2,
    yaw: east ? 0 : Math.PI,
  };
  const hx = ROOM_D / 2; // local half extent across (X)
  const hz = ROOM_W / 2; // local half extent along (Z)
  const W = (lx: number, y: number, lz: number) => toWorld(f, lx, y, lz);

  // Boss desk against the far (+X local) wall, facing the door (-X).
  const bossX = hx - 0.9;
  const bossDesk = makeDesk(f, bossX, 0, -Math.PI / 2, {
    lx: bossX - 0.9,
    lz: 0,
  });

  // 8 agent desks: 2 columns (x) x 4 rows (z), facing +X (boss side).
  const colX = [-0.8, 1.2];
  const rowZ = [1.9, -1.9, 3.4, -3.4];
  const desks: DeskSlot[] = [];
  for (const cx of colX)
    for (const rz of rowZ) desks.push(makeDesk(f, cx, rz, Math.PI / 2));

  const aisle = [W(-hx + 1, 0, 0), W(-0.4, 0, 0), W(0.5, 0, 0)];

  const corners = [W(-hx, 0, -hz), W(-hx, 0, hz), W(hx, 0, -hz), W(hx, 0, hz)];
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minZ = Math.min(...corners.map((c) => c.z));
  const maxZ = Math.max(...corners.map((c) => c.z));

  const loungePos = W(-hx + 0.8, 0, hz - 0.8);
  const loungeYaw = worldYaw(f, Math.atan2(hx - 0.8, -(hz - 0.8)));

  return {
    sessionId,
    slot,
    origin: v3(f.ox, 0, f.oz),
    yaw: f.yaw,
    size: { w: ROOM_W, d: ROOM_D, h: WALL_H },
    door: W(-hx, 0, 0),
    doorOutside: W(-hx - 1, 0, 0),
    doorInside: W(-hx + 1, 0, 0),
    bossDesk,
    desks,
    aisle,
    whiteboard: {
      position: W(0.4, 1.5, -hz + 0.05),
      yaw: worldYaw(f, 0),
      width: 2.4,
      height: 1.2,
    },
    lounge: { position: loungePos, yaw: loungeYaw },
    lamp: W(-hx - 0.1, WALL_H - 0.25, 0),
    nameplate: {
      position: W(-hx - 0.1, 2.2, DOOR_W / 2 + 0.7),
      yaw: worldYaw(f, -Math.PI / 2),
    },
    feedCamera: {
      position: W(-hx + 0.25, 2.8, hz - 0.25),
      target: W(0.5, 0.9, 0),
    },
    bounds: { min: v3(minX, 0, minZ), max: v3(maxX, WALL_H, maxZ) },
  };
}

export function generateLayout(
  slots: ReadonlyMap<string, RoomSlot>,
): BuildingLayout {
  const {
    ROOM_W,
    ROOM_D,
    WALL_H,
    HALL_W,
    LOBBY_D,
    CONTROL_D,
    ROOM_GAP,
    MIN_BAYS,
  } = LAYOUT;
  const pitch = ROOM_W + ROOM_GAP;
  let maxBay = -1;
  for (const s of slots.values()) maxBay = Math.max(maxBay, s.bay);
  const bays = Math.max(MIN_BAYS, maxBay + 1);
  const hallLength = bays * pitch - ROOM_GAP;
  const fullW = HALL_W + 2 * ROOM_D;

  const rooms = [...slots.entries()]
    .sort((a, b) => a[1].index - b[1].index)
    .map(([id, slot]) => buildRoom(id, slot));

  const taken = new Set([...slots.values()].map((s) => s.index));
  const emptySlots: RoomSlot[] = [];
  for (let i = 0; i < bays * 2; i++)
    if (!taken.has(i)) emptySlots.push(slotForIndex(i));

  const controlZ = hallLength;
  return {
    lobby: {
      origin: v3(0, 0, -LOBBY_D / 2),
      size: v3(fullW, WALL_H + 1.3, LOBBY_D),
      spawn: v3(0, 0, -LOBBY_D + 2),
      spawnYaw: 0,
    },
    hall: { origin: v3(0, 0, 0), length: hallLength, width: HALL_W },
    controlRoom: {
      origin: v3(0, 0, controlZ + CONTROL_D / 2),
      size: v3(fullW, WALL_H, CONTROL_D),
      door: v3(0, 0, controlZ),
      screenWall: {
        origin: v3(0, 1.9, controlZ + CONTROL_D - 0.05),
        yaw: Math.PI,
        cols: 4,
        rows: 4,
        cellW: 0.9,
        cellH: 0.52,
      },
      spawn: v3(0, 0, controlZ + 1.5),
    },
    rooms,
    bays,
    emptySlots,
    bounds: {
      min: v3(-fullW / 2, 0, -LOBBY_D),
      max: v3(fullW / 2, WALL_H + 1.3, controlZ + CONTROL_D),
    },
  };
}

export function roomAt(
  layout: BuildingLayout,
  p: { x: number; z: number },
): Zone {
  const halfW = layout.bounds.max.x;
  if (Math.abs(p.x) > halfW) return { kind: "outside" };
  if (p.z < 0)
    return p.z >= layout.bounds.min.z ? { kind: "lobby" } : { kind: "outside" };
  const hallEnd = layout.hall.length;
  if (p.z > hallEnd) {
    return p.z <= layout.controlRoom.origin.z + layout.controlRoom.size.z / 2
      ? { kind: "control" }
      : { kind: "outside" };
  }
  if (Math.abs(p.x) <= layout.hall.width / 2) return { kind: "hall" };
  for (const r of layout.rooms) {
    const b = r.bounds;
    if (p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z) {
      return { kind: "room", sessionId: r.sessionId };
    }
  }
  return { kind: "outside" };
}
