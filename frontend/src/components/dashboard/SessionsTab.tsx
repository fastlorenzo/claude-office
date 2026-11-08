"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { STATUS_COLORS, type RoomStatus } from "@/engine/contracts";
import { campusStatus, sessionProject } from "@/components/world/sessionMeta";
import {
  SessionsPanel,
  type SessionHandlers,
} from "@/components/world/hud/SessionsPanel";

const STATUSES: RoomStatus[] = ["needs_you", "working", "done", "ended"];

/** Sessions list at page width, with status and project filters. */
export function SessionsTab(props: SessionHandlers): ReactNode {
  const { t } = useTranslation();
  const campus = useCampusStore((s) => s.sessions);
  const [status, setStatus] = useState<RoomStatus | "all">("all");
  const [project, setProject] = useState("");

  const byId = useMemo(
    () => new Map(campus.map((c) => [c.sessionId, c])),
    [campus],
  );
  const projects = useMemo(
    () =>
      [
        ...new Set(
          props.sessions
            .map((s) => sessionProject(s, byId.get(s.id)))
            .filter((p): p is string => !!p),
        ),
      ].sort(),
    [props.sessions, byId],
  );
  const filtered = useMemo(
    () =>
      props.sessions.filter((s) => {
        const cs = byId.get(s.id);
        if (status !== "all" && campusStatus(cs) !== status) return false;
        if (project && sessionProject(s, cs) !== project) return false;
        return true;
      }),
    [props.sessions, byId, status, project],
  );

  const chip = (active: boolean): string =>
    `rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
      active
        ? "border-[#D97757]/60 bg-[#D97757]/15 text-[#f0a58a]"
        : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.07] hover:text-slate-100"
    }`;

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#0B111B]/90 shadow-lg shadow-black/30">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] p-3">
        <button
          type="button"
          onClick={() => setStatus("all")}
          aria-pressed={status === "all"}
          className={chip(status === "all")}
        >
          {t("dashboard.tab.sessions")} · {props.sessions.length}
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(status === s ? "all" : s)}
            aria-pressed={status === s}
            className={`${chip(status === s)} inline-flex items-center gap-1.5`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: STATUS_COLORS[s] }}
            />
            {t(`hud.status.${s}`)}
          </button>
        ))}
        {projects.length > 1 && (
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label={t("ops.col.project")}
            className="ml-auto rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-[#D97757]/60"
          >
            <option value="">{t("ops.col.project")}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
      <SessionsPanel {...props} sessions={filtered} />
    </section>
  );
}
