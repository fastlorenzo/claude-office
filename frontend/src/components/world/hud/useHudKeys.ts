"use client";

import { useEffect } from "react";
import { useWorldUiStore, type HudPanel } from "@/stores/worldUiStore";
import { PANELS } from "./panels";

/** Opens the full-screen Ops dashboard from anywhere. */
export const OPS_KEY = "b";

const KEY_TO_PANEL = new Map<string, HudPanel>();
for (const meta of Object.values(PANELS)) {
  for (const k of meta.keys) KEY_TO_PANEL.set(k, meta.id);
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

/** Keyboard-first panel control: Tab/G/C/L/A/M/O/H toggle, B ops dashboard, Esc closes the top. */
export function useHudKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      if (isTyping(document.activeElement)) return;

      const ui = useWorldUiStore.getState();
      if (!ui.ready) return;

      if (e.key === "Escape") {
        if (ui.opsOpen) {
          ui.closeOps();
          e.preventDefault();
        } else if (ui.closeTop()) e.preventDefault();
        return;
      }
      if (e.key.toLowerCase() === OPS_KEY) {
        e.preventDefault();
        ui.toggleOps();
        return;
      }
      // Panels sit under the dashboard: ignore their keys while it is open.
      if (ui.opsOpen) return;
      const panel = KEY_TO_PANEL.get(e.key.toLowerCase());
      if (!panel) return;
      e.preventDefault();
      ui.toggle(panel);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
