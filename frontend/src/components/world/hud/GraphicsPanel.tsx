"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { RotateCcw, Undo2 } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  applyPreset,
  defaultGraphicsSettings,
  nearestPreset,
  updateSetting,
  type GraphicsPreset,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { getWorld } from "../worldRef";
import { LABEL } from "./glass";
import { GraphicsRow } from "./graphics/GraphicsRow";
import { PresetBar } from "./graphics/PresetBar";
import { SECTIONS } from "./graphics/schema";
import { StatsReadout } from "./graphics/StatsReadout";

/**
 * Graphics menu body. Shared by the HUD dock (key "O") and the header
 * Settings modal. Every change is applied live: it goes into the preferences
 * store (debounced persistence) and WorldCanvas forwards it to the engine.
 */
export function GraphicsPanel({
  closeOnEscape = true,
}: {
  closeOnEscape?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const graphics = usePreferencesStore((s) => s.graphics);
  const setGraphics = usePreferencesStore((s) => s.setGraphics);
  const close = useWorldUiStore((s) => s.close);

  const world = getWorld();
  const pending = world !== null && typeof world.setGraphics !== "function";

  const change = <K extends keyof GraphicsSettings>(
    key: K,
    value: GraphicsSettings[K],
  ): void => setGraphics(updateSetting(graphics, key, value));
  const pick = (p: Exclude<GraphicsPreset, "custom">): void =>
    setGraphics(applyPreset(p, graphics));

  // Custom has no anchor preset, so reset to the closest one.
  const resetToPreset = (): void =>
    setGraphics(
      applyPreset(
        graphics.preset === "custom"
          ? nearestPreset(graphics)
          : graphics.preset,
        graphics,
      ),
    );

  // Sliders/selects are inputs, which useHudKeys ignores, so Esc is handled here.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && closeOnEscape) {
      e.preventDefault();
      close("graphics");
    }
  };

  return (
    <div onKeyDown={onKeyDown} className="flex flex-col pb-3">
      <StatsReadout />
      <div className="px-4 pb-2 pt-3">
        <p className={LABEL}>{t("gfx.presets")}</p>
      </div>
      <PresetBar active={graphics.preset} onPick={pick} />

      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={resetToPreset}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/70"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
          {t("gfx.resetPreset")}
        </button>
        <button
          type="button"
          onClick={() => setGraphics(defaultGraphicsSettings())}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/70"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {t("gfx.restoreDefaults")}
        </button>
        <span className="self-center text-[10px] text-slate-500">
          {t("gfx.liveHint")}
        </span>
      </div>

      {SECTIONS.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`gfx-sec-${section.id}`}
          className="border-t border-white/10"
        >
          <h3
            id={`gfx-sec-${section.id}`}
            className={`${LABEL} px-4 pb-1 pt-3`}
          >
            {t(section.titleKey)}
          </h3>
          {section.rows.map((row) => (
            <GraphicsRow
              key={row.key}
              row={row}
              value={graphics[row.key]}
              pending={pending}
              onChange={
                change as (key: keyof GraphicsSettings, v: never) => void
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}
