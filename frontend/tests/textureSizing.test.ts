import { describe, expect, it } from "vitest";
import { signAtlasRows } from "@/engine/world/wayfinding";

describe("generated-canvas sizing helpers", () => {
  it("sign atlas only allocates the rows its faces need", () => {
    expect(signAtlasRows(1)).toBe(1);
    expect(signAtlasRows(2)).toBe(1);
    expect(signAtlasRows(3)).toBe(2);
    expect(signAtlasRows(5)).toBe(3);
    expect(signAtlasRows(8)).toBe(4);
    expect(signAtlasRows(0)).toBe(1);
  });
});
