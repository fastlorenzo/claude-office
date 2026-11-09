import { describe, expect, it } from "vitest";
import { GraphicsController } from "@/engine/fx/GraphicsController";
import {
  applyPreset,
  defaultGraphicsSettings,
} from "@/engine/fx/graphicsSettings";

type Mrt = {
  getCustomRenderList?: (i: number, l: unknown[], n: number) => unknown;
};

function make() {
  const mrt: Mrt = {};
  const scene = {
    geometryBufferRenderer: { getGBuffer: () => mrt },
    activeCamera: { globalPosition: { x: 0, y: 0, z: 0 } },
  };
  const t = { scene, getFx: () => null } as never;
  const s = applyPreset("medium", defaultGraphicsSettings());
  return { mrt, scene, gc: new GraphicsController(t, s, false) };
}

describe("G-buffer custom render list", () => {
  it("returns an empty list (not null) when no pass needs the G-buffer", () => {
    const { mrt, gc } = make();
    gc.update(16);
    expect(gc.currentPlan?.gbufferRangeM ?? 0).toBe(0);
    const out = mrt.getCustomRenderList?.(0, [{}, {}], 2);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(0);
  });
  it("re-hooks a fresh MRT after the G-buffer is re-created", () => {
    const { scene, gc } = make();
    gc.update(16);
    const mrt2: Mrt = {};
    scene.geometryBufferRenderer = { getGBuffer: () => mrt2 };
    gc.update(16);
    expect(typeof mrt2.getCustomRenderList).toBe("function");
  });
});
