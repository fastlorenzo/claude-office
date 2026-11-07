import { describe, expect, it } from "vitest";
import {
  PRESETS,
  applyPreset,
  defaultGraphicsSettings,
  updateSetting,
} from "@/engine/fx/graphicsSettings";
import {
  activeStages,
  aaParts,
  diffPlan,
  firstChangedStage,
  planFx,
  resolveEffective,
  structuralKeys,
} from "@/engine/fx/fxPlan";
import { QualityGovernor } from "@/engine/fx/Quality";

const base = defaultGraphicsSettings();
const of = (p: "low" | "medium" | "high" | "ultra") =>
  planFx(applyPreset(p, base));

describe("antialiasing mapping", () => {
  it("keeps TAA and MSAA mutually exclusive", () => {
    for (const aa of ["taa", "taa+fxaa"] as const) {
      const a = aaParts(aa);
      expect(a.taa).toBe(true);
      expect(a.msaa).toBe(1);
    }
    expect(aaParts("msaa4")).toEqual({ msaa: 4, fxaa: false, taa: false });
    expect(aaParts("fxaa").fxaa).toBe(true);
    expect(aaParts("off")).toEqual({ msaa: 1, fxaa: false, taa: false });
  });
  it("uses 8 TAA samples, 16 with FXAA", () => {
    expect(of("high").taa?.samples).toBe(8);
    expect(of("ultra").taa?.samples).toBe(16);
    expect(of("ultra").fxaa).toBe(true);
  });
});

describe("planFx presets", () => {
  it("low renders at 0.75 through FSR1 and skips heavy effects", () => {
    const p = of("low");
    expect(p.fsr?.scaleFactor).toBeCloseTo(1.33, 2);
    expect(p.renderScale).toBe(1);
    expect(p.ssao).toBeNull();
    expect(p.ssr).toBeNull();
    expect(p.sharpenOn).toBe(false); // FSR does the sharpening
    expect(p.shadows).toBe("off");
  });
  it("uses plain hardware scaling without an upscaler", () => {
    const s = { ...applyPreset("medium", base), renderScale: 0.6 };
    const p = planFx(s);
    expect(p.fsr).toBeNull();
    expect(p.renderScale).toBeCloseTo(0.6);
  });
  it("scales SSAO / SSR with the quality level", () => {
    expect(of("medium").ssao?.samples).toBe(8);
    expect(of("high").ssao?.samples).toBe(16);
    expect(of("ultra").ssao?.samples).toBeGreaterThan(16);
    expect(of("medium").ssr).toBeNull();
    expect(of("high").ssr?.downsample).toBe(1);
    expect(of("ultra").ssr?.downsample).toBe(0);
    expect(of("ultra").ssr!.maxSteps).toBeGreaterThan(of("high").ssr!.maxSteps);
  });
  it("passes personal settings through", () => {
    const s = updateSetting(updateSetting(base, "fov", 90), "fpsCap", 60);
    const p = planFx(s);
    expect(p.fovDeg).toBe(90);
    expect(p.fpsCap).toBe(60);
  });
});

describe("diffPlan / structural stages", () => {
  it("reports nothing for identical plans", () => {
    expect(diffPlan(of("high"), of("high")).size).toBe(0);
  });
  it("reports only the changed fields", () => {
    const a = planFx(applyPreset("high", base));
    const b = planFx(
      updateSetting(applyPreset("high", base), "vignette", false),
    );
    expect([...diffPlan(a, b)]).toEqual(["vignette"]);
  });
  it("vignette / grading changes are not structural", () => {
    const a = of("high");
    const b = planFx(
      updateSetting(applyPreset("high", base), "colorGrading", false),
    );
    expect(firstChangedStage(structuralKeys(a), structuralKeys(b))).toBe(-1);
  });
  it("rebuilds from the first changed stage", () => {
    const a = structuralKeys(of("high"));
    const noSsr = structuralKeys(
      planFx(
        updateSetting(
          applyPreset("high", base),
          "screenSpaceReflections",
          "off",
        ),
      ),
    );
    // stages: fsr(0) ssao(1) ssr(2) ...
    expect(firstChangedStage(a, noSsr)).toBe(2);
    const noFsr = structuralKeys(of("medium"));
    expect(firstChangedStage(structuralKeys(of("low")), noFsr)).toBe(0);
    expect(firstChangedStage(null, a)).toBe(0);
  });
  it("DoF presence is structural only while live", () => {
    const p = of("high");
    expect(structuralKeys(p, false).default).not.toBe(
      structuralKeys(p, true).default,
    );
  });
  it("lists active post-processes", () => {
    const names = activeStages(of("ultra"), false);
    expect(names).toEqual(
      expect.arrayContaining(["ssao2", "ssr", "taa", "fxaa", "bloom", "grain"]),
    );
    expect(activeStages(of("low"), false)).toContain("fsr1");
  });
});

describe("resolveEffective", () => {
  it("auto resolves to the governor tier but keeps personal prefs", () => {
    const s = { ...updateSetting(base, "fov", 88), preset: "auto" as const };
    const eff = resolveEffective(s, "low");
    expect(eff.fov).toBe(88);
    expect(eff.shadows).toBe(PRESETS.low.shadows);
    expect(resolveEffective(s, "high").shadows).toBe(PRESETS.high.shadows);
  });
  it("leaves concrete presets untouched", () => {
    const s = applyPreset("ultra", base);
    expect(resolveEffective(s, "low")).toBe(s);
  });
});

describe("QualityGovernor", () => {
  it("steps down on slow frames and back up after 20 s of fast ones", () => {
    const seen: string[] = [];
    const g = new QualityGovernor(true, false, (t) => seen.push(t));
    expect(g.tier).toBe("high");
    let now = 0;
    for (let i = 0; i < 400; i++) g.sample(40, (now += 40)); // 16 s slow
    expect(g.tier).toBe("low"); // high -> medium -> low, 3 s apart
    for (let i = 0; i < 3000; i++) g.sample(8, (now += 8)); // 24 s fast
    expect(g.tier).toBe("medium");
    expect(seen).toEqual(["medium", "low", "medium"]);
  });
  it("is inert when pinned", () => {
    const g = new QualityGovernor(false, false, () => {});
    for (let i = 0; i < 400; i++) g.sample(60, i * 60);
    expect(g.tier).toBe("high");
  });
  it("starts low on low-end devices", () => {
    expect(new QualityGovernor(true, true, () => {}).tier).toBe("low");
  });
});
