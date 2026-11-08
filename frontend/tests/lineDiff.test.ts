import { describe, expect, it } from "vitest";
import { lineDiff } from "@/utils/console/lineDiff";

describe("lineDiff", () => {
  it("handles pure add", () => {
    const d = lineDiff("", "a\nb");
    expect(d).toMatchObject({ added: 2, removed: 0, truncated: false });
    expect(d.lines.map((l) => l.type)).toEqual(["add", "add"]);
  });
  it("handles pure remove", () => {
    const d = lineDiff("a\nb", "");
    expect(d).toMatchObject({ added: 0, removed: 2 });
  });
  it("handles replace with context", () => {
    const d = lineDiff("x\ny\nz", "x\nY\nz");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines).toEqual([
      { type: "ctx", text: "x" },
      { type: "del", text: "y" },
      { type: "add", text: "Y" },
      { type: "ctx", text: "z" },
    ]);
  });
  it("finds an insertion inside a block via LCS", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nb\nNEW\nc\nd");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });
  it("identical text has no changes", () => {
    expect(lineDiff("a\nb", "a\nb")).toMatchObject({ added: 0, removed: 0 });
  });
  it("caps output lines and flags truncation", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
    const d = lineDiff("", big, { maxLines: 50 });
    expect(d.lines).toHaveLength(50);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(1000);
  });
  it("degrades to remove-all/add-all above the LCS cell cap", () => {
    const a = Array.from({ length: 100 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 100 }, (_, i) => `b${i}`).join("\n");
    const d = lineDiff(a, b, { maxCells: 100, maxLines: 1000 });
    expect(d).toMatchObject({ added: 100, removed: 100, truncated: true });
  });
});
