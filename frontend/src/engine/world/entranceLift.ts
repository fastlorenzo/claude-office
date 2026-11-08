/**
 * Entrance lift state machine (pure, no Babylon): two stops, G (level 0) and
 * the reception (level 1). A call from a stop brings the car there, opens its
 * doors, fades the view out, asks for the rider to be moved to the other stop
 * (the car snaps there while the screen is dark), opens the doors there and
 * fades back in; the doors close again after a dwell.
 */

export type LiftLevel = 0 | 1;

export const LIFT_TIMING = {
  /** Car travel between the stops when called from the other floor (s). */
  travel: 2.4,
  /** Door open / close (s). */
  door: 0.7,
  /** Doors held open before the fade (s). */
  board: 0.35,
  /** Fade out / in (s). */
  fade: 0.35,
  /** Dark hold while the rider is moved (s). */
  dark: 0.25,
  /** Doors stay open after arrival (s). */
  dwell: 2.2,
} as const;

type Phase =
  | { k: "idle" }
  | { k: "travel"; t: number; from: LiftLevel; to: LiftLevel; ride: boolean }
  | { k: "opening"; t: number; ride: boolean }
  | { k: "board"; t: number }
  | { k: "fadeOut"; t: number }
  | { k: "dark"; t: number }
  | { k: "fadeIn"; t: number }
  | { k: "dwell"; t: number }
  | { k: "closing"; t: number };

export interface LiftFrame {
  /** Car position: 0 = at G, 1 = at the reception (eased while travelling). */
  car: number;
  /** Door opening 0..1 per level. */
  doors: [number, number];
  /** Screen fade 0 (clear) .. 1 (black). */
  fade: number;
  /** Set on the one frame the rider must be moved to this level. */
  teleportTo: LiftLevel | null;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export class LiftController {
  private level: LiftLevel;
  private phase: Phase = { k: "idle" };
  private door = 0;

  constructor(start: LiftLevel = 0) {
    this.level = start;
  }

  get carLevel(): LiftLevel {
    return this.level;
  }

  get busy(): boolean {
    return this.phase.k !== "idle";
  }

  /** Rider pressed the call button at `from`; ignored while a ride runs. */
  call(from: LiftLevel): boolean {
    const p = this.phase.k;
    if (p !== "idle" && p !== "dwell" && p !== "closing") return false;
    if (from !== this.level) {
      if (p !== "idle") return false; // doors still open at the other stop
      this.phase = {
        k: "travel",
        t: 0,
        from: this.level,
        to: from,
        ride: true,
      };
      return true;
    }
    // Same floor: (re)open from wherever the doors are.
    this.phase = { k: "opening", t: this.door * LIFT_TIMING.door, ride: true };
    return true;
  }

  update(dt: number): LiftFrame {
    const T = LIFT_TIMING;
    let teleportTo: LiftLevel | null = null;
    let fade = 0;
    let car: number = this.level;
    const p = this.phase;
    switch (p.k) {
      case "idle":
        break;
      case "travel": {
        p.t += dt;
        const u = ease(clamp01(p.t / T.travel));
        car = p.from + (p.to - p.from) * u;
        if (p.t >= T.travel) {
          this.level = p.to;
          car = p.to;
          this.phase = { k: "opening", t: 0, ride: p.ride };
        }
        break;
      }
      case "opening":
        p.t += dt;
        this.door = clamp01(p.t / T.door);
        if (p.t >= T.door)
          this.phase = p.ride ? { k: "board", t: 0 } : { k: "dwell", t: 0 };
        break;
      case "board":
        p.t += dt;
        if (p.t >= T.board) this.phase = { k: "fadeOut", t: 0 };
        break;
      case "fadeOut":
        p.t += dt;
        fade = clamp01(p.t / T.fade);
        if (p.t >= T.fade) {
          fade = 1;
          // Rider and car arrive at the other stop with its doors open.
          this.level = this.level === 0 ? 1 : 0;
          car = this.level;
          teleportTo = this.level;
          this.phase = { k: "dark", t: 0 };
        }
        break;
      case "dark":
        p.t += dt;
        fade = 1;
        if (p.t >= T.dark) this.phase = { k: "fadeIn", t: 0 };
        break;
      case "fadeIn":
        p.t += dt;
        fade = 1 - clamp01(p.t / T.fade);
        if (p.t >= T.fade) this.phase = { k: "dwell", t: 0 };
        break;
      case "dwell":
        p.t += dt;
        if (p.t >= T.dwell) this.phase = { k: "closing", t: 0 };
        break;
      case "closing":
        p.t += dt;
        this.door = 1 - clamp01(p.t / T.door);
        if (p.t >= T.door) {
          this.door = 0;
          this.phase = { k: "idle" };
        }
        break;
    }
    const doors: [number, number] = [0, 0];
    if (p.k !== "travel" && this.phase.k !== "travel")
      doors[this.level] = this.door;
    return { car, doors, fade, teleportTo };
  }
}
