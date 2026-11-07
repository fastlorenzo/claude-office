/**
 * Pure helpers for the workpiece pool (no Babylon): polyline sampling, size ->
 * variant mapping, queue slotting, matrix / colour packing and change
 * detection. Everything the GPU pool needs to decide WITHOUT touching a buffer.
 */
import type { CheckState, PrLabel } from "@/engine/contracts";
import type { SizeClass } from "@/engine/logic/factoryModel";
import { stateColor } from "@/engine/logic/factoryModel";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Placed extends Vec3 {
  /** Rotation about +Y so the piece's local +X points along travel. */
  yaw: number;
}

/** Walks a lane: t in 0..1 -> position + heading. */
export type PathResolver = (t: number) => Placed;

/** Belt surface above the lane path's floor level (metres). */
export const BELT_HEIGHT = 0.85;
/** Vertical pitch of stacked pallets in the queue rack. */
export const QUEUE_STACK_STEP = 0.9;

export type PieceSize = SizeClass | "XS";

export interface PieceInstance {
  id: string;
  /** Polyline (floor level; belt height is added) or a resolver. */
  lanePath?: Vec3[] | PathResolver;
  /** 0..1 along the path. */
  t: number;
  /** Queue slot index; when set the piece is staged instead of on a lane. */
  queueSlot?: number;
  sizeClass: PieceSize;
  state: CheckState;
  draft?: boolean;
  bot?: boolean;
  labels?: PrLabel[];
  /** Plate text "#412 · title". */
  tag?: string;
}

export interface ResolvedPiece {
  id: string;
  placed: Placed;
  variant: number;
  color: string;
  draft: boolean;
  bot: boolean;
  tag: string;
  accent: string;
  /** Texture-relevant text key (tag + bot + accent). */
  tagKey: string;
}

// ---------------------------------------------------------------------------
// Geometry sampling
// ---------------------------------------------------------------------------

/** Position + heading at t (0..1, clamped) along a polyline, by arc length. */
export function samplePolyline(path: readonly Vec3[], t: number): Placed {
  if (path.length === 0) return { x: 0, y: 0, z: 0, yaw: 0 };
  if (path.length === 1) return { ...path[0], yaw: 0 };
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(
      path[i].x - path[i - 1].x,
      path[i].y - path[i - 1].y,
      path[i].z - path[i - 1].z,
    );
    lens.push(l);
    total += l;
  }
  let target = u * total;
  let seg = 0;
  while (seg < lens.length - 1 && target > lens[seg]) {
    target -= lens[seg];
    seg++;
  }
  const a = path[seg];
  const b = path[seg + 1];
  const k = lens[seg] > 1e-9 ? Math.min(1, target / lens[seg]) : 0;
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-9) {
    // Degenerate (vertical or zero) segment: keep the previous heading.
    for (let j = seg; j >= 0; j--) {
      const ddx = path[j + 1].x - path[j].x;
      const ddz = path[j + 1].z - path[j].z;
      if (Math.hypot(ddx, ddz) > 1e-9) {
        dx = ddx;
        dz = ddz;
        break;
      }
    }
  }
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    yaw: Math.hypot(dx, dz) < 1e-9 ? 0 : Math.atan2(-dz, dx),
  };
}

/** Size class -> body variant: 0 crate, 1 machined block, 2 assembly, 3 large assembly. */
export function variantForSize(size: PieceSize): number {
  switch (size) {
    case "XS":
      return 0;
    case "S":
      return 1;
    case "M":
      return 2;
    default:
      return 3;
  }
}

/**
 * Slot i of a staging rack given as a point list. Slots beyond the list wrap
 * around and stack upward (one more pallet layer per lap).
 */
export function queueSlot(
  points: readonly Vec3[],
  i: number,
  stackStep = QUEUE_STACK_STEP,
): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  const n = points.length;
  const idx = Math.max(0, Math.floor(i));
  const p = points[idx % n];
  return { x: p.x, y: p.y + Math.floor(idx / n) * stackStep, z: p.z };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.6, 0.6, 0.6];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const STEEL: [number, number, number] = [0.62, 0.66, 0.72];

/** Satin body tint: the state colour pulled toward steel so metal still reads. */
export function bodyTint(hex: string): [number, number, number] {
  const c = hexToRgb(hex);
  return [
    STEEL[0] + (c[0] - STEEL[0]) * 0.42,
    STEEL[1] + (c[1] - STEEL[1]) * 0.42,
    STEEL[2] + (c[2] - STEEL[2]) * 0.42,
  ];
}

// ---------------------------------------------------------------------------
// Resolve + pack
// ---------------------------------------------------------------------------

export function splitTag(tag: string): { num: string; title: string } {
  const i = tag.indexOf(" · ");
  if (i < 0) return { num: tag, title: "" };
  return { num: tag.slice(0, i), title: tag.slice(i + 3) };
}

export function resolvePiece(
  p: PieceInstance,
  queue: readonly Vec3[],
  beltHeight = BELT_HEIGHT,
): ResolvedPiece {
  let placed: Placed;
  if (p.queueSlot !== undefined) {
    const q = queueSlot(queue, p.queueSlot);
    placed = { ...q, yaw: 0 };
  } else if (typeof p.lanePath === "function") {
    const r = p.lanePath(p.t);
    placed = { ...r, y: r.y + beltHeight };
  } else {
    const r = samplePolyline(p.lanePath ?? [], p.t);
    placed = { ...r, y: r.y + beltHeight };
  }
  const accent = p.labels?.find((l) => l.color)?.color ?? "#64748b";
  const tag = p.tag ?? "";
  const bot = !!p.bot;
  return {
    id: p.id,
    placed,
    variant: variantForSize(p.sizeClass),
    color: stateColor(p.state),
    draft: !!p.draft,
    bot,
    tag,
    accent,
    tagKey: `${tag}|${bot ? 1 : 0}|${accent}|${stateColor(p.state)}`,
  };
}

const mm = (v: number) => Math.round(v * 1000);

/** Everything that affects instance buffers (text lives in tagKey). */
export function pieceSignature(r: ResolvedPiece): string {
  const { x, y, z, yaw } = r.placed;
  return `${mm(x)},${mm(y)},${mm(z)},${Math.round(yaw * 1000)}|${r.variant}|${r.color}|${r.draft ? 1 : 0}|${r.bot ? 1 : 0}|${r.tagKey}`;
}

/** True when the id set or any signature differs (=> buffers must be rewritten). */
export function signaturesChanged(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  if (prev.size !== next.size) return true;
  for (const [id, s] of next) if (prev.get(id) !== s) return true;
  return false;
}

/** Row-major (Babylon) matrix: uniform-ish scale, yaw about Y, translation. */
export function writeMatrix(
  out: Float32Array,
  at: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx = 1,
  sy = 1,
  sz = 1,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[at] = c * sx;
  out[at + 1] = 0;
  out[at + 2] = -s * sx;
  out[at + 3] = 0;
  out[at + 4] = 0;
  out[at + 5] = sy;
  out[at + 6] = 0;
  out[at + 7] = 0;
  out[at + 8] = s * sz;
  out[at + 9] = 0;
  out[at + 10] = c * sz;
  out[at + 11] = 0;
  out[at + 12] = x;
  out[at + 13] = y;
  out[at + 14] = z;
  out[at + 15] = 1;
}

/** Body envelope (footprint x, height, depth) per variant, metres. Pallet deck top = 0.14. */
export const BODY_DIMS: readonly { w: number; h: number; d: number }[] = [
  { w: 0.54, h: 0.4, d: 0.44 },
  { w: 0.62, h: 0.34, d: 0.46 },
  { w: 0.64, h: 0.5, d: 0.48 },
  { w: 0.72, h: 0.66, d: 0.52 },
];
export const PALLET_TOP = 0.14;

export interface Packed {
  count: number;
  pallet: Float32Array;
  /** Per body variant: matrices + RGBA colours. */
  bodies: { count: number; m: Float32Array; c: Float32Array }[];
  band: { count: number; m: Float32Array; c: Float32Array };
  ghost: { count: number; m: Float32Array; c: Float32Array };
}

function grow(a: Float32Array, n: number): Float32Array {
  if (a.length >= n) return a;
  return new Float32Array(Math.max(n, a.length * 2, 64));
}

/** Packs resolved pieces into per-part buffers (reuses `into`'s arrays when large enough). */
export function packPieces(
  pieces: readonly ResolvedPiece[],
  into?: Packed,
): Packed {
  const n = pieces.length;
  const out: Packed = into ?? {
    count: 0,
    pallet: new Float32Array(0),
    bodies: [0, 1, 2, 3].map(() => ({
      count: 0,
      m: new Float32Array(0),
      c: new Float32Array(0),
    })),
    band: { count: 0, m: new Float32Array(0), c: new Float32Array(0) },
    ghost: { count: 0, m: new Float32Array(0), c: new Float32Array(0) },
  };
  out.count = n;
  out.pallet = grow(out.pallet, n * 16);
  for (const b of out.bodies) {
    b.count = 0;
    b.m = grow(b.m, n * 16);
    b.c = grow(b.c, n * 4);
  }
  out.band.count = 0;
  out.band.m = grow(out.band.m, n * 16);
  out.band.c = grow(out.band.c, n * 4);
  out.ghost.count = 0;
  out.ghost.m = grow(out.ghost.m, n * 16);
  out.ghost.c = grow(out.ghost.c, n * 4);
  for (let i = 0; i < n; i++) {
    const r = pieces[i];
    const { x, y, z, yaw } = r.placed;
    writeMatrix(out.pallet, i * 16, x, y, z, yaw);
    const rgb = hexToRgb(r.color);
    // band (status ring light)
    const bi = out.band.count++;
    writeMatrix(out.band.m, bi * 16, x, y, z, yaw);
    out.band.c.set([rgb[0], rgb[1], rgb[2], 1], bi * 4);
    if (r.draft) {
      const d = BODY_DIMS[r.variant];
      const gi = out.ghost.count++;
      writeMatrix(
        out.ghost.m,
        gi * 16,
        x,
        y + PALLET_TOP + d.h / 2,
        z,
        yaw,
        d.w,
        d.h,
        d.d,
      );
      out.ghost.c.set([rgb[0], rgb[1], rgb[2], 1], gi * 4);
    } else {
      const b = out.bodies[r.variant];
      const k = b.count++;
      writeMatrix(b.m, k * 16, x, y + PALLET_TOP, z, yaw);
      const t = bodyTint(r.color);
      b.c.set([t[0], t[1], t[2], 1], k * 4);
    }
  }
  out.band.count = n;
  return out;
}

/** Tag LOD from distance with hysteresis: 0 hidden, 1 number only, 2 number + title. */
export function tagLod(dist: number, prev: number): 0 | 1 | 2 {
  const h = 0.5;
  const near = prev === 2 ? 5 + h : 5 - h;
  const far = prev >= 1 ? 10 + h : 10 - h;
  if (dist <= near) return 2;
  if (dist <= far) return 1;
  return 0;
}
