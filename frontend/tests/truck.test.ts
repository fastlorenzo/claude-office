import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import { Truck, TRUCK } from "@/engine/world/factory/Truck";

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

/** Raw thin-instance matrix buffer (Babylon caches its Matrix[] view). */
function wheelM5(t: Truck, i = 0): number {
  return (t as unknown as { wheelBuf: Float32Array }).wheelBuf[i * 16 + 5];
}

function make(): { scene: Scene; truck: Truck } {
  const scene = new Scene(new NullEngine());
  return { scene, truck: new Truck(scene, null) };
}

describe("Truck (WS6)", () => {
  it("is three draws: body, livery, 12 thin-instanced wheels", () => {
    const { truck } = make();
    expect(truck.meshes).toHaveLength(3);
    expect(truck.wheels.thinInstanceCount).toBe(12);
  });

  it("has EU artic proportions (16.5 m, 2.55 m trailer, 4 m high)", () => {
    const { truck } = make();
    const p = truck.body.getVerticesData("position")!;
    let zMin = Infinity;
    let zMax = -Infinity;
    let yMax = -Infinity;
    let trailerHalfW = 0;
    for (let i = 0; i < p.length; i += 3) {
      zMin = Math.min(zMin, p[i + 2]);
      zMax = Math.max(zMax, p[i + 2]);
      yMax = Math.max(yMax, p[i + 1]);
      // Trailer box flank (above the rails, ahead of the open doors).
      if (p[i + 2] > 1.3 && p[i + 2] < 13.7 && p[i + 1] > 1.5)
        trailerHalfW = Math.max(trailerHalfW, Math.abs(p[i]));
    }
    expect(zMax - zMin).toBeGreaterThan(16.3);
    expect(zMax - zMin).toBeLessThanOrEqual(16.5);
    expect(yMax).toBeCloseTo(TRUCK.roofY, 1);
    expect(trailerHalfW).toBeCloseTo(TRUCK.trailerW / 2, 1);
    expect(TRUCK.trailerL).toBe(13.6);
    expect(TRUCK.floorY).toBe(1.2);
  });

  it("stands every tyre on the ground", () => {
    const { truck } = make();
    for (const m of truck.wheels.thinInstanceGetWorldMatrices()) {
      const y = m.getTranslation().y;
      const r = 0.536 * Math.hypot(m.m[4], m.m[5], m.m[6]);
      expect(y - r).toBeLessThanOrEqual(0);
      expect(y - r).toBeGreaterThan(-0.03);
    }
  });

  it("rolls the wheels with the root's z travel, not on a reset jump", () => {
    const { scene, truck } = make();
    const before = wheelM5(truck);
    truck.root.position.z += 1;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const rolled = wheelM5(truck);
    expect(before).toBeCloseTo(1);
    expect(rolled).toBeCloseTo(Math.cos(1 / 0.536), 4);
    truck.root.position.z = 80;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(wheelM5(truck)).toBeCloseTo(rolled, 6);
    truck.dispose();
    expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false);
  });
});
