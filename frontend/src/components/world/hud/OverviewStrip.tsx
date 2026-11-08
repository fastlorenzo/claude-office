"use client";

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { GitBranch } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { STATUS_COLORS, type CampusSession } from "@/engine/contracts";
import { roomStatus } from "@/engine/logic/status";
import type { Session } from "@/hooks/useSessions";
import { groupSessions } from "@/engine/logic/projectGroups";
import {
  distinctName,
  labelMap,
  sessionProject,
  toSessionMeta,
} from "../sessionMeta";
import { enterSession } from "../enterSession";
import { GLASS, LABEL } from "./glass";
import { PhasePill, RefChips, midTruncate } from "./GlanceParts";
import {
  sessionBranch,
  sessionRefs,
  sessionSummary,
  sessionWorkItems,
  shouldCollapse,
  sortSessions,
  todoProgress,
} from "./sessionGlance";

// ----------------------------------------------------------------------------
// Visibility: a tiny external store so the toggle key and the component share
// state without effects. Persisted per browser (best effort).
// ----------------------------------------------------------------------------

export const OVERVIEW_KEY = "p";
const STORAGE_KEY = "claude-office.world.overview";
let visible = true;
try {
  if (typeof localStorage !== "undefined") {
    visible = localStorage.getItem(STORAGE_KEY) !== "0";
  }
} catch {
  // storage unavailable: keep default
}
const listeners = new Set<() => void>();

export function setOverviewVisible(next: boolean): void {
  visible = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function toggleOverview(): void {
  setOverviewVisible(!visible);
}

function useOverviewVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => visible,
    () => true,
  );
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

/** P toggles the Overview strip. */
export function useOverviewKey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== OVERVIEW_KEY) return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      if (isTyping(document.activeElement)) return;
      e.preventDefault();
      toggleOverview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

// ----------------------------------------------------------------------------

function StatusDot({
  color,
  pulse,
  size = 10,
}: {
  color: string;
  pulse: boolean;
  size?: number;
}): ReactNode {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span
          className="absolute inset-0 animate-ping rounded-full"
          style={{ backgroundColor: color, opacity: 0.55 }}
        />
      )}
      <span
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          backgroundColor: color,
          boxShadow: pulse ? `0 0 8px ${color}` : "none",
        }}
      />
    </span>
  );
}

interface CardProps {
  cs: CampusSession;
  label: string;
  project: string | null;
  portrait: boolean;
  dotsOnly: boolean;
}

function SessionCard({
  cs,
  label,
  project,
  portrait,
  dotsOnly,
}: CardProps): ReactNode {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const status = roomStatus(cs);
  const color = STATUS_COLORS[status];
  const needs = status === "needs_you";
  const summary = sessionSummary(cs);
  const refs = sessionRefs(cs);
  const branch = sessionBranch(cs);
  const { done, total, pct } = todoProgress(cs);
  const items = sessionWorkItems(cs);
  const recent = cs.recentActivity.slice(-3).reverse();
  const name = distinctName(label, project, summary);
  const title = summary ?? label;

  if (dotsOnly) {
    return (
      <button
        type="button"
        tabIndex={-1}
        title={`${label}: ${title}`}
        aria-label={label}
        onClick={() => void enterSession(cs.sessionId)}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${GLASS}`}
      >
        <StatusDot color={color} pulse={needs} size={9} />
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void enterSession(cs.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void enterSession(cs.sessionId);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className={`cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-slate-900/80 ${GLASS} ${
        portrait ? "w-[240px] shrink-0" : "w-[260px] max-w-full"
      }`}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot color={color} pulse={needs} size={8} />
        <span
          className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-slate-300"
          title={project ?? label}
        >
          {project ?? label}
        </span>
        {branch && (
          <span
            className="flex min-w-0 shrink items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1.5 py-px font-mono text-xs text-slate-400"
            title={branch}
          >
            <GitBranch className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{midTruncate(branch)}</span>
          </span>
        )}
        {name && project && (
          <span
            className="min-w-0 truncate text-xs italic text-slate-500"
            title={name}
          >
            {name}
          </span>
        )}
        {needs && (
          <span
            className="ml-auto shrink-0 rounded-full px-1.5 py-px text-xs font-bold uppercase tracking-wider text-slate-950"
            style={{ backgroundColor: color }}
          >
            {t("hud.overview.needsYou")}
          </span>
        )}
      </div>

      {(summary || refs.length > 0) && (
        <div className="mt-1 flex items-start gap-1.5">
          {summary && (
            <span
              className="line-clamp-2 min-w-0 text-[13px] font-bold leading-tight text-white"
              title={summary}
            >
              {summary}
            </span>
          )}
          <span className="flex shrink-0 flex-wrap items-center gap-1 pt-px">
            <RefChips refs={refs} />
          </span>
        </div>
      )}

      <div className="mt-1">
        <PhasePill cs={cs} />
      </div>

      {total > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          <div
            className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label={t("hud.overview.todos")}
            aria-valuenow={done}
            aria-valuemax={total}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, backgroundColor: color }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-slate-500">
            {done}/{total}
          </span>
        </div>
      )}

      {hover && (items.length > 0 || recent.length > 0) && (
        <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
          {items.length > 0 && (
            <div>
              <div className={`${LABEL} mb-0.5 !text-xs`}>
                {t("hud.overview.workItems")}
              </div>
              <ul className="space-y-0.5 text-xs text-slate-200">
                {items.map((w, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span
                      className="mt-1.5 h-1 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="min-w-0 break-words">{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recent.length > 0 && (
            <div>
              <div className={`${LABEL} mb-0.5 !text-xs`}>
                {t("hud.overview.recent")}
              </div>
              <ul className="space-y-0.5 font-mono text-xs text-slate-400">
                {recent.map((a, i) => (
                  <li key={`${a.timestamp}-${i}`} className="truncate">
                    {a.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OverviewStrip({
  sessions,
  portrait,
}: {
  sessions: Session[];
  portrait: boolean;
}): ReactNode {
  const { t } = useTranslation();
  useOverviewKey();
  const shown = useOverviewVisible();
  const campus = useCampusStore((s) => s.sessions);
  const [hover, setHover] = useState(false);

  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  const projects = useMemo(() => {
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const out = new Map<string, string | null>();
    for (const cs of campus)
      out.set(cs.sessionId, sessionProject(byId.get(cs.sessionId), cs));
    return out;
  }, [sessions, campus]);
  const allProjects = useCampusStore((s) => s.projects);
  const sorted = useMemo(() => sortSessions(campus), [campus]);
  // One block per project (its team room), most urgent project first.
  const blocks = useMemo(() => {
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const metas = campus.map((cs) => {
      const s = byId.get(cs.sessionId);
      return s
        ? toSessionMeta(s, cs)
        : {
            id: cs.sessionId,
            label: cs.project ?? cs.sessionId,
            createdAt: 0,
            status: "active" as const,
          };
    });
    const rank = new Map(sorted.map((cs, i) => [cs.sessionId, i]));
    const live = new Map(campus.map((c) => [c.sessionId, c]));
    return groupSessions(campus, metas, allProjects)
      .map((g) => ({
        id: g.id,
        name: g.name,
        list: g.sessionIds
          .map((id) => live.get(id)!)
          .sort(
            (a, b) =>
              (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
          ),
      }))
      .sort(
        (a, b) =>
          (rank.get(a.list[0].sessionId) ?? 0) -
          (rank.get(b.list[0].sessionId) ?? 0),
      );
  }, [sessions, campus, allProjects, sorted]);

  if (!shown || sorted.length === 0) return null;
  const dotsOnly = shouldCollapse(sorted.length) && !hover;

  return (
    <div
      aria-label={t("hud.overview.title")}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`pointer-events-auto absolute top-[4.5rem] flex gap-1.5 ${
        portrait
          ? "left-3 right-[4.5rem] snap-x snap-proximity flex-row overflow-x-auto pb-1.5 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] [scrollbar-color:rgba(148,163,184,0.6)_transparent] [scrollbar-width:thin]"
          : "left-3 max-h-[calc(100%-10.5rem)] flex-col overflow-y-auto pr-1"
      }`}
    >
      {blocks.map((b) => (
        <section
          key={b.id}
          aria-label={b.name}
          className={`flex gap-1.5 ${portrait ? "shrink-0 snap-start flex-row" : "flex-col"}`}
        >
          {!dotsOnly && (
            <div
              className={`${LABEL} flex items-center gap-1.5 px-1 pt-1 !text-xs text-slate-300`}
            >
              <span className="truncate">{b.name}</span>
              <span className="text-slate-500">
                {t("hud.overview.sessionCount", { count: b.list.length })}
              </span>
            </div>
          )}
          {b.list.map((cs) => (
            <SessionCard
              key={cs.sessionId}
              cs={cs}
              label={labels.get(cs.sessionId) ?? cs.sessionId.slice(0, 8)}
              project={projects.get(cs.sessionId) ?? null}
              portrait={portrait}
              dotsOnly={dotsOnly}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
