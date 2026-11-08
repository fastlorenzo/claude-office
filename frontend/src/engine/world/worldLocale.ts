/**
 * Language of the canvas text baked into the 3D world (wayfinding signs,
 * directory board). `ControlRoom.setData` forwards the UI language here; a
 * change re-runs every subscriber so baked canvases repaint. No Babylon.
 */
import { setNumberLocale } from "@/engine/logic/opsModel";
import { getTranslation, type Locale, type TranslationKey } from "@/i18n";

type Params = Record<string, string | number>;

let locale: Locale = "en";
let tr = getTranslation(locale);
const subs = new Set<() => void>();

export function setWorldLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  tr = getTranslation(next);
  setNumberLocale(next);
  for (const cb of [...subs]) cb();
}

export function worldT(key: TranslationKey, params?: Params): string {
  return tr(key, params);
}

/** Repaint hook; returns the unsubscribe function. */
export function onWorldLocale(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
