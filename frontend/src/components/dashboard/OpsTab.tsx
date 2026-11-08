"use client";

import { useMemo, type ReactNode } from "react";
import { useCampusStore } from "@/stores/campusStore";
import type { Session } from "@/hooks/useSessions";
import { labelMap } from "@/components/world/sessionMeta";
import { useNow } from "@/components/world/hud/GlanceParts";
import { OpsDashboard } from "@/components/world/hud/ops/OpsDashboard";
import { useSessionNav } from "@/components/shared/sessionNav";

/** Ops dashboard as a page section. Row click opens that session's console tab. */
export function OpsTab({ sessions }: { sessions: Session[] }): ReactNode {
  const campus = useCampusStore((s) => s.sessions);
  const stats = useCampusStore((s) => s.stats);
  const projects = useCampusStore((s) => s.projects);
  const nowMs = useNow();
  const nav = useSessionNav();
  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  return (
    <OpsDashboard
      variant="page"
      campus={campus}
      stats={stats}
      projects={projects}
      labels={labels}
      nowMs={nowMs}
      onEnter={(id) => nav.openConsole(id)}
    />
  );
}
