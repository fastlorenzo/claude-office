"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { DoorOpen, GitBranch, Monitor, Pencil, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { STATUS_COLORS } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import {
  campusStatus,
  distinctName,
  sessionLabel,
  sessionProject,
} from "../sessionMeta";
import { PhasePill, RefChips, midTruncate } from "./GlanceParts";
import { primaryAction, useSessionNav } from "@/components/shared/sessionNav";
import { LABEL } from "./glass";
import {
  sessionBranch,
  sessionRefs,
  sessionSummary,
  sessionWorkItems,
} from "./sessionGlance";

export interface SessionHandlers {
  sessions: Session[];
  sessionsLoading: boolean;
  sessionId: string;
  onSessionSelect: (id: string) => Promise<void>;
  onDeleteSession: (session: Session) => void;
  onRenameSession: (sessionId: string, newName: string) => Promise<void>;
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={draft}
      maxLength={64}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      className="w-full rounded-md border border-[#D97757]/60 bg-slate-900 px-1.5 py-0.5 text-sm text-white outline-none"
    />
  );
}

export function SessionsPanel({
  sessions,
  sessionsLoading,
  sessionId,
  onDeleteSession,
  onRenameSession,
}: SessionHandlers): ReactNode {
  const { t } = useTranslation();
  const campus = useCampusStore((s) => s.sessions);
  const [editing, setEditing] = useState<string | null>(null);
  const nav = useSessionNav();

  const byId = useMemo(
    () => new Map(campus.map((c) => [c.sessionId, c])),
    [campus],
  );
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );

  const enter = (s: Session): void => {
    primaryAction(nav)(s.id);
  };

  if (sessionsLoading && sessions.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-slate-400">
        {t("hud.sessions.loading")}
      </p>
    );
  }
  if (sorted.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-slate-400">
        {t("hud.sessions.empty")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1 p-2">
      {sorted.map((s) => {
        const cs = byId.get(s.id);
        const status = campusStatus(cs);
        const color = STATUS_COLORS[status];
        const selected = s.id === sessionId;
        const summary = cs ? sessionSummary(cs) : null;
        const refs = cs ? sessionRefs(cs) : [];
        const project = sessionProject(s, cs);
        const name = distinctName(sessionLabel(s, cs), project, summary);
        const branch = cs ? sessionBranch(cs) : null;
        const host = cs?.host ?? s.host ?? null;
        const items = cs ? sessionWorkItems(cs) : [];
        return (
          <li key={s.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => enter(s)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  enter(s);
                }
              }}
              className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                selected
                  ? "border-[#D97757]/50 bg-[#D97757]/10"
                  : "border-transparent hover:border-white/10 hover:bg-white/5"
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: color,
                  boxShadow: status === "ended" ? "none" : `0 0 8px ${color}`,
                }}
              />
              <div className="min-w-0 flex-1">
                {editing === s.id ? (
                  <RenameInput
                    initial={sessionLabel(s, cs)}
                    onCancel={() => setEditing(null)}
                    onCommit={(v) => {
                      setEditing(null);
                      if (v.trim()) void onRenameSession(s.id, v.trim());
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-slate-300">
                      {project ?? sessionLabel(s, cs)}
                    </span>
                    {branch && (
                      <span
                        className="flex min-w-0 shrink items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1.5 py-px font-mono text-xs text-slate-400"
                        title={branch}
                      >
                        <GitBranch className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">
                          {midTruncate(branch, 30)}
                        </span>
                      </span>
                    )}
                    {host && (
                      <span
                        className="flex min-w-0 shrink items-center gap-1 rounded-full border border-white/10 px-1.5 py-px text-xs text-slate-500"
                        title={host}
                      >
                        <Monitor className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">
                          {midTruncate(host, 24)}
                        </span>
                      </span>
                    )}
                    {name && project && (
                      <span className="min-w-0 truncate text-xs italic text-slate-500">
                        {name}
                      </span>
                    )}
                    <span
                      className={`${LABEL} ml-auto shrink-0 !tracking-[0.1em]`}
                      style={{ color }}
                    >
                      {t(`hud.status.${status}`)}
                    </span>
                  </div>
                )}
                {(summary || refs.length > 0) && (
                  <div className="mt-0.5 flex items-start gap-1.5">
                    {summary && (
                      <span
                        className="line-clamp-2 min-w-0 text-[13px] font-bold leading-tight text-slate-100"
                        title={summary}
                      >
                        {summary}
                      </span>
                    )}
                    <span className="flex shrink-0 flex-wrap gap-1 pt-px">
                      <RefChips refs={refs} />
                    </span>
                  </div>
                )}
                {cs && !cs.ended && (
                  <div className="mt-1">
                    <PhasePill cs={cs} />
                  </div>
                )}
                {items.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                    {items.slice(0, 2).map((w, i) => (
                      <li key={i} className="truncate">
                        › {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <span className="shrink-0 text-xs text-slate-500">
                {formatDistanceToNow(new Date(s.updatedAt), {
                  addSuffix: false,
                })}
              </span>
              <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {nav.enterRoom && (
                  <button
                    type="button"
                    aria-label={t("world.action.enter")}
                    title={t("world.action.enter")}
                    onClick={(e) => {
                      e.stopPropagation();
                      enter(s);
                    }}
                    className="rounded-md p-1.5 text-[#D97757] hover:bg-[#D97757]/20 hover:text-white"
                  >
                    <DoorOpen className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t("hud.sessions.rename")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(s.id);
                  }}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t("hud.sessions.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(s);
                  }}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
