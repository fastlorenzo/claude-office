import { describe, expect, it } from "vitest";
import { classifyCharacterMaterial as c } from "@/engine/characters/characterMaterials";

describe("classifyCharacterMaterial", () => {
  it("classifies MPFB materials", () => {
    expect(c("office_f01_skin")).toBe("skin");
    expect(c("office_m03_eyes")).toBe("eyes");
    expect(c("office_m03_hair")).toBe("hair");
    expect(c("office_m03_brows")).toBe("hair");
    expect(c("office_m03_lashes")).toBe("lashes");
    expect(c("office_m03_shoes")).toBe("other");
    expect(c("office_f02_clothes_toigo_wool_pants")).toBe("other");
  });
  it("classifies Rocketbox materials", () => {
    expect(c("m005_head")).toBe("skin");
    expect(c("m005_body")).toBe("other");
    expect(c("f014_opacity")).toBe("hair");
    expect(c("f015_glasses")).toBe("other");
  });
});
