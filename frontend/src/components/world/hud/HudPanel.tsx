"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  useWorldUiStore,
  type HudPanel as PanelId,
} from "@/stores/worldUiStore";
import { GLASS } from "./glass";
import { Keycap } from "./Keycap";
import { PANELS } from "./panels";

/**
 * Glass frame shared by every HUD panel: title, key hint, close button.
 * Embedded legacy panels (git, events, …) bring their own chrome, so their
 * border/radius is flattened to sit flush inside the frame.
 */
export function HudPanelFrame({
  id,
  flatten = false,
  children,
}: {
  id: PanelId;
  flatten?: boolean;
  children: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  const close = useWorldUiStore((s) => s.close);
  const meta = PANELS[id];
  const Icon = meta.icon;
  return (
    <section
      aria-label={t(meta.titleKey)}
      className={`pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl ${GLASS}`}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-4 py-2.5">
        <Icon className="h-4 w-4 text-[#D97757]" />
        <h2 className="flex-1 truncate text-xs font-semibold uppercase tracking-[0.14em] text-slate-200">
          {t(meta.titleKey)}
        </h2>
        {meta.keyLabel && id !== "inspect" && !id.startsWith("factory") ? (
          <Keycap>{meta.keyLabel}</Keycap>
        ) : null}
        <button
          type="button"
          onClick={() => close(id)}
          aria-label={t("hud.close")}
          title={`${t("hud.close")} (Esc)`}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div
        className={`min-h-0 flex-1 overflow-y-auto ${
          flatten
            ? "[&>*]:!h-full [&>*]:!rounded-none [&>*]:!border-0 [&>*]:!bg-transparent"
            : ""
        }`}
      >
        {children}
      </div>
    </section>
  );
}
