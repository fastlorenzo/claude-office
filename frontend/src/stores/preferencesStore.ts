"use client";

import { create } from "zustand";
import { isLocale, type Locale } from "@/i18n";
import type { BrandingOptions } from "@/engine/contracts";
import {
  DEFAULT_BRANDING,
  clampText,
  MAX_NAME_CHARS,
  MAX_TAGLINE_CHARS,
  normalizeBranding,
  parseNeonColor,
} from "@/engine/world/brandLayout";
import { apiFetch } from "@/utils/api";
import {
  applyPreset,
  defaultGraphicsSettings,
  parseGraphicsSettings,
  serializeGraphicsSettings,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";

// ============================================================================
// TYPES
// ============================================================================

export type ClockType = "analog" | "digital";
export type ClockFormat = "12h" | "24h";
export type Renderer = "3d" | "pixel";
export type GraphicsQuality = "auto" | "high" | "low";

export interface PreferencesState {
  clockType: ClockType;
  clockFormat: ClockFormat;
  autoFollowNewSessions: boolean;
  language: Locale;
  renderer: Renderer;
  graphicsQuality: GraphicsQuality;
  /** Full 3D graphics settings (Graphics menu); persisted as "graphics_settings". */
  graphics: GraphicsSettings;
  isLoaded: boolean;

  // Lobby brand sign (persisted as brand_* preferences)
  brandName: string;
  brandTagline: string;
  /** PNG/WebP data URL (<= 512 px, <= 200 KB) or "" for the default star. */
  brandLogo: string;
  brandNeonColor: string;
  brandFlicker: boolean;

  // Attention settings
  commandBarEnabled: boolean;
  clickToFocusEnabled: boolean;
  toastFilterPermission: boolean;
  toastFilterError: boolean;
  toastFilterTaskComplete: boolean;
  toastFilterArrival: boolean;
  toastAutoDismissLow: number;
  toastAutoDismissInfo: number;

  // Actions
  loadPreferences: () => Promise<void>;
  setClockType: (type: ClockType) => Promise<void>;
  setClockFormat: (format: ClockFormat) => Promise<void>;
  setAutoFollowNewSessions: (enabled: boolean) => Promise<void>;
  setLanguage: (language: Locale) => Promise<void>;
  setRenderer: (renderer: Renderer) => Promise<void>;
  setGraphicsQuality: (quality: GraphicsQuality) => Promise<void>;
  /** Replace graphics settings; applied immediately, persisted debounced. */
  setGraphics: (graphics: GraphicsSettings) => void;
  /** Flush a pending debounced graphics save right away. */
  flushGraphics: () => Promise<void>;
  cycleClockMode: () => Promise<void>;
  setCommandBarEnabled: (enabled: boolean) => Promise<void>;
  setClickToFocusEnabled: (enabled: boolean) => Promise<void>;
  setToastFilterPermission: (enabled: boolean) => Promise<void>;
  setToastFilterError: (enabled: boolean) => Promise<void>;
  setToastFilterTaskComplete: (enabled: boolean) => Promise<void>;
  setToastFilterArrival: (enabled: boolean) => Promise<void>;
  setToastAutoDismissLow: (ms: number) => Promise<void>;
  setToastAutoDismissInfo: (ms: number) => Promise<void>;
  setBrandName: (name: string) => void;
  setBrandTagline: (tagline: string) => void;
  setBrandLogo: (dataUrl: string) => Promise<void>;
  setBrandNeonColor: (color: string) => Promise<void>;
  setBrandFlicker: (enabled: boolean) => Promise<void>;
}

/** Store slice -> options consumed by IWorld.setBranding. */
export function selectBranding(
  s: Pick<
    PreferencesState,
    | "brandName"
    | "brandTagline"
    | "brandLogo"
    | "brandNeonColor"
    | "brandFlicker"
  >,
): BrandingOptions {
  return normalizeBranding({
    name: s.brandName,
    tagline: s.brandTagline,
    logo: s.brandLogo,
    color: s.brandNeonColor,
    flicker: s.brandFlicker,
  });
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PREFS_PATH = "/api/v1/preferences";

const DEFAULT_CLOCK_TYPE: ClockType = "analog";
const DEFAULT_CLOCK_FORMAT: ClockFormat = "12h";
const DEFAULT_AUTO_FOLLOW_NEW_SESSIONS = true;
const DEFAULT_LANGUAGE: Locale = "en";
const DEFAULT_RENDERER: Renderer = "3d";
const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = "auto";
const DEFAULT_COMMAND_BAR_ENABLED = true;
const DEFAULT_CLICK_TO_FOCUS_ENABLED = false;
const DEFAULT_TOAST_FILTER_PERMISSION = true;
const DEFAULT_TOAST_FILTER_ERROR = false;
const DEFAULT_TOAST_FILTER_TASK_COMPLETE = true;
const DEFAULT_TOAST_FILTER_ARRIVAL = false;
const DEFAULT_TOAST_AUTO_DISMISS_LOW = 5000;
const DEFAULT_TOAST_AUTO_DISMISS_INFO = 3000;

// ============================================================================
// PARSERS
// ============================================================================

/** Explicit parse: anything other than "pixel" (incl. missing) is "3d". */
export function parseRenderer(raw: string | undefined): Renderer {
  return raw === "pixel" ? "pixel" : DEFAULT_RENDERER;
}

export function parseGraphicsQuality(raw: string | undefined): GraphicsQuality {
  return raw === "high" || raw === "low" ? raw : DEFAULT_GRAPHICS_QUALITY;
}

/**
 * graphics_settings JSON wins; otherwise derive from the legacy
 * graphics_quality (auto/high/low → preset).
 */
export function resolveGraphics(
  prefs: Record<string, string>,
  isMobile = false,
): GraphicsSettings {
  if (prefs.graphics_settings)
    return parseGraphicsSettings(prefs.graphics_settings, isMobile);
  const base = defaultGraphicsSettings(isMobile);
  const q = parseGraphicsQuality(prefs.graphics_quality);
  return prefs.graphics_quality ? applyPreset(q, base) : base;
}

const BRAND_SAVE_DEBOUNCE_MS = 400;
const brandTimers = new Map<string, ReturnType<typeof setTimeout>>();

const GRAPHICS_SAVE_DEBOUNCE_MS = 300;
let graphicsTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// API HELPERS
// ============================================================================

async function fetchPreferences(): Promise<Record<string, string>> {
  try {
    const res = await apiFetch(PREFS_PATH);
    if (res.ok) {
      return (await res.json()) as Record<string, string>;
    }
  } catch (err) {
    console.warn("[preferences] Failed to fetch:", err);
  }
  return {};
}

async function setPreference(key: string, value: string): Promise<void> {
  try {
    await apiFetch(`${PREFS_PATH}/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  } catch (err) {
    console.warn(`[preferences] Failed to save "${key}":`, err);
  }
}

/** Typing-friendly save: last value per key wins after a short pause. */
function saveDebounced(key: string, value: string): void {
  const prev = brandTimers.get(key);
  if (prev) clearTimeout(prev);
  brandTimers.set(
    key,
    setTimeout(() => {
      brandTimers.delete(key);
      void setPreference(key, value);
    }, BRAND_SAVE_DEBOUNCE_MS),
  );
}

// ============================================================================
// STORE
// ============================================================================

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
  clockType: DEFAULT_CLOCK_TYPE,
  clockFormat: DEFAULT_CLOCK_FORMAT,
  autoFollowNewSessions: DEFAULT_AUTO_FOLLOW_NEW_SESSIONS,
  language: DEFAULT_LANGUAGE,
  renderer: DEFAULT_RENDERER,
  graphicsQuality: DEFAULT_GRAPHICS_QUALITY,
  graphics: defaultGraphicsSettings(),
  commandBarEnabled: DEFAULT_COMMAND_BAR_ENABLED,
  clickToFocusEnabled: DEFAULT_CLICK_TO_FOCUS_ENABLED,
  toastFilterPermission: DEFAULT_TOAST_FILTER_PERMISSION,
  toastFilterError: DEFAULT_TOAST_FILTER_ERROR,
  toastFilterTaskComplete: DEFAULT_TOAST_FILTER_TASK_COMPLETE,
  toastFilterArrival: DEFAULT_TOAST_FILTER_ARRIVAL,
  toastAutoDismissLow: DEFAULT_TOAST_AUTO_DISMISS_LOW,
  toastAutoDismissInfo: DEFAULT_TOAST_AUTO_DISMISS_INFO,
  brandName: DEFAULT_BRANDING.name,
  brandTagline: DEFAULT_BRANDING.tagline,
  brandLogo: "",
  brandNeonColor: DEFAULT_BRANDING.color,
  brandFlicker: DEFAULT_BRANDING.flicker,
  isLoaded: false,

  loadPreferences: async () => {
    const prefs = await fetchPreferences();

    const clockTypeRaw = prefs.clock_type || DEFAULT_CLOCK_TYPE;
    const clockFormatRaw = prefs.clock_format || DEFAULT_CLOCK_FORMAT;
    const autoFollowRaw = prefs.auto_follow_new_sessions;
    const autoFollowNewSessions =
      autoFollowRaw === undefined
        ? DEFAULT_AUTO_FOLLOW_NEW_SESSIONS
        : autoFollowRaw === "true";
    const language = prefs.language || DEFAULT_LANGUAGE;

    set({
      clockType:
        clockTypeRaw === "analog" || clockTypeRaw === "digital"
          ? clockTypeRaw
          : DEFAULT_CLOCK_TYPE,
      clockFormat:
        clockFormatRaw === "12h" || clockFormatRaw === "24h"
          ? clockFormatRaw
          : DEFAULT_CLOCK_FORMAT,
      autoFollowNewSessions,
      language: isLocale(language) ? language : DEFAULT_LANGUAGE,
      renderer: parseRenderer(prefs.renderer),
      graphicsQuality: parseGraphicsQuality(prefs.graphics_quality),
      graphics: resolveGraphics(
        prefs,
        typeof window !== "undefined" && window.innerWidth < 768,
      ),
      commandBarEnabled: prefs.commandBarEnabled !== "false",
      clickToFocusEnabled: prefs.clickToFocusEnabled !== "false",
      toastFilterPermission: prefs.toastFilterPermission !== "false",
      toastFilterError: prefs.toastFilterError !== "false",
      toastFilterTaskComplete: prefs.toastFilterTaskComplete !== "false",
      toastFilterArrival: prefs.toastFilterArrival !== "false",
      toastAutoDismissLow: prefs.toastAutoDismissLow
        ? Number(prefs.toastAutoDismissLow)
        : DEFAULT_TOAST_AUTO_DISMISS_LOW,
      toastAutoDismissInfo: prefs.toastAutoDismissInfo
        ? Number(prefs.toastAutoDismissInfo)
        : DEFAULT_TOAST_AUTO_DISMISS_INFO,
      brandName:
        prefs.brand_name === undefined
          ? DEFAULT_BRANDING.name
          : clampText(prefs.brand_name, MAX_NAME_CHARS),
      brandTagline: clampText(prefs.brand_tagline, MAX_TAGLINE_CHARS),
      brandLogo: normalizeBranding({ logo: prefs.brand_logo }).logo ?? "",
      brandNeonColor:
        parseNeonColor(prefs.brand_neon_color) ?? DEFAULT_BRANDING.color,
      brandFlicker: prefs.brand_flicker === "true",
      isLoaded: true,
    });
  },

  setBrandName: (brandName) => {
    set({ brandName });
    saveDebounced("brand_name", clampText(brandName, MAX_NAME_CHARS));
  },

  setBrandTagline: (brandTagline) => {
    set({ brandTagline });
    saveDebounced("brand_tagline", clampText(brandTagline, MAX_TAGLINE_CHARS));
  },

  setBrandLogo: async (brandLogo) => {
    set({ brandLogo });
    await setPreference("brand_logo", brandLogo);
  },

  setBrandNeonColor: async (color) => {
    const brandNeonColor = parseNeonColor(color) ?? DEFAULT_BRANDING.color;
    set({ brandNeonColor });
    await setPreference("brand_neon_color", brandNeonColor);
  },

  setBrandFlicker: async (brandFlicker) => {
    set({ brandFlicker });
    await setPreference("brand_flicker", String(brandFlicker));
  },

  setClockType: async (clockType) => {
    set({ clockType });
    await setPreference("clock_type", clockType);
  },

  setClockFormat: async (clockFormat) => {
    set({ clockFormat });
    await setPreference("clock_format", clockFormat);
  },

  setAutoFollowNewSessions: async (enabled) => {
    set({ autoFollowNewSessions: enabled });
    await setPreference("auto_follow_new_sessions", String(enabled));
  },

  setLanguage: async (language) => {
    set({ language });
    await setPreference("language", language);
  },

  setRenderer: async (renderer) => {
    set({ renderer });
    await setPreference("renderer", renderer);
  },

  setGraphicsQuality: async (graphicsQuality) => {
    set({ graphicsQuality });
    // Keep the full settings in step with the legacy auto/high/low switch.
    get().setGraphics(applyPreset(graphicsQuality, get().graphics));
    await setPreference("graphics_quality", graphicsQuality);
  },

  setGraphics: (graphics) => {
    set({ graphics });
    if (graphicsTimer) clearTimeout(graphicsTimer);
    graphicsTimer = setTimeout(() => {
      graphicsTimer = null;
      void setPreference(
        "graphics_settings",
        serializeGraphicsSettings(get().graphics),
      );
    }, GRAPHICS_SAVE_DEBOUNCE_MS);
  },

  flushGraphics: async () => {
    if (!graphicsTimer) return;
    clearTimeout(graphicsTimer);
    graphicsTimer = null;
    await setPreference(
      "graphics_settings",
      serializeGraphicsSettings(get().graphics),
    );
  },

  cycleClockMode: async () => {
    const { clockType, clockFormat } = get();

    // Cycle: analog → digital 12h → digital 24h → analog
    let newClockType: ClockType;
    let newClockFormat: ClockFormat;

    if (clockType === "analog") {
      newClockType = "digital";
      newClockFormat = "12h";
    } else if (clockType === "digital" && clockFormat === "12h") {
      newClockType = "digital";
      newClockFormat = "24h";
    } else {
      newClockType = "analog";
      newClockFormat = "12h";
    }

    set({ clockType: newClockType, clockFormat: newClockFormat });

    // Save both in parallel
    await Promise.all([
      setPreference("clock_type", newClockType),
      setPreference("clock_format", newClockFormat),
    ]);
  },

  setCommandBarEnabled: async (enabled) => {
    set({ commandBarEnabled: enabled });
    await setPreference("commandBarEnabled", String(enabled));
  },

  setClickToFocusEnabled: async (enabled) => {
    set({ clickToFocusEnabled: enabled });
    await setPreference("clickToFocusEnabled", String(enabled));
  },

  setToastFilterPermission: async (enabled) => {
    set({ toastFilterPermission: enabled });
    await setPreference("toastFilterPermission", String(enabled));
  },

  setToastFilterError: async (enabled) => {
    set({ toastFilterError: enabled });
    await setPreference("toastFilterError", String(enabled));
  },

  setToastFilterTaskComplete: async (enabled) => {
    set({ toastFilterTaskComplete: enabled });
    await setPreference("toastFilterTaskComplete", String(enabled));
  },

  setToastFilterArrival: async (enabled) => {
    set({ toastFilterArrival: enabled });
    await setPreference("toastFilterArrival", String(enabled));
  },

  setToastAutoDismissLow: async (ms) => {
    set({ toastAutoDismissLow: ms });
    await setPreference("toastAutoDismissLow", String(ms));
  },

  setToastAutoDismissInfo: async (ms) => {
    set({ toastAutoDismissInfo: ms });
    await setPreference("toastAutoDismissInfo", String(ms));
  },
}));

// ============================================================================
// SELECTORS
// ============================================================================

export const selectClockType = (state: PreferencesState) => state.clockType;
export const selectClockFormat = (state: PreferencesState) => state.clockFormat;
export const selectAutoFollowNewSessions = (state: PreferencesState) =>
  state.autoFollowNewSessions;
export const selectLanguage = (state: PreferencesState) => state.language;
export const selectRenderer = (state: PreferencesState) => state.renderer;
export const selectGraphicsQuality = (state: PreferencesState) =>
  state.graphicsQuality;
export const selectGraphics = (state: PreferencesState) => state.graphics;
export const selectIsLoaded = (state: PreferencesState) => state.isLoaded;
export const selectCommandBarEnabled = (state: PreferencesState) =>
  state.commandBarEnabled;
export const selectClickToFocusEnabled = (state: PreferencesState) =>
  state.clickToFocusEnabled;
export const selectToastFilterPermission = (state: PreferencesState) =>
  state.toastFilterPermission;
export const selectToastFilterError = (state: PreferencesState) =>
  state.toastFilterError;
export const selectToastFilterTaskComplete = (state: PreferencesState) =>
  state.toastFilterTaskComplete;
export const selectToastFilterArrival = (state: PreferencesState) =>
  state.toastFilterArrival;
export const selectToastAutoDismissLow = (state: PreferencesState) =>
  state.toastAutoDismissLow;
export const selectToastAutoDismissInfo = (state: PreferencesState) =>
  state.toastAutoDismissInfo;
