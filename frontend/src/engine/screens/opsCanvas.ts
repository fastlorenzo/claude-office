/**
 * Canvas renderers for the control-room ops wall and console monitors. Every
 * panel reads the shared OpsModel (engine/logic/opsModel.ts), the same data
 * the DOM Ops dashboard renders, and draws in one small design system:
 *
 *   - one sans stack (Geist / Inter) + one mono stack for figures
 *   - type scale in centimetres of wall (`u` = texture px per cm), so text
 *     keeps its physical size whatever the texture resolution
 *   - dark graphite/navy surfaces, status colours from STATUS_COLORS,
 *     amber = needs you, cyan = neutral data, red = over a limit
 *
 * Pure canvas (no Babylon): callers own the DynamicTexture.
 */

import { STATUS_COLORS } from "../contracts";
import {
  alertText,
  contextTone,
  fmtCount,
  fmtPct,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  kindColor,
  limitTone,
  phaseColor,
  TONE_COLORS,
  type OpsModel,
  type OpsRow,
  type OpsWindow,
} from "../logic/opsModel";
import { PHASE_LABEL_EN } from "../logic/sessionInfo";
import {
  fitText,
  roundRect,
  screenFonts,
  withAlpha,
  wrapText,
  type Ctx2D,
} from "./canvasKit";

export { phaseColor };

export const OPS_THEME = {
  bg0: "#070B12",
  bg1: "#0B111B",
  card: "#101826",
  cardHi: "#152033",
  line: "rgba(148,163,184,0.18)",
  lineSoft: "rgba(148,163,184,0.08)",
  text: "#EAF0F8",
  sub: "#A3B1C4",
  muted: "#6B7A90",
  accent: "#38BDF8",
  amber: STATUS_COLORS.needs_you,
  red: "#EF4444",
  green: "#22C55E",
  add: "#4ADE80",
  del: "#F87171",
  track: "rgba(148,163,184,0.16)",
} as const;
const C = OPS_THEME;

type Weight = 400 | 500 | 600 | 700;

interface TextOpts {
  size: number;
  color?: string;
  weight?: Weight;
  mono?: boolean;
  align?: CanvasTextAlign;
  max?: number;
  caps?: boolean;
}

function font(size: number, weight: Weight = 500, mono = false): string {
  const F = screenFonts();
  return `${weight} ${Math.round(size)}px ${mono ? F.mono : F.sans}`;
}

/** Draws one line (baseline = middle). Returns the drawn width. */
function text(
  ctx: Ctx2D,
  s: string,
  x: number,
  y: number,
  o: TextOpts,
): number {
  ctx.font = font(o.size, o.weight ?? 500, o.mono);
  ctx.fillStyle = o.color ?? C.text;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = "middle";
  let v = o.caps ? s.toUpperCase() : s;
  if (o.caps) ctx.letterSpacing = `${Math.round(o.size * 0.08)}px`;
  if (o.max != null) v = fitText(ctx, v, o.max);
  ctx.fillText(v, x, y);
  const w = ctx.measureText(v).width;
  if (o.caps) ctx.letterSpacing = "0px";
  ctx.textAlign = "left";
  return w;
}

function measure(
  ctx: Ctx2D,
  s: string,
  size: number,
  weight: Weight = 500,
  mono = false,
) {
  ctx.font = font(size, weight, mono);
  return ctx.measureText(s).width;
}

function dot(ctx: Ctx2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function chip(
  ctx: Ctx2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  filled = false,
): number {
  const w = measure(ctx, s, size, 600, true) + size * 0.9;
  const h = size * 1.45;
  roundRect(ctx, x, y - h / 2, w, h, h * 0.28);
  ctx.fillStyle = filled ? color : withAlpha(color, 0.16);
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeStyle = withAlpha(color, 0.6);
  ctx.stroke();
  text(ctx, s, x + w / 2, y + size * 0.04, {
    size,
    weight: 600,
    mono: true,
    align: "center",
    color: filled ? "#0B0F16" : color,
  });
  return w;
}

function bar(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  color: string,
) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = C.track;
  ctx.fill();
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0) {
    roundRect(ctx, x, y, Math.max(h, w * f), h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Line + soft fill sparkline, oldest left. */
export function spark(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  data: number[],
  color: string,
  opts: { max?: number; fill?: boolean; line?: number } = {},
) {
  if (data.length < 2) {
    ctx.strokeStyle = C.lineSoft;
    ctx.lineWidth = Math.max(1, h * 0.03);
    ctx.beginPath();
    ctx.moveTo(x, y + h - 1);
    ctx.lineTo(x + w, y + h - 1);
    ctx.stroke();
    return;
  }
  const max = Math.max(1e-6, opts.max ?? Math.max(...data));
  const step = w / (data.length - 1);
  const py = (v: number) => y + h - (Math.max(0, v) / max) * h * 0.94;
  ctx.beginPath();
  data.forEach((v, i) => {
    if (i === 0) ctx.moveTo(x, py(v));
    else ctx.lineTo(x + i * step, py(v));
  });
  if (opts.fill !== false) {
    ctx.save();
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, withAlpha(color, 0.38));
    g.addColorStop(1, withAlpha(color, 0.02));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    data.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x, py(v));
      else ctx.lineTo(x + i * step, py(v));
    });
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = opts.line ?? Math.max(1.5, h * 0.035);
  ctx.lineJoin = "round";
  ctx.stroke();
}

function panelBg(ctx: Ctx2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, C.bg1);
  g.addColorStop(1, C.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Panel title row: small caps title, optional subtitle, accent hairline. */
function header(
  ctx: Ctx2D,
  u: number,
  w: number,
  title: string,
  sub: string | null,
  right: string | null,
): number {
  const y = 7 * u;
  const tw = text(ctx, title, 6 * u, y, {
    size: 6 * u,
    weight: 700,
    caps: true,
    color: C.sub,
  });
  if (sub)
    text(ctx, sub, 6 * u + tw + 3 * u, y, {
      size: 5.4 * u,
      color: C.muted,
      max: w * 0.45,
    });
  if (right)
    text(ctx, right, w - 6 * u, y, {
      size: 5.4 * u,
      color: C.muted,
      align: "right",
      mono: true,
    });
  ctx.fillStyle = C.line;
  ctx.fillRect(6 * u, 13 * u, w - 12 * u, Math.max(1, 0.25 * u));
  return 13 * u;
}

// ============================================================================
// SESSIONS BOARD
// ============================================================================

/** Column layout as fractions of the inner width (shared by header + rows). */
const COLS = {
  project: [0.0, 0.31],
  phase: [0.315, 0.205],
  context: [0.53, 0.14],
  cost: [0.685, 0.095],
  lines: [0.785, 0.075],
  model: [0.865, 0.085],
  crew: [0.955, 0.045],
} as const;

/** Sessions board: one row per live session, sorted needs-you first. */
export function drawSessionsBoard(
  ctx: Ctx2D,
  W: number,
  H: number,
  m: OpsModel,
  u: number,
) {
  panelBg(ctx, W, H);
  const c = m.counts;
  const top = header(
    ctx,
    u,
    W,
    "Sessions",
    `${c.live} live · ${c.subagents} subagents`,
    null,
  );
  // Count chips (right side of the header).
  let cx = W - 6 * u;
  const chips: Array<[string, number, string]> = [
    ["IDLE", c.done, STATUS_COLORS.done],
    ["WORKING", c.working, STATUS_COLORS.working],
    ["NEEDS YOU", c.needs_you, STATUS_COLORS.needs_you],
  ];
  for (const [label, n, col] of chips) {
    const s = `${n} ${label}`;
    const w = measure(ctx, s, 5 * u, 600, true) + 5 * u * 0.9;
    cx -= w;
    chip(ctx, s, cx, 7 * u, 5 * u, col, label === "NEEDS YOU" && n > 0);
    cx -= 2.5 * u;
  }

  const x0 = 6 * u;
  const iw = W - 12 * u;
  const col = (k: keyof typeof COLS) => ({
    x: x0 + COLS[k][0] * iw,
    w: COLS[k][1] * iw,
  });
  // Column headings.
  const hy = top + 5 * u;
  const hs = {
    size: 4.4 * u,
    weight: 600 as Weight,
    caps: true,
    color: C.muted,
  };
  text(ctx, "Project · what it's building", col("project").x + 3 * u, hy, hs);
  text(ctx, "Now", col("phase").x, hy, hs);
  text(ctx, "Context", col("context").x, hy, hs);
  text(ctx, "Cost · time", col("cost").x, hy, hs);
  text(ctx, "Lines", col("lines").x, hy, hs);
  text(ctx, "Model", col("model").x, hy, hs);
  text(ctx, "Crew", col("crew").x, hy, hs);

  const live = m.rows.filter((r) => r.status !== "ended");
  const ended = m.rows.length - live.length;
  const bodyY = hy + 4.5 * u;
  const bodyH = H - bodyY - 3 * u;
  if (live.length === 0) {
    text(ctx, "No live sessions", W / 2, bodyY + bodyH * 0.4, {
      size: 9 * u,
      weight: 600,
      color: C.sub,
      align: "center",
    });
    text(
      ctx,
      "Start Claude Code anywhere and it shows up here",
      W / 2,
      bodyY + bodyH * 0.4 + 10 * u,
      { size: 6 * u, color: C.muted, align: "center" },
    );
    return;
  }
  const fullH = 23 * u;
  const compactH = 13 * u;
  const footer = 7 * u;
  let rowH = fullH;
  let k = 1; // row scale: fewer sessions → taller rows, bigger text
  let fit = Math.floor(bodyH / rowH);
  if (live.length <= fit) {
    rowH = Math.min(fullH * 1.45, bodyH / Math.max(4, live.length));
    k = Math.max(1, rowH / fullH);
    fit = Math.floor(bodyH / rowH);
  } else {
    rowH = Math.max(compactH, Math.min(fullH, bodyH / live.length));
    fit = Math.floor(bodyH / rowH);
  }
  const shown = live.slice(0, live.length > fit ? fit - 1 : fit);
  const compact = rowH < 19 * u;
  shown.forEach((r, i) => {
    drawRow(
      ctx,
      r,
      x0,
      bodyY + i * rowH,
      iw,
      rowH - 1.4 * u,
      u * k,
      compact,
      col,
    );
  });
  const rest = live.length - shown.length;
  if (rest > 0 || ended > 0) {
    const fy = bodyY + shown.length * rowH + footer / 2;
    const parts: string[] = [];
    if (rest > 0) parts.push(`+${rest} more live`);
    if (ended > 0) parts.push(`${ended} ended`);
    text(ctx, parts.join("  ·  "), x0 + 3 * u, fy, {
      size: 5 * u,
      color: C.muted,
    });
  }
}

function drawRow(
  ctx: Ctx2D,
  r: OpsRow,
  x: number,
  y: number,
  w: number,
  h: number,
  u: number,
  compact: boolean,
  col: (k: keyof typeof COLS) => { x: number; w: number },
) {
  const sc = STATUS_COLORS[r.status];
  const needs = r.status === "needs_you";
  roundRect(ctx, x, y, w, h, 1.6 * u);
  ctx.fillStyle = needs ? withAlpha(sc, 0.13) : C.card;
  ctx.fill();
  if (needs) {
    ctx.strokeStyle = withAlpha(sc, 0.55);
    ctx.lineWidth = Math.max(1, 0.35 * u);
    ctx.stroke();
  }
  // Status stripe.
  roundRect(ctx, x, y, 1.1 * u, h, 0.55 * u);
  ctx.fillStyle = sc;
  ctx.fill();

  const l1 = compact ? y + h / 2 : y + h * 0.33;
  const l2 = y + h * 0.72;
  const big = compact ? 6.4 * u : 7.6 * u;
  const body = compact ? 5.4 * u : 6.0 * u;
  const small = 5.2 * u;

  // Project + refs + alive marker.
  const p = col("project");
  const px = p.x + 3.4 * u;
  dot(ctx, px + 1.2 * u, l1, 1.2 * u, r.alive ? sc : "transparent");
  if (!r.alive) {
    ctx.strokeStyle = C.muted;
    ctx.lineWidth = Math.max(1, 0.3 * u);
    ctx.beginPath();
    ctx.arc(px + 1.2 * u, l1, 1.1 * u, 0, Math.PI * 2);
    ctx.stroke();
  }
  const nameX = px + 3.6 * u;
  const pw = text(ctx, r.project, nameX, l1, {
    size: big,
    weight: 700,
    max: p.w * 0.55,
  });
  let rx = nameX + pw + 2 * u;
  for (const ref of r.refs) {
    const cw = measure(ctx, ref, 4.4 * u, 600, true) + 4.4 * u * 0.9;
    if (rx + cw > p.x + p.w - 2 * u) break;
    chip(ctx, ref, rx, l1, 4.4 * u, "#94A3B8");
    rx += cw + 1.2 * u;
  }
  if (!compact)
    text(ctx, r.summary ?? r.branch ?? "No description yet", nameX, l2, {
      size: body,
      color: r.summary ? C.sub : C.muted,
      max: p.w - (nameX - p.x) - 2 * u,
    });

  // Phase.
  const ph = col("phase");
  const pc = phaseColor(r.phaseKind);
  dot(ctx, ph.x + 1.1 * u, l1, 1.1 * u, pc);
  const label = r.phaseLabel || PHASE_LABEL_EN[r.phaseKind];
  text(ctx, label, ph.x + 3.4 * u, l1, {
    size: body,
    weight: 600,
    color: needs ? sc : C.text,
    max: ph.w - 4 * u,
  });
  if (!compact) {
    const bits = [
      r.phaseDetail,
      r.phaseElapsed ? `for ${r.phaseElapsed}` : null,
    ];
    if (r.idleFor && r.status !== "working") bits.push(`idle ${r.idleFor}`);
    text(ctx, bits.filter(Boolean).join(" · ") || "—", ph.x + 3.4 * u, l2, {
      size: small,
      color: C.muted,
      max: ph.w - 4 * u,
    });
  }

  // Context bar.
  const cxl = col("context");
  const tone = TONE_COLORS[contextTone(r.contextPct)];
  const pctW = 11 * u;
  text(ctx, fmtPct(r.contextPct), cxl.x, l1, {
    size: body,
    weight: 700,
    mono: true,
    color: r.contextPct != null && r.contextPct >= 70 ? tone : C.text,
  });
  bar(
    ctx,
    cxl.x + pctW,
    l1 - 1 * u,
    cxl.w - pctW - 3 * u,
    2 * u,
    (r.contextPct ?? 0) / 100,
    tone,
  );
  if (!compact)
    text(
      ctx,
      r.contextTokens != null
        ? `${fmtTokens(r.contextTokens)} / ${fmtTokens(r.contextWindow)}`
        : "—",
      cxl.x,
      l2,
      { size: small, color: C.muted, mono: true },
    );

  // Cost + session time.
  const co = col("cost");
  text(ctx, fmtUsd(r.costUsd), co.x, l1, {
    size: body,
    weight: 600,
    mono: true,
    max: co.w,
  });
  if (!compact)
    text(ctx, fmtSpan(r.durationMs), co.x, l2, {
      size: small,
      color: C.muted,
      mono: true,
    });

  // Lines.
  const li = col("lines");
  if (compact) {
    const s = r.linesAdded != null ? `+${fmtCount(r.linesAdded)}` : "—";
    text(ctx, s, li.x, l1, { size: small, color: C.add, mono: true });
  } else {
    text(
      ctx,
      r.linesAdded != null ? `+${fmtCount(r.linesAdded)}` : "—",
      li.x,
      l1,
      {
        size: body,
        color: r.linesAdded != null ? C.add : C.muted,
        mono: true,
        weight: 600,
      },
    );
    text(
      ctx,
      r.linesRemoved != null ? `−${fmtCount(r.linesRemoved)}` : "",
      li.x,
      l2,
      { size: small, color: C.del, mono: true },
    );
  }

  // Model / effort / cache.
  const mo = col("model");
  text(ctx, r.model ?? "—", mo.x, l1, {
    size: body,
    weight: 600,
    max: mo.w - 1.5 * u,
    color: r.model ? C.text : C.muted,
  });
  if (!compact) {
    const cache =
      r.cacheMinsLeft == null
        ? null
        : r.cacheMinsLeft === 0
          ? "cache cold"
          : `cache ${r.cacheMinsLeft}m`;
    const low = r.cacheMinsLeft != null && r.cacheMinsLeft <= 5;
    const eff = r.effort ?? "";
    const ew = eff
      ? text(ctx, eff, mo.x, l2, {
          size: small,
          color: C.muted,
          max: mo.w * 0.45,
        })
      : 0;
    if (cache)
      text(ctx, (eff ? " · " : "") + cache, mo.x + ew, l2, {
        size: small,
        color: low ? C.amber : C.muted,
        max: mo.w - ew - 1 * u,
      });
  }

  // Crew: subagents + todos.
  const cr = col("crew");
  text(ctx, `${r.subagents}`, cr.x, l1, {
    size: body,
    weight: 700,
    mono: true,
    color: r.subagents ? C.accent : C.muted,
  });
  text(
    ctx,
    r.subagents === 1 ? "agent" : "agents",
    cr.x + measure(ctx, `${r.subagents}`, body, 700, true) + 1 * u,
    l1,
    {
      size: small * 0.9,
      color: C.muted,
    },
  );
  if (!compact && r.todoTotal > 0) {
    text(ctx, `${r.todoDone}/${r.todoTotal}`, cr.x, l2, {
      size: small,
      color: C.muted,
      mono: true,
    });
  }
}

// ============================================================================
// USAGE
// ============================================================================

function gauge(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  r: number,
  w: OpsWindow | null,
  u: number,
  title: string,
) {
  const a0 = Math.PI * 0.8;
  const a1 = Math.PI * 2.2;
  const lw = r * 0.16;
  ctx.lineCap = "round";
  ctx.lineWidth = lw;
  ctx.strokeStyle = C.track;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
  const tone = TONE_COLORS[limitTone(w)];
  if (w) {
    const proj = Math.min(100, w.projectedPct ?? w.usedPct);
    if (proj > w.usedPct) {
      ctx.strokeStyle = withAlpha(tone, 0.28);
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + ((a1 - a0) * proj) / 100);
      ctx.stroke();
    }
    ctx.strokeStyle = tone;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + ((a1 - a0) * Math.min(100, w.usedPct)) / 100);
    ctx.stroke();
    if (w.projectedPct != null) {
      const pa = a0 + ((a1 - a0) * Math.min(100, w.projectedPct)) / 100;
      ctx.lineCap = "butt";
      ctx.lineWidth = Math.max(2, 0.5 * u);
      ctx.strokeStyle = w.projectedPct > 100 ? C.red : C.text;
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(pa) * (r - lw * 0.9),
        cy + Math.sin(pa) * (r - lw * 0.9),
      );
      ctx.lineTo(
        cx + Math.cos(pa) * (r + lw * 0.9),
        cy + Math.sin(pa) * (r + lw * 0.9),
      );
      ctx.stroke();
    }
  }
  ctx.lineCap = "butt";
  text(ctx, title, cx, cy - r * 0.42, {
    size: 4.8 * u,
    weight: 700,
    caps: true,
    color: C.muted,
    align: "center",
  });
  text(ctx, w ? fmtPct(w.usedPct) : "—", cx, cy + r * 0.02, {
    size: r * 0.5,
    weight: 700,
    mono: true,
    align: "center",
    color: w ? C.text : C.muted,
  });
  text(
    ctx,
    w?.projectedPct != null ? `pace ${fmtPct(w.projectedPct)}` : "pace —",
    cx,
    cy + r * 0.46,
    {
      size: 5.2 * u,
      weight: 600,
      align: "center",
      color: w && (w.projectedPct ?? 0) > 100 ? C.red : C.sub,
    },
  );
  text(
    ctx,
    w?.resetsInMs != null ? `resets in ${fmtSpan(w.resetsInMs)}` : "reset —",
    cx,
    cy + r * 0.86,
    { size: 4.8 * u, align: "center", color: C.muted, mono: true },
  );
}

function kpi(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  u: number,
  label: string,
  value: string,
  color: string = C.text,
  sub?: string,
) {
  text(ctx, label, x, y, {
    size: 4.4 * u,
    weight: 600,
    caps: true,
    color: C.muted,
    max: w,
  });
  text(ctx, value, x, y + 8 * u, {
    size: 9.5 * u,
    weight: 700,
    mono: true,
    color,
    max: w,
  });
  if (sub)
    text(ctx, sub, x, y + 16 * u, {
      size: 4.8 * u,
      color: C.muted,
      max: w,
      mono: true,
    });
}

export function drawUsagePanel(
  ctx: Ctx2D,
  W: number,
  H: number,
  m: OpsModel,
  u: number,
) {
  panelBg(ctx, W, H);
  const top = header(ctx, u, W, "Usage", "account-wide limits", null);
  const us = m.usage;
  const r = Math.min(W / 4.9, 27 * u);
  const gy = top + 6 * u + r;
  gauge(ctx, W * 0.27, gy, r, us.fiveHour, u, "5-hour");
  gauge(ctx, W * 0.73, gy, r, us.sevenDay, u, "7-day");
  if (!us.fiveHour && !us.sevenDay)
    text(
      ctx,
      "Limits appear once the status line reports",
      W / 2,
      gy + r + 4 * u,
      {
        size: 4.6 * u,
        color: C.muted,
        align: "center",
      },
    );

  const ky = gy + r + 10 * u;
  const kw = (W - 12 * u) / 3;
  kpi(ctx, 6 * u, ky, kw - 2 * u, u, "Cost today", fmtUsd(us.costTodayUsd));
  kpi(
    ctx,
    6 * u + kw,
    ky,
    kw - 2 * u,
    u,
    "Burn rate",
    us.burnUsdPerHour != null ? `${fmtUsd(us.burnUsdPerHour)}/h` : "—",
    us.burnUsdPerHour != null && us.burnUsdPerHour > 30 ? C.amber : C.text,
  );
  const la = us.linesAddedToday;
  const lr = us.linesRemovedToday;
  text(ctx, "Lines today", 6 * u + 2 * kw, ky, {
    size: 4.4 * u,
    weight: 600,
    caps: true,
    color: C.muted,
  });
  text(ctx, la != null ? `+${fmtCount(la)}` : "—", 6 * u + 2 * kw, ky + 8 * u, {
    size: 8 * u,
    weight: 700,
    mono: true,
    color: C.add,
  });
  text(ctx, lr != null ? `−${fmtCount(lr)}` : "", 6 * u + 2 * kw, ky + 16 * u, {
    size: 5.6 * u,
    weight: 600,
    mono: true,
    color: C.del,
  });

  // Cost sparkline (5-min buckets, last 3 h).
  const sy = ky + 24 * u;
  const sh = H - sy - 10 * u;
  if (sh > 12 * u) {
    text(ctx, "Spend per 5 min · last 3 h", 6 * u, sy, {
      size: 4.4 * u,
      weight: 600,
      caps: true,
      color: C.muted,
    });
    const series = us.costSeries;
    const top2 = sy + 5 * u;
    const ch = sh - 4 * u;
    if (series.length >= 2) {
      const max = Math.max(...series);
      spark(ctx, 6 * u, top2, W - 12 * u, ch, series, C.accent, {
        max: max * 1.1,
      });
      text(ctx, fmtUsd(max), W - 6 * u, top2 + 2 * u, {
        size: 4.2 * u,
        color: C.muted,
        align: "right",
        mono: true,
      });
    } else {
      spark(ctx, 6 * u, top2, W - 12 * u, ch, [], C.accent);
      text(ctx, "No spend data yet", W / 2, top2 + ch / 2, {
        size: 5 * u,
        color: C.muted,
        align: "center",
      });
    }
    text(ctx, "3h ago", 6 * u, H - 4.5 * u, { size: 4 * u, color: C.muted });
    text(ctx, "now", W - 6 * u, H - 4.5 * u, {
      size: 4 * u,
      color: C.muted,
      align: "right",
    });
  }
}

// ============================================================================
// ACTIVITY
// ============================================================================

export function drawActivityPanel(
  ctx: Ctx2D,
  W: number,
  H: number,
  m: OpsModel,
  u: number,
) {
  panelBg(ctx, W, H);
  const a = m.activity;
  const top = header(
    ctx,
    u,
    W,
    "Activity",
    a.eventsLastMin != null ? `${a.eventsLastMin} events/min now` : null,
    null,
  );
  // Building events/min.
  const ay = top + 6 * u;
  const n = a.eventsPerMin.length;
  text(
    ctx,
    `Events per minute · last ${n >= 60 ? 60 : n || 60} min`,
    6 * u,
    ay,
    {
      size: 4.4 * u,
      weight: 600,
      caps: true,
      color: C.muted,
    },
  );
  const ch = 30 * u;
  const cw = W - 12 * u;
  // Grid lines.
  ctx.fillStyle = C.lineSoft;
  for (let k = 0; k <= 3; k++)
    ctx.fillRect(6 * u, ay + 5 * u + (ch * k) / 3, cw, Math.max(1, 0.2 * u));
  spark(ctx, 6 * u, ay + 5 * u, cw, ch, a.eventsPerMin, "#60A5FA", {
    max: Math.max(4, a.peakPerMin * 1.1),
  });
  text(ctx, `peak ${a.peakPerMin}`, W - 6 * u, ay + 7 * u, {
    size: 4.2 * u,
    color: C.muted,
    align: "right",
    mono: true,
  });

  // Per-session sparklines.
  let y = ay + ch + 12 * u;
  text(ctx, "Per session · 30 min", 6 * u, y, {
    size: 4.4 * u,
    weight: 600,
    caps: true,
    color: C.muted,
  });
  y += 6 * u;
  const rows = m.rows.filter((r) => r.status !== "ended").slice(0, 6);
  const rh = 8.6 * u;
  const max = Math.max(4, ...rows.flatMap((r) => r.spark));
  for (const r of rows) {
    const sc = STATUS_COLORS[r.status];
    dot(ctx, 7.2 * u, y + rh / 2, 1 * u, sc);
    text(ctx, r.project, 10 * u, y + rh / 2, {
      size: 5.2 * u,
      weight: 600,
      max: W * 0.3,
    });
    const sx = W * 0.4;
    const sw = W * 0.44;
    spark(ctx, sx, y + 1 * u, sw, rh - 2.4 * u, r.spark, sc, {
      max,
      line: Math.max(1.5, 0.35 * u),
    });
    const last = r.spark.length ? r.spark[r.spark.length - 1] : null;
    text(ctx, last != null ? `${last}/m` : "—", W - 6 * u, y + rh / 2, {
      size: 4.8 * u,
      color: C.sub,
      align: "right",
      mono: true,
    });
    y += rh;
  }
  if (rows.length === 0)
    text(ctx, "—", 10 * u, y + rh / 2, { size: 5 * u, color: C.muted });

  // Tool mix stacked bar.
  y = Math.max(y + 5 * u, H - 44 * u);
  text(ctx, "Tool mix", 6 * u, y, {
    size: 4.4 * u,
    weight: 600,
    caps: true,
    color: C.muted,
  });
  const total = a.toolMix.reduce((s, t) => s + t.count, 0);
  const by = y + 4.5 * u;
  const bh = 4 * u;
  roundRect(ctx, 6 * u, by, cw, bh, bh / 2);
  ctx.fillStyle = C.track;
  ctx.fill();
  if (total > 0) {
    ctx.save();
    roundRect(ctx, 6 * u, by, cw, bh, bh / 2);
    ctx.clip();
    let bx = 6 * u;
    for (const t of a.toolMix) {
      const tw = (t.count / total) * cw;
      ctx.fillStyle = kindColor(t.kind);
      ctx.fillRect(bx, by, tw, bh);
      bx += tw;
    }
    ctx.restore();
    let lx = 6 * u;
    const ly = by + bh + 5 * u;
    for (const t of a.toolMix.slice(0, 5)) {
      const s = `${PHASE_LABEL_EN[t.kind] ?? t.kind} ${Math.round((t.count / total) * 100)}%`;
      const w = measure(ctx, s, 4.4 * u) + 5 * u;
      if (lx + w > W - 6 * u) break;
      dot(ctx, lx + 1 * u, ly, 1 * u, kindColor(t.kind));
      text(ctx, s, lx + 3 * u, ly, { size: 4.4 * u, color: C.sub });
      lx += w + 1.5 * u;
    }
  }

  // KPIs.
  const ky = H - 22 * u;
  const kw = (W - 12 * u) / 3;
  const tf = a.testFailures ?? 0;
  kpi(
    ctx,
    6 * u,
    ky,
    kw - 2 * u,
    u,
    "Tests",
    a.testRuns != null ? `${a.testRuns}` : "—",
    C.text,
    a.testRuns != null ? (tf > 0 ? `${tf} failing` : "all passing") : undefined,
  );
  kpi(
    ctx,
    6 * u + kw,
    ky,
    kw - 2 * u,
    u,
    "Tool errors",
    a.errors != null ? `${a.errors}` : "—",
    (a.errors ?? 0) > 0 ? C.amber : C.text,
  );
  kpi(
    ctx,
    6 * u + 2 * kw,
    ky,
    kw - 2 * u,
    u,
    "Tool calls",
    fmtCount(a.toolCalls),
    C.text,
    a.subagentsSpawned != null ? `${a.subagentsSpawned} subagents` : undefined,
  );
  if (tf > 0) {
    // Recolour the failing sub-line.
    text(ctx, `${tf} failing`, 6 * u, ky + 16 * u, {
      size: 4.8 * u,
      color: C.red,
      mono: true,
      weight: 600,
    });
  }
}

// ============================================================================
// ALERTS STRIP + TICKER
// ============================================================================

export function drawAlertStrip(
  ctx: Ctx2D,
  W: number,
  H: number,
  m: OpsModel,
  clock: string,
) {
  const u = H / 30;
  ctx.fillStyle = C.bg0;
  ctx.fillRect(0, 0, W, H);
  const n = m.alerts.length;
  const cy = H / 2;
  const right = text(ctx, clock, W - 5 * u, cy, {
    size: 13 * u,
    weight: 600,
    mono: true,
    align: "right",
    color: C.sub,
  });
  const rx = W - 10 * u - right;
  if (n === 0) {
    dot(ctx, 9 * u, cy, 3 * u, C.green);
    text(ctx, "All clear · nothing needs you", 16 * u, cy, {
      size: 11 * u,
      weight: 600,
      color: C.text,
      max: rx - 20 * u,
    });
    return;
  }
  const high = m.alerts.some((a) => a.severity === "high");
  const col = high ? C.amber : "#FBBF24";
  const tag = `${n} ALERT${n === 1 ? "" : "S"}`;
  const tw = chip(ctx, tag, 4 * u, cy, 10 * u, col, true);
  let x = 4 * u + tw + 5 * u;
  m.alerts.forEach((a, i) => {
    if (x > rx - 20 * u) return;
    if (i > 0) {
      dot(ctx, x, cy, 1.2 * u, C.muted);
      x += 4 * u;
    }
    const color = a.severity === "high" ? C.amber : C.text;
    const s = alertText(a);
    const w = text(ctx, s, x, cy, {
      size: 10.5 * u,
      weight: a.severity === "high" ? 600 : 500,
      color,
      max: rx - x - 4 * u,
    });
    x += w + 4 * u;
  });
}

export function drawTicker(ctx: Ctx2D, W: number, H: number, m: OpsModel) {
  const u = H / 24;
  ctx.fillStyle = C.bg0;
  ctx.fillRect(0, 0, W, H);
  const cy = H / 2;
  const lw = chip(ctx, "LIVE", 4 * u, cy, 8 * u, C.red, true);
  let x = 4 * u + lw + 5 * u;
  if (m.ticker.length === 0) {
    text(ctx, "Waiting for activity…", x, cy, { size: 9 * u, color: C.muted });
    return;
  }
  for (const it of m.ticker) {
    if (x > W - 30 * u) break;
    const t = text(ctx, it.clock, x, cy, {
      size: 8.4 * u,
      color: C.muted,
      mono: true,
    });
    x += t + 2.5 * u;
    const p = text(ctx, it.project, x, cy, {
      size: 8.6 * u,
      weight: 700,
      color: STATUS_COLORS[it.status] === STATUS_COLORS.ended ? C.sub : C.text,
    });
    x += p + 2.5 * u;
    const s = text(ctx, it.text, x, cy, {
      size: 8.6 * u,
      color: C.sub,
      max: Math.min(W * 0.32, W - x - 4 * u),
    });
    x += s + 4 * u;
    ctx.fillStyle = C.line;
    ctx.fillRect(x, cy - 5 * u, Math.max(1, 0.3 * u), 10 * u);
    x += 4 * u;
  }
}

// ============================================================================
// CONSOLE MONITOR CARD (one session in detail)
// ============================================================================

export interface CardExtras {
  todos: Array<{ text: string; status: string }>;
  activity: Array<{ clock: string; actor: string; text: string }>;
  index: number;
  total: number;
}

export function drawSessionCard(
  ctx: Ctx2D,
  x0: number,
  y0: number,
  W: number,
  H: number,
  r: OpsRow | null,
  extra: CardExtras | null,
) {
  const u = H / 100;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, W, H);
  ctx.clip();
  ctx.translate(x0, y0);
  panelBg(ctx, W, H);
  if (!r || !extra) {
    text(ctx, "CLAUDE OFFICE", W / 2, H * 0.44, {
      size: 7 * u,
      weight: 700,
      caps: true,
      color: C.muted,
      align: "center",
    });
    text(ctx, "No live sessions", W / 2, H * 0.58, {
      size: 6 * u,
      color: C.muted,
      align: "center",
    });
    ctx.restore();
    return;
  }
  const sc = STATUS_COLORS[r.status];
  ctx.fillStyle = sc;
  ctx.fillRect(0, 0, W, 1.6 * u);
  const pad = 4 * u;
  // Header: project + refs + index.
  const hy = 9 * u;
  const pw = text(ctx, r.project, pad, hy, {
    size: 8.4 * u,
    weight: 700,
    max: W * 0.5,
  });
  let rx = pad + pw + 2 * u;
  for (const ref of r.refs) {
    const cw = chip(ctx, ref, rx, hy, 4.6 * u, "#94A3B8");
    rx += cw + 1.2 * u;
  }
  text(ctx, `${extra.index + 1}/${extra.total}`, W - pad, hy, {
    size: 4.6 * u,
    color: C.muted,
    align: "right",
    mono: true,
  });
  // Summary (2 lines).
  ctx.font = font(5.6 * u, 500);
  const lines = wrapText(
    ctx,
    r.summary ?? r.branch ?? "No description yet",
    W - 2 * pad,
    2,
  );
  lines.forEach((l, i) =>
    text(ctx, l, pad, 18 * u + i * 6.6 * u, { size: 5.6 * u, color: C.sub }),
  );
  // Phase pill.
  const py = 33 * u;
  const pc = phaseColor(r.phaseKind);
  roundRect(ctx, pad, py - 4 * u, W - 2 * pad, 8 * u, 2 * u);
  ctx.fillStyle = withAlpha(pc, 0.14);
  ctx.fill();
  dot(ctx, pad + 3 * u, py, 1.3 * u, pc);
  const lw = text(ctx, r.phaseLabel, pad + 6 * u, py, {
    size: 5.4 * u,
    weight: 700,
    color: r.status === "needs_you" ? sc : C.text,
    max: W * 0.45,
  });
  const det = [r.phaseDetail, r.phaseElapsed ? `for ${r.phaseElapsed}` : null]
    .filter(Boolean)
    .join(" · ");
  if (det)
    text(ctx, det, pad + 8 * u + lw, py, {
      size: 4.8 * u,
      color: C.sub,
      max: W - 2 * pad - lw - 10 * u,
    });

  // Status-line row: context bar + metrics.
  const my = 45 * u;
  const tone = TONE_COLORS[contextTone(r.contextPct)];
  text(ctx, "CONTEXT", pad, my, { size: 3.8 * u, weight: 600, color: C.muted });
  bar(
    ctx,
    pad + 15 * u,
    my - 1.2 * u,
    W * 0.3,
    2.4 * u,
    (r.contextPct ?? 0) / 100,
    tone,
  );
  text(
    ctx,
    `${fmtPct(r.contextPct)}  ${r.contextTokens != null ? `${fmtTokens(r.contextTokens)}/${fmtTokens(r.contextWindow)}` : ""}`,
    pad + 17 * u + W * 0.3,
    my,
    { size: 4.6 * u, mono: true, color: C.text },
  );
  const metrics: Array<[string, string, string]> = [
    ["COST", fmtUsd(r.costUsd), C.text],
    ["TIME", fmtSpan(r.durationMs), C.text],
    [
      "LINES",
      r.linesAdded != null
        ? `+${fmtCount(r.linesAdded)} −${fmtCount(r.linesRemoved)}`
        : "—",
      C.add,
    ],
    ["MODEL", [r.model, r.effort].filter(Boolean).join(" · ") || "—", C.text],
  ];
  const mw = (W - 2 * pad) / metrics.length;
  metrics.forEach(([k, v, col], i) => {
    const mx = pad + i * mw;
    text(ctx, k, mx, 53 * u, { size: 3.8 * u, weight: 600, color: C.muted });
    text(ctx, v, mx, 59 * u, {
      size: 4.8 * u,
      weight: 600,
      mono: k !== "MODEL",
      color: col,
      max: mw - 2 * u,
    });
  });

  // Todos (left) + recent activity (right).
  const ty = 68 * u;
  ctx.fillStyle = C.line;
  ctx.fillRect(pad, ty - 4 * u, W - 2 * pad, Math.max(1, 0.25 * u));
  const half = (W - 2 * pad) / 2;
  text(
    ctx,
    `TODOS ${r.todoTotal ? `${r.todoDone}/${r.todoTotal}` : ""}`,
    pad,
    ty,
    { size: 3.8 * u, weight: 600, color: C.muted },
  );
  extra.todos.slice(0, 4).forEach((t, i) => {
    const yy = ty + 6 * u + i * 6 * u;
    const done = t.status === "completed";
    const active = t.status === "in_progress";
    dot(
      ctx,
      pad + 1.2 * u,
      yy,
      1.1 * u,
      done ? C.green : active ? C.accent : C.track,
    );
    text(ctx, t.text, pad + 4 * u, yy, {
      size: 4.4 * u,
      color: done ? C.muted : active ? C.text : C.sub,
      max: half - 6 * u,
    });
  });
  text(ctx, `RECENT · ${r.subagents} subagents`, pad + half, ty, {
    size: 3.8 * u,
    weight: 600,
    color: C.muted,
  });
  extra.activity.slice(0, 4).forEach((a, i) => {
    const yy = ty + 6 * u + i * 6 * u;
    const cw = text(ctx, a.clock, pad + half, yy, {
      size: 4 * u,
      color: C.muted,
      mono: true,
    });
    text(ctx, a.text, pad + half + cw + 2 * u, yy, {
      size: 4.4 * u,
      color: C.sub,
      max: half - cw - 3 * u,
    });
  });
  ctx.restore();
}
