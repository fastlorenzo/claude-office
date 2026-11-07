/**
 * Pure cell assignment for the control-room wall.
 */

export type WallCell<S = { sessionId: string; label: string; status: string }> =
  | { kind: "session"; session: S }
  | { kind: "empty" }
  | { kind: "more"; count: number };

/**
 * Assign sessions to `cellCount` cells in order. When there are more sessions
 * than cells, the last cell becomes "+N more" (N = sessions not shown).
 */
export function wallCells<S>(sessions: S[], cellCount: number): WallCell<S>[] {
  const n = Math.max(0, cellCount);
  const out: WallCell<S>[] = [];
  const overflow = sessions.length > n;
  const shown = overflow ? Math.max(0, n - 1) : sessions.length;
  for (let i = 0; i < n; i++) {
    if (i < shown) out.push({ kind: "session", session: sessions[i] });
    else if (overflow && i === n - 1)
      out.push({ kind: "more", count: sessions.length - shown });
    else out.push({ kind: "empty" });
  }
  return out;
}
