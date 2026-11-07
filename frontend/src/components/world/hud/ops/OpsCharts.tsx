"use client";

import type { ReactNode } from "react";
import {
  kindColor,
  limitTone,
  TONE_COLORS,
  type OpsToolSlice,
  type OpsWindow,
} from "@/engine/logic/opsModel";

/** Line + soft-fill sparkline (oldest left), scales to its box. */
export function Sparkline({
  data,
  color,
  max,
  className = "h-8 w-full",
  fill = true,
}: {
  data: number[];
  color: string;
  max?: number;
  className?: string;
  fill?: boolean;
}): ReactNode {
  const W = 100;
  const H = 30;
  if (data.length < 2)
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={className}
        aria-hidden
      >
        <line
          x1={0}
          y1={H - 0.5}
          x2={W}
          y2={H - 0.5}
          stroke="rgba(148,163,184,0.2)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  const m = Math.max(1e-6, max ?? Math.max(...data));
  const step = W / (data.length - 1);
  const pts = data.map(
    (v, i) => [i * step, H - (Math.max(0, v) / m) * H * 0.94] as const,
  );
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join("");
  const id = `g${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.35} />
              <stop offset="1" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 240° rate-limit gauge: used (solid), projected (ghost arc + tick). */
export function Gauge({
  w,
  label,
  paceLabel,
  resetLabel,
}: {
  w: OpsWindow | null;
  label: string;
  paceLabel: string;
  resetLabel: string;
}): ReactNode {
  const r = 40;
  const cx = 50;
  const cy = 50;
  const a0 = Math.PI * 0.8;
  const span = Math.PI * 1.4;
  const pt = (f: number, rr = r) => {
    const a = a0 + span * Math.min(1, Math.max(0, f));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr] as const;
  };
  const arc = (f: number) => {
    const [x0, y0] = pt(0);
    const [x1, y1] = pt(f);
    const large = span * Math.min(1, f) > Math.PI ? 1 : 0;
    return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}`;
  };
  const tone = TONE_COLORS[limitTone(w)];
  const used = w ? w.usedPct / 100 : 0;
  const proj = w?.projectedPct != null ? w.projectedPct / 100 : null;
  const over = (w?.projectedPct ?? 0) > 100;
  return (
    <div className="flex min-w-0 flex-col items-center">
      <svg
        viewBox="0 0 100 92"
        className="w-full max-w-[200px]"
        role="img"
        aria-label={`${label} ${w ? Math.round(w.usedPct) : "—"}%`}
      >
        <path
          d={arc(1)}
          fill="none"
          stroke="rgba(148,163,184,0.16)"
          strokeWidth={9}
          strokeLinecap="round"
        />
        {proj != null && proj > used && (
          <path
            d={arc(proj)}
            fill="none"
            stroke={tone}
            strokeOpacity={0.28}
            strokeWidth={9}
            strokeLinecap="round"
          />
        )}
        {w && used > 0 && (
          <path
            d={arc(used)}
            fill="none"
            stroke={tone}
            strokeWidth={9}
            strokeLinecap="round"
          />
        )}
        {proj != null && (
          <line
            x1={pt(proj, r - 8)[0]}
            y1={pt(proj, r - 8)[1]}
            x2={pt(proj, r + 8)[0]}
            y2={pt(proj, r + 8)[1]}
            stroke={over ? "#EF4444" : "#EAF0F8"}
            strokeWidth={1.6}
          />
        )}
        <text
          x={50}
          y={34}
          textAnchor="middle"
          className="fill-slate-500 text-[7px] font-semibold uppercase tracking-widest"
        >
          {label}
        </text>
        <text
          x={50}
          y={58}
          textAnchor="middle"
          className="fill-slate-100 font-mono text-[20px] font-bold"
        >
          {w ? `${Math.round(w.usedPct)}%` : "—"}
        </text>
        <text
          x={50}
          y={74}
          textAnchor="middle"
          className={`text-[7.5px] font-semibold ${over ? "fill-red-400" : "fill-slate-300"}`}
        >
          {paceLabel}
        </text>
        <text
          x={50}
          y={88}
          textAnchor="middle"
          className="fill-slate-500 font-mono text-[6.5px]"
        >
          {resetLabel}
        </text>
      </svg>
    </div>
  );
}

/** Horizontal stacked bar for the tool mix. */
export function StackedBar({ mix }: { mix: OpsToolSlice[] }): ReactNode {
  const total = mix.reduce((s, t) => s + t.count, 0);
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-400/15">
      {total > 0 &&
        mix.map((t) => (
          <div
            key={t.kind}
            title={`${t.kind} ${t.count}`}
            style={{
              width: `${(t.count / total) * 100}%`,
              background: kindColor(t.kind),
            }}
          />
        ))}
    </div>
  );
}
