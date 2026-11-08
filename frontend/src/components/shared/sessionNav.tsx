"use client";

import { createContext, useContext } from "react";
import type { InteractionTarget } from "@/engine/contracts";
import { enterSession } from "@/components/world/enterSession";
import { useWorldUiStore } from "@/stores/worldUiStore";

export interface OpenConsoleOptions {
  /** Lay the console over the ops dashboard (Esc returns to ops). */
  from?: "ops";
  /** Focus one tool call (tool_use_id). */
  callId?: string;
}

/**
 * How a shared panel navigates. Each host supplies its own implementation:
 * the 3D HUD (dock/sheet + teleport), the dashboard page (URL navigation).
 * `enterRoom` is absent where there is no room to walk into.
 */
export interface SessionNav {
  openConsole: (sessionId: string, opts?: OpenConsoleOptions) => void;
  enterRoom?: (sessionId: string) => void;
  openFactory?: (target: InteractionTarget) => void;
}

/** The 3D implementation, also the default so HUD panels work without a provider. */
export const WORLD_SESSION_NAV: SessionNav = {
  openConsole: (id, opts) => useWorldUiStore.getState().openConsole(id, opts),
  enterRoom: (id) => void enterSession(id),
  openFactory: (target) => useWorldUiStore.getState().openFactory(target),
};

const SessionNavContext = createContext<SessionNav>(WORLD_SESSION_NAV);

export const SessionNavProvider = SessionNavContext.Provider;

export function useSessionNav(): SessionNav {
  return useContext(SessionNavContext);
}

/** Primary row action: walk into the room when possible, else open the console. */
export function primaryAction(nav: SessionNav): (sessionId: string) => void {
  return nav.enterRoom ?? ((id) => nav.openConsole(id));
}
