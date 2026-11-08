"use client";

/**
 * Agent tree (spec 2.4): main agent at the root, subagents nested under the
 * agent that spawned them, each with its colour, icon, name, type, state,
 * call/error counts and elapsed time. Click filters the timeline to that
 * node and its descendants; shift-click adds; double-click locates the spawn
 * row. `AgentChipBar` is the compact one-line variant.
 */

import { memo, useMemo, type ReactNode } from "react";
import { Check, CornerDownRight, X } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { formatDuration } from "@/utils/console/toolFormat";
import type { AgentNode } from "@/utils/console/types";
import { elapsedMs, useConsoleNow } from "./clock";
import { agentVisual, CHIP, INDENT_PX, SECTION_LABEL } from "./theme";

type NodeState = "running" | "done" | "zombie" | "idle";

/** Coarse state of a node for glyphs and dimming. */
export function nodeState(a: AgentNode): NodeState {
  const s = a.state.toLowerCase();
  if (s === "zombie") return "zombie";
  if (a.kind === "main")
    return s === "idle" || s === "ended" ? "idle" : "running";
  if (a.endedAt || s === "done" || s === "completed" || s === "ended")
    return "done";
  return "running";
}

function StateGlyph({ st }: { st: NodeState }): ReactNode {
  if (st === "running")
    return (
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        <span className="absolute h-2 w-2 rounded-full bg-sky-400/60 motion-safe:animate-ping" />
        <span className="h-2 w-2 rounded-full bg-sky-400" />
      </span>
    );
  if (st === "done")
    return <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={3} />;
  if (st === "zombie")
    return <X className="h-3.5 w-3.5 text-rose-400" strokeWidth={3} />;
  return <span className="inline-block h-2 w-2 rounded-full bg-slate-500" />;
}

interface Flat {
  node: AgentNode;
  depth: number;
  last: boolean;
}

/** Depth-first order: main first, children by start time. */
export function orderAgents(agents: ReadonlyMap<string, AgentNode>): Flat[] {
  const kids = new Map<string | null, AgentNode[]>();
  for (const a of agents.values()) {
    const p =
      a.parentId && agents.has(a.parentId)
        ? a.parentId
        : a.id === "main"
          ? null
          : agents.has("main")
            ? "main"
            : null;
    let l = kids.get(p);
    if (!l) kids.set(p, (l = []));
    l.push(a);
  }
  const by = (x: AgentNode, y: AgentNode) =>
    (x.kind === "main" ? -1 : 0) - (y.kind === "main" ? -1 : 0) ||
    (x.startedAt ?? "").localeCompare(y.startedAt ?? "");
  const out: Flat[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null, depth: number) => {
    const list = (kids.get(p) ?? []).slice().sort(by);
    list.forEach((a, i) => {
      if (seen.has(a.id) || depth > 16) return;
      seen.add(a.id);
      out.push({ node: a, depth, last: i === list.length - 1 });
      walk(a.id, depth + 1);
    });
  };
  walk(null, 0);
  return out;
}

const AgentNodeRow = memo(function AgentNodeRow({
  node,
  depth,
  selected,
  onPick,
  onLocate,
}: {
  node: AgentNode;
  depth: number;
  selected: boolean;
  onPick: (id: string, additive: boolean) => void;
  onLocate?: (id: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const v = agentVisual(node.id, node, t("console.mainAgent"));
  const st = nodeState(node);
  const now = useConsoleNow(st === "running" && node.kind !== "main");
  const elapsed = node.startedAt
    ? node.endedAt
      ? Date.parse(node.endedAt) - Date.parse(node.startedAt)
      : node.kind === "main"
        ? null
        : elapsedMs(node.startedAt, now)
    : null;
  const second =
    st === "running"
      ? node.currentActivity
      : node.resultPreview?.replace(/\s+/g, " ");
  const stateLabel =
    st === "running"
      ? node.kind === "main"
        ? t("console.agentState.working")
        : t("console.agentState.running")
      : st === "done"
        ? t("console.agentState.done")
        : st === "zombie"
          ? t("console.agentState.zombie")
          : t("console.agentState.idle");
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={depth + 1}
      tabIndex={-1}
      onClick={(e) => onPick(node.id, e.shiftKey)}
      onDoubleClick={() => onLocate?.(node.id)}
      title={node.taskPreview ?? v.name}
      className={`relative cursor-pointer rounded-lg py-1.5 pr-2 transition-colors ${
        selected ? "bg-white/[0.08] ring-1 ring-inset" : "hover:bg-white/[0.04]"
      } ${st === "done" || st === "zombie" ? "opacity-70" : ""}`}
      style={{
        paddingLeft: 12 + depth * INDENT_PX,
        ...(selected ? { ["--tw-ring-color" as string]: `${v.color}80` } : {}),
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-[3px] rounded-full"
        style={{ background: v.color }}
      />
      {depth > 0 && (
        <span
          aria-hidden
          className="absolute top-0 h-[18px] w-[9px] rounded-bl-md border-b-2 border-l-2"
          style={{
            left: 12 + (depth - 1) * INDENT_PX + 3,
            borderColor: "rgba(148,163,184,0.25)",
          }}
        />
      )}
      <div className="flex items-center gap-1.5">
        <v.Icon
          className="h-4 w-4 shrink-0"
          style={{ color: v.color }}
          aria-hidden
        />
        <span
          className="min-w-0 truncate text-[13px] font-semibold"
          style={{ color: node.kind === "main" ? v.color : "#E2E8F0" }}
        >
          {v.name}
        </span>
        <span
          className="ml-auto flex shrink-0 items-center gap-1.5"
          title={stateLabel}
        >
          {elapsed !== null && elapsed > 0 && (
            <span className="font-mono text-xs tabular-nums text-slate-500">
              {formatDuration(elapsed)}
            </span>
          )}
          <StateGlyph st={st} />
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap pl-[22px] text-xs text-slate-500">
        {v.type && (
          <span
            className="shrink-0 rounded px-1.5 leading-5 text-slate-300"
            style={{ background: `${v.color}22` }}
          >
            {v.type}
          </span>
        )}
        <span>{stateLabel}</span>
        <span>· {t("console.nCalls", { count: node.toolCalls })}</span>
        {node.errors > 0 && (
          <span className="text-rose-400">
            · {t("console.nErrors", { count: node.errors })}
          </span>
        )}
      </div>
      {second && (
        <div className="mt-0.5 flex items-center gap-1 pl-[22px] text-xs text-slate-400">
          <CornerDownRight className="h-3 w-3 shrink-0 text-slate-600" />
          <span className="truncate font-mono">{second}</span>
        </div>
      )}
    </div>
  );
});

export function AgentTree({
  agents,
  selected,
  onPick,
  onLocate,
  showHeader = true,
}: {
  agents: ReadonlyMap<string, AgentNode>;
  /** Agent ids picked as timeline filter roots. */
  selected: readonly string[];
  onPick: (id: string, additive: boolean) => void;
  onLocate?: (id: string) => void;
  showHeader?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const flat = useMemo(() => orderAgents(agents), [agents]);
  const running = flat.filter((f) => nodeState(f.node) === "running").length;
  return (
    <div className="flex min-h-0 flex-col">
      {showHeader && (
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <span className={SECTION_LABEL}>{t("console.agents")}</span>
          <span className="text-xs text-slate-500">
            {t("console.agentsSummary", { count: flat.length, running })}
          </span>
        </div>
      )}
      <div
        role="tree"
        aria-label={t("console.agents")}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2"
      >
        {flat.length === 0 ? (
          <div className="px-3 py-4 text-xs italic text-slate-500">
            {t("agentStatus.noAgents")}
          </div>
        ) : (
          flat.map((f) => (
            <AgentNodeRow
              key={f.node.id}
              node={f.node}
              depth={f.depth}
              selected={selected.includes(f.node.id)}
              onPick={onPick}
              onLocate={onLocate}
            />
          ))
        )}
      </div>
      {showHeader && selected.length > 0 && (
        <div className="border-t border-white/[0.06] px-3 py-1.5 text-xs text-slate-500">
          {t("console.treeFilterHint")}
        </div>
      )}
    </div>
  );
}

/** One-line agent filter: `[All] [♛ Main] [◆ Audit… ◌] [◆ Review… ✓]`. */
export function AgentChipBar({
  agents,
  selected,
  onPick,
  touch = false,
}: {
  agents: ReadonlyMap<string, AgentNode>;
  selected: readonly string[];
  onPick: (id: string | null, additive: boolean) => void;
  touch?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const flat = useMemo(() => orderAgents(agents), [agents]);
  if (flat.length <= 1) return null;
  const h = touch ? "min-h-[36px]" : "min-h-[26px]";
  return (
    <div
      role="toolbar"
      aria-label={t("console.agentFilter")}
      className="flex items-center gap-1.5 overflow-x-auto px-2.5 py-1.5 [scrollbar-width:thin]"
    >
      <button
        type="button"
        onClick={() => onPick(null, false)}
        aria-pressed={selected.length === 0}
        className={`${CHIP} ${h} shrink-0 ${selected.length === 0 ? "border-white/25 bg-white/10 text-slate-100" : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200"}`}
      >
        {t("console.allAgents")}
      </button>
      {flat.map(({ node }) => {
        const v = agentVisual(node.id, node, t("console.mainAgent"));
        const on = selected.includes(node.id);
        const st = nodeState(node);
        return (
          <button
            key={node.id}
            type="button"
            aria-pressed={on}
            onClick={(e) => onPick(node.id, e.shiftKey)}
            title={[v.name, v.type, node.taskPreview?.slice(0, 200)]
              .filter(Boolean)
              .join(" · ")}
            className={`${CHIP} ${h} max-w-[12rem] shrink-0 ${st === "done" ? "opacity-75" : ""}`}
            style={{
              color: v.color,
              borderColor: on ? `${v.color}` : `${v.color}40`,
              background: on ? `${v.color}30` : `${v.color}12`,
            }}
          >
            <v.Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-semibold">{v.name}</span>
            <StateGlyph st={st} />
          </button>
        );
      })}
    </div>
  );
}
