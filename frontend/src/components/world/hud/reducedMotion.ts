"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePreferencesStore } from "@/stores/preferencesStore";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Live `prefers-reduced-motion: reduce`. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!window.matchMedia?.(QUERY).matches,
    () => false,
  );
}

/**
 * The engine reads head bob and sign flicker from the preference store, so
 * reduced motion is applied there: turned off whenever the OS asks for it
 * (the player can switch them back on in Options afterwards).
 */
export function useApplyReducedMotion(): void {
  const reduce = usePrefersReducedMotion();
  useEffect(() => {
    if (!reduce) return;
    const prefs = usePreferencesStore.getState();
    if (prefs.graphics.headBob)
      prefs.setGraphics({ ...prefs.graphics, headBob: false });
    if (prefs.brandFlicker) void prefs.setBrandFlicker(false);
  }, [reduce]);
}
