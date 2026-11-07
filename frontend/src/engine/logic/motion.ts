import type { RoomLayout, Vec3 } from "../contracts";

export type PathPoint = "outside" | "door" | "boss" | { desk: number };

const EPS = 1e-6;
const dist = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const clone = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

/** Closest point on the room's aisle spine (local z = 0) to a world point. */
function spineJunction(room: RoomLayout, p: Vec3): Vec3 {
  const c = Math.cos(room.yaw);
  const s = Math.sin(room.yaw);
  const dx = p.x - room.origin.x;
  const dz = p.z - room.origin.z;
  const lx = dx * c - dz * s;
  return {
    x: room.origin.x + lx * c,
    y: 0,
    z: room.origin.z - lx * s,
  };
}

interface Route {
  /** Points from the node toward the spine (node first, junction excluded). */
  head: Vec3[];
  junction: Vec3;
}

function route(room: RoomLayout, pt: PathPoint): Route {
  if (pt === "outside") {
    return { head: [room.doorOutside, room.door], junction: room.doorInside };
  }
  if (pt === "door") {
    return { head: [room.door], junction: room.doorInside };
  }
  if (pt === "boss") {
    return {
      head: [room.bossDesk.approach],
      junction: spineJunction(room, room.bossDesk.approach),
    };
  }
  const desk = room.desks[pt.desk];
  if (!desk) throw new Error(`buildPath: no desk ${pt.desk}`);
  return {
    head: [desk.seat, desk.approach],
    junction: spineJunction(room, desk.approach),
  };
}

export function buildPath(
  room: RoomLayout,
  from: PathPoint,
  to: PathPoint,
): Vec3[] {
  const a = route(room, from);
  const b = route(room, to);
  const raw = [...a.head, a.junction, b.junction, ...[...b.head].reverse()];
  const out: Vec3[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > EPS) out.push(clone(p));
  }
  return out;
}

export class PathFollower {
  private readonly path: Vec3[];
  private readonly speed: number;
  private seg = 0;
  private segT = 0; // metres travelled along current segment
  private yaw = 0;
  private _remaining: number;

  constructor(path: Vec3[], speed = 1.4) {
    this.path = path.map(clone);
    this.speed = speed;
    let total = 0;
    for (let i = 1; i < this.path.length; i++)
      total += dist(this.path[i - 1], this.path[i]);
    this._remaining = total;
    if (this.path.length > 1) this.yaw = this.segYaw(0);
  }

  get remaining(): number {
    return this._remaining;
  }

  private segYaw(i: number): number {
    const a = this.path[i];
    const b = this.path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.hypot(dx, dz) < EPS) return this.yaw;
    return Math.atan2(dx, dz);
  }

  update(dt: number): { position: Vec3; yaw: number; done: boolean } {
    if (this.path.length === 0)
      return { position: { x: 0, y: 0, z: 0 }, yaw: this.yaw, done: true };
    let budget = Math.max(0, dt) * this.speed;
    while (budget > 0 && this.seg < this.path.length - 1) {
      const a = this.path[this.seg];
      const b = this.path[this.seg + 1];
      const len = dist(a, b);
      const left = len - this.segT;
      if (budget >= left) {
        budget -= left;
        this._remaining -= left;
        this.seg++;
        this.segT = 0;
        if (this.seg < this.path.length - 1) this.yaw = this.segYaw(this.seg);
      } else {
        this.segT += budget;
        this._remaining -= budget;
        budget = 0;
      }
    }
    const done = this.seg >= this.path.length - 1;
    if (done) this._remaining = 0;
    let position: Vec3;
    if (done) {
      position = clone(this.path[this.path.length - 1]);
    } else {
      const a = this.path[this.seg];
      const b = this.path[this.seg + 1];
      const len = dist(a, b);
      const t = len < EPS ? 0 : this.segT / len;
      position = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      };
    }
    return { position, yaw: this.yaw, done };
  }
}

export function damp(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function dampAngle(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  const twoPi = Math.PI * 2;
  let d = (target - current) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return current + d * (1 - Math.exp(-lambda * dt));
}
