/**
 * setEnabled attribution for the vanish diagnostic (no Babylon import: the
 * pure gate modules use it). Gates wrap their toggles in `asGate(name, fn)`;
 * vanishDiag's Node.prototype.setEnabled wrapper records who switched what.
 */
export interface EnableRecord {
  gate: string;
  on: boolean;
  at: number;
  /** Untagged toggle of a shell mesh: where it came from. */
  stack?: string;
}

/** Node -> its last setEnabled call. */
export const enableRecords = new WeakMap<object, EnableRecord>();

let current: string | null = null;

/** Gate whose `asGate` callback is running (null = untagged caller). */
export function currentGate(): string | null {
  return current;
}

/** Run `fn` with every setEnabled inside it attributed to `gate`. */
export function asGate<T>(gate: string, fn: () => T): T {
  const prev = current;
  current = gate;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
