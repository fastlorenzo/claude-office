import type { CampusSession } from "@/engine/contracts";
import { roomStatus } from "@/engine/logic/status";

const RANK = { needs_you: 0, working: 1, done: 2, ended: 3 } as const;

/** The session that most deserves a look: needs you, then working, then newest. */
export function attentionSession(
  campus: readonly CampusSession[],
): string | undefined {
  let best: CampusSession | undefined;
  for (const c of campus) {
    if (!best || RANK[roomStatus(c)] < RANK[roomStatus(best)]) best = c;
  }
  return best?.sessionId;
}
