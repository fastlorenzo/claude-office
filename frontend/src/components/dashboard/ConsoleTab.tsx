"use client";

import { useMemo, type ReactNode } from "react";
import { Box } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import type { InteractionTarget } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import { sessionLabel } from "@/components/world/sessionMeta";
import { InspectPanel } from "@/components/world/hud/InspectPanel";
import { PanelCard, Picker } from "./parts";
import { threeDHref } from "./dashboardUrl";

/**
 * Console tab. Phase 1 stand-in: the session inspector at page width. The
 * Session Console (WS5) replaces the body in phase 2.
 */
export function ConsoleTab({
  sessions,
  sessionId,
  token,
  onPick,
}: {
  sessions: Session[];
  sessionId: string | undefined;
  token: string | null;
  onPick: (id: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const campus = useCampusStore((s) => s.sessions);
  const byId = useMemo(
    () => new Map(campus.map((c) => [c.sessionId, c])),
    [campus],
  );
  const options = sessions.map((s) => ({
    value: s.id,
    label: sessionLabel(s, byId.get(s.id)),
  }));
  const current = sessions.find((s) => s.id === sessionId);
  const target = useMemo<InteractionTarget | null>(
    () =>
      current
        ? {
            kind: "screen",
            sessionId: current.id,
            roomLabel: sessionLabel(current, byId.get(current.id)),
          }
        : null,
    [current, byId],
  );
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Picker
        label={t("dashboard.pickSession")}
        value={sessionId ?? ""}
        options={options}
        onChange={onPick}
      />
      {target ? (
        <PanelCard
          title={t("dashboard.tab.console")}
          icon={Box}
          action={
            <a
              href={threeDHref(target.sessionId, token)}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10"
            >
              {t("dashboard.openIn3d")}
            </a>
          }
        >
          <InspectPanel sessions={sessions} target={target} />
        </PanelCard>
      ) : (
        <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">
          {t("dashboard.pickSession")}
        </p>
      )}
    </div>
  );
}
