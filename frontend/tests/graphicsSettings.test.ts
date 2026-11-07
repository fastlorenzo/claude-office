import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANISOTROPY_VALUES,
  PERSONAL_KEYS,
  PRESETS,
  applyPreset,
  defaultGraphicsSettings,
  matchesPreset,
  nearestPreset,
  parseGraphicsSettings,
  serializeGraphicsSettings,
  updateSetting,
} from "../src/engine/fx/graphicsSettings";
import en from "../src/i18n/en";
import {
  ALL_ROWS,
  SECTIONS,
} from "../src/components/world/hud/graphics/schema";
import { PANELS } from "../src/components/world/hud/panels";
import { resolveGraphics } from "../src/stores/preferencesStore";

describe("graphics settings model", () => {
  it("applyPreset keeps personal keys", () => {
    const cur = { ...defaultGraphicsSettings(), fov: 90, invertY: true };
    const s = applyPreset("low", cur);
    expect(s.preset).toBe("low");
    expect(s.fov).toBe(90);
    expect(s.invertY).toBe(true);
    expect(s.shadows).toBe("off");
  });

  it("updateSetting flips to custom for preset fields only", () => {
    const s = applyPreset("high");
    expect(updateSetting(s, "fov", 80).preset).toBe("high");
    expect(updateSetting(s, "bloom", false).preset).toBe("custom");
    expect(updateSetting(s, "preset", "ultra").preset).toBe("ultra");
  });

  it("matchesPreset / nearestPreset", () => {
    const s = applyPreset("medium");
    expect(matchesPreset(s, "medium")).toBe(true);
    expect(matchesPreset(updateSetting(s, "shadows", "ultra"), "medium")).toBe(
      false,
    );
    expect(nearestPreset(updateSetting(s, "shadows", "ultra"))).toBe("medium");
  });

  it("roundtrips through serialize/parse", () => {
    const s = updateSetting(applyPreset("ultra"), "fpsCap", 60);
    expect(parseGraphicsSettings(serializeGraphicsSettings(s))).toEqual(s);
  });

  it("falls back to defaults on junk", () => {
    const d = defaultGraphicsSettings();
    expect(parseGraphicsSettings(null)).toEqual(d);
    expect(parseGraphicsSettings("{nope")).toEqual(d);
    expect(parseGraphicsSettings("42")).toEqual(d);
  });

  it("validates enums and clamps numbers", () => {
    const d = defaultGraphicsSettings();
    const s = parseGraphicsSettings(
      JSON.stringify({
        preset: "ludicrous",
        shadows: "gigantic",
        antiAliasing: "taa",
        anisotropy: 3,
        fpsCap: 75,
        fov: 500,
        renderScale: -2,
        bloom: "yes",
        extra: 1,
      }),
    );
    expect(s.preset).toBe(d.preset);
    expect(s.shadows).toBe(d.shadows);
    expect(s.antiAliasing).toBe("taa");
    expect(s.anisotropy).toBe(d.anisotropy);
    expect(s.fpsCap).toBe(d.fpsCap);
    expect(s.fov).toBe(100);
    expect(s.renderScale).toBe(0.5);
    expect(s.bloom).toBe(d.bloom);
    expect("extra" in s).toBe(false);
    expect(ANISOTROPY_VALUES).toContain(s.anisotropy);
  });

  it("demotes a preset whose fields were edited to custom", () => {
    const raw = JSON.stringify({ ...applyPreset("low"), shadows: "ultra" });
    expect(parseGraphicsSettings(raw).preset).toBe("custom");
    expect(
      parseGraphicsSettings(JSON.stringify(applyPreset("high"))).preset,
    ).toBe("high");
  });

  it("mobile defaults to low", () => {
    const m = defaultGraphicsSettings(true);
    expect(m.preset).toBe("low");
    expect(m.maxPixelRatio).toBe(1.5);
    expect(m.shadows).toBe(PRESETS.low.shadows);
  });
});

describe("legacy graphics_quality mapping", () => {
  it("prefers graphics_settings", () => {
    const s = applyPreset("ultra");
    expect(
      resolveGraphics({
        graphics_settings: serializeGraphicsSettings(s),
        graphics_quality: "low",
      }).preset,
    ).toBe("ultra");
  });
  it("derives from graphics_quality when absent", () => {
    expect(resolveGraphics({ graphics_quality: "low" }).preset).toBe("low");
    expect(resolveGraphics({ graphics_quality: "high" }).preset).toBe("high");
    expect(resolveGraphics({ graphics_quality: "auto" }).preset).toBe("auto");
    expect(resolveGraphics({})).toEqual(defaultGraphicsSettings());
  });
});

describe("graphics menu schema", () => {
  const keys = new Set(Object.keys(defaultGraphicsSettings()));
  it("covers every setting except preset exactly once", () => {
    const rowKeys = ALL_ROWS.map((r) => r.key as string);
    expect(new Set(rowKeys).size).toBe(rowKeys.length);
    expect(
      [...keys].filter((k) => k !== "preset" && !rowKeys.includes(k)),
    ).toEqual([]);
    for (const k of rowKeys) expect(keys.has(k)).toBe(true);
  });
  it("has translations for every row and section", () => {
    for (const r of ALL_ROWS) {
      expect(`gfx.s.${r.key}` in en).toBe(true);
      expect(`gfx.s.${r.key}.d` in en).toBe(true);
    }
    for (const s of SECTIONS) expect(s.titleKey in en).toBe(true);
    for (const p of ["auto", "low", "medium", "high", "ultra", "custom"]) {
      expect(`gfx.preset.${p}` in en).toBe(true);
      expect(`gfx.preset.${p}.d` in en).toBe(true);
    }
  });
  it("personal keys are in the display-ish sections", () => {
    expect(PERSONAL_KEYS.length).toBeGreaterThan(0);
  });
  it("registers the O key without clashing", () => {
    expect(PANELS.graphics.keys).toEqual(["o"]);
    const all = Object.values(PANELS).flatMap((p) => p.keys);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("preferences debounce", () => {
  afterEach(() => vi.useRealTimers());
  it("persists once after sliders settle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { usePreferencesStore } =
      await import("../src/stores/preferencesStore");
    const st = usePreferencesStore.getState();
    for (const v of [0.6, 0.7, 0.8])
      st.setGraphics(
        updateSetting(
          usePreferencesStore.getState().graphics,
          "renderScale",
          v,
        ),
      );
    expect(usePreferencesStore.getState().graphics.renderScale).toBe(0.8);
    await vi.advanceTimersByTimeAsync(350);
    const puts = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("graphics_settings"),
    );
    expect(puts).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
