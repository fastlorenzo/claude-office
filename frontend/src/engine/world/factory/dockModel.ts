/**
 * Pure helpers for the shipping dock: release-shelf slotting, departures
 * board line formatting and truck/door livery layout. No Babylon, no DOM.
 */
import type {
  BrandingOptions,
  CheckState,
  PipelineRun,
  ReleaseInfo,
} from "@/engine/contracts";
import { CI_COLORS, SESSION_COLORS } from "@/engine/logic/statusPalette";
import {
  layoutBrand,
  type BrandLayout,
  type Measure,
} from "@/engine/world/brandLayout";

// ----------------------------------------------------------------- shelves

export const SHELF = {
  bays: 3,
  cols: 4,
  levels: 3,
} as const;
export const SHELF_CAPACITY = SHELF.bays * SHELF.cols * SHELF.levels;
/** Fill order of levels: eye level first, then low, then high. */
const LEVEL_ORDER = [1, 0, 2] as const;
export const MAX_TAG_CHARS = 10;

export interface ShelfSlot {
  /** Index in newest-first order. */
  index: number;
  bay: number;
  col: number;
  level: number;
  /** Label text (tag, trimmed). */
  label: string;
  prerelease: boolean;
  tag: string;
}

export function shortTag(tag: string, max = MAX_TAG_CHARS): string {
  const t = (tag ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function ts(r: ReleaseInfo): number {
  const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/** Newest first (undated last, input order kept), capped at capacity. */
export function sortReleases(list: readonly ReleaseInfo[]): ReleaseInfo[] {
  return list
    .map((r, i) => ({ r, i }))
    .filter((x) => !!x.r.tag)
    .sort((a, b) => ts(b.r) - ts(a.r) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Newest release gets bay 0 / eye level / col 0; slots fill level-major
 * (eye row across all bays, then the low row, then the high row).
 */
export function slotReleases(
  list: readonly ReleaseInfo[],
  capacity = SHELF_CAPACITY,
): ShelfSlot[] {
  const sorted = sortReleases(list).slice(
    0,
    Math.min(capacity, SHELF_CAPACITY),
  );
  const out: ShelfSlot[] = [];
  let i = 0;
  outer: for (const level of LEVEL_ORDER) {
    for (let bay = 0; bay < SHELF.bays; bay++) {
      for (let col = 0; col < SHELF.cols; col++) {
        const r = sorted[i];
        if (!r) break outer;
        out.push({
          index: i,
          bay,
          col,
          level,
          label: shortTag(r.tag),
          prerelease: !!r.prerelease,
          tag: r.tag,
        });
        i++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- board

export type BoardKind = "deploy" | "release";

export interface BoardLine {
  kind: BoardKind;
  /** Left column, e.g. "DEPLOY" / "RELEASE". */
  type: string;
  name: string;
  ref: string;
  status: string;
  state: CheckState | "shipped" | "prerelease";
  color: string;
  age: string;
}

export const BOARD_ROWS = 6;
export const BOARD_NAME_CHARS = 16;
export const BOARD_REF_CHARS = 12;

export const STATE_COLORS: Record<string, string> = {
  ...CI_COLORS,
  shipped: CI_COLORS.success,
  prerelease: SESSION_COLORS.needs_you,
};

const DEPLOY_LABEL: Record<CheckState, string> = {
  success: "DELIVERED",
  running: "DEPARTING",
  failure: "FAILED",
  queued: "QUEUED",
  cancelled: "CANCELLED",
  none: "IDLE",
};

export function truncate(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** "now", "5m", "3h", "2d", "6w", "" for unknown. */
export function formatAge(
  iso: string | null | undefined,
  nowMs: number,
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

const STATE_RANK: Record<string, number> = {
  running: 0,
  queued: 1,
  failure: 2,
  success: 3,
  cancelled: 4,
  none: 5,
};

export function deployLine(p: PipelineRun, nowMs: number): BoardLine {
  return {
    kind: "deploy",
    type: p.kind === "release" ? "RELEASE" : "DEPLOY",
    name: truncate(p.workflow, BOARD_NAME_CHARS),
    ref: truncate(p.branch ?? "", BOARD_REF_CHARS),
    status: DEPLOY_LABEL[p.state] ?? "IDLE",
    state: p.state,
    color: STATE_COLORS[p.state] ?? STATE_COLORS.none,
    age: formatAge(p.startedAt, nowMs),
  };
}

export function releaseLine(r: ReleaseInfo, nowMs: number): BoardLine {
  const pre = !!r.prerelease;
  return {
    kind: "release",
    type: "RELEASE",
    name: truncate(r.name || r.tag, BOARD_NAME_CHARS),
    ref: truncate(r.tag, BOARD_REF_CHARS),
    status: pre ? "PRE-RELEASE" : "SHIPPED",
    state: pre ? "prerelease" : "shipped",
    color: STATE_COLORS[pre ? "prerelease" : "shipped"],
    age: formatAge(r.publishedAt, nowMs),
  };
}

/**
 * Departures board: live deploys first (running, queued, failed, then done by
 * recency), then releases newest-first; capped at `rows`.
 */
export function boardLines(
  releases: readonly ReleaseInfo[],
  pipelines: readonly PipelineRun[],
  nowMs: number,
  rows = BOARD_ROWS,
): BoardLine[] {
  const deploys = pipelines
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.kind === "deploy" || x.p.kind === "release")
    .sort((a, b) => {
      const ra = STATE_RANK[a.p.state] ?? 9;
      const rb = STATE_RANK[b.p.state] ?? 9;
      if (ra !== rb) return ra - rb;
      const ta = a.p.startedAt ? Date.parse(a.p.startedAt) : 0;
      const tb = b.p.startedAt ? Date.parse(b.p.startedAt) : 0;
      return (tb || 0) - (ta || 0) || a.i - b.i;
    })
    .map((x) => deployLine(x.p, nowMs));
  const rel = sortReleases(releases).map((r) => releaseLine(r, nowMs));
  return [...deploys, ...rel].slice(0, rows);
}

// ----------------------------------------------------------------- livery

export interface LiveryLayout {
  /** Brand block (logo + name + tagline) in pixel space. */
  brand: BrandLayout;
  /** Rect the brand block was fitted into. */
  box: { x: number; y: number; w: number; h: number };
  /** Accent band along the bottom (px). */
  band: { y: number; h: number };
  /** Swoosh anchor at the rear (left) end: width fraction of the panel. */
  swooshW: number;
}

/**
 * Trailer side livery: brand block centred in the upper two thirds, an accent
 * band along the bottom, a swoosh at the rear. Text always fits the box.
 */
export function liveryLayout(
  b: Pick<BrandingOptions, "name" | "tagline" | "logo">,
  width: number,
  height: number,
  measure: Measure,
): LiveryLayout {
  const bandH = height * 0.07;
  const box = {
    x: width * 0.16,
    y: height * 0.12,
    w: width * 0.68,
    h: height * 0.62,
  };
  const lay = layoutBrand(b, box.w, box.h, measure);
  const shift = <T extends { x: number; y: number }>(o: T | null): T | null =>
    o ? { ...o, x: o.x + box.x, y: o.y + box.y } : null;
  return {
    brand: {
      logo: shift(lay.logo),
      name: shift(lay.name),
      tagline: shift(lay.tagline),
    },
    box,
    band: { y: height - bandH * 1.9, h: bandH },
    swooshW: 0.16,
  };
}

/** Single-line door mark (logo + name), fitted into w x h. */
export function doorMarkLayout(
  b: Pick<BrandingOptions, "name" | "logo">,
  width: number,
  height: number,
  measure: Measure,
): BrandLayout {
  return layoutBrand(
    { name: b.name, tagline: "", logo: b.logo },
    width,
    height,
    measure,
  );
}

/** Mix "#rrggbb" toward white (t>0) or black (t<0). */
export function shade(hex: string, t: number): string {
  const v = hex.replace("#", "");
  const n = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  const out = n.map((c) => {
    const k = t >= 0 ? c + (255 - c) * t : c * (1 + t);
    return Math.max(0, Math.min(255, Math.round(k)));
  });
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
