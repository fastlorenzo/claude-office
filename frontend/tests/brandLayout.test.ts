import { describe, expect, it } from "vitest";
import {
  MAX_LOGO_BYTES,
  dataUrlByteSize,
  downscaleSize,
  fitText,
  layoutBrand,
  neonColors,
  normalizeBranding,
  parseBrandLogo,
  parseNeonColor,
  validateLogoDataUrl,
  validateLogoFile,
} from "@/engine/world/brandLayout";

const measure = (t: string, px: number) => t.length * px * 0.55;

describe("parseNeonColor", () => {
  it("accepts palette names, short and long hex", () => {
    expect(parseNeonColor("cyan")).toBe("#19e3ff");
    expect(parseNeonColor("#F0A")).toBe("#ff00aa");
    expect(parseNeonColor("12ab9C")).toBe("#12ab9c");
  });
  it("rejects junk", () => {
    expect(parseNeonColor("")).toBeNull();
    expect(parseNeonColor("#12")).toBeNull();
    expect(parseNeonColor("blue-ish")).toBeNull();
    expect(parseNeonColor(null)).toBeNull();
  });
  it("neonColors keeps hue vivid with a near-white core", () => {
    const c = neonColors("#19e3ff");
    expect(c.halo).toBe("#19e3ff");
    expect(parseInt(c.core.slice(1, 3), 16)).toBeGreaterThan(200);
  });
});

describe("normalizeBranding", () => {
  it("defaults and clamps", () => {
    const d = normalizeBranding({});
    expect(d.name).toBe("Claude Office");
    expect(d.logo).toBeNull();
    const n = normalizeBranding({
      name: "  A   B  ".padEnd(80, "x"),
      color: "x",
    });
    expect(n.name.length).toBeLessThanOrEqual(28);
    expect(n.color).toBe("#ff6b57");
  });
  it("allows an empty name (logo only)", () => {
    expect(normalizeBranding({ name: "" }).name).toBe("");
  });
});

describe("logo validation", () => {
  const b64 = (n: number) => "A".repeat(n);
  it("checks file type and size", () => {
    expect(validateLogoFile("image/png", 1000)).toBeNull();
    expect(validateLogoFile("image/svg+xml", 1000)).toBeNull();
    expect(validateLogoFile("image/gif", 1000)).toBe("type");
    expect(validateLogoFile("image/png", 0)).toBe("empty");
    expect(validateLogoFile("image/png", 50 * 1024 * 1024)).toBe("tooLarge");
  });
  it("measures and bounds data URLs", () => {
    const small = `data:image/png;base64,${b64(400)}`;
    expect(dataUrlByteSize(small)).toBe(300);
    expect(validateLogoDataUrl(small)).toBeNull();
    const big = `data:image/webp;base64,${b64(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8)}`;
    expect(validateLogoDataUrl(big)).toBe("tooLarge");
    expect(parseBrandLogo(big)).toBeNull();
    expect(parseBrandLogo(small)).toBe(small);
    expect(parseBrandLogo("data:text/html;base64,AAAA")).toBeNull();
    expect(parseBrandLogo("javascript:alert(1)")).toBeNull();
  });
  it("downscales to max 512 without upscaling", () => {
    expect(downscaleSize(2048, 1024)).toEqual({ w: 512, h: 256 });
    expect(downscaleSize(100, 50)).toEqual({ w: 100, h: 50 });
    expect(downscaleSize(0, 0)).toEqual({ w: 1, h: 1 });
  });
});

describe("layout", () => {
  it("fitText shrinks then squashes", () => {
    expect(fitText(measure, "abcd", 1000, 100, 20).squash).toBe(1);
    const shrunk = fitText(measure, "abcdefghij", 300, 100, 20);
    expect(shrunk.px).toBeLessThan(100);
    expect(shrunk.width).toBeLessThanOrEqual(300 + 1e-6);
    const squashed = fitText(measure, "x".repeat(60), 300, 100, 20);
    expect(squashed.px).toBe(20);
    expect(squashed.squash).toBeLessThan(1);
  });
  it("centres the group and fits the box", () => {
    const l = layoutBrand(
      { name: "Claude Office", tagline: "", logo: "x" },
      1700,
      374,
      measure,
    );
    expect(l.logo).not.toBeNull();
    expect(l.name).not.toBeNull();
    expect(l.tagline).toBeNull();
    const right = l.name!.x + l.name!.maxW;
    expect(l.logo!.x).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(1700 + 1e-6);
  });
  it("stacks tagline under name and handles name-less logo", () => {
    const l = layoutBrand(
      { name: "Acme", tagline: "Ops", logo: "x" },
      1700,
      374,
      measure,
    );
    expect(l.tagline!.y).toBeGreaterThan(l.name!.y);
    const only = layoutBrand(
      { name: "", tagline: "", logo: "x" },
      1700,
      374,
      measure,
    );
    expect(only.name).toBeNull();
    expect(only.logo!.x + only.logo!.size / 2).toBeCloseTo(850, 3);
  });
});
