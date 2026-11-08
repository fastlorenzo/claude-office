"use client";

import { useMemo, type ReactNode } from "react";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import type { Session } from "@/hooks/useSessions";
import { labelMap } from "../../sessionMeta";
import { useSessionNav } from "@/components/shared/sessionNav";
import { useNow } from "../GlanceParts";
import { OpsDashboard } from "./OpsDashboard";

/** Store-connected Ops dashboard (B anywhere, or F on the control-room wall). */
export function OpsOverlay({ sessions }: { sessions: Session[] }): ReactNode {
  const open = useWorldUiStore((s) => s.opsOpen);
  const focus = useWorldUiStore((s) => s.opsFocus);
  const campus = useCampusStore((s) => s.sessions);
  const stats = useCampusStore((s) => s.stats);
  const projects = useCampusStore((s) => s.projects);
  const nav = useSessionNav();
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
      onEnter={(id) => nav.openConsole(id, { from: "ops" })}
      onEnterRoom={
        nav.enterRoom
          ? (id) => {
              ui.closeOps();
              nav.enterRoom?.(id);
            }
          : undefined
      }
    />
  );
}
