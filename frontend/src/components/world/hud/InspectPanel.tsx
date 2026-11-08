"use client";

import { useMemo, type ReactNode } from "react";
import { DoorOpen, GitBranch, Terminal } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { canFocusTerminal, useAttentionStore } from "@/stores/attentionStore";
import { STATUS_COLORS } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import {
  campusStatus,
  distinctName,
  sessionLabel,
  sessionProject,
} from "../sessionMeta";
import { PhasePill, RefChips } from "./GlanceParts";
import { enterSession } from "../enterSession";
import { LABEL } from "./glass";
import {
  sessionBranch,
  sessionRefs,
  sessionSummary,
  sessionWorkItems,
} from "./sessionGlance";

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-t border-white/10 px-4 py-3">
      <h3 className={`${LABEL} mb-2`}>{title}</h3>
      {children}
    </section>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function InspectPanel({ sessions }: { sessions: Session[] }): ReactNode {
  const { t } = useTranslation();
  const target = useWorldUiStore((s) => s.inspectTarget);
  const cs = useCampusStore((s) =>
    target
      ? s.sessions.find((x) => x.sessionId === target.sessionId)
      : undefined,
  );
  const session = useMemo(
    () => sessions.find((s) => s.id === target?.sessionId),
    [sessions, target],
  );
  const focusAgentTerminal = useAttentionStore((s) => s.focusAgentTerminal);

  if (!target) {
    return (
      <p className="p-6 text-center text-sm text-slate-400">
        {t("hud.inspect.none")}
      </p>
    );
  }

  const label = session ? sessionLabel(session, cs) : target.roomLabel;
  const project = sessionProject(session, cs);
  const summary = cs ? sessionSummary(cs) : null;
  const name = distinctName(label, project, summary);
  const status = campusStatus(cs);
  const color = STATUS_COLORS[status];
  const todos = cs?.todos ?? [];
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  const agentId =
    target.agentId && target.agentId !== "boss" ? target.agentId : null;

  return (
    <div className="flex flex-col">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-white">
              {project ?? label}
            </h3>
            {name && project && (
              <div className="truncate text-xs italic text-slate-500">
                {name}
              </div>
            )}
          </div>
          <span
            className="rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider"
            style={{
              color,
              borderColor: `${color}66`,
              background: `${color}1a`,
            }}
          >
            {t(`hud.status.${status}`)}
          </span>
        </div>
        {cs && (
          <div className="mt-3 space-y-1.5">
            {sessionBranch(cs) && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs text-slate-300">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate">{sessionBranch(cs)}</span>
              </span>
            )}
            {(summary || sessionRefs(cs).length > 0) && (
              <p className="flex flex-wrap items-center gap-1.5 text-[15px] font-bold leading-snug text-white">
                {summary}
                <RefChips refs={sessionRefs(cs)} />
              </p>
            )}
            <PhasePill cs={cs} size="md" />
            {sessionWorkItems(cs).length > 0 && (
              <ul className="space-y-0.5 pt-1 text-xs text-slate-200">
                {sessionWorkItems(cs).map((w, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span
                      className="mt-1.5 h-1 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {cs ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-slate-500">{t("hud.inspect.boss")}</dt>
            <dd className="text-slate-200">{cs.boss.state}</dd>
            <dt className="text-slate-500">{t("hud.inspect.task")}</dt>
            <dd className="truncate text-slate-200">
              {cs.boss.currentTask || "—"}
            </dd>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            {t("hud.inspect.noData")}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              void enterSession(target.sessionId);
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#D97757] px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-[#e58a6b]"
          >
            <DoorOpen className="h-3.5 w-3.5" />
            {t("world.action.enter")}
          </button>
          {canFocusTerminal() && (
            <button
              type="button"
              onClick={() => void focusAgentTerminal(target.sessionId, agentId)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 transition-colors hover:bg-white/10"
            >
              <Terminal className="h-3.5 w-3.5" />
              {t("hud.inspect.terminal")}
            </button>
          )}
        </div>
      </div>

      {cs ? (
        <>
          <Section title={`${t("hud.inspect.agents")} (${cs.agents.length})`}>
            {cs.agents.length === 0 ? (
              <p className="text-sm text-slate-500">
                {t("hud.inspect.noAgents")}
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <tbody>
                  {cs.agents.map((a) => (
                    <tr
                      key={a.id}
                      className={`border-b border-white/5 last:border-0 ${
                        a.id === target.agentId ? "bg-white/5" : ""
                      }`}
                    >
                      <td className="w-5 py-1.5 pl-1">
                        <span
                          className="block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: a.color }}
                        />
                      </td>
                      <td className="max-w-[7rem] truncate py-1.5 pr-2 font-semibold text-slate-100">
                        {a.name ?? a.id.slice(0, 6)}
                      </td>
                      <td className="py-1.5 pr-2 text-slate-400">{a.state}</td>
                      <td className="max-w-[10rem] truncate py-1.5 text-slate-500">
                        {a.currentTask ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title={`${t("hud.inspect.todos")} (${done}/${todos.length})`}
          >
            {todos.length === 0 ? (
              <p className="text-sm text-slate-500">
                {t("hud.inspect.noTodos")}
              </p>
            ) : (
              <>
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-[#D97757] transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <ul className="space-y-1 text-xs">
                  {todos.map((td, i) => (
                    <li
                      key={`${td.task_id ?? i}`}
                      className={`flex items-start gap-2 ${
                        td.status === "completed"
                          ? "text-slate-500 line-through"
                          : td.status === "in_progress"
                            ? "text-white"
                            : "text-slate-300"
                      }`}
                    >
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                          td.status === "completed"
                            ? "bg-emerald-400"
                            : td.status === "in_progress"
                              ? "bg-[#D97757]"
                              : "bg-slate-600"
                        }`}
                      />
                      {td.content}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section title={t("hud.inspect.activity")}>
            {cs.recentActivity.length === 0 ? (
              <p className="text-sm text-slate-500">
                {t("hud.inspect.noActivity")}
              </p>
            ) : (
              <ul className="space-y-1 font-mono text-xs">
                {[...cs.recentActivity].reverse().map((a, i) => (
                  <li key={`${a.timestamp}-${i}`} className="flex gap-2">
                    <span className="shrink-0 text-slate-600">
                      {time(a.timestamp)}
                    </span>
                    <span className="min-w-0 truncate text-slate-300">
                      {a.summary}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
