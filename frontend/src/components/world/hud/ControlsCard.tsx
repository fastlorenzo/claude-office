"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation, type TranslationKey } from "@/hooks/useTranslation";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { helpSeen, markControlsSeen, markHelpSeen } from "./controlsFlags";
import { GLASS, LABEL } from "./glass";
import { Keycap } from "./Keycap";
import { HINT_ORDER, PANELS } from "./panels";

const ROWS: { keys: string[]; label: TranslationKey }[] = [
  { keys: ["W", "A", "S", "D"], label: "hud.help.move" },
  { keys: ["Mouse"], label: "hud.help.look" },
  { keys: ["Shift"], label: "hud.help.run" },
  { keys: ["Space"], label: "controls.jump" },
  { keys: ["F"], label: "hud.help.interact" },
  { keys: ["Enter"], label: "hud.help.enter" },
  { keys: ["V"], label: "hud.help.camera" },
  { keys: ["N", "E"], label: "hud.help.fly" },
  { keys: ["M"], label: "controls.map" },
  { keys: ["B"], label: "hud.help.ops" },
  { keys: ["R"], label: "controls.unstuck" },
];

const WHERE: TranslationKey[] = [
  "controls.where.offices",
  "controls.where.factory",
  "controls.where.control",
];

/**
 * First-run controls and orientation card. Dismissible and persisted; it comes
 * back whenever the pointer lock is lost until the player has opened Help once.
 */
export function ControlsCard({ isMobile }: { isMobile: boolean }): ReactNode {
  const { t } = useTranslation();
  const locked = useWorldUiStore((s) => s.pointerLocked);
  const panelOpen = useWorldUiStore((s) => s.panels.length > 0);
  const opsOpen = useWorldUiStore((s) => s.opsOpen);
  const helpOpen = useWorldUiStore((s) => s.panels.includes("help"));
  const open = useWorldUiStore((s) => s.controlsOpen);
  const setOpen = useWorldUiStore((s) => s.setControlsOpen);
  const wasLocked = useRef(locked);

  useEffect(() => {
    const was = wasLocked.current;
    wasLocked.current = locked;
    if (locked) {
      // Capturing the mouse means the player found the controls.
      markControlsSeen();
      setOpen(false);
    } else if (was && !helpSeen()) setOpen(true);
  }, [locked, setOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    markHelpSeen();
    setOpen(false);
  }, [helpOpen, setOpen]);

  if (!open || panelOpen || opsOpen) return null;
  const dismiss = (): void => {
    markControlsSeen();
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-label={t("controls.title")}
      className={`pointer-events-auto absolute left-1/2 top-1/2 z-20 max-h-[calc(100%-120px)] w-[min(560px,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-4 ${GLASS}`}
    >
      <p className="text-base font-semibold text-white">
        {t("controls.title")}
      </p>
      <p className="mb-3 text-xs text-slate-400">
        {isMobile ? t("controls.touch") : t("controls.subtitle")}
      </p>
      {!isMobile && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {ROWS.map((r) => (
            <div key={r.label} className="flex items-center gap-2 text-xs">
              <span className="flex min-w-[6.5rem] shrink-0 gap-1">
                {r.keys.map((k) => (
                  <Keycap key={k}>{k}</Keycap>
                ))}
              </span>
              <span className="text-slate-300">{t(r.label)}</span>
            </div>
          ))}
        </div>
      )}
      {!isMobile && (
        <div className="mt-3">
          <p className={`${LABEL} mb-1.5`}>{t("controls.panels")}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {HINT_ORDER.map((id) => {
              const m = PANELS[id];
              return m.hintKey ? (
                <span
                  key={id}
                  className="flex items-center gap-1.5 text-xs text-slate-300"
                >
                  <Keycap>{m.keyLabel}</Keycap>
                  {t(m.hintKey)}
                </span>
              ) : null;
            })}
          </div>
        </div>
      )}
      <div className="mt-3">
        <p className={`${LABEL} mb-1.5`}>{t("controls.where")}</p>
        <ul className="space-y-0.5 text-xs text-slate-300">
          {WHERE.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="mt-4 rounded-lg bg-[#D97757] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#e58a6c]"
      >
        {t("controls.dismiss")}
      </button>
    </div>
  );
}
