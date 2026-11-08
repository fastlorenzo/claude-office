"use client";

/**
 * Expanded body of one tool call, one renderer per tool (spec 2.5 table).
 * Renders from the streamed previews, or from the full payload once "Open
 * full" has loaded it (the caller passes whichever it has).
 */

import { useState, type ReactNode } from "react";
import {
  Ban,
  Check,
  Circle,
  CircleDot,
  CornerDownRight,
  Square,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { parseMcpName, rendererFor } from "@/utils/console/toolFormat";
import type { AgentNode, ToolCall } from "@/utils/console/types";
import { agentVisual } from "../theme";
import { langFromPath } from "../tokenize";
import { CodeLines, Empty, formatBytes, KV, SectionTitle } from "./code";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

export interface ToolBodyProps {
  call: ToolCall;
  /** Input: full when loaded, else the preview. */
  input: Record<string, unknown> | null;
  /** Output text: full when loaded, else the preview. */
  output: string | null;
  /** Original output size, when known. */
  outputBytes: number | null;
  /** The output shown is cut. */
  outputTruncated: boolean;
  agents: ReadonlyMap<string, AgentNode>;
}

const STDERR_SPLIT = "\n--- stderr ---\n";

function s(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sizeNote(
  shown: string,
  total: number | null,
  truncated: boolean,
  of: (a: string, b: string) => string,
): string | null {
  const a = formatBytes(new Blob([shown]).size);
  if (truncated && total) return of(a, formatBytes(total));
  return shown ? a : null;
}

function ErrorBox({ text }: { text: string }): ReactNode {
  return (
    <div className="mb-2 whitespace-pre-wrap break-words rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-200">
      {text}
    </div>
  );
}

function OutputSection({
  label,
  text,
  props,
  lang = "text",
  numbered = false,
  startLine = 1,
}: {
  label: string;
  text: string | null;
  props: ToolBodyProps;
  lang?: Parameters<typeof CodeLines>[0]["lang"];
  numbered?: boolean;
  startLine?: number;
}): ReactNode {
  const { t } = useTranslation();
  const note = text
    ? sizeNote(text, props.outputBytes, props.outputTruncated, (a, b) =>
        t("console.sizeOf", { shown: a, total: b }),
      )
    : null;
  return (
    <>
      <SectionTitle right={note}>{label}</SectionTitle>
      {text ? (
        <CodeLines
          text={text}
          lang={lang}
          numbered={numbered}
          startLine={startLine}
        />
      ) : (
        <Empty>{t("console.empty")}</Empty>
      )}
    </>
  );
}

function EditBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const path = s(p.input?.file_path) ?? p.call.target ?? "";
  const lang = langFromPath(path);
  const edits: Array<Record<string, unknown>> = Array.isArray(p.input?.edits)
    ? (p.input.edits as Array<Record<string, unknown>>)
    : [p.input ?? {}];
  return (
    <div className="space-y-2">
      {edits.map((e, i) => (
        <div key={i}>
          {edits.length > 1 && (
            <SectionTitle
              right={e.replace_all ? <KV k="replace_all" v="true" /> : null}
            >
              {t("console.editN", { n: i + 1, total: edits.length })}
            </SectionTitle>
          )}
          <DiffView
            oldText={s(e.old_string) ?? ""}
            newText={s(e.new_string) ?? ""}
            lang={lang}
          />
        </div>
      ))}
      {edits.length === 1 && p.input?.replace_all === true && (
        <div className="flex justify-end">
          <KV k="replace_all" v="true" />
        </div>
      )}
    </div>
  );
}

function WriteBody(p: ToolBodyProps): ReactNode {
  const path = s(p.input?.file_path) ?? p.call.target ?? "";
  const content = s(p.input?.content);
  const { t } = useTranslation();
  return content ? (
    <CodeLines text={content} lang={langFromPath(path)} />
  ) : (
    <Empty>{t("console.noPreview")}</Empty>
  );
}

function ReadBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const path = s(p.input?.file_path) ?? p.call.target ?? "";
  const lang = langFromPath(path);
  return (
    <OutputSection
      label={lang === "text" ? t("console.output") : lang}
      text={p.output}
      props={p}
      lang={lang}
      numbered
      startLine={Math.max(1, n(p.input?.offset) ?? 1)}
    />
  );
}

function BashBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const cmd = s(p.input?.command) ?? p.call.target ?? "";
  const desc = s(p.input?.description);
  const out = p.output ?? "";
  const cut = out.indexOf(STDERR_SPLIT);
  const stdout = cut < 0 ? out : out.slice(0, cut);
  const stderr = cut < 0 ? "" : out.slice(cut + STDERR_SPLIT.length);
  const bg = p.input?.run_in_background === true;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {desc && <span className="text-[13px] text-slate-300">{desc}</span>}
        {bg && <KV k={t("console.background")} v="true" />}
        {n(p.input?.timeout) !== null && (
          <KV k="timeout" v={`${n(p.input?.timeout)}ms`} />
        )}
      </div>
      <div className="mt-1.5">
        <CodeLines text={`$ ${cmd}`} lang="sh" shell numbered={false} />
      </div>
      <OutputSection label="stdout" text={stdout || null} props={p} />
      {(stderr || p.call.status === "error") && (
        <OutputSection
          label="stderr"
          text={stderr || null}
          props={{ ...p, outputTruncated: false }}
        />
      )}
      {p.call.status === "interrupted" && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
          <Square className="h-3 w-3" /> {t("console.status.interrupted")}
        </div>
      )}
    </div>
  );
}

function SearchBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const chips = Object.entries(p.input ?? {}).filter(
    ([, v]) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  const lines = (p.output ?? "").split("\n").filter(Boolean);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map(([k, v]) => (
          <KV key={k} k={k} v={String(v)} />
        ))}
      </div>
      <SectionTitle right={t("console.matches", { count: lines.length })}>
        {t("console.results")}
      </SectionTitle>
      {lines.length === 0 ? (
        <Empty>{t("console.noMatches")}</Empty>
      ) : (
        <SearchResults lines={lines} />
      )}
    </div>
  );
}

function SearchResults({ lines }: { lines: string[] }): ReactNode {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 40);
  return (
    <div className="rounded-lg border border-white/[0.07] bg-[#060A12] py-1 font-mono text-xs leading-[1.6]">
      {shown.map((l, i) => {
        const m = /^([^:\s]+?)(:\d+)?(:.*)?$/.exec(l);
        return (
          <div
            key={i}
            className="truncate px-3 hover:bg-white/[0.03]"
            title={l}
          >
            {m ? (
              <>
                <span className="text-sky-300">{m[1]}</span>
                {m[2] && <span className="text-amber-300">{m[2]}</span>}
                {m[3] && <span className="text-slate-300">{m[3]}</span>}
              </>
            ) : (
              <span className="text-slate-300">{l}</span>
            )}
          </div>
        );
      })}
      {lines.length > 40 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 w-full border-t border-white/[0.06] px-3 py-1 text-left text-xs text-sky-300 hover:bg-white/[0.04]"
        >
          {all
            ? t("console.showLess")
            : t("console.showAllLines", { count: lines.length })}
        </button>
      )}
    </div>
  );
}

function WebBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const url = s(p.input?.url);
  const query = s(p.input?.query);
  const prompt = s(p.input?.prompt);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {url && <KV k="url" v={url} />}
        {query && <KV k="query" v={query} />}
      </div>
      {prompt && (
        <>
          <SectionTitle>{t("console.prompt")}</SectionTitle>
          <div className="text-[13px] text-slate-300">{prompt}</div>
        </>
      )}
      <SectionTitle>{t("console.result")}</SectionTitle>
      {p.output ? (
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
          <Markdown text={p.output} />
        </div>
      ) : (
        <Empty>{t("console.empty")}</Empty>
      )}
    </div>
  );
}

function Collapsible({
  text,
  lines = 6,
}: {
  text: string;
  lines?: number;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
      <div
        className={
          open || !long
            ? ""
            : "max-h-[9.5em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
        }
      >
        <Markdown text={text} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-xs text-sky-300 hover:text-sky-200"
        >
          {open ? t("console.showLess") : t("console.showAll")}
        </button>
      )}
    </div>
  );
}

function TaskBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const prompt = s(p.input?.prompt);
  const child =
    (p.call.spawnedAgentId && p.agents.get(p.call.spawnedAgentId)) ||
    [...p.agents.values()].find((a) => a.spawnToolUseId === p.call.id);
  const v = child ? agentVisual(child.id, child, t("console.mainAgent")) : null;
  const result = child?.resultPreview ?? p.output;
  return (
    <div>
      {child && v && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-semibold"
            style={{
              color: v.color,
              borderColor: `${v.color}55`,
              background: `${v.color}18`,
            }}
          >
            <v.Icon className="h-3.5 w-3.5" />
            {v.name}
          </span>
          {v.type && <KV k={t("console.type")} v={v.type} />}
          {v.shortId && <KV k="id" v={v.shortId} />}
          <KV k={t("console.calls")} v={String(child.toolCalls)} />
          {child.errors > 0 && (
            <KV k={t("console.errors")} v={String(child.errors)} />
          )}
        </div>
      )}
      {prompt && (
        <>
          <SectionTitle>{t("console.prompt")}</SectionTitle>
          <Collapsible text={prompt} />
        </>
      )}
      <SectionTitle>
        <span className="inline-flex items-center gap-1">
          <CornerDownRight className="h-3 w-3" />
          {t("console.result")}
        </span>
      </SectionTitle>
      {result ? (
        <Collapsible text={result} lines={8} />
      ) : (
        <Empty>{t("console.noResultYet")}</Empty>
      )}
    </div>
  );
}

const TODO_ICON = {
  completed: { Icon: Check, cls: "text-emerald-400" },
  in_progress: { Icon: CircleDot, cls: "text-sky-400" },
  pending: { Icon: Circle, cls: "text-slate-500" },
} as const;

function TodoBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const todos = Array.isArray(p.input?.todos)
    ? (p.input.todos as Array<Record<string, unknown>>)
    : [];
  if (todos.length === 0) return <Empty>{t("console.empty")}</Empty>;
  return (
    <ul className="space-y-1">
      {todos.map((todo, i) => {
        const st = (s(todo.status) ?? "pending") as keyof typeof TODO_ICON;
        const { Icon, cls } = TODO_ICON[st] ?? TODO_ICON.pending;
        return (
          <li
            key={i}
            className={`flex items-start gap-2 rounded-md px-2 py-1 text-[13px] ${
              st === "in_progress" ? "bg-sky-400/10" : ""
            }`}
          >
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} />
            <span
              className={
                st === "completed"
                  ? "text-slate-500 line-through"
                  : "text-slate-200"
              }
            >
              {s(st === "in_progress" ? todo.activeForm : null) ??
                s(todo.content) ??
                ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function JsonBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const mcp = parseMcpName(p.call.toolName);
  const outLang = p.output && /^\s*[[{]/.test(p.output) ? "json" : "text";
  let pretty = p.output;
  if (outLang === "json" && p.output) {
    try {
      pretty = JSON.stringify(JSON.parse(p.output), null, 2);
    } catch {
      // keep raw
    }
  }
  return (
    <div>
      {mcp && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <KV k={t("console.server")} v={mcp.server} />
          {mcp.tool && <KV k={t("console.tool")} v={mcp.tool} />}
        </div>
      )}
      <SectionTitle>{t("console.input")}</SectionTitle>
      {p.input && Object.keys(p.input).length > 0 ? (
        <CodeLines
          text={JSON.stringify(p.input, null, 2)}
          lang="json"
          numbered={false}
        />
      ) : (
        <Empty>{t("console.empty")}</Empty>
      )}
      <OutputSection
        label={t("console.output")}
        text={pretty}
        props={p}
        lang={outLang}
      />
    </div>
  );
}

/** The expanded body for any call. */
export function ToolBody(p: ToolBodyProps): ReactNode {
  const { t } = useTranslation();
  const r = rendererFor(p.call.toolName);
  let body: ReactNode;
  switch (r) {
    case "diff":
      body = <EditBody {...p} />;
      break;
    case "write":
      body = <WriteBody {...p} />;
      break;
    case "read":
      body = <ReadBody {...p} />;
      break;
    case "bash":
      body = <BashBody {...p} />;
      break;
    case "search":
      body = <SearchBody {...p} />;
      break;
    case "web":
      body = <WebBody {...p} />;
      break;
    case "task":
      body = <TaskBody {...p} />;
      break;
    case "todo":
      body = <TodoBody {...p} />;
      break;
    default:
      body = <JsonBody {...p} />;
  }
  return (
    <div className="min-w-0">
      {p.call.error && <ErrorBox text={p.call.error} />}
      {p.call.status === "denied" && (
        <div
          className="mb-2 flex items-center gap-1.5 text-xs text-slate-400"
          title={t("console.deniedHint")}
        >
          <Ban className="h-3.5 w-3.5" /> {t("console.status.denied")}
        </div>
      )}
      {body}
    </div>
  );
}
