"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Gauge } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { Impact, Option } from "./schema";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/70";

/** Three-bar performance-impact glyph. */
export function ImpactIcon({ impact }: { impact: Impact }): ReactNode {
  const { t } = useTranslation();
  const n = impact === "low" ? 1 : impact === "med" ? 2 : 3;
  const color =
    impact === "low"
      ? "bg-emerald-400"
      : impact === "med"
        ? "bg-amber-400"
        : "bg-rose-400";
  const label = t(`gfx.impact.${impact}`);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex h-4 shrink-0 items-end gap-[2px]"
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm ${i <= n ? color : "bg-white/15"}`}
          style={{ height: 4 + i * 3 }}
        />
      ))}
    </span>
  );
}

/** Four-pip GPU cost meter used by the preset cards. */
export function CostMeter({ cost }: { cost: number }): ReactNode {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={`${t("gfx.gpuCost")}: ${cost}/4`}
      title={t("gfx.gpuCost")}
      className="flex items-center gap-1 text-slate-500"
    >
      <Gauge className="h-3 w-3" aria-hidden />
      <span className="flex gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`h-1.5 w-2.5 rounded-sm ${
              i <= cost ? "bg-[#D97757]" : "bg-white/15"
            }`}
          />
        ))}
      </span>
    </span>
  );
}

export function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option[];
  value: string | number;
  onChange: (v: string | number) => void;
}): ReactNode {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: KeyboardEvent): void => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (idx + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className="flex flex-wrap gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5"
    >
      {options.map((o, i) => {
        const on = i === idx;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${FOCUS} ${
              on
                ? "bg-[#D97757]/25 text-[#f4b9a4]"
                : "text-slate-400 hover:bg-white/10 hover:text-white"
            }`}
          >
            {o.labelKey ? t(o.labelKey) : o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${FOCUS} ${
        checked ? "bg-[#D97757]" : "bg-white/20"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        aria-label={label}
        aria-valuetext={display}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-1.5 w-32 cursor-pointer accent-[#D97757] sm:w-40 ${FOCUS}`}
      />
      <output className="w-11 text-right text-xs font-semibold tabular-nums text-slate-200">
        {display}
      </output>
    </div>
  );
}

export function SelectField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option[];
  value: string | number;
  onChange: (v: string | number) => void;
}): ReactNode {
  const { t } = useTranslation();
  const id = useId();
  return (
    <select
      id={id}
      aria-label={label}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      className={`rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-200 ${FOCUS}`}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.labelKey ? t(o.labelKey) : o.label}
        </option>
      ))}
    </select>
  );
}
