import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setGraphics = vi.fn();
const setBrandFlicker = vi.fn(async () => {});

vi.mock("react", () => ({
  useEffect: (fn: () => void) => void fn(),
  useSyncExternalStore: (_sub: unknown, get: () => boolean) => get(),
}));
vi.mock("@/stores/preferencesStore", () => ({
  usePreferencesStore: {
    getState: () => ({
      graphics: { headBob: true },
      brandFlicker: true,
      setGraphics,
      setBrandFlicker,
    }),
  },
}));

import {
  useApplyReducedMotion,
  usePrefersReducedMotion,
} from "../src/components/world/hud/reducedMotion";

function stubMedia(reduce: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: reduce,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setGraphics.mockClear();
  setBrandFlicker.mockClear();
});

describe("reduced motion", () => {
  it("reads the media query", () => {
    stubMedia(true);
    expect(usePrefersReducedMotion()).toBe(true);
    stubMedia(false);
    expect(usePrefersReducedMotion()).toBe(false);
  });

  it("turns head bob and sign flicker off when reduced motion is asked for", () => {
    stubMedia(true);
    useApplyReducedMotion();
    expect(setGraphics).toHaveBeenCalledWith({ headBob: false });
    expect(setBrandFlicker).toHaveBeenCalledWith(false);
  });

  it("leaves them alone otherwise", () => {
    stubMedia(false);
    useApplyReducedMotion();
    expect(setGraphics).not.toHaveBeenCalled();
    expect(setBrandFlicker).not.toHaveBeenCalled();
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("HUD text floor", () => {
  it("has no sub-12px Tailwind text classes in components/world", () => {
    const bad = walk(join(__dirname, "../src/components/world")).filter(
      (f) =>
        !f.endsWith("OpsCharts.tsx") &&
        /text-\[(?:[0-9]|1[01])px\]/.test(readFileSync(f, "utf8")),
    );
    expect(bad).toEqual([]);
  });
});
