"use client";

import { useMemo, type ReactNode } from "react";
import { useCampusStore } from "@/stores/campusStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { Session } from "@/hooks/useSessions";
import { labelMap } from "@/components/world/sessionMeta";
import { useNow } from "@/components/world/hud/GlanceParts";
import { OpsDashboard } from "@/components/world/hud/ops/OpsDashboard";
import { SessionConsole } from "@/components/console/SessionConsole";
import { useSessionNav } from "@/components/shared/sessionNav";
import { attentionSession } from "./focusSession";

/**
 * Ops dashboard as a page section. A row click focuses that session in the
 * live console under the board (which uses the otherwise empty height of a
 * tall screen); the console's link opens the full Console tab.
 */
export function OpsTab({
  sessions,
  focusId,
  onFocus,
}: {
  sessions: Session[];
  focusId: string | undefined;
  onFocus: (id: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const campus = useCampusStore((s) => s.sessions);
  const stats = useCampusStore((s) => s.stats);
  const projects = useCampusStore((s) => s.projects);
  const nowMs = useNow();
  const nav = useSessionNav();
  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  const shown =
    focusId && campus.some((c) => c.sessionId === focusId)
      ? focusId
      : attentionSession(campus);
  return (
    <div className="flex flex-col gap-3">
      <OpsDashboard
        variant="page"
        campus={campus}
        stats={stats}
        projects={projects}
        labels={labels}
        nowMs={nowMs}
        focusId={shown}
        onEnter={onFocus}
      />
      {shown && (
        <section
          aria-label={t("dashboard.tab.console")}
          className="mx-4 hidden h-[clamp(560px,calc(100dvh-8rem),1100px)] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070C14]/95 shadow-lg shadow-black/30 lg:flex"
        >
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-hud-keytrap
          >
            <SessionConsole
              key={shown}
              sessionId={shown}
              presentation="sheet"
              crossLink={{
                label: t("dashboard.tab.console"),
                onClick: () => nav.openConsole(shown),
              }}
            />
          </div>
        </section>
      )}
    </div>
  );
}
