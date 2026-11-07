import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import { DoorSign } from "@/engine/screens/DoorSign";

/** Minimal 2D context: every method is a no-op, measureText is linear. */
function fakeCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "measureText") {
        return (text: string) => ({ width: text.length * 8 });
      }
      if (k.startsWith("create")) return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): CanvasRenderingContext2D {
    return fakeCtx();
  }
}

beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("DoorSign (NullEngine)", () => {
  it("builds, updates on change only, handles LOD and disposes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const sign = new DoorSign(scene, {
      position: { x: 1, y: 1.5, z: 2 },
      yaw: Math.PI,
      sessionId: "s1",
      roomLabel: "claude-office",
    });
    const meshes = sign.getMeshes();
    expect(meshes.length).toBeGreaterThan(1);
    for (const m of meshes) {
      expect(m.metadata.interact).toMatchObject({
        kind: "screen",
        sessionId: "s1",
        roomLabel: "claude-office",
      });
    }
    expect(sign.getGlowMeshes().length).toBeGreaterThan(0);

    const data = {
      label: "claude-office",
      status: "working" as const,
      objective: "Build the 3D office view",
      focus: "Fixing subagent tracking",
      todoDone: 2,
      todoTotal: 5,
      gitBranch: "feat/3d-office",
    };
    expect(() => sign.update(data)).not.toThrow();
    expect(() => sign.update(data)).not.toThrow();
    expect(() => sign.update({ ...data, status: "needs_you" })).not.toThrow();
    sign.setLod("far");
    sign.update({ ...data, objective: null, focus: null });
    sign.setLod("near");

    sign.dispose();
    sign.dispose();
    expect(scene.getMeshByName("doorsign_s1_surface")).toBeNull();
    scene.dispose();
    engine.dispose();
  });
});
