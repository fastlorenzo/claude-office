import { describe, expect, it } from "vitest";
import type { PipelineRun, ReleaseInfo } from "@/engine/contracts";
import {
  BOARD_ROWS,
  SHELF,
  SHELF_CAPACITY,
  boardLines,
  doorMarkLayout,
  formatAge,
  liveryLayout,
  shade,
  shortTag,
  slotReleases,
  truncate,
} from "@/engine/world/factory/dockModel";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const rel = (tag: string, m?: number, pre = false): ReleaseInfo => ({
  tag,
  publishedAt: m === undefined ? null : ago(m),
  prerelease: pre,
});
const run = (
  id: string,
  state: PipelineRun["state"],
  kind: PipelineRun["kind"] = "deploy",
  m = 5,
): PipelineRun => ({
  id,
  workflow: `wf-${id}`,
  kind,
  state,
  startedAt: ago(m),
  branch: "main",
});

// 0.6 em per char.
const measure = (t: string, px: number) => t.length * px * 0.6;

describe("shelf slotting", () => {
  it("puts the newest release at bay 0, eye level, col 0", () => {
    const s = slotReleases([rel("v1", 100), rel("v2", 10), rel("v0", 500)]);
    expect(s.map((x) => x.tag)).toEqual(["v2", "v1", "v0"]);
    expect(s[0]).toMatchObject({ bay: 0, col: 0, level: 1, index: 0 });
    expect(s[1]).toMatchObject({ bay: 0, col: 1, level: 1 });
  });

  it("fills the eye row across bays before the low and high rows", () => {
    const list = Array.from({ length: SHELF.bays * SHELF.cols + 1 }, (_, i) =>
      rel(`v${i}`, i),
    );
    const s = slotReleases(list);
    expect(
      s.slice(0, SHELF.bays * SHELF.cols).every((x) => x.level === 1),
    ).toBe(true);
    expect(s[SHELF.bays * SHELF.cols]).toMatchObject({
      level: 0,
      bay: 0,
      col: 0,
    });
  });

  it("caps at capacity, keeps undated last, skips empty tags", () => {
    const many = Array.from({ length: 80 }, (_, i) => rel(`t${i}`, i + 1));
    expect(slotReleases(many)).toHaveLength(SHELF_CAPACITY);
    const s = slotReleases([rel("old"), rel("new", 1), rel("")]);
    expect(s.map((x) => x.tag)).toEqual(["new", "old"]);
    const unique = new Set(
      slotReleases(many).map((x) => `${x.bay}/${x.col}/${x.level}`),
    );
    expect(unique.size).toBe(SHELF_CAPACITY);
  });

  it("trims long tags and flags prereleases", () => {
    expect(shortTag("v1.14.0-rc.2-beta")).toHaveLength(10);
    expect(shortTag("v1.0")).toBe("v1.0");
    expect(slotReleases([rel("v2-rc", 1, true)])[0].prerelease).toBe(true);
  });
});

describe("departures board", () => {
  it("formats ages", () => {
    expect(formatAge(ago(0.2), NOW)).toBe("now");
    expect(formatAge(ago(7), NOW)).toBe("7m");
    expect(formatAge(ago(180), NOW)).toBe("3h");
    expect(formatAge(ago(60 * 24 * 4), NOW)).toBe("4d");
    expect(formatAge(ago(60 * 24 * 30), NOW)).toBe("4w");
    expect(formatAge(null, NOW)).toBe("");
    expect(formatAge("garbage", NOW)).toBe("");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 6)).toBe("abcde…");
    expect(truncate("  a   b ", 6)).toBe("a b");
  });

  it("lists live deploys first, then releases; ignores ci runs", () => {
    const lines = boardLines(
      [rel("v1.0", 60 * 48), rel("v1.1-rc", 60 * 5, true)],
      [
        run("a", "success", "deploy", 30),
        run("b", "running"),
        run("c", "success", "ci"),
        run("d", "failure", "deploy", 90),
      ],
      NOW,
    );
    expect(lines.map((l) => l.status)).toEqual([
      "DEPARTING",
      "FAILED",
      "DELIVERED",
      "PRE-RELEASE",
      "SHIPPED",
    ]);
    expect(lines[0]).toMatchObject({
      kind: "deploy",
      type: "DEPLOY",
      age: "5m",
    });
    expect(lines[3]).toMatchObject({
      kind: "release",
      ref: "v1.1-rc",
      age: "5h",
    });
    expect(lines[0].color).not.toBe(lines[1].color);
  });

  it("caps rows and handles empty input", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      run(String(i), "success", "deploy", i + 1),
    );
    expect(boardLines([], many, NOW)).toHaveLength(BOARD_ROWS);
    expect(boardLines([], [], NOW)).toEqual([]);
  });

  it("truncates long workflow names", () => {
    const l = boardLines(
      [],
      [{ ...run("x", "queued"), workflow: "a-very-long-workflow-name-here" }],
      NOW,
    )[0];
    expect(l.name.length).toBeLessThanOrEqual(16);
    expect(l.status).toBe("QUEUED");
  });
});

describe("livery layout", () => {
  const W = 2048;
  const H = 400;

  it("keeps the brand block inside the panel and centred", () => {
    const lay = liveryLayout(
      { name: "Northwind Freight", tagline: "Ship it.", logo: "x" },
      W,
      H,
      measure,
    );
    expect(lay.brand.logo).not.toBeNull();
    const l = lay.brand.logo!;
    expect(l.x).toBeGreaterThanOrEqual(lay.box.x - 1);
    expect(l.y).toBeGreaterThanOrEqual(lay.box.y - 1);
    expect(l.y + l.size).toBeLessThanOrEqual(lay.box.y + lay.box.h + 1);
    const n = lay.brand.name!;
    expect(n.x + measure("Northwind Freight", n.px)).toBeLessThanOrEqual(
      lay.box.x + lay.box.w + 1,
    );
    expect(lay.band.y).toBeGreaterThan(lay.box.y + lay.box.h);
  });

  it("shrinks long names to fit and never overflows", () => {
    const mid = "Northwind Freight Logistics";
    const lay = liveryLayout(
      { name: mid, tagline: "", logo: "x" },
      W,
      H,
      measure,
    );
    const n = lay.brand.name!;
    expect(measure(mid, n.px)).toBeLessThanOrEqual(n.maxW + 1);
    const short = liveryLayout(
      { name: "Acme", tagline: "", logo: "x" },
      W,
      H,
      measure,
    );
    expect(short.brand.name!.px).toBeGreaterThan(n.px);
    // Extreme names hit the minimum size and are squashed by maxWidth at draw.
    const huge = "A Very Long Company Name Incorporated Worldwide Holdings";
    const hl = liveryLayout(
      { name: huge, tagline: "", logo: "x" },
      W,
      H,
      measure,
    );
    expect(hl.brand.name!.px).toBeGreaterThanOrEqual(H * 0.62 * 0.22 * 0.7);
    expect(hl.brand.name!.maxW).toBeLessThanOrEqual(hl.box.w);
  });

  it("omits the logo block when there is no logo", () => {
    const lay = liveryLayout(
      { name: "Acme", tagline: "", logo: null },
      W,
      H,
      measure,
    );
    expect(lay.brand.logo).toBeNull();
    expect(lay.brand.tagline).toBeNull();
  });

  it("door mark fits its box", () => {
    const lay = doorMarkLayout(
      { name: "Northwind", logo: "x" },
      560,
      200,
      measure,
    );
    expect(measure("Northwind", lay.name!.px)).toBeLessThanOrEqual(
      lay.name!.maxW + 1,
    );
    expect(lay.logo!.x + lay.logo!.size).toBeLessThanOrEqual(lay.name!.x);
  });

  it("shades colours toward white / black", () => {
    expect(shade("#808080", 1)).toBe("#ffffff");
    expect(shade("#808080", -1)).toBe("#000000");
    expect(shade("#ff0000", 0)).toBe("#ff0000");
  });
});
