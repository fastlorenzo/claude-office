/**
 * Pure building layout: project-room slot allocation, pod allocation, geometry
 * generation and zone lookup. No Babylon / React / DOM. Metres, radians,
 * +Y up, +Z down the hall (lobby at z < 0, control room past the hall end).
 *
 * Rules
 *  - One team room per PROJECT on a bay grid along the hall (LAYOUT.ROOM_W per
 *    bay). A room = 1 entry bay (door, lounge corner, coffee point) + one bay
 *    per pod. Size class by session count: 1–2 → standard (2 pod bays),
 *    3–4 → large (4), 5+ → open-plan wing (sessions rounded up to even, ≥ 6).
 *  - The entry bay is always at the lobby end (low z) of the room; pods follow
 *    in order. A room grows by appending pod bays at its far end, so existing
 *    pods never move; when the bays past it are taken, only that room moves.
 *  - Slots are keyed by project id and kept across updates; new rooms take the
 *    first free run that ends nearest the lobby (balances both sides).
 *  - Inside a room: a circulation strip along the glass (spine = walking
 *    graph); each pod = the session lead's desk at the far end facing a bench
 *    of 8 subagent desks (4 × 2, back to back), a nameplate monitor at the
 *    head of the bench, a mobile whiteboard beside the lead; acoustic
 *    dividers between pod bays.
 */

import {
  LAYOUT,
  type BuildingLayout,
  type DeskSlot,
  type LayoutOptions,
  type Panel,
  type ProjectRoomLayout,
  type ProjectRoomSize,
  type ProjectSlot,
  type RoomLayout,
  type RoomSide,
  type Vec3,
  type Zone,
} from "../contracts";

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// ---------------------------------------------------------------------------
// Desk geometry (metres)
// ---------------------------------------------------------------------------

const DESK_D = 0.72;
const SEAT_BEHIND = 0.55;
const SEAT_Y = 0.5;
const APPROACH_EXTRA = 0.7;
const MONITOR_Y = 1.0;
const MONITOR_INSET = 0.15;

/**
 * Pod geometry in the pod frame (origin on the spine at the pod centre,
 * +z into the room, x along the hall). The glass is at z = -CORRIDOR_W / 2.
 */
export const POD = {
  /** Bench desk centres along z, index 0 nearest the lead. */
  benchZ: [5.9, 4.5, 3.1, 1.7] as const,
  /** Half gap between the back-to-back benches (desk centre |x|). */
  benchX: 0.38,
  /** Bench extent along z (desk ends). */
  benchZ0: 1.0,
  benchZ1: 6.6,
  bossZ: 7.65,
  /** Lead approach (walks the +x walkway, then behind the desk). */
  bossApproachX: 1.45,
  signZ: 0.9,
  signY: 1.3,
  signW: 0.8,
  signH: 0.5,
  boardX: -1.5,
  boardZ: 8.35,
  boardY: 1.45,
  boardW: 1.3,
  boardH: 0.92,
  /** Divider panel extent along z and height. */
  dividerZ0: 1.0,
  dividerZ1: 6.7,
  dividerH: 1.15,
} as const;

/** Entry bay (bay-local: x = depth from the glass, z along the bay). */
export const ENTRY = {
  doorZ: 0.4, // door centre
  pierZ0: -2.4,
  pierZ1: -0.3,
  infoY: 1.55,
  infoW: 1.2,
  infoH: 0.74,
  ledW: 3.0,
  ledH: 0.22,
  /** Balcony door centre (bay-local z): beside the lounge, not behind it. */
  balconyDoorZ: 1.4,
} as const;

/** Balcony depth outside the outer glazing (factory overlook). */
export const BALCONY_D = 1.2;
/** Structural glass floor strip inside the outer glazing. */
export const GLASS_FLOOR_W = 1.0;

/** Bulkhead (solid transom) front face offset from the glass line, hall side. */
export const BULKHEAD_D = 0.18;

// ---------------------------------------------------------------------------
// Size classes
// ---------------------------------------------------------------------------

export function roomSizeFor(sessions: number): ProjectRoomSize {
  return sessions <= 2 ? "standard" : sessions <= 4 ? "large" : "wing";
}

/** Pod bays a room needs for `sessions` sessions. */
export function podCapacityFor(sessions: number): number {
  const n = Math.max(1, sessions);
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  return Math.max(6, n + (n % 2));
}

/** Bays a room needs (entry bay + pod bays). */
export function roomSpanFor(sessions: number): number {
  return podCapacityFor(sessions) + 1;
}

/** Session-equivalents the `wing` size holds (demand cap). */
export const WING_DEMAND = 6;

/** Span for a project: its sessions, raised by `spanFor` demand up to `wing`. */
export function demandSpan(
  id: string,
  sessions: number,
  opts: LayoutOptions = {},
): number {
  const raw = opts.spanFor?.(id, sessions);
  const demand =
    raw != null && Number.isFinite(raw) ? Math.min(WING_DEMAND, raw) : 0;
  return roomSpanFor(Math.max(sessions, demand));
}

// ---------------------------------------------------------------------------
// Slot allocation (keyed by project id)
// ---------------------------------------------------------------------------

export interface SlotRequest {
  id: string;
  createdAt: number;
  /** Live sessions in the project (default 1). */
  sessions?: number;
}

export function layoutSides(opts: LayoutOptions = {}): RoomSide[] {
  if (opts.hallOverlook === "east") return ["west"];
  if (opts.hallOverlook === "west") return ["east"];
  const s = opts.sides?.length ? [...opts.sides] : ["east", "west"];
  return (["east", "west"] as RoomSide[]).filter((x) => s.includes(x));
}

class Occupancy {
  private readonly used = new Map<RoomSide, Set<number>>();
  constructor(sides: readonly RoomSide[]) {
    for (const s of sides) this.used.set(s, new Set());
  }
  free(side: RoomSide, bay: number, span: number): boolean {
    const u = this.used.get(side);
    if (!u || bay < 0) return false;
    for (let b = bay; b < bay + span; b++) if (u.has(b)) return false;
    return true;
  }
  take(side: RoomSide, bay: number, span: number): void {
    const u = this.used.get(side)!;
    for (let b = bay; b < bay + span; b++) u.add(b);
  }
  release(side: RoomSide, bay: number, span: number): void {
    const u = this.used.get(side)!;
    for (let b = bay; b < bay + span; b++) u.delete(b);
  }
  end(side: RoomSide): number {
    const u = this.used.get(side);
    return u && u.size ? Math.max(...u) + 1 : 0;
  }
  firstFit(side: RoomSide, span: number): number {
    let b = 0;
    while (!this.free(side, b, span)) b++;
    return b;
  }
}

/**
 * Stable project-room slots. Existing rooms keep their side + first bay;
 * shrinking frees the tail; growing extends in place when the bays past the
 * room are free, else only that room relocates. New rooms (and relocations)
 * take the free run ending nearest the lobby, east first on ties.
 */
export function allocateSlots(
  prev: ReadonlyMap<string, ProjectSlot>,
  projects: readonly SlotRequest[],
  opts: LayoutOptions = {},
): Map<string, ProjectSlot> {
  const sides = layoutSides(opts);
  const sorted = [...projects].sort(
    (a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const need = new Map(
    sorted.map((p) => [p.id, demandSpan(p.id, p.sessions ?? 1, opts)]),
  );
  const occ = new Occupancy(sides);
  const next = new Map<string, ProjectSlot>();
  const usedIdx = new Set<number>();
  const growing: { id: string; slot: ProjectSlot }[] = [];

  // Pass 1: keep every previous room that still fits in its current run.
  for (const p of sorted) {
    const s = prev.get(p.id);
    if (!s || !sides.includes(s.side) || usedIdx.has(s.index)) continue;
    const span = need.get(p.id)!;
    usedIdx.add(s.index);
    if (span <= s.span && occ.free(s.side, s.bay, span)) {
      occ.take(s.side, s.bay, span);
      next.set(p.id, { ...s, span });
    } else if (occ.free(s.side, s.bay, s.span)) {
      occ.take(s.side, s.bay, s.span);
      growing.push({ id: p.id, slot: s });
    } else usedIdx.delete(s.index);
  }
  // Pass 2: grow in place when the bays past the room are free.
  const relocate: string[] = [];
  for (const g of growing) {
    const span = need.get(g.id)!;
    const extra = span - g.slot.span;
    if (occ.free(g.slot.side, g.slot.bay + g.slot.span, extra)) {
      occ.take(g.slot.side, g.slot.bay + g.slot.span, extra);
      next.set(g.id, { ...g.slot, span });
    } else {
      occ.release(g.slot.side, g.slot.bay, g.slot.span);
      usedIdx.delete(g.slot.index); // re-claimed by the relocated room below
      relocate.push(g.id);
    }
  }
  // Pass 3: new rooms + relocations, first fit nearest the lobby.
  let cursor = 0;
  const nextIndex = (keep?: number) => {
    if (keep !== undefined && !usedIdx.has(keep)) {
      usedIdx.add(keep);
      return keep;
    }
    while (usedIdx.has(cursor)) cursor++;
    usedIdx.add(cursor);
    return cursor;
  };
  for (const p of sorted) {
    if (next.has(p.id)) continue;
    const span = need.get(p.id)!;
    let best: { side: RoomSide; bay: number } | null = null;
    for (const side of sides) {
      const bay = occ.firstFit(side, span);
      if (
        !best ||
        bay + span < best.bay + span ||
        (bay === best.bay && occ.end(side) < occ.end(best.side))
      )
        best = { side, bay };
    }
    if (!best) continue;
    occ.take(best.side, best.bay, span);
    const keep = relocate.includes(p.id) ? prev.get(p.id)?.index : undefined;
    next.set(p.id, { index: nextIndex(keep), ...best, span });
  }
  return next;
}

/**
 * Stable pod indices (sessionId → pod bay index inside its project room).
 * A session keeps its pod while it still fits the room's capacity; newcomers
 * take the lowest free pod.
 */
export function allocatePods(
  prev: ReadonlyMap<string, number>,
  groups: readonly { id: string; sessionIds: readonly string[] }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) {
    const cap = podCapacityFor(g.sessionIds.length);
    const used = new Set<number>();
    for (const sid of g.sessionIds) {
      const p = prev.get(sid);
      if (p !== undefined && p < cap && !used.has(p)) {
        out.set(sid, p);
        used.add(p);
      }
    }
    let c = 0;
    for (const sid of g.sessionIds) {
      if (out.has(sid)) continue;
      while (used.has(c)) c++;
      out.set(sid, c);
      used.add(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

interface Frame {
  ox: number;
  oz: number;
  yaw: number;
}

export function toWorld(f: Frame, lx: number, y: number, lz: number): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return v3(f.ox + lx * c + lz * s, y, f.oz - lx * s + lz * c);
}

function makeDesk(
  f: Frame,
  lx: number,
  lz: number,
  localYaw: number,
  approachOverride?: { lx: number; lz: number },
): DeskSlot {
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
    yaw: f.yaw + localYaw,
    seat,
    approach,
    monitor: {
      position: toWorld(f, lx + fx * inset, MONITOR_Y, lz + fz * inset),
      yaw: f.yaw + localYaw + Math.PI,
    },
  };
}

const boundsOf = (pts: Vec3[], h: number) => ({
  min: v3(
    Math.min(...pts.map((p) => p.x)),
    0,
    Math.min(...pts.map((p) => p.z)),
  ),
  max: v3(
    Math.max(...pts.map((p) => p.x)),
    h,
    Math.max(...pts.map((p) => p.z)),
  ),
});

/** Room yaw (local -X faces the hall) and the outward sign of a side. */
const sideSign = (side: RoomSide) => (side === "east" ? 1 : -1);
const sideYaw = (side: RoomSide) => (side === "east" ? 0 : Math.PI);

/** Bay frame: origin on the glass line at the bay centre, local x into the room. */
export function bayFrame(side: RoomSide, bay: number): Frame {
  return {
    ox: sideSign(side) * (LAYOUT.HALL_W / 2),
    oz: (bay + 0.5) * LAYOUT.ROOM_W,
    yaw: sideYaw(side),
  };
}

/** Pod frame for the pod bay at absolute `bay` (see POD). */
export function podFrame(side: RoomSide, bay: number): Frame {
  return {
    ox: sideSign(side) * (LAYOUT.HALL_W / 2 + LAYOUT.CORRIDOR_W / 2),
    oz: (bay + 0.5) * LAYOUT.ROOM_W,
    yaw: sideYaw(side) + Math.PI / 2,
  };
}

/** Footprint of `span` bays from `bay` on a side (glass line → far wall). */
function runBounds(side: RoomSide, bay: number, span: number, h: number) {
  const sx = sideSign(side);
  const x0 = sx * (LAYOUT.HALL_W / 2);
  const x1 = sx * (LAYOUT.HALL_W / 2 + LAYOUT.ROOM_D);
  return boundsOf(
    [v3(x0, 0, bay * LAYOUT.ROOM_W), v3(x1, 0, (bay + span) * LAYOUT.ROOM_W)],
    h,
  );
}

function buildPod(
  sessionId: string,
  projectId: string,
  podIndex: number,
  slot: ProjectSlot,
  door: { door: Vec3; doorOutside: Vec3; doorInside: Vec3 },
): RoomLayout {
  const bay = slot.bay + 1 + podIndex;
  const f = podFrame(slot.side, bay);
  const desks: DeskSlot[] = [];
  for (let i = 0; i < 8; i++) {
    const k = i >> 1;
    const side = i & 1 ? -1 : 1;
    // Seated user faces the bench centre line (−side along x).
    desks.push(
      makeDesk(
        f,
        side * POD.benchX,
        POD.benchZ[k],
        side > 0 ? -Math.PI / 2 : Math.PI / 2,
      ),
    );
  }
  const bossDesk = makeDesk(f, 0, POD.bossZ, Math.PI, {
    lx: POD.bossApproachX,
    lz: POD.bossZ + SEAT_BEHIND,
  });
  const panel = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
  ): Panel => ({
    position: toWorld(f, x, y, z),
    yaw: f.yaw + Math.PI, // faces the spine (−z)
    width: w,
    height: h,
  });
  const H = LAYOUT.WALL_H;
  return {
    sessionId,
    projectId,
    podIndex,
    slot: {
      index: bay * 2 + (slot.side === "west" ? 1 : 0),
      side: slot.side,
      bay,
    },
    origin: v3(f.ox, 0, f.oz),
    yaw: f.yaw,
    size: { w: LAYOUT.ROOM_W, d: LAYOUT.ROOM_D, h: H },
    ...door,
    bossDesk,
    desks,
    whiteboard: panel(
      POD.boardX,
      POD.boardY,
      POD.boardZ,
      POD.boardW,
      POD.boardH,
    ),
    sign: panel(0, POD.signY, POD.signZ, POD.signW, POD.signH),
    bounds: runBounds(slot.side, bay, 1, H),
  };
}

function buildProject(
  projectId: string,
  name: string,
  slot: ProjectSlot,
  sessionPods: readonly { sessionId: string; pod: number }[],
  opts: LayoutOptions,
): ProjectRoomLayout {
  const { ROOM_W, ROOM_D, WALL_H: H, HALL_W, CORRIDOR_W, DOOR_W } = LAYOUT;
  const sx = sideSign(slot.side);
  const yaw = sideYaw(slot.side);
  const capacity = slot.span - 1;
  const ef = bayFrame(slot.side, slot.bay);
  const E = (lx: number, y: number, lz: number) => toWorld(ef, lx, y, lz);
  const door = {
    door: E(0, 0, ENTRY.doorZ),
    doorOutside: E(-1, 0, ENTRY.doorZ),
    doorInside: E(CORRIDOR_W / 2, 0, ENTRY.doorZ),
  };
  const occupied = new Map(sessionPods.map((s) => [s.pod, s.sessionId]));
  const podBays = Array.from({ length: capacity }, (_, k) => {
    const pf = podFrame(slot.side, slot.bay + 1 + k);
    return {
      center: v3(pf.ox, 0, pf.oz),
      yaw: pf.yaw,
      occupied: occupied.has(k),
    };
  });
  const pods = sessionPods
    .filter((s) => s.pod < capacity)
    .sort((a, b) => a.pod - b.pod)
    .map((s) => buildPod(s.sessionId, projectId, s.pod, slot, door));
  // Dividers on the boundaries before each pod bay (incl. entry | pod 0).
  const dividers = Array.from({ length: capacity }, (_, k) => {
    const z = (slot.bay + 1 + k) * ROOM_W;
    return { position: v3(sx * (HALL_W / 2), 0, z), yaw };
  });
  const z0 = slot.bay * ROOM_W;
  const z1 = (slot.bay + slot.span) * ROOM_W;
  const bounds = runBounds(slot.side, slot.bay, slot.span, H);
  const midZ = (z0 + z1) / 2;
  const inwardYaw = yaw - Math.PI / 2; // faces the hall (−X local)
  const roomOverlook = opts.roomOverlook ?? true;
  const xFront = sx * (HALL_W / 2);
  const xOuter = sx * (HALL_W / 2 + ROOM_D);
  const outwardYaw = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
  const columns: Vec3[] = [];
  for (let b = slot.bay; b <= slot.bay + slot.span; b++)
    for (const x of [xFront, xOuter]) columns.push(v3(x, 0, b * ROOM_W));
  return {
    projectId,
    name,
    slot,
    sizeClass: capacity <= 2 ? "standard" : capacity <= 4 ? "large" : "wing",
    capacity,
    origin: v3(sx * (HALL_W / 2 + ROOM_D / 2), 0, midZ),
    yaw,
    size: { w: z1 - z0, d: ROOM_D, h: H },
    ...door,
    entry: { center: v3(ef.ox, 0, ef.oz), yaw },
    podBays,
    pods,
    dividers,
    led: {
      position: E(
        -BULKHEAD_D / 2 - 0.008,
        ENTRY_LED_Y,
        (ENTRY.pierZ0 + ENTRY.doorZ + DOOR_W / 2) / 2,
      ),
      yaw: yaw + Math.PI / 2,
      width: ENTRY.ledW,
      height: ENTRY.ledH,
    },
    infoScreen: {
      position: E(-0.11, ENTRY.infoY, (ENTRY.pierZ0 + ENTRY.pierZ1) / 2),
      yaw: inwardYaw,
      width: ENTRY.infoW,
      height: ENTRY.infoH,
    },
    overlook: roomOverlook
      ? {
          origin: v3(sx * (HALL_W / 2 + ROOM_D), 0, z0),
          dir: v3(0, 0, 1),
          length: z1 - z0,
          height: H,
        }
      : null,
    footprint: { x0: xFront, x1: xOuter, z0, z1 },
    outer: { x: xOuter, yaw: outwardYaw, z0, z1 },
    balcony: {
      x0: xOuter,
      x1: xOuter + sx * BALCONY_D,
      z0,
      z1,
      door: v3(xOuter, 0, E(0, 0, ENTRY.balconyDoorZ).z),
      doorYaw: outwardYaw,
    },
    glassFloor: { x0: xOuter - sx * GLASS_FLOOR_W, x1: xOuter, z0, z1 },
    columns,
    entryBay: slot.bay,
    span: slot.span,
    feedCamera: {
      position: v3(sx * (HALL_W / 2 + 0.3), 2.85, z0 + 0.3),
      target: v3(
        sx * (HALL_W / 2 + ROOM_D * 0.55),
        0.9,
        Math.min(z1 - 2, z0 + ROOM_W * 2.2),
      ),
    },
    bounds,
  };
}

/** LED line centre height on the solid bulkhead over the entry. */
export const ENTRY_LED_Y = 2.82;

export interface LayoutGroup {
  id: string;
  name?: string;
  sessionIds: readonly string[];
}

/**
 * Geometry for the allocated slots. `groups` lists each project's sessions
 * (defaults: every slot key is a project with one session of the same id)
 * and `pods` their pod indices (defaults: member order).
 */
export function generateLayout(
  slots: ReadonlyMap<string, ProjectSlot>,
  groups?: readonly LayoutGroup[],
  pods?: ReadonlyMap<string, number>,
  opts: LayoutOptions = {},
): BuildingLayout {
  const {
    ROOM_W,
    ROOM_D,
    WALL_H,
    HALL_W,
    LOBBY_D,
    CONTROL_D,
    CONTROL_MIN_W,
    CONTROL_H,
    MIN_BAYS,
  } = LAYOUT;
  const sides = layoutSides(opts);
  const byId = new Map((groups ?? []).map((g) => [g.id, g]));
  let maxBay = 0;
  for (const s of slots.values()) maxBay = Math.max(maxBay, s.bay + s.span);
  const bays = Math.max(MIN_BAYS, maxBay);
  const hallLength = bays * ROOM_W;
  const fullW = HALL_W + 2 * ROOM_D;

  const projects = [...slots.entries()]
    .sort((a, b) => a[1].index - b[1].index)
    .map(([id, slot]) => {
      const g = byId.get(id) ?? { id, name: id, sessionIds: [id] };
      const sp = g.sessionIds.map((sid, i) => ({
        sessionId: sid,
        pod: pods?.get(sid) ?? i,
      }));
      return buildProject(id, g.name ?? id, slot, sp, opts);
    });
  const rooms = projects.flatMap((p) => p.pods);

  const emptySlots: ProjectSlot[] = [];
  for (const side of sides) {
    const used = new Set<number>();
    for (const s of slots.values())
      if (s.side === side)
        for (let b = s.bay; b < s.bay + s.span; b++) used.add(b);
    let run = -1;
    for (let b = 0; b <= bays; b++) {
      const free = b < bays && !used.has(b);
      if (free && run < 0) run = b;
      if (!free && run >= 0) {
        emptySlots.push({ index: -1, side, bay: run, span: b - run });
        run = -1;
      }
    }
  }

  const controlZ = hallLength;
  const controlW = Math.max(CONTROL_MIN_W, fullW);
  const halfW = Math.max(fullW, controlW) / 2;
  return {
    lobby: {
      origin: v3(0, 0, -LOBBY_D / 2),
      size: v3(fullW, WALL_H + 1.3, LOBBY_D),
      spawn: v3(0, 0, -LOBBY_D + 2),
      spawnYaw: 0,
    },
    hall: {
      origin: v3(0, 0, 0),
      length: hallLength,
      width: HALL_W,
      overlook: opts.hallOverlook ?? null,
    },
    controlRoom: {
      origin: v3(0, 0, controlZ + CONTROL_D / 2),
      size: v3(controlW, CONTROL_H, CONTROL_D),
      door: v3(0, 0, controlZ),
      doorWidth: 1.8,
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
    projects,
    rooms,
    bays,
    sides,
    emptySlots,
    bounds: {
      min: v3(-halfW, 0, -LOBBY_D),
      max: v3(halfW, WALL_H + 1.3, controlZ + CONTROL_D),
    },
  };
}

const inside = (b: { min: Vec3; max: Vec3 }, p: { x: number; z: number }) =>
  p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;

export function roomAt(
  layout: BuildingLayout,
  p: { x: number; z: number },
): Zone {
  const halfW = layout.bounds.max.x;
  if (Math.abs(p.x) > halfW) return { kind: "outside" };
  if (p.z < 0) {
    return p.z >= layout.bounds.min.z &&
      Math.abs(p.x) <= layout.lobby.size.x / 2
      ? { kind: "lobby" }
      : { kind: "outside" };
  }
  const hallEnd = layout.hall.length;
  if (p.z > hallEnd) {
    const c = layout.controlRoom;
    return p.z <= c.origin.z + c.size.z / 2 && Math.abs(p.x) <= c.size.x / 2
      ? { kind: "control" }
      : { kind: "outside" };
  }
  if (Math.abs(p.x) <= layout.hall.width / 2) return { kind: "hall" };
  for (const r of layout.projects) {
    if (!inside(r.bounds, p)) continue;
    const pod = r.pods.find((d) => inside(d.bounds, p)) ?? r.pods[0];
    if (!pod) return { kind: "outside" };
    return { kind: "room", sessionId: pod.sessionId, projectId: r.projectId };
  }
  return { kind: "outside" };
}

/** The project room a session's pod is in. */
export function projectOfSession(
  layout: BuildingLayout,
  sessionId: string,
): ProjectRoomLayout | undefined {
  return layout.projects.find((p) =>
    p.pods.some((d) => d.sessionId === sessionId),
  );
}
