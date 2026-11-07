/**
 * Workpiece motion logic for one production line (P3.1). Pure TypeScript, no Babylon.
 *
 * Feed successive `LineModel`s with `setModel`, advance with `step(dtMs)`. Every piece
 * gets a smoothed placement on an abstract path; a later adapter maps
 * `{segmentPath, laneIndex, t}` onto FactoryLayout coordinates.
 *
 * Path semantics (t is 0..1 along the path):
 *  - "lane"   : lane start (intake bench) -> merge gate. laneIndex set.
 *  - "rework" : arc from the failure point (`fromT` on the lane) back to the lane start.
 *               t = 1 is the rework bay. Re-run plays it in reverse (phase "returning").
 *  - "queue"  : waiting on the intake rack / holding rack at `queueSlot` (smoothed,
 *               fractional while the queue shifts). While phase = "entering" the piece
 *               slides from its rack slot (t = 0) onto the lane start (t = 1).
 *  - "trunk"  : merge gate -> project trunk end.  - "main": trunk end -> QC (t = 1 at QC).
 *  - "dock"   : QC -> dock.  - "scrap": from the lane to the scrap bin.
 * Merge sequence phases: gate -> trunk -> main -> qc -> dock -> shipped.
 */
import type { LineModel, Workpiece } from "@/engine/logic/factoryModel";
import { lineProgress } from "@/engine/logic/factoryModel";

export type MotionPath =
  "lane" | "rework" | "queue" | "trunk" | "main" | "dock" | "scrap";

export type MotionPhase =
  | "rack"
  | "queued"
  | "holding"
  | "entering"
  | "lane"
  | "rework"
  | "rework-wait"
  | "returning"
  | "gate"
  | "trunk"
  | "main"
  | "qc"
  | "dock"
  | "shipped"
  | "scrapping"
  | "scrapped";

export interface PieceMotion {
  id: string;
  segmentPath: MotionPath;
  laneIndex?: number;
  t: number;
  phase: MotionPhase;
  /** Smoothed queue slot (queue path only). */
  queueSlot?: number;
  /** Lane t where a rework / scrap move started. */
  fromT?: number;
  /** Passed through from the model (merged / closed fade). */
  fade: number;
}

export type MotionEvent = {
  type: "merged" | "failed" | "shipped" | "scrapped";
  id: string;
};

export interface MotionFrame {
  pieces: PieceMotion[];
  events: MotionEvent[];
}

export const MOTION = {
  /** Normal belt speed in lane lengths per second. */
  BELT_SPEED: 0.2,
  /** Hard cap: never faster than one lane length per second. */
  MAX_SPEED: 1,
  ENTER_MS: 700,
  REWORK_MS: 900,
  RETURN_MS: 600,
  SCRAP_MS: 1200,
  GATE_MS: 600,
  TRUNK_MS: 2400,
  MAIN_MS: 3200,
  QC_MS: 900,
  DOCK_MS: 1600,
  SLOT_SPEED: 4,
  MAX_DT_MS: 1000,
} as const;

type Mode = MotionPhase;
type Want =
  "rack" | "queued" | "holding" | "lane" | "rework" | "merged" | "scrap";

interface PieceState {
  id: string;
  mode: Mode;
  lane: number;
  /** Smoothed lane t. */
  t: number;
  target: number;
  want: Want;
  elapsed: number;
  fromT: number;
  slot: number;
  slotTarget: number;
  seq: number;
  fade: number;
}

const BUSY = new Set<Mode>([
  "entering",
  "rework",
  "returning",
  "gate",
  "trunk",
  "main",
  "qc",
  "dock",
  "scrapping",
]);
const MERGE_STAGES: [Mode, number][] = [
  ["gate", MOTION.GATE_MS],
  ["trunk", MOTION.TRUNK_MS],
  ["main", MOTION.MAIN_MS],
  ["qc", MOTION.QC_MS],
  ["dock", MOTION.DOCK_MS],
];
const MERGING = new Set<Mode>([
  "gate",
  "trunk",
  "main",
  "qc",
  "dock",
  "shipped",
]);

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

function wantOf(w: Workpiece): Want {
  switch (w.position.segment) {
    case "trunk":
      return "merged";
    case "scrap":
      return "scrap";
    case "rework":
      return w.lane === null ? "queued" : "rework";
    case "holding":
      return "holding";
    case "rack":
      return w.lane !== null
        ? "lane"
        : w.stamp === "QUEUED"
          ? "queued"
          : "rack";
    default:
      return w.lane === null ? "queued" : "lane";
  }
}

export class FactoryMotion {
  private pieces = new Map<string, PieceState>();
  private events: MotionEvent[] = [];
  private initialised = false;
  private seq = 0;
  private stationCount = 0;

  /** Replace the target model. The first call snaps every piece to its resting place. */
  setModel(model: LineModel, _nowMs: number): void {
    void _nowMs;
    this.stationCount = model.stations.length;
    const snap = !this.initialised;
    this.initialised = true;
    const present = new Set<string>();
    const created: PieceState[] = [];
    const norm = 3 + this.stationCount + 0.99;

    for (const w of model.workpieces) {
      present.add(w.id);
      let p = this.pieces.get(w.id);
      const want = wantOf(w);
      const isNew = !p;
      if (!p) {
        p = {
          id: w.id,
          mode: "rack",
          lane: w.lane ?? 0,
          t: 0,
          target: 0,
          want,
          elapsed: 0,
          fromT: 0,
          slot: 0,
          slotTarget: 0,
          seq: this.seq++,
          fade: w.fade,
        };
        this.pieces.set(w.id, p);
      }
      p.want = want;
      p.fade = Number.isFinite(w.fade) ? w.fade : 1;
      if (w.lane !== null && w.lane !== undefined) {
        if (p.mode === "lane" && p.lane !== w.lane) p.mode = "rack";
        p.lane = w.lane;
      }
      const lp = lineProgress(w.position, this.stationCount);
      p.target = lp < 0 ? 0 : clamp01(lp / norm);
      if (isNew) {
        this.place(p, snap);
        created.push(p);
      }
    }

    // Drop pieces that left the model (a running merge sequence plays out first).
    for (const [id, p] of this.pieces) {
      if (present.has(id)) continue;
      if (MERGING.has(p.mode) && p.mode !== "shipped") {
        p.want = "merged";
        continue;
      }
      this.pieces.delete(id);
    }

    const before = new Map<string, Mode>();
    for (const p of this.pieces.values()) before.set(p.id, p.mode);
    for (const p of this.pieces.values()) {
      this.settle(p);
    }

    // Queue slots: rank among waiting pieces by arrival.
    const waiting = [...this.pieces.values()]
      .filter((p) => this.isWaiting(p))
      .sort((a, b) => a.seq - b.seq);
    waiting.forEach((p, i) => {
      p.slotTarget = i;
    });
    // New or newly parked pieces appear in place; only later shifts animate.
    for (const p of this.pieces.values()) {
      if (
        this.isWaiting(p) &&
        (created.includes(p) || !this.waitingMode(before.get(p.id)))
      ) {
        p.slot = p.slotTarget;
      }
    }
  }

  /** Advance the animation. Returns a fresh snapshot; events are drained. */
  step(dtMs: number): MotionFrame {
    const dt = Number.isFinite(dtMs)
      ? Math.min(MOTION.MAX_DT_MS, Math.max(0, dtMs))
      : 0;
    for (const p of this.pieces.values()) this.advance(p, dt);
    const pieces: PieceMotion[] = [];
    for (const p of this.pieces.values()) pieces.push(this.output(p));
    const events = this.events;
    this.events = [];
    return { pieces, events };
  }

  get size(): number {
    return this.pieces.size;
  }

  // -------------------------------------------------------------------------

  private waitingMode(m: Mode | undefined): boolean {
    return m === "rack" || m === "queued" || m === "holding";
  }

  private isWaiting(p: PieceState): boolean {
    return p.mode === "rack" || p.mode === "queued" || p.mode === "holding";
  }

  /** Initial placement of a new piece (snapped on the first model, animated after). */
  private place(p: PieceState, snap: boolean): void {
    p.slot = p.seq;
    switch (p.want) {
      case "rack":
      case "queued":
      case "holding":
        p.mode = p.want;
        break;
      case "lane":
        if (snap) {
          p.mode = "lane";
          p.t = p.target;
        } else {
          p.mode = "queued";
          p.slot = 0;
          p.slotTarget = 0;
          this.begin(p, "entering");
        }
        break;
      case "rework":
        p.mode = "rework-wait";
        break;
      case "merged":
        p.mode = "shipped";
        break;
      case "scrap":
        p.mode = "scrapped";
        break;
    }
    if (!snap && p.want === "lane") p.t = 0;
  }

  private begin(p: PieceState, mode: Mode): void {
    p.mode = mode;
    p.elapsed = 0;
  }

  /** Reconcile the piece's mode with what the model wants (never interrupts a move
   *  except for merge / scrap). */
  private settle(p: PieceState): void {
    if (p.mode === "shipped") return;
    if (p.want === "merged") {
      if (MERGING.has(p.mode)) return;
      p.fromT = p.mode === "lane" ? p.t : 0;
      this.events.push({ type: "merged", id: p.id });
      this.begin(p, "gate");
      return;
    }
    if (p.want === "scrap") {
      if (p.mode === "scrapping" || p.mode === "scrapped") return;
      p.fromT = p.t;
      this.begin(p, "scrapping");
      return;
    }
    if (BUSY.has(p.mode)) return;
    switch (p.want) {
      case "rack":
      case "queued":
      case "holding":
        if (p.mode !== p.want) {
          p.mode = p.want;
          p.slot = p.slotTarget;
        }
        break;
      case "lane":
        if (p.mode === "rework-wait") this.begin(p, "returning");
        else if (this.isWaiting(p) || p.mode === "scrapped") {
          p.t = 0;
          this.begin(p, "entering");
        }
        break;
      case "rework":
        if (p.mode === "lane" || p.mode === "returning") {
          p.fromT = p.mode === "lane" ? p.t : 0;
          this.events.push({ type: "failed", id: p.id });
          this.begin(p, "rework");
        } else if (this.isWaiting(p) || p.mode === "scrapped") {
          p.mode = "rework-wait";
        }
        break;
    }
  }

  private advance(p: PieceState, dt: number): void {
    if (this.isWaiting(p)) {
      const d = p.slotTarget - p.slot;
      const m = MOTION.SLOT_SPEED * (dt / 1000);
      p.slot = Math.abs(d) <= m ? p.slotTarget : p.slot + Math.sign(d) * m;
      return;
    }
    if (p.mode === "lane") {
      const d = p.target - p.t;
      const speed = Math.min(
        MOTION.MAX_SPEED,
        Math.max(MOTION.BELT_SPEED, Math.abs(d) * 2),
      );
      const m = speed * (dt / 1000);
      p.t = Math.abs(d) <= m ? p.target : p.t + Math.sign(d) * m;
      return;
    }
    if (!BUSY.has(p.mode)) return;
    p.elapsed += dt;
    switch (p.mode) {
      case "entering":
        if (p.elapsed >= MOTION.ENTER_MS) {
          p.t = 0;
          p.mode = "lane";
          this.settle(p);
        }
        break;
      case "rework":
        if (p.elapsed >= MOTION.REWORK_MS) {
          p.mode = "rework-wait";
          this.settle(p);
        }
        break;
      case "returning":
        if (p.elapsed >= MOTION.RETURN_MS) {
          p.t = 0;
          p.mode = "lane";
          this.settle(p);
        }
        break;
      case "scrapping":
        if (p.elapsed >= MOTION.SCRAP_MS) {
          p.mode = "scrapped";
          this.events.push({ type: "scrapped", id: p.id });
          this.settle(p);
        }
        break;
      default: {
        // merge sequence
        const idx = MERGE_STAGES.findIndex(([m]) => m === p.mode);
        if (idx >= 0 && p.elapsed >= MERGE_STAGES[idx][1]) {
          const next = MERGE_STAGES[idx + 1];
          if (next) this.begin(p, next[0]);
          else {
            p.mode = "shipped";
            this.events.push({ type: "shipped", id: p.id });
          }
        }
      }
    }
  }

  private output(p: PieceState): PieceMotion {
    const e = (ms: number) => clamp01(p.elapsed / ms);
    const o: PieceMotion = {
      id: p.id,
      segmentPath: "lane",
      t: 0,
      phase: p.mode,
      fade: p.fade,
    };
    switch (p.mode) {
      case "rack":
      case "queued":
      case "holding":
        o.segmentPath = "queue";
        o.queueSlot = p.slot;
        break;
      case "entering":
        o.segmentPath = "queue";
        o.laneIndex = p.lane;
        o.queueSlot = p.slot;
        o.t = smooth(e(MOTION.ENTER_MS));
        break;
      case "lane":
        o.laneIndex = p.lane;
        o.t = p.t;
        break;
      case "rework":
        o.segmentPath = "rework";
        o.laneIndex = p.lane;
        o.fromT = p.fromT;
        o.t = smooth(e(MOTION.REWORK_MS));
        break;
      case "rework-wait":
        o.segmentPath = "rework";
        o.laneIndex = p.lane;
        o.fromT = p.fromT;
        o.t = 1;
        break;
      case "returning":
        o.segmentPath = "rework";
        o.laneIndex = p.lane;
        o.fromT = p.fromT;
        o.t = 1 - smooth(e(MOTION.RETURN_MS));
        break;
      case "gate":
        o.laneIndex = p.lane;
        o.fromT = p.fromT;
        o.t = p.fromT + (1 - p.fromT) * smooth(e(MOTION.GATE_MS));
        break;
      case "trunk":
        o.segmentPath = "trunk";
        o.laneIndex = p.lane;
        o.t = e(MOTION.TRUNK_MS);
        break;
      case "main":
        o.segmentPath = "main";
        o.t = e(MOTION.MAIN_MS);
        break;
      case "qc":
        o.segmentPath = "main";
        o.t = 1;
        break;
      case "dock":
        o.segmentPath = "dock";
        o.t = e(MOTION.DOCK_MS);
        break;
      case "shipped":
        o.segmentPath = "dock";
        o.t = 1;
        break;
      case "scrapping":
        o.segmentPath = "scrap";
        o.laneIndex = p.lane;
        o.fromT = p.fromT;
        o.t = smooth(e(MOTION.SCRAP_MS));
        break;
      case "scrapped":
        o.segmentPath = "scrap";
        o.t = 1;
        break;
    }
    return o;
  }
}
