// @vitest-environment happy-dom
/**
 * A World never shares its WebGL context with an earlier World (ownCanvas.ts).
 *
 * Regression: Fast Refresh disposed the World and built the next one on the
 * same <canvas>; the old engine's late GPU work (HDR prefilter after dispose)
 * ran on the shared context and corrupted the new engine's texture / unit
 * state cache, so floors, walls and ceilings vanished on `/` until a reload.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimCanvas } from "@/engine/world/ownCanvas";

const engines: { canvas: unknown; opts: Record<string, unknown> }[] = [];

vi.mock("@/engine/babylon", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeEngine {
    constructor(canvas: unknown, _aa: unknown, opts: Record<string, unknown>) {
      engines.push({ canvas, opts });
      throw new Error("no webgl in tests");
    }
  }
  return { ...real, Engine: FakeEngine };
});

function host(): { root: HTMLDivElement; canvas: HTMLCanvasElement } {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.className = "block h-full w-full";
  canvas.tabIndex = 0;
  canvas.setAttribute("data-tour-id", "c");
  root.appendChild(canvas);
  document.body.appendChild(root);
  return { root, canvas };
}

afterEach(() => {
  document.body.innerHTML = "";
  engines.length = 0;
});

describe("claimCanvas", () => {
  it("renders into a private sibling canvas and restores the host on release", () => {
    const h = host();
    const c = claimCanvas(h.canvas);
    expect(c.canvas).not.toBe(h.canvas);
    expect(h.canvas.nextElementSibling).toBe(c.canvas);
    expect(c.canvas.className).toBe("block h-full w-full");
    expect(c.canvas.tabIndex).toBe(0);
    expect(c.canvas.getAttribute("data-tour-id")).toBe("c");
    expect(h.canvas.style.display).toBe("none");
    c.release();
    c.release(); // idempotent
    expect(h.root.children.length).toBe(1);
    expect(h.canvas.style.display).toBe("");
  });

  it("a remount on the same host never reuses an earlier canvas", () => {
    const h = host();
    const seen = new Set<HTMLCanvasElement>([h.canvas]);
    for (let i = 0; i < 3; i++) {
      const c = claimCanvas(h.canvas);
      expect(seen.has(c.canvas)).toBe(false);
      seen.add(c.canvas);
      c.release();
    }
  });
});

describe("World canvas ownership", () => {
  it("builds its engine on a private canvas whose context is lost on dispose", async () => {
    const { createWorld } = await import("@/engine/world/World");
    const h = host();
    const opts = {
      quality: "high" as const,
      cameraMode: "fp" as const,
      isMobile: false,
      assetBase: "/assets",
    };
    expect(() => createWorld(h.canvas, opts)).toThrow("no webgl");
    expect(() => createWorld(h.canvas, opts)).toThrow("no webgl");
    expect(engines).toHaveLength(2);
    const [a, b] = engines;
    expect(a.canvas).not.toBe(h.canvas);
    expect(b.canvas).not.toBe(h.canvas);
    expect(b.canvas).not.toBe(a.canvas);
    expect(a.opts.loseContextOnDispose).toBe(true);
    // A failed construction leaves the host untouched.
    expect(h.root.children.length).toBe(1);
    expect(h.canvas.style.display).toBe("");
  });
});
