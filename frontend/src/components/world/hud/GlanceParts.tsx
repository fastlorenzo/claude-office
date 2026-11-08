"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  Bot,
  Code2,
  Compass,
  FlaskConical,
  GitCommitHorizontal,
  Hammer,
  Hand,
  Hourglass,
  MessageCircleQuestion,
  Moon,
  Search,
  Sparkles,
  Terminal,
  Minimize2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { CampusSession, SessionPhaseKind } from "@/engine/contracts";
import { formatElapsed, isPhaseKind, sessionPhase } from "./sessionGlance";
import { activeAgents } from "./sessionGlance";

// One shared 15 s ticker for every card (not one interval per card).
const TICK_MS = 15_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time in ms, refreshed every 15 s, shared by all subscribers. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

const PHASE_STYLE: Record<
  SessionPhaseKind,
  { color: string; Icon: LucideIcon }
> = {
  needs_approval: { color: "#F59E0B", Icon: Hand },
  waiting_user: { color: "#60A5FA", Icon: MessageCircleQuestion },
  planning: { color: "#A78BFA", Icon: Sparkles },
  researching: { color: "#38BDF8", Icon: Search },
  exploring: { color: "#94A3B8", Icon: Compass },
  coding: { color: "#4ADE80", Icon: Code2 },
  testing: { color: "#A78BFA", Icon: FlaskConical },
  building: { color: "#A78BFA", Icon: Hammer },
  running: { color: "#94A3B8", Icon: Terminal },
  git: { color: "#2DD4BF", Icon: GitCommitHorizontal },
  delegating: { color: "#4ADE80", Icon: Bot },
  compacting: { color: "#94A3B8", Icon: Minimize2 },
  idle: { color: "#94A3B8", Icon: Moon },
  ended: { color: "#64748B", Icon: Hourglass },
};

/** Phase pill: icon + label (coloured by kind) + muted detail + elapsed. */
export function PhasePill({
  cs,
  size = "sm",
}: {
  cs: CampusSession;
  size?: "sm" | "md";
}): ReactNode {
  const { t } = useTranslation();
  const nowMs = useNow();
  const phase = sessionPhase(cs);
  const known = isPhaseKind(phase.kind);
  const { color, Icon } = PHASE_STYLE[known ? phase.kind : "running"];
  const label = known ? t(`hud.phase.${phase.kind}`) : phase.label;
  const elapsed = formatElapsed(phase.since, nowMs);
  const agents = phase.kind === "delegating" ? activeAgents(cs) : [];
  const pulse = phase.kind === "needs_approval";
  const text = size === "md" ? "text-xs" : "text-xs";
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 ${text} leading-tight`}
      title={[label, phase.detail, elapsed].filter(Boolean).join(" · ")}
    >
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-semibold ${
          pulse ? "animate-pulse" : ""
        }`}
        style={{
          color,
          background: `${color}22`,
          border: `1px solid ${color}55`,
        }}
      >
        <Icon className="h-3 w-3 shrink-0" />
        {label}
      </span>
      {agents.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5">
          {agents.slice(0, 5).map((a) => (
            <span
              key={a.id}
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: a.color }}
            />
          ))}
        </span>
      )}
      {phase.detail && (
        <span className="min-w-0 truncate font-mono text-xs text-slate-400">
          {phase.detail}
        </span>
      )}
      {elapsed && (
        <span className="shrink-0 text-xs text-slate-500">· {elapsed}</span>
      )}
    </div>
  );
}

/** Small mono pills for ticket / PR references. */
export function RefChips({ refs }: { refs: string[] }): ReactNode {
  if (refs.length === 0) return null;
  return (
    <>
      {refs.map((r) => (
        <span
          key={r}
          className="shrink-0 rounded border border-white/10 bg-white/5 px-1 py-px font-mono text-xs font-semibold leading-none text-slate-300"
        >
          {r}
        </span>
      ))}
    </>
  );
}

/** Middle-truncate for branch chips (CSS can only truncate at the end). */
export function midTruncate(s: string, max = 26): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}
