"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import type { Session } from "@/hooks/useSessions";
import { sessionLabel } from "@/components/world/sessionMeta";
import { SessionConsole } from "@/components/console/SessionConsole";
import { Picker } from "./parts";
import { threeDHref } from "./dashboardUrl";

/** Console tab: the full Session Console for one session (`?session=&call=`). */
export function ConsoleTab({
  sessions,
  sessionId,
  callId,
  token,
  onPick,
}: {
  sessions: Session[];
  sessionId: string | undefined;
  callId: string | undefined;
  token: string | null;
  onPick: (id: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const campus = useCampusStore((s) => s.sessions);
  const options = useMemo(() => {
    const byId = new Map(campus.map((c) => [c.sessionId, c]));
    return sessions.map((s) => ({
      value: s.id,
      label: sessionLabel(s, byId.get(s.id)),
    }));
  }, [sessions, campus]);
  return (
    <div className="flex flex-col gap-3">
      <Picker
        label={t("dashboard.pickSession")}
        value={sessionId ?? ""}
        options={options}
        onChange={onPick}
        className="w-full sm:w-80"
      />
      {sessionId ? (
        <div className="flex h-[calc(100dvh-15rem)] min-h-[520px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070C14]/95 shadow-lg shadow-black/30">
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-hud-keytrap
          >
            <SessionConsole
              key={sessionId}
              sessionId={sessionId}
              presentation="sheet"
              focusCallId={callId}
              onEnterRoom={() =>
                window.location.assign(threeDHref(sessionId, token))
              }
              crossLink={{
                label: t("dashboard.openIn3d"),
                href: threeDHref(sessionId, token),
              }}
            />
          </div>
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">
          {t("dashboard.pickSession")}
        </p>
      )}
    </div>
  );
}
