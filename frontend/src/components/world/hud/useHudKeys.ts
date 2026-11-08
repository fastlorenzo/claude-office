"use client";

import { useEffect } from "react";
import { useWorldUiStore, type HudPanel } from "@/stores/worldUiStore";
import { BINDINGS } from "@/engine/input/bindings";
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

/** True inside a region that owns its keys (e.g. the console timeline). */
function inKeytrap(el: Element | null | undefined): boolean {
  return !!el?.closest?.("[data-hud-keytrap]");
}

/**
 * Keyboard-first panel control: Tab/G/C/L/I/T/M/O/H toggle, B ops dashboard,
 * Esc closes the top. Keys are ignored inside `[data-hud-keytrap]` (except
 * Esc). `selectedId` is the console fallback when no room is entered.
 */
export function useHudKeys(selectedId?: string): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      if (isTyping(document.activeElement)) return;
      const trapped =
        inKeytrap(document.activeElement) ||
        inKeytrap(e.target as Element | null);
      if (trapped && e.key !== "Escape") return;

      const ui = useWorldUiStore.getState();
      if (!ui.ready) return;

      // Engine-owned codes (WASD, arrows, V, N, F, R, Enter...) never reach the
      // HUD while the world has input; this is what froze the player on `A`.
      const inputEnabled =
        ui.panels.length === 0 && !ui.opsOpen && ui.peerPopup === null;
      if (inputEnabled && BINDINGS[e.code] !== undefined) return;

      if (e.key === "Escape") {
        if (ui.panels.includes("console")) {
          // Console first: when it was opened from ops, ops stays underneath.
          ui.close("console");
          e.preventDefault();
        } else if (ui.opsOpen) {
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
      // Tab belongs to keyboard focus navigation unless the mouse is captured.
      if (e.key === "Tab" && !ui.pointerLocked && ui.panels.length === 0)
        return;
      const panel = KEY_TO_PANEL.get(e.key.toLowerCase());
      if (!panel) return;
      e.preventDefault();
      if (panel === "console") {
        if (ui.panels.includes("console")) {
          ui.close("console");
          return;
        }
        const zone = ui.pose?.zone;
        const id =
          (zone?.kind === "room" ? zone.sessionId : undefined) ??
          selectedId ??
          ui.consoleTarget?.sessionId;
        if (id) ui.openConsole(id);
        return;
      }
      ui.toggle(panel);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);
}
