/**
 * Walkable decks of the control room (pure geometry → collider boxes).
 *
 * The tiered console row (0.25 m riser) and the supervisor platform (0.3 m)
 * are drawn by ControlRoom; without floor colliders the player sank into them.
 * The character controller has no step-up, so every open deck edge gets a
 * gentle ramp (≈ 22°, 0.6 m long) whose top face meets the deck slab: the
 * player walks up instead of being stopped by a 25 cm wall. The tier is an
 * annular sector around the wall centre C, approximated by ≤ 3° chord boxes
 * (the same chord scheme as the drum walls).
 *
 * Box frame (Colliders.addBox): yaw `a` turns local +Z to the radial
 * direction (sin a, cos a) and local +X to increasing angle; pitch < 0 raises
 * the box's +Z end.
 */
import { Vector3 } from "@/engine/babylon";
import type { ColliderSink } from "@/engine/physics/Colliders";
import { CONSOLE, type ControlPlan } from "./controlRoomPlan";

/** Ramp: horizontal length and how far it reaches onto the deck. */
export const DECK_RAMP = { len: 0.6, inset: 0.15 } as const;
/**
 * Max chord angle of the tier slab / ramp strips. Chord boxes take the outer
 * chord's width, so at the inner radius they overhang by (r1 − r)·sin(Δ/2):
 * 1.5° keeps that lip at the radial ends under 5 cm.
 */
const CHORD = (1.5 * Math.PI) / 180;
/** Supervisor side rails: posts this far in from the platform edge, run depth. */
const SV_RAIL = { inset: 0.05, run: 0.95 } as const;

export interface DeckSector {
  /** Inner / outer radius around (cx, cz) and the angle range. */
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  deck: number;
}

/** Riser footprint of every tiered console row (matches ControlRoom). */
export function tierSectors(p: ControlPlan): DeckSector[] {
  const out: DeckSector[] = [];
  for (const row of p.rows) {
    if (row.deck <= 0) continue;
    const span0 = Math.min(...row.halves.map((h) => h[0]));
    const span1 = Math.max(...row.halves.map((h) => h[1]));
    out.push({
      r0: row.r - CONSOLE.depth / 2 - 1.35,
      r1: row.r + CONSOLE.depth / 2 + 0.15,
      a0: span0 - 0.18 / row.r,
      a1: span1 + 0.18 / row.r,
      deck: row.deck,
    });
  }
  return out;
}

/**
 * A ramp box whose top face runs from (u = -len + inset, y = 0) to
 * (u = inset, y = h) along its local +Z (u), centred laterally on `at`.
 * `at` is the deck edge point; `yaw` turns local +Z into the deck.
 */
function ramp(
  sink: ColliderSink,
  group: string,
  at: { x: number; z: number },
  yaw: number,
  width: number,
  h: number,
): void {
  const L = DECK_RAMP.len;
  const th = Math.atan2(h, L);
  const len = Math.hypot(L, h);
  const T = 0.12;
  // Extend 0.15 m past the low end (it sinks under the floor there).
  const ext = 0.15;
  const um = DECK_RAMP.inset - L / 2 - ((L / len) * ext) / 2;
  const ym = h / 2 - ((h / len) * ext) / 2;
  const cu = um + Math.sin(th) * (T / 2);
  const cy = ym - Math.cos(th) * (T / 2);
  sink.addBox(
    group,
    new Vector3(at.x + Math.sin(yaw) * cu, cy, at.z + Math.cos(yaw) * cu),
    new Vector3(width, T, len + ext),
    yaw,
    { pitch: -th },
  );
}

/** Tier: chord slab boxes (floor → deck) + inner/outer/end ramps. */
export function addTierColliders(
  sink: ColliderSink,
  group: string,
  cx: number,
  cz: number,
  s: DeckSector,
): void {
  const at = (r: number, a: number) => ({
    x: cx + r * Math.sin(a),
    z: cz + r * Math.cos(a),
  });
  const k = DECK_RAMP.inset;
  const rs0 = s.r0 + k;
  const rs1 = s.r1 - k;
  const rm = (rs0 + rs1) / 2;
  // Slab between the ramps, angularly inset so that even at its outer
  // radius it starts where the end ramps top out (inboard it overlaps them:
  // a lip ≤ 4 cm the capsule rides over, never a gap).
  const as0 = s.a0 + k / rs1;
  const as1 = s.a1 - k / rs1;
  const n = Math.max(1, Math.ceil((as1 - as0) / CHORD));
  const da = (as1 - as0) / n;
  for (let i = 0; i < n; i++) {
    const a = as0 + (i + 0.5) * da;
    const c = at(rm, a);
    sink.addBox(
      group,
      new Vector3(c.x, s.deck / 2, c.z),
      new Vector3(2 * rs1 * Math.sin(da / 2) + 0.02, s.deck, rs1 - rs0),
      a,
    );
  }
  // Radial ramps along the inner (toward C) and outer edges.
  const m = Math.max(1, Math.ceil((s.a1 - s.a0) / CHORD));
  const dm = (s.a1 - s.a0) / m;
  for (let i = 0; i < m; i++) {
    const a = s.a0 + (i + 0.5) * dm;
    // Inner edge: rising outward (+radial).
    ramp(
      sink,
      group,
      at(s.r0, a),
      a,
      2 * s.r0 * Math.sin(dm / 2) + 0.03,
      s.deck,
    );
    // Outer edge: rising inward.
    ramp(
      sink,
      group,
      at(s.r1, a),
      a + Math.PI,
      2 * (s.r1 + DECK_RAMP.len) * Math.sin(dm / 2) + 0.03,
      s.deck,
    );
  }
  // End ramps on the two radial edges, rising into the deck. They span the
  // slab's radial extent only: where the inner/outer ramps already reach
  // deck height their sides are hidden (no lip at the corners).
  const mid = rm;
  const w = rs1 - rs0;
  const edge = (a: number, inward: number) => {
    // Edge point on the radial line, then the ramp runs tangentially.
    const p = at(mid, a);
    ramp(sink, group, p, a + inward * (Math.PI / 2), w, s.deck);
  };
  edge(s.a0, 1);
  edge(s.a1, -1);
}

/** Supervisor platform: slab, ramps on the open edges, side-rail guards. */
export function addSupervisorColliders(
  sink: ColliderSink,
  group: string,
  cx: number,
  sv: NonNullable<ControlPlan["supervisor"]>,
): void {
  const k = DECK_RAMP.inset;
  const pw = sv.phw;
  const h = sv.deck;
  const railZ1 = sv.pz0 + SV_RAIL.run;
  // Slab (the back edge carries the rail collider ControlRoom adds).
  sink.addBox(
    group,
    new Vector3(cx, h / 2, (sv.pz0 + sv.pz1 - k) / 2),
    new Vector3(2 * (pw - k), h, sv.pz1 - k - sv.pz0),
  );
  // Front edge: ramp rising toward -z (into the platform).
  ramp(sink, group, { x: cx, z: sv.pz1 }, Math.PI, 2 * pw, h);
  // Sides: rails over the back run, ramps over the open run to the front.
  for (const s of [-1, 1]) {
    const x = cx + s * pw;
    sink.addBox(
      group,
      new Vector3(
        cx + s * (pw - SV_RAIL.inset),
        h + 0.6,
        (sv.pz0 + railZ1) / 2,
      ),
      new Vector3(0.08, 1.2, railZ1 - sv.pz0),
    );
    // A slab strip under the railed run (no ramp there).
    sink.addBox(
      group,
      new Vector3(x - s * (k / 2), h / 2, (sv.pz0 + railZ1) / 2),
      new Vector3(k, h, railZ1 - sv.pz0),
    );
    ramp(
      sink,
      group,
      { x, z: (railZ1 + sv.pz1) / 2 },
      s > 0 ? -Math.PI / 2 : Math.PI / 2,
      sv.pz1 - railZ1,
      h,
    );
  }
}

/** Every deck collider of the room. */
export function addDeckColliders(
  sink: ColliderSink,
  group: string,
  p: ControlPlan,
): void {
  for (const s of tierSectors(p)) addTierColliders(sink, group, p.cx, p.cz, s);
  if (p.supervisor) addSupervisorColliders(sink, group, p.cx, p.supervisor);
}
