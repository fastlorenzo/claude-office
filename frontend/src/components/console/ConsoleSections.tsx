"use client";

/** Console right-pane sections: Todos and Git (Chat reuses ConversationView). */

import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  CircleDot,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitStatus, TodoItem } from "@/utils/console/types";
import { SECTION_LABEL } from "./theme";

const TODO = {
  completed: { Icon: Check, cls: "text-emerald-400" },
  in_progress: { Icon: CircleDot, cls: "text-sky-400" },
  pending: { Icon: Circle, cls: "text-slate-500" },
} as const;

export function TodosSection({
  todos,
}: {
  todos: readonly TodoItem[];
}): ReactNode {
  const { t } = useTranslation();
  const done = todos.filter((x) => x.status === "completed").length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className={SECTION_LABEL}>{t("console.tab.todos")}</span>
        <span className="text-xs text-slate-500">
          {t("console.todosDone", { done, total: todos.length })}
        </span>
      </div>
      {todos.length > 0 && (
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-emerald-400/80"
            style={{ width: `${(done / todos.length) * 100}%` }}
          />
        </div>
      )}
      {todos.length === 0 ? (
        <div className="py-6 text-center text-[13px] italic text-slate-500">
          {t("console.noTodos")}
        </div>
      ) : (
        <ul className="space-y-1">
          {todos.map((todo, i) => {
            const { Icon, cls } = TODO[todo.status] ?? TODO.pending;
            const active = todo.status === "in_progress";
            return (
              <li
                key={todo.task_id ?? i}
                className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13px] ${active ? "border border-sky-400/25 bg-sky-400/[0.08]" : ""}`}
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${cls}`} />
                <span
                  className={
                    todo.status === "completed"
                      ? "text-slate-500 line-through"
                      : "text-slate-200"
                  }
                >
                  {active && todo.active_form ? todo.active_form : todo.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const FILE_CLS: Record<string, string> = {
  M: "text-amber-300",
  A: "text-emerald-400",
  D: "text-rose-400",
  R: "text-violet-300",
  C: "text-violet-300",
  "?": "text-slate-400",
};

export function GitSection({ git }: { git: GitStatus | null }): ReactNode {
  const { t } = useTranslation();
  if (!git) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[13px] italic text-slate-500">
        {t("console.noGit")}
      </div>
    );
  }
  const files = git.changed_files ?? [];
  const commits = git.commits ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-slate-100">
          <GitBranch className="h-4 w-4 text-teal-300" />
          {git.branch}
        </span>
        {(git.ahead ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-emerald-300">
            <ArrowUp className="h-3.5 w-3.5" />
            {git.ahead}
          </span>
        )}
        {(git.behind ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-amber-300">
            <ArrowDown className="h-3.5 w-3.5" />
            {git.behind}
          </span>
        )}
      </div>
      <section>
        <div className={`${SECTION_LABEL} mb-1.5`}>
          {t("console.changedFiles", { count: files.length })}
        </div>
        {files.length === 0 ? (
          <div className="text-xs italic text-slate-500">
            {t("console.cleanTree")}
          </div>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs">
            {files.map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-white/[0.03]"
              >
                <span
                  className={`w-3 shrink-0 font-bold ${FILE_CLS[f.status] ?? "text-slate-400"}`}
                >
                  {f.status}
                </span>
                <span className="truncate text-slate-300" title={f.path}>
                  {f.path}
                </span>
                {f.staged && (
                  <span className="ml-auto shrink-0 text-emerald-400/80">
                    {t("console.staged")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div className={`${SECTION_LABEL} mb-1.5`}>{t("console.commits")}</div>
        <ul className="space-y-1">
          {commits.map((c) => (
            <li key={c.hash} className="flex items-start gap-2 text-xs">
              <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="shrink-0 font-mono text-amber-300/90">
                {c.hash.slice(0, 7)}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-slate-200"
                title={c.message}
              >
                {c.message}
              </span>
              <span className="shrink-0 text-slate-500">{c.relative_time}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
