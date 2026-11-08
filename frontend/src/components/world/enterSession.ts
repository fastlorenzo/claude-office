import { useWorldUiStore } from "@/stores/worldUiStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { getTranslation } from "@/i18n";
import { getWorld } from "./worldRef";

/** What the world view lends to the helper (registered by WorldCanvas). */
export interface EnterContext {
  select: (sessionId: string) => Promise<void> | void;
  selectedId: () => string;
  label: (sessionId: string) => string;
}

let ctx: EnterContext | null = null;

export function setEnterContext(next: EnterContext | null): void {
  ctx = next;
}

/** True when a 3D world is live, i.e. entering a session is meaningful. */
export function canEnterSession(): boolean {
  return ctx !== null;
}

/**
 * Enter a session as a game action: walk/teleport into its room, select it,
 * open the console dock and flash an "Entered <room>" banner. Every entry
 * point (Enter key, panels, popups) goes through here.
 */
export async function enterSession(sessionId: string): Promise<void> {
  const ui = useWorldUiStore.getState();
  const zone = ui.pose?.zone;
  const inside = zone?.kind === "room" && zone.sessionId === sessionId;
  if (!inside) getWorld()?.teleport({ sessionId });

  ui.setPeerPopup(null);
  ui.openConsole(sessionId);
  const label = ctx?.label(sessionId) ?? sessionId.slice(0, 8);
  const t = getTranslation(usePreferencesStore.getState().language);
  ui.showBanner(t("world.enter.toast", { label }));

  if (ctx && ctx.selectedId() !== sessionId) {
    try {
      await ctx.select(sessionId);
    } catch {
      // Selection failures surface through the session loader's own toasts.
    }
  }
}
