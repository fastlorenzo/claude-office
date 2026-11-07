"use client";

import { useMemo, type ReactNode } from "react";
import type { CampusProject } from "@/engine/contracts";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import type { Session } from "@/hooks/useSessions";
import { labelMap } from "../../sessionMeta";
import { enterSession } from "../../enterSession";
import { useNow } from "../GlanceParts";
import { OpsDashboard } from "./OpsDashboard";

/** Store-connected Ops dashboard (B anywhere, or F on the control-room wall). */
export function OpsOverlay({ sessions }: { sessions: Session[] }): ReactNode {
  const open = useWorldUiStore((s) => s.opsOpen);
  const focus = useWorldUiStore((s) => s.opsFocus);
  const campus = useCampusStore((s) => s.sessions);
  const stats = useCampusStore((s) => s.stats);
  // CampusState.projects once the store carries it (grouped by name until then).
  const projects = useCampusStore(
    (s) => (s as { projects?: CampusProject[] | null }).projects ?? null,
  );
  const nowMs = useNow();
  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  if (!open) return null;
  const ui = useWorldUiStore.getState();
  return (
    <OpsDashboard
      campus={campus}
      stats={stats}
      projects={projects}
      labels={labels}
      nowMs={nowMs}
      focusId={focus}
      onClose={() => ui.closeOps()}
      onEnter={(id) => {
        ui.closeOps();
        void enterSession(id);
      }}
      onInspect={(id, label) => {
        ui.closeOps();
        ui.openInspect({ kind: "screen", sessionId: id, roomLabel: label });
      }}
    />
  );
}
