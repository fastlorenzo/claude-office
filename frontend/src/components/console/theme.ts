/**
 * Visual language of the Session Console (spec section 2.2): surfaces, agent
 * identity, status colours and tool icons. Shared by every console component,
 * the compact timeline, the conversation and the agent panel so the main agent
 * and each subagent look the same everywhere.
 */

import {
  Bot,
  Crown,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  Plug,
  Search,
  Terminal,
  Timer,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "@/i18n";
import { toolKindOf, type ToolKind } from "@/utils/console/toolFormat";
import type {
  AgentKind,
  AgentNode,
  ToolCallStatus,
} from "@/utils/console/types";

// ---------------------------------------------------------------------------
// Surfaces and type
// ---------------------------------------------------------------------------

/** Page / sheet surface (ops CARD). */
export const CARD =
  "rounded-2xl border border-white/[0.08] bg-[#0B111B]/95 shadow-lg shadow-black/30";
/** Small-caps section label. */
export const SECTION_LABEL =
  "text-xs font-semibold uppercase tracking-[0.14em] text-slate-400";
/** Quiet bordered button used across the console. */
export const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 disabled:opacity-40";
/** Toggle chip (filters). Combine with {@link chipOn}. */
export const CHIP =
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60";
export const CHIP_OFF =
  "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200 hover:bg-white/[0.07]";
export const CHIP_ON = "border-sky-400/50 bg-sky-400/15 text-sky-200";
/** Code panels. */
export const CODE_BOX =
  "rounded-lg border border-white/[0.07] bg-[#060A12] font-mono text-xs leading-[1.6]";

/** Collapsed row heights (spec 2.5): 28 px desktop, 44 px touch. */
export const ROW_H = 30;
export const ROW_H_TOUCH = 44;
/** Indent per agent depth level. */
export const INDENT_PX = 16;

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/** Brand orange (the header "Claude" colour) for the main agent. */
export const MAIN_COLOR = "#F97316";
const TEAMMATE_COLOR = "#A78BFA";
const BACKGROUND_COLOR = "#94A3B8";
/** Fallback subagent palette (backend normally assigns `Agent.color`). */
const SUB_PALETTE = [
  "#3B82F6",
  "#22C55E",
  "#A855F7",
  "#EC4899",
  "#14B8A6",
  "#EAB308",
  "#06B6D4",
  "#84CC16",
];

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return SUB_PALETTE[Math.abs(h) % SUB_PALETTE.length];
}

export interface AgentVisual {
  kind: AgentKind;
  color: string;
  Icon: LucideIcon;
  /** Display name: "Main agent", the Task description, or a short id. */
  name: string;
  /** Short type chip (`Explore`, `general-purpose`, ...), if any. */
  type: string | null;
  /** Short native id for hover (`a5a60c7`). */
  shortId: string | null;
}

const KIND_ICON: Record<AgentKind, LucideIcon> = {
  main: Crown,
  subagent: Bot,
  teammate: Users,
  background: Timer,
};

function shortNative(node: AgentNode | undefined, id: string): string | null {
  if (node?.nativeId) return node.nativeId.slice(0, 7);
  if (!id.startsWith("subagent_")) return null;
  const tail = id.replace(/^subagent_(toolu_)?/, "");
  return tail ? tail.slice(-7) : null;
}

/**
 * Identity of an agent id, from its tree node when known. Works for ids with
 * no node (legacy events, a frame racing its node) by inferring the kind.
 */
export function agentVisual(
  id: string,
  node: AgentNode | undefined,
  mainLabel: string,
): AgentVisual {
  const kind: AgentKind = node?.kind ?? (id === "main" ? "main" : "subagent");
  const color =
    kind === "main"
      ? MAIN_COLOR
      : kind === "teammate"
        ? (node?.color ?? TEAMMATE_COLOR)
        : kind === "background"
          ? BACKGROUND_COLOR
          : (node?.color ?? hashColor(id));
  const shortId = shortNative(node, id);
  const name =
    kind === "main"
      ? mainLabel
      : node?.name && node.name !== id
        ? node.name
        : kind === "background"
          ? `bg ${shortId ?? id}`
          : `agent ${shortId ?? id}`;
  return {
    kind,
    color,
    Icon: KIND_ICON[kind],
    name,
    type: node?.agentType ?? null,
    shortId,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusStyle {
  /** Text colour class for the glyph and status label. */
  text: string;
  /** Row background tint, if any. */
  tint: string;
  /** Hex used for rails/overlays. */
  hex: string;
  labelKey: TranslationKey;
}

export const STATUS_STYLE: Record<ToolCallStatus, StatusStyle> = {
  running: {
    text: "text-sky-400",
    tint: "",
    hex: "#38BDF8",
    labelKey: "console.status.running",
  },
  spawned: {
    text: "text-sky-400",
    tint: "",
    hex: "#38BDF8",
    labelKey: "console.status.spawned",
  },
  waiting_permission: {
    text: "text-amber-300",
    tint: "bg-amber-400/[0.09]",
    hex: "#FBBF24",
    labelKey: "console.status.waiting",
  },
  ok: {
    text: "text-emerald-400",
    tint: "",
    hex: "#34D399",
    labelKey: "console.status.ok",
  },
  error: {
    text: "text-rose-400",
    tint: "bg-rose-500/10",
    hex: "#FB7185",
    labelKey: "console.status.error",
  },
  denied: {
    text: "text-slate-500",
    tint: "",
    hex: "#64748B",
    labelKey: "console.status.denied",
  },
  interrupted: {
    text: "text-slate-400",
    tint: "",
    hex: "#94A3B8",
    labelKey: "console.status.interrupted",
  },
};

export function isLive(status: ToolCallStatus): boolean {
  return (
    status === "running" ||
    status === "spawned" ||
    status === "waiting_permission"
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  bash: Terminal,
  search: Search,
  web: Globe,
  agent: Bot,
  mcp: Plug,
  other: Wrench,
};

/** Lucide icon for a tool name (spec 2.2 tool icon table). */
export function toolIcon(toolName: string): LucideIcon {
  if (toolName === "TodoWrite") return ListChecks;
  return KIND_ICONS[toolKindOf(toolName)];
}

/** Icon per filter bucket (filter chips). */
export function kindIcon(kind: ToolKind): LucideIcon {
  return KIND_ICONS[kind];
}

/** i18n key for each filter bucket. */
export const KIND_LABEL: Record<ToolKind, TranslationKey> = {
  read: "console.kind.read",
  edit: "console.kind.edit",
  bash: "console.kind.bash",
  search: "console.kind.search",
  web: "console.kind.web",
  agent: "console.kind.agent",
  mcp: "console.kind.mcp",
  other: "console.kind.other",
};
