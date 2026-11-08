/**
 * Pure placement vocabulary of the set dressing (WS6): a `Piece` is one prop
 * instance in world metres; colliders derive from the prop's bounding box
 * (`DRESSING_DIMS`). Everything here is Node-testable (no Babylon objects).
 */
import { DRESSING_DIMS } from "@/engine/assets/proceduralProps";

export type DressingRole = keyof typeof DRESSING_DIMS;

export interface Piece {
  role: DressingRole;
  /** Bounding-box centre on the floor plan, base height. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Uniform or per-axis (x, y, z) scale on top of the model size. */
  scale?: number | readonly [number, number, number];
}

/** Props big enough to walk into (the rest hang, lie flat or are soft). */
export const SOLID_ROLES: ReadonlySet<DressingRole> = new Set<DressingRole>([
  "fireExtinguisher",
  "pallet",
  "palletJack",
  "toolTrolley",
  "bollard",
  "binIndustrial",
  "visitorChair",
]);

export interface Box {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

const scaleOf = (p: Piece): [number, number, number] =>
  p.scale === undefined
    ? [1, 1, 1]
    : typeof p.scale === "number"
      ? [p.scale, p.scale, p.scale]
      : [p.scale[0], p.scale[1], p.scale[2]];

/** Collision / bounding box of a piece (centre, full size, yaw). */
export function pieceBox(p: Piece): Box {
  const d = DRESSING_DIMS[p.role];
  const [kx, ky, kz] = scaleOf(p);
  return {
    x: p.x,
    y: p.y + (d.h * ky) / 2,
    z: p.z,
    sx: d.w * kx,
    sy: d.h * ky,
    sz: d.d * kz,
    yaw: p.yaw,
  };
}

/** Collider boxes of the solid pieces. */
export function solidBoxes(pieces: readonly Piece[]): Box[] {
  return pieces.filter((p) => SOLID_ROLES.has(p.role)).map(pieceBox);
}

/** World-plan corners of a (yawed) box footprint. */
export function corners(b: Box): [number, number][] {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const out: [number, number][] = [];
  for (const [ax, az] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const lx = (ax * b.sx) / 2;
    const lz = (az * b.sz) / 2;
    // Local +x -> (cos, -sin), local +z -> (sin, cos) (Babylon yaw).
    out.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]);
  }
  return out;
}

/** Axis-aligned plan extent of a piece (with a margin). */
export function planExtent(
  p: Piece,
  margin = 0,
): { x0: number; x1: number; z0: number; z1: number } {
  const cs = corners(pieceBox(p));
  return {
    x0: Math.min(...cs.map((q) => q[0])) - margin,
    x1: Math.max(...cs.map((q) => q[0])) + margin,
    z0: Math.min(...cs.map((q) => q[1])) - margin,
    z1: Math.max(...cs.map((q) => q[1])) + margin,
  };
}

/**
 * Stand a prop against a wall: `(wx, wz)` is the wall point, `(nx, nz)` the
 * unit normal pointing into the room. `back` names the prop's wall side in
 * its own frame ("-z": chairs, fire points; "+z": the cable tray's arms).
 * Returns the box centre and the yaw.
 */
export function against(
  role: DressingRole,
  wx: number,
  wz: number,
  nx: number,
  nz: number,
  opts: { gap?: number; back?: "-z" | "+z"; scale?: number } = {},
): { x: number; z: number; yaw: number } {
  const d = DRESSING_DIMS[role].d * (opts.scale ?? 1);
  const dist = (opts.gap ?? 0) + d / 2;
  const f = opts.back === "+z" ? -1 : 1;
  return {
    x: wx + nx * dist,
    z: wz + nz * dist,
    yaw: Math.atan2(f * nx, f * nz),
  };
}
