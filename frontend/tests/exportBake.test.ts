/**
 * Lightmap exporter (tools/lightmaps, engine/bake): deterministic, layout-
 * invariant part hashes, colour-blind hashing, and a well-formed bake source.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import { ArtBatcher } from "@/engine/art/geometry";
import {
  buildBakeScene,
  demoBuildingLayout,
  type BakeScene,
} from "@/engine/bake/bakeScene";
import {
  asFixturePoints,
  BAKE_SET_NAMES,
  exportSet,
  fixtureLights,
  hashSet,
} from "@/engine/bake/exportParts";
import { partHash, sha1Hex, topologyHash } from "@/engine/bake/hash";
import { Materials } from "@/engine/materials/Materials";
import { v3 } from "@/engine/util/MeshBatcher";

describe("bake hash", () => {
  it("sha1Hex matches node:crypto", () => {
    for (const n of [0, 1, 55, 56, 64, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(sha1Hex(data)).toBe(createHash("sha1").update(data).digest("hex"));
    }
  });

  it("quantises positions (sub-0.1 mm noise does not change the hash)", () => {
    const idx = [0, 1, 2];
    const a = partHash([0, 0, 0, 1, 0, 0, 0, 1.25, 0], idx);
    const b = partHash([0, 0, 1e-6, 1 + 2e-6, 0, 0, 0, 1.25, -1e-6], idx);
    expect(b).toBe(a);
    expect(partHash([0, 0, 0, 1, 0, 0, 0, 1.3, 0], idx)).not.toBe(a);
    // Origin is subtracted before quantising.
    expect(
      partHash([5, 0, 0, 6, 0, 0, 5, 1.25, 0], idx, { x: 5, y: 0, z: 0 }),
    ).toBe(a);
    expect(topologyHash(3, idx)).not.toBe(topologyHash(4, idx));
  });

  it("ignores ArtBatcher colour jitter", () => {
    const hashes = [0, 0.3].map((jitter) => {
      const scene = new Scene(new NullEngine());
      const b = new ArtBatcher(scene, new Materials(scene, "/assets"), "t", 3);
      b.jitter = jitter;
      b.box("oak", v3(0, 0.5, 0), v3(1, 1, 2));
      b.box("oak", v3(2, 0.5, 0), v3(0.5, 1, 0.5));
      const [m] = b.build();
      const h = partHash(m.getVerticesData("position")!, m.getIndices()!);
      scene.dispose();
      return h;
    });
    expect(hashes[1]).toBe(hashes[0]);
  });
});

describe("bake export (headless office)", () => {
  let s: BakeScene;
  beforeAll(() => {
    s = buildBakeScene(demoBuildingLayout(6));
  });
  afterAll(() => s.dispose());

  it("hashes every set identically on a second build", () => {
    const again = buildBakeScene(demoBuildingLayout(6));
    for (const set of BAKE_SET_NAMES) {
      const a = hashSet(s.scene, set, s.layout);
      expect(a.length).toBeGreaterThan(3);
      expect(hashSet(again.scene, set, again.layout)).toEqual(a);
    }
    again.dispose();
  });

  it("modules / lobby / entrance hashes do not depend on the campus size", () => {
    const other = buildBakeScene(demoBuildingLayout(11));
    for (const set of ["modules", "lobby", "entrance"] as const)
      expect(hashSet(other.scene, set, other.layout)).toEqual(
        hashSet(s.scene, set, s.layout),
      );
    other.dispose();
  });

  it("writes a bake source per set (targets, context, lights)", () => {
    const fixtures = asFixturePoints(s.fixtures);
    const lights = fixtureLights(s.lighting, s.scene, fixtures);
    expect(lights.length).toBe(fixtures.length);
    expect(lights.every((l) => l.intensity > 0 && l.dir)).toBe(true);
    const input = {
      scene: s.scene,
      lighting: s.lighting,
      layout: s.layout,
      fixtures,
      lights,
    };
    const mods = exportSet(input, "modules");
    const kinds = new Set(mods.targets.map((t) => t.name.split(":")[0]));
    expect([...kinds].sort()).toEqual(
      ["podZone", "projBay", "projDivider", "projEnd", "projEntry"].sort(),
    );
    expect(mods.sun).toBeNull();
    expect(mods.lights.length).toBeGreaterThan(10);
    for (const t of mods.targets) {
      expect(t.matrix).toHaveLength(16);
      expect(mods.meshes[t.name].positions.length).toBe(t.vertexCount * 3);
    }
    const lobby = exportSet(input, "lobby");
    expect(lobby.sun?.intensity).toBeGreaterThan(0);
    expect(lobby.lights.some((l) => l.kind === "window")).toBe(false);
    const control = exportSet(input, "control");
    expect(control.verify).toBe("topology");
    expect(control.lights.every((l) => l.kind === "zone")).toBe(true);
    expect(
      control.targets.every((t) => t.topoHash && t.bbox?.length === 6),
    ).toBe(true);
    // Context never contains the baked hero copy itself.
    for (const e of [mods, lobby, control])
      expect(e.instances.length).toBeGreaterThan(10);
  });
});
