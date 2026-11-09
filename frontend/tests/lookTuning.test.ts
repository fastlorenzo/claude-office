/**
 * WS-E: global look values (fx/look.ts) with dev query overrides, and the
 * fixture pool budget when the lightmaps carry the architecture's light.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOK, look, resetLookOverrides } from "@/engine/fx/look";
import { Lighting, fixturePoolSize } from "@/engine/fx/Lighting";
import { CreateBox, NullEngine, Scene } from "@/engine/babylon";

afterEach(() => {
  vi.unstubAllGlobals();
  resetLookOverrides();
});

describe("look", () => {
  it("defaults to LOOK without a query", () => {
    vi.stubGlobal("location", { search: "" });
    resetLookOverrides();
    for (const k of Object.keys(LOOK) as (keyof typeof LOOK)[])
      expect(look(k)).toBe(LOOK[k]);
  });

  it("takes sane numeric query overrides only", () => {
    vi.stubGlobal("location", {
      search: "?exposure=1.3&env=0.2&fill=abc&key=99&contrast=1.2",
    });
    resetLookOverrides();
    expect(look("exposure")).toBe(1.3);
    expect(look("env")).toBe(0.2);
    expect(look("fill")).toBe(LOOK.fill);
    expect(look("key")).toBe(LOOK.key);
    expect(look("contrast")).toBe(1.2);
    expect(look("contrastNoGrade")).toBe(1.2);
  });
});

describe("fixturePoolSize", () => {
  it("no budget: no lights", () => {
    expect(fixturePoolSize(0, true, false)).toBe(0);
    expect(fixturePoolSize(0, true, true)).toBe(0);
  });
  it("forward fallback hops at most 4 lights, baked or not", () => {
    expect(fixturePoolSize(8, false, false)).toBe(4);
    expect(fixturePoolSize(2, false, true)).toBe(2);
  });
  it("clustered: lightmaps halve the pool (fixtures only light props / characters / hall)", () => {
    expect(fixturePoolSize(4, true, false)).toBe(80);
    expect(fixturePoolSize(4, true, true)).toBe(40);
    expect(fixturePoolSize(8, true, false)).toBe(160);
    expect(fixturePoolSize(8, true, true)).toBe(80);
  });
});

describe("low-tier ambient with lightmaps", () => {
  it("keeps the key on baked sets (they get no fill / fixtures at any tier) and round-trips", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lighting = new Lighting(scene);
    const floor = CreateBox("floor", { size: 1 }, scene);
    lighting.setShadowQuality("high");
    lighting.setMaxDynamicLights(4);
    lighting.setPoolIntensity(1);
    lighting.bakeExclude([floor], { sun: false });
    const high = [lighting.fill.intensity, lighting.key.intensity];
    expect(high[0]).toBeCloseTo(LOOK.fill, 6);
    expect(high[1]).toBeCloseTo(LOOK.key, 6);
    lighting.setShadowQuality("off");
    lighting.setMaxDynamicLights(0);
    lighting.setPoolIntensity(0);
    expect(lighting.fill.intensity).toBeCloseTo(LOOK.fill * 1.2, 6);
    expect(lighting.key.intensity).toBeCloseTo(LOOK.key, 6);
    expect(lighting.fill.excludedMeshes).toContain(floor);
    lighting.setShadowQuality("high");
    lighting.setMaxDynamicLights(4);
    lighting.setPoolIntensity(1);
    expect([lighting.fill.intensity, lighting.key.intensity]).toEqual(high);
    lighting.dispose();
    scene.dispose();
    engine.dispose();
  });
});

describe("skinScattering (ultra only)", () => {
  it("is on only in the ultra preset and flows into the plan", async () => {
    const { PRESETS, applyPreset } =
      await import("@/engine/fx/graphicsSettings");
    const { planFx } = await import("@/engine/fx/fxPlan");
    expect(PRESETS.ultra.skinScattering).toBe(true);
    for (const t of ["low", "medium", "high"] as const)
      expect(PRESETS[t].skinScattering).toBe(false);
    expect(planFx(applyPreset("ultra")).skinScattering).toBe(true);
    expect(planFx(applyPreset("high")).skinScattering).toBe(false);
  });

  it("tags tuned skin materials and toggles them; off when no prepass", async () => {
    const { PBRMaterial } = await import("@/engine/babylon");
    const { tuneCharacterMaterial, setSkinScattering } =
      await import("@/engine/characters/characterMaterials");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const skin = new PBRMaterial("office_m01_skin", scene);
    expect(tuneCharacterMaterial(skin)).toBe(true);
    expect(skin.subSurface.isScatteringEnabled).toBe(false);
    const ok = setSkinScattering(scene, true);
    // NullEngine has no MRT prepass: refused, nothing changes.
    expect(skin.subSurface.isScatteringEnabled).toBe(ok);
    expect(setSkinScattering(scene, false)).toBe(true);
    expect(skin.subSurface.isScatteringEnabled).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});
