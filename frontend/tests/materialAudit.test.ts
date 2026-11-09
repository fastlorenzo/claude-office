/**
 * WS5 material audit (NullEngine): physically plausible PBR parameters and
 * frozen static materials.
 *
 *  - every PBRMaterial is a dielectric (metallic 0) or a metal (1);
 *  - no textured surface amplifies its albedo map (gain channel > 1 lifts
 *    8-bit noise and reads as grey plastic);
 *  - after init every material that does not animate is frozen (the
 *    allowed exceptions are listed and capped at 8).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Matrix,
  NullEngine,
  PBRMaterial,
  Scene,
  type Material,
} from "@/engine/babylon";
import { Materials, surfaceAudit } from "@/engine/materials/Materials";
import { ContactShadows, blobMatrix } from "@/engine/assets/contactShadows";
import {
  createEmissiveMaterial,
  setScreenTexture,
  sharedScreenMaterial,
} from "@/engine/screens/canvasKit";
import { Conveyors } from "@/engine/world/factory/Conveyors";
import { Stations } from "@/engine/world/factory/Stations";
import { Workpieces } from "@/engine/world/factory/Workpieces";
import { Cells } from "@/engine/world/factory/Cell";
import { textureBytes } from "@/engine/fx/textureMemory";

/** Minimal 2D canvas so DynamicTexture-based modules construct headless. */
function stubCanvas(): void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  if (g.OffscreenCanvas) return;
  const ctx: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "measureText"
          ? () => ({ width: 0, actualBoundingBoxAscent: 0 })
          : k === "getImageData" || k === "createImageData"
            ? () => ({ data: new Uint8ClampedArray(4) })
            : k === "createLinearGradient" || k === "createRadialGradient"
              ? () => ({ addColorStop: () => undefined })
              : () => undefined,
      set: () => true,
    },
  );
  g.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return ctx;
    }
  };
}

/** Materials allowed to stay unfrozen (they animate per frame). */
const ANIMATED = [
  /^conveyorRubber$/, // BeltScrollPlugin scroll uniform
  /^wpTag/, // ShaderMaterial: camera position per frame
  /^opsPulse$/, // alert pulse
];

describe("material audit (WS5)", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeAll(() => {
    stubCanvas();
    engine = new NullEngine();
    scene = new Scene(engine);
    const materials = new Materials(scene, "/assets");
    for (const a of surfaceAudit()) materials.get(a.key);
    materials.tinted("fabric", "#7E9A82");
    materials.forVertexColors("concreteSoffit", { grime: true });
    materials.color("#C9CFD7", 0.42, 0);
    materials.freezeAll();
    // Built after freezeAll, as rooms / the factory are in the real world.
    materials.felt("#B85C3E");
    new Conveyors(scene);
    new Stations(scene);
    new Workpieces(scene);
    new Cells(scene);
    new ContactShadows(scene);
    const live = createEmissiveMaterial("monitor_mat", scene, null);
    live.freeze();
    setScreenTexture(live, null);
    sharedScreenMaterial(scene, "bezel");
    sharedScreenMaterial(scene, "screenOff");
    sharedScreenMaterial(scene, "frame");
  });

  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });

  it("surface table: metallic is 0 or 1, textured gains <= 1", () => {
    for (const a of surfaceAudit()) {
      expect([0, 1], a.key).toContain(a.metallic);
      if (a.tint)
        for (const c of a.tint) expect(c, a.key).toBeLessThanOrEqual(1);
    }
  });

  it("every PBRMaterial in the scene is a dielectric or a metal", () => {
    const pbr = scene.materials.filter(
      (m): m is PBRMaterial => m instanceof PBRMaterial,
    );
    expect(pbr.length).toBeGreaterThan(40);
    const bad = pbr
      // Unlit / emissive-only materials have no BRDF to audit.
      .filter((m) => !m.unlit && !m.disableLighting)
      .filter((m) => m.metallic !== 0 && m.metallic !== 1)
      .map((m) => `${m.name}=${m.metallic}`);
    expect(bad).toEqual([]);
  });

  it("no albedo gain > 1 on a textured PBR surface", () => {
    const bad = scene.materials
      .filter(
        (m): m is PBRMaterial => m instanceof PBRMaterial && !!m.albedoTexture,
      )
      .filter(
        (m) => Math.max(m.albedoColor.r, m.albedoColor.g, m.albedoColor.b) > 1,
      )
      .map((m) => m.name);
    expect(bad).toEqual([]);
  });

  it("all non-animated materials are frozen after init (<= 8 exceptions)", () => {
    const thawed = scene.materials
      .filter((m: Material) => !m.isFrozen)
      .map((m) => m.name)
      .filter((n) => n !== "default material");
    const unexpected = thawed.filter((n) => !ANIMATED.some((r) => r.test(n)));
    expect(unexpected).toEqual([]);
    expect(thawed.length).toBeLessThanOrEqual(8);
  });

  it("a screen picture swap keeps the material frozen", () => {
    const m = createEmissiveMaterial("swap", scene, null);
    m.freeze();
    setScreenTexture(m, null);
    expect(m.isFrozen).toBe(true);
  });
});

describe("contact shadow placement (WS5)", () => {
  it("scales the unit quad to the footprint × 1.15, 3 mm above the floor", () => {
    const place = Matrix.Translation(2, 0, -3);
    const m = blobMatrix(place, 2, 1, new Matrix());
    const a = m.asArray();
    expect(a[0]).toBeCloseTo(2.3, 5);
    expect(a[10]).toBeCloseTo(1.15, 5);
    expect(a[12]).toBeCloseTo(2, 5);
    expect(a[13]).toBeCloseTo(0.003, 5);
    expect(a[14]).toBeCloseTo(-3, 5);
  });
});

describe("texture memory estimate (WS5)", () => {
  it("counts cubes ×6, mips ×4/3, half floats ×2 and red maps as 1 channel", () => {
    const base = {
      width: 1024,
      height: 1024,
      isCube: false,
      generateMipMaps: false,
      type: 0,
      format: 5,
    };
    expect(textureBytes(base)).toBe(1024 * 1024 * 4);
    expect(textureBytes({ ...base, generateMipMaps: true })).toBeCloseTo(
      (1024 * 1024 * 4 * 4) / 3,
    );
    expect(textureBytes({ ...base, isCube: true, type: 2 })).toBe(
      1024 * 1024 * 6 * 8,
    );
    expect(textureBytes({ ...base, type: 1, format: 6 })).toBe(1024 * 1024 * 4);
  });
});

describe("vertex AO (WS5)", () => {
  it("darkens a floor-standing piece toward the contact and its underside", async () => {
    const { vertexAO } = await import("@/engine/art/geometry");
    const { CreateBox } = await import("@/engine/babylon");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const leg = CreateBox(
      "leg",
      { width: 0.05, height: 0.7, depth: 0.05 },
      scene,
    );
    leg.position.y = 0.35; // stands on the office floor
    const ao = vertexAO(leg)!;
    expect(ao).not.toBeNull();
    expect(Math.min(...ao)).toBeCloseTo(0.8, 5);
    const shelf = CreateBox(
      "shelf",
      { width: 1, height: 0.03, depth: 0.4 },
      scene,
    );
    shelf.position.y = 1.2; // floating: only its underside darkens
    const s = vertexAO(shelf)!;
    expect(Math.min(...s)).toBeCloseTo(0.9, 5);
    const wall = CreateBox("wall", { width: 4, height: 3, depth: 0.2 }, scene);
    wall.position.y = 1.5; // too tall for contact AO (would smear)
    const w = vertexAO(wall)!;
    expect(Math.min(...w)).toBeCloseTo(0.9, 5);
    scene.dispose();
    engine.dispose();
  });
});

describe("lighting state is a pure function of the plan (WS5 L1, P4)", () => {
  it("allocates no shadow generator before the first plan and round-trips ambient", async () => {
    const { Lighting } = await import("@/engine/fx/Lighting");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lighting = new Lighting(scene);
    // (No camera: NullEngine has no cascaded shadows; the static sun map
    // still shows whether anything was allocated.)
    lighting.addStaticCasters([]);
    expect(lighting.sun.getShadowGenerator()).toBeFalsy();
    lighting.setShadowQuality("high");
    lighting.setMaxDynamicLights(4);
    lighting.setPoolIntensity(1);
    const high = [lighting.fill.intensity, lighting.key.intensity];
    expect(lighting.sun.getShadowGenerator()).toBeTruthy();
    lighting.setShadowQuality("off");
    lighting.setMaxDynamicLights(0);
    lighting.setPoolIntensity(0);
    const low = [lighting.fill.intensity, lighting.key.intensity];
    // Low tier (no sun, no fixtures): its own ambient, within 15 % of high
    // at the spawn (WS5b perf-gate luminance): 1.2 x fill, 0.75 x key of the
    // LOOK levels (no lightmaps in this scene).
    const { LOOK } = await import("@/engine/fx/look");
    expect(low[0]).toBeCloseTo(LOOK.fill * 1.2, 6);
    expect(low[1]).toBeCloseTo(LOOK.key * 0.75, 6);
    lighting.setShadowQuality("high");
    lighting.setMaxDynamicLights(4);
    lighting.setPoolIntensity(1);
    expect([lighting.fill.intensity, lighting.key.intensity]).toEqual(high);
    lighting.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("lists static casters at once, so receivers compile the sun-shadow lookup (WS5b)", async () => {
    const { Lighting } = await import("@/engine/fx/Lighting");
    const { CreateBox } = await import("@/engine/babylon");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lighting = new Lighting(scene);
    lighting.setShadowQuality("high");
    const roof = CreateBox(
      "roof",
      { width: 10, height: 0.1, depth: 10 },
      scene,
    );
    roof.position.y = 6;
    lighting.addStaticCasters([roof]);
    // Not deferred to the readiness-gated first render: Babylon skips the
    // SHADOW<n> define while a generator's render list is empty, and frozen
    // materials never revisit it.
    expect(lighting.staticShadowState.listed).toBe(1);
    expect(lighting.sun.autoUpdateExtends).toBe(false);
    lighting.dispose();
    scene.dispose();
    engine.dispose();
  });
});

describe("compressed texture memory (KTX2)", () => {
  const tex = {
    width: 1024,
    height: 1024,
    isCube: false,
    generateMipMaps: false,
    type: 0,
    format: 36492, // BC7
  };
  it("sizes block formats by bits per pixel, mips included", async () => {
    const { textureBytes: tb, compressedBitsPerPixel } =
      await import("@/engine/fx/textureMemory");
    expect(tb(tex)).toBe(1024 * 1024); // 8 bpp
    expect(tb({ ...tex, format: 37492 })).toBe(1024 * 512); // ETC2 RGB 4 bpp
    expect(tb({ ...tex, format: 33776, generateMipMaps: true })).toBeCloseTo(
      (1024 * 512 * 4) / 3,
    );
    // a shipped mip chain counts even when generateMipMaps is off
    expect(tb({ ...tex, mipLevelCount: 11 })).toBeCloseTo(
      (1024 * 1024 * 4) / 3,
    );
    expect(compressedBitsPerPixel(37808)).toBe(8); // ASTC 4x4
    expect(compressedBitsPerPixel(37840)).toBe(8); // sRGB ASTC 4x4
    expect(compressedBitsPerPixel(37815)).toBe(2); // ASTC 8x8
    expect(compressedBitsPerPixel(5)).toBe(0); // RGBA is not compressed
  });
});
