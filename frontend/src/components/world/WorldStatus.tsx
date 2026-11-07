"use client";

import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Building2 } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { GLASS } from "./hud/glass";

/** Loading screen shown until the world reports ready. */
export function LoadingScreen(): ReactNode {
  const { t } = useTranslation();
  const ready = useWorldUiStore((s) => s.ready);
  const error = useWorldUiStore((s) => s.error);
  if (ready || error) return null;
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-[radial-gradient(ellipse_at_center,#1e293b_0%,#020617_75%)]">
      <div
        className={`flex h-20 w-20 items-center justify-center rounded-3xl ${GLASS}`}
      >
        <Building2 className="h-9 w-9 animate-pulse text-[#D97757]" />
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold tracking-tight text-white">
          {t("world.loading.title")}
        </p>
        <p className="mt-1 text-xs text-slate-400">{t("world.loading.hint")}</p>
      </div>
      <div className="relative h-1 w-56 overflow-hidden rounded-full bg-white/10">
        <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-[#D97757] animate-[hud-load_1.4s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}

/** True when the browser can create a WebGL context at all. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(
      c.getContext("webgl2") ||
      c.getContext("webgl") ||
      c.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

/** Error state with an escape hatch back to the pixel renderer. */
export function ErrorScreen(): ReactNode {
  const { t } = useTranslation();
  const error = useWorldUiStore((s) => s.error);
  const setRenderer = usePreferencesStore((s) => s.setRenderer);
  const retryWorld = useWorldUiStore((s) => s.retryWorld);
  const noWebgl = useMemo(() => (error ? !webglAvailable() : false), [error]);
  if (!error) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950 p-6">
      <div
        className={`flex max-w-md flex-col items-center gap-4 rounded-3xl p-8 text-center ${GLASS}`}
      >
        <AlertTriangle className="h-9 w-9 text-amber-400" />
        <h2 className="text-lg font-semibold text-white">
          {noWebgl ? t("world.error.title") : t("world.error.titleRuntime")}
        </h2>
        <p className="text-sm text-slate-400">
          {noWebgl ? t("world.error.desc") : t("world.error.descRuntime")}
        </p>
        <code className="max-h-24 w-full overflow-auto rounded-lg bg-black/40 p-2 text-left text-[11px] text-rose-300">
          {error}
        </code>
        <div className="flex flex-wrap justify-center gap-2">
          {!noWebgl && (
            <button
              type="button"
              onClick={retryWorld}
              className="rounded-xl bg-[#D97757] px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[#e58a6b]"
            >
              {t("world.error.retry")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void setRenderer("pixel")}
            className={`rounded-xl px-5 py-2.5 text-sm font-bold transition-colors ${
              noWebgl
                ? "bg-[#D97757] text-white hover:bg-[#e58a6b]"
                : "border border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"
            }`}
          >
            {t("world.error.switch")}
          </button>
        </div>
      </div>
    </div>
  );
}
