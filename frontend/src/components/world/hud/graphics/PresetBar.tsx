"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { PRESET_COST, type GraphicsPreset } from "@/engine/fx/graphicsSettings";
import { CostMeter } from "./controls";
import { PRESET_ORDER } from "./schema";

export function PresetBar({
  active,
  onPick,
}: {
  active: GraphicsPreset;
  onPick: (p: Exclude<GraphicsPreset, "custom">) => void;
}): ReactNode {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Custom is a status, not a target: arrow keys skip it.
  const pickable = PRESET_ORDER.filter(
    (p): p is Exclude<GraphicsPreset, "custom"> => p !== "custom",
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
    const cur = pickable.indexOf(active as (typeof pickable)[number]);
    const next = (Math.max(cur, 0) + step + pickable.length) % pickable.length;
    onPick(pickable[next]);
    refs.current[next]?.focus();
  };
  const activeKey: GraphicsPreset = active;
  const cost = active === "custom" ? 3 : PRESET_COST[active];
  return (
    <div className="px-4 pb-3">
      <div
        role="radiogroup"
        aria-label={t("gfx.presets")}
        onKeyDown={onKey}
        className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-black/30 p-1"
      >
        {PRESET_ORDER.map((p) => {
          const on = p === activeKey;
          const isCustom = p === "custom";
          const pi = pickable.indexOf(p as (typeof pickable)[number]);
          return (
            <button
              key={p}
              ref={(el) => {
                if (!isCustom) refs.current[pi] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={isCustom}
              disabled={isCustom}
              tabIndex={on || (active === "custom" && p === "auto") ? 0 : -1}
              onClick={() => (isCustom ? undefined : onPick(p))}
              className={`min-w-[3.5rem] flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/70 ${
                on
                  ? "bg-[#D97757]/25 text-[#f4b9a4] shadow-inner"
                  : isCustom
                    ? "cursor-default text-slate-600"
                    : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {t(`gfx.preset.${p}`)}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-start justify-between gap-3">
        <p className="text-xs leading-snug text-slate-400">
          {t(`gfx.preset.${active}.d`)}
        </p>
        <CostMeter cost={cost} />
      </div>
    </div>
  );
}
