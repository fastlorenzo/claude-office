/**
 * Idempotent enable/disable for visibility gates (building sightlines, room
 * LOD). A gate states what it wants every tick; `enforceEnabled` switches
 * only the nodes whose own state differs and reports how many it switched,
 * so a node turned off behind a gate's back is turned back on at the next
 * tick instead of staying off for good (the change-only caches did that),
 * and the gate can count that drift (`__worldStats.gateDrift`).
 */
import { asGate } from "@/engine/world/gateTrace";

export interface Toggleable {
  isDisposed(): boolean;
  isEnabled(checkAncestors?: boolean): boolean;
  setEnabled(value: boolean): void;
}

/** Bring every node to `on`; returns the number of nodes it had to switch. */
export function enforceEnabled(
  gate: string,
  nodes: Iterable<Toggleable | null | undefined>,
  on: boolean,
): number {
  let n = 0;
  asGate(gate, () => {
    for (const node of nodes) {
      if (!node || node.isDisposed()) continue;
      if (node.isEnabled(false) === on) continue;
      node.setEnabled(on);
      n += 1;
    }
  });
  return n;
}

/** A gated unit: `setEnabled` enforces and returns how many nodes it switched. */
export interface GateHandle {
  setEnabled(v: boolean): number | void;
}

/**
 * Drift bookkeeping shared by the gates: nodes found OFF while the gate's
 * decision for them was already ON (someone else switched them off).
 */
export class GateDrift {
  /** Since start. */
  total = 0;
  /** In the last tick. */
  last = 0;

  begin(): void {
    this.last = 0;
  }

  /** `prev` = the decision before this tick, `on` = now, `switched` = enforce result. */
  note(prev: boolean | undefined, on: boolean, switched: number | void): void {
    if (prev === true && on && typeof switched === "number" && switched > 0) {
      this.last += switched;
      this.total += switched;
    }
  }
}
