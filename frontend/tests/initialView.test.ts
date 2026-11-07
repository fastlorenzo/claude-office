import { describe, expect, it } from "vitest";
import { initialView } from "@/stores/initialView";

const withFloors = { buildingName: "B", floors: [{ id: "f" }] } as never;
const empty = { buildingName: "B", floors: [] } as never;

describe("initialView", () => {
  it("pixel + floors opens the building", () => {
    expect(initialView("pixel", withFloors, "single")).toBe("building");
  });
  it("3d + floors stays on single", () => {
    expect(initialView("3d", withFloors, "single")).toBe("single");
  });
  it("no floors stays single", () => {
    expect(initialView("pixel", empty, "single")).toBe("single");
  });
  it("never overrides a non-single view", () => {
    expect(initialView("pixel", withFloors, "command")).toBe("command");
    expect(initialView("3d", withFloors, "floor")).toBe("floor");
  });
});
