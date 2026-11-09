/**
 * Runtime baked lighting (WS-D): the shared part hash, the realtime fallback
 * (no manifest / hash mismatch leave materials and lights untouched), the
 * applied path (baked variant + UV2 + light exclusion, vertex AO divided
 * out) and the LightmapPlugin's define stability across texture swaps
 * (frozen materials must never recompile or vanish when a lightmap lands or
 * after a context restore).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NullEngine,
  PBRMaterial,
  Scene,
  VertexBuffer,
  type Mesh,
} from "@/engine/babylon";
import { ArtBatcher } from "@/engine/art/geometry";
import { partHash, sha1Hex, topologyHash } from "@/engine/bake/hash";
import { bakeApplier, bakeParts } from "@/engine/bake/parts";
import {
  BakedLighting,
  encodeRGBD,
  parseManifest,
  type BakeIO,
  type LightmapManifest,
  type RawImage,
} from "@/engine/fx/BakedLighting";
import { Lighting } from "@/engine/fx/Lighting";
import {
  LightmapPlugin,
  lightmapPluginOf,
} from "@/engine/materials/LightmapPlugin";
import { Materials } from "@/engine/materials/Materials";
import { v3 } from "@/engine/util/MeshBatcher";

interface World {
  engine: NullEngine;
  scene: Scene;
  materials: Materials;
  lighting: Lighting;
}

const worlds: World[] = [];

function world(): World {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const materials = new Materials(scene, "/assets");
  const lighting = new Lighting(scene);
  const w = { engine, scene, materials, lighting };
  worlds.push(w);
  return w;
}

afterEach(() => {
  for (const w of worlds.splice(0)) {
    BakedLighting.of(w.scene)?.dispose();
    w.lighting.dispose();
    w.materials.dispose();
    w.scene.dispose();
    w.engine.dispose();
  }
  vi.restoreAllMocks();
});

/** A small "lobby": floor + a desk standing on it (vertex AO) + glass. */
function buildLobby(w: World, seed = 3): Mesh[] {
  const b = new ArtBatcher(w.scene, w.materials, "lobby", seed);
  b.box("floorLobby", v3(0, -0.05, 0), v3(6, 0.1, 6));
  b.box("oak", v3(0, 0.37, 0), v3(1.4, 0.74, 0.7));
  b.box("oak", v3(2, 0.37, 1), v3(1.4, 0.74, 0.7));
  b.box("glass", v3(0, 1.5, 3), v3(6, 3, 0.02));
  return b.build({ receiveShadows: true, bake: { set: "lobby" } });
}

const RAW: RawImage = {
  data: new Uint8Array([...encodeRGBD(1, 1, 1), ...encodeRGBD(2, 2, 2)]),
  width: 2,
  height: 1,
};

/** Manifest + uv2.bin for the parts of a reference build (as WS-C bakes). */
function bakeOf(
  parts: Mesh[],
  sun: boolean,
): { manifest: LightmapManifest; uv2: ArrayBuffer } {
  const entries: Record<
    string,
    { hash: string; vertexCount: number; uv2Offset: number }
  > = {};
  const floats: number[] = [];
  for (const p of parts) {
    if (p.material?.needAlphaBlending()) continue;
    const nv = p.getTotalVertices();
    entries[p.name] = {
      hash: partHash(p.getVerticesData("position")!, p.getIndices()!),
      vertexCount: nv,
      uv2Offset: floats.length,
    };
    for (let i = 0; i < nv; i++) floats.push((i % 7) / 7, (i % 5) / 5);
  }
  return {
    manifest: {
      version: 1,
      sets: {
        lobby: {
          image: "lobby.png",
          encoding: "rgbd",
          size: 2,
          gain: 1,
          sun,
          frame: "world",
          uv2: "lobby_uv2.bin",
          parts: entries,
        },
      },
    },
    uv2: new Float32Array(floats).buffer,
  };
}

function io(
  manifest: unknown,
  uv2: ArrayBuffer | null,
  image: () => Promise<RawImage> = async () => RAW,
): Partial<BakeIO> & { images: number } {
  const o = {
    images: 0,
    json: async () => manifest,
    binary: async () => uv2,
    image: async () => {
      o.images += 1;
      return image();
    },
  };
  return o;
}

/** Reference parts built in a throwaway scene (the exporter's view). */
function referenceBake(sun = true) {
  const ref = world();
  return bakeOf(buildLobby(ref), sun);
}

describe("part hash (engine/bake/hash.ts)", () => {
  it("is SHA-1", () => {
    expect(sha1Hex(new TextEncoder().encode("abc"))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
    expect(sha1Hex(new Uint8Array(0))).toBe(
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    );
    // Two-block message (padding across a block boundary).
    expect(sha1Hex(new Uint8Array(56).fill(0x61))).toBe(
      "c2db330f6083854c99d4b5bfb6e8f29f201be699",
    );
  });

  it("is deterministic, quantised and frame-relative", () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const idx = [0, 1, 2];
    const h = partHash(pos, idx);
    expect(partHash([...pos], [...idx])).toBe(h);
    // Sub-quantum noise (JSC vs V8 last bits) does not matter …
    expect(
      partHash(
        pos.map((v) => v + 1e-9),
        idx,
      ),
    ).toBe(h);
    // … a 1 mm move does, and so does the topology.
    expect(partHash([0.001, ...pos.slice(1)], idx)).not.toBe(h);
    expect(partHash(pos, [0, 2, 1])).not.toBe(h);
    // -0 hashes like 0.
    expect(partHash([-0, 0, 0, 1, 0, 0, 0, 1, 0], idx)).toBe(h);
    // Origin: the control room translated by the hall length hashes the same.
    const moved = pos.map((v, i) => (i % 3 === 2 ? v + 37.25 : v));
    expect(partHash(moved, idx, { x: 0, y: 0, z: 37.25 })).toBe(h);
  });

  it("ignores vertex colours and UVs (jitter seeds) of merged parts", () => {
    const a = world();
    const b = world();
    const pa = buildLobby(a, 3);
    const pb = buildLobby(b, 99);
    expect(pa.map((m) => m.name)).toEqual(pb.map((m) => m.name));
    const ca = pa[0].getVerticesData(VertexBuffer.ColorKind)!;
    const cb = pb[0].getVerticesData(VertexBuffer.ColorKind)!;
    expect(Array.from(ca)).not.toEqual(Array.from(cb));
    for (let i = 0; i < pa.length; i++)
      expect(
        partHash(pa[i].getVerticesData("position")!, pa[i].getIndices()!),
      ).toBe(partHash(pb[i].getVerticesData("position")!, pb[i].getIndices()!));
  });
});

describe("bake set registry", () => {
  it("registers merged parts under deterministic names", () => {
    const w = world();
    const parts = buildLobby(w);
    expect(parts.map((p) => p.name)).toEqual([
      "lobby:mat:floorLobby",
      "lobby:mat:oak",
      "lobby:mat:glass",
    ]);
    expect(bakeParts(w.scene, "lobby").map((p) => p.mesh)).toEqual(parts);
    expect(bakeParts(w.scene, "control")).toEqual([]);
  });
});

describe("realtime fallback", () => {
  it("no manifest: nothing changes, no applier, bakes.active empty", async () => {
    const w = world();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(null, null),
    });
    expect(bakeApplier(w.scene)).toBeNull();
    const parts = buildLobby(w);
    expect(parts[0].material).toBe(w.materials.get("floorLobby"));
    expect(parts[1].material).toBe(w.materials.get("oak"));
    for (const p of parts)
      expect(p.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(false);
    expect(w.lighting.fill.excludedMeshes).toHaveLength(0);
    expect(bl.stats()).toEqual({
      active: [],
      mismatched: [],
      missing: true,
      parts: 0,
    });
  });

  it("realtime build is identical with and without a (failed) manifest", async () => {
    const plain = world();
    const p0 = buildLobby(plain);
    const w = world();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(null, null),
    });
    const p1 = buildLobby(w);
    for (let i = 0; i < p0.length; i++) {
      expect(p1[i].name).toBe(p0[i].name);
      expect(
        Array.from(p1[i].getVerticesData(VertexBuffer.ColorKind)!),
      ).toEqual(Array.from(p0[i].getVerticesData(VertexBuffer.ColorKind)!));
    }
  });

  it("hash mismatch: that part stays realtime, reported once", async () => {
    const { manifest, uv2 } = referenceBake();
    manifest.sets.lobby!.parts["lobby:mat:oak"].hash = "0".repeat(40);
    const w = world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const parts = buildLobby(w);
    const oak = parts.find((p) => p.name === "lobby:mat:oak")!;
    expect(oak.material).toBe(w.materials.get("oak"));
    expect(oak.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(false);
    expect(w.lighting.fill.excludedMeshes).not.toContain(oak);
    expect(bl.stats().mismatched).toEqual(["lobby:lobby:mat:oak"]);
    expect(warn).not.toHaveBeenCalled(); // deferred to the next frame
    frame(w);
    frame(w);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/geometry hash/);
  });

  it("a rebuilt part replaces the stale mismatch (no warning for it)", async () => {
    const { manifest, uv2 } = referenceBake();
    const w = world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    // First build at another layout: geometry differs → mismatches.
    const b = new ArtBatcher(w.scene, w.materials, "lobby", 3);
    b.box("oak", v3(0.3, 0.4, -2), v3(2, 0.8, 0.8));
    const stale = b.build({
      bake: { set: "lobby", origin: { x: 0, y: 0, z: 0 } },
    });
    expect(bl.stats().mismatched).toEqual(["lobby:lobby:mat:oak"]);
    // Replaced before the first frame by the real build.
    for (const m of stale) m.dispose();
    buildLobby(w);
    frame(w);
    expect(bl.stats().mismatched).toEqual([]);
    expect(bl.stats().active).toEqual(["lobby"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("all parts mismatched: bakes.active is empty", async () => {
    const { manifest, uv2 } = referenceBake();
    for (const p of Object.values(manifest.sets.lobby!.parts))
      p.hash = "f".repeat(40);
    const w = world();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const parts = buildLobby(w);
    expect(parts[0].material).toBe(w.materials.get("floorLobby"));
    expect(bl.stats().active).toEqual([]);
    expect(bl.stats().mismatched).toHaveLength(2);
  });

  it("missing uv2.bin: set dropped, realtime, missing flagged", async () => {
    const { manifest } = referenceBake();
    const w = world();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, null),
    });
    const parts = buildLobby(w);
    expect(parts[0].material).toBe(w.materials.get("floorLobby"));
    expect(bl.stats()).toMatchObject({ active: [], missing: true });
  });

  it("rejects malformed manifests", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ version: 2, sets: {} })).toBeNull();
    expect(
      parseManifest({ version: 1, sets: { lobby: { encoding: "rgbe" } } }),
    ).toEqual({ version: 1, sets: {} });
  });
});

describe("applied bake", () => {
  it("matching parts take the baked variant, UV2 and light exclusion", async () => {
    const { manifest, uv2 } = referenceBake(true);
    const w = world();
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const parts = buildLobby(w);
    const [floor, oak, glass] = parts;
    const base = w.materials.get("floorLobby");
    expect(floor.material).not.toBe(base);
    expect(w.materials.baseOf(floor.material)).toBe(base);
    expect(lightmapPluginOf(floor.material as PBRMaterial)).toBeInstanceOf(
      LightmapPlugin,
    );
    // The realtime original is untouched (other meshes keep using it).
    expect(lightmapPluginOf(base)).toBeNull();
    const nv = floor.getTotalVertices();
    expect(floor.getVerticesData(VertexBuffer.UV2Kind)!.length).toBe(nv * 2);
    // Glass never takes a bake.
    expect(glass.material).toBe(w.materials.get("glass"));
    // fill + sun excluded (sun baked in), key kept (character shadows).
    expect(w.lighting.fill.excludedMeshes).toEqual(
      expect.arrayContaining([floor, oak]),
    );
    expect(w.lighting.sun.excludedMeshes).toContain(floor);
    expect(w.lighting.key.excludedMeshes).not.toContain(floor);
    expect(w.lighting.fill.excludedMeshes).not.toContain(glass);
    expect(bl.stats()).toEqual({
      active: ["lobby"],
      mismatched: [],
      missing: false,
      parts: 2,
    });
  });

  it("sun:false sets keep the realtime sun", async () => {
    const { manifest, uv2 } = referenceBake(false);
    const w = world();
    await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const [floor] = buildLobby(w);
    expect(w.lighting.fill.excludedMeshes).toContain(floor);
    expect(w.lighting.sun.excludedMeshes).not.toContain(floor);
  });

  it("vertex AO is divided back out of baked parts only", async () => {
    const plain = world();
    const ref = buildLobby(plain).find((p) => p.name === "lobby:mat:oak")!;
    const { manifest, uv2 } = referenceBake();
    const w = world();
    await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const oak = buildLobby(w).find((p) => p.name === "lobby:mat:oak")!;
    const a = ref.getVerticesData(VertexBuffer.ColorKind)!;
    const b = oak.getVerticesData(VertexBuffer.ColorKind)!;
    // Desk sides near the floor were darkened (0.8–1) in the realtime build;
    // the baked build has the plain jitter colour there (≥ realtime).
    let darker = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(b[i]).toBeGreaterThanOrEqual(a[i] - 1e-6);
      if (b[i] > a[i] + 1e-3) darker += 1;
    }
    expect(darker).toBeGreaterThan(0);
  });

  it("probes: a baked variant takes its original's probe", async () => {
    const { manifest, uv2 } = referenceBake();
    const w = world();
    await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const [floor] = buildLobby(w);
    const probes = (
      w.lighting as unknown as {
        variants: Map<PBRMaterial, PBRMaterial[]>;
      }
    ).variants;
    expect(probes.get(w.materials.get("floorLobby"))).toEqual([floor.material]);
  });
});

/** One rendered frame's after-render notification (no camera needed). */
function frame(w: World): void {
  w.scene.onAfterRenderObservable.notifyObservers(w.scene);
}

describe("control set: topology verification", () => {
  /** A control-room-like part at a hall-length dependent position. */
  function buildControl(w: World, cz: number, shift = 0): Mesh[] {
    const b = new ArtBatcher(w.scene, w.materials, "controlInt", 11);
    b.box("floorDark", v3(0, -0.05, cz), v3(8, 0.1, 8));
    b.box("oak", v3(1 + shift, 0.4, cz + 1.3), v3(2, 0.8, 0.8));
    return b.build({ bake: { set: "control", origin: { x: 0, y: 0, z: cz } } });
  }

  function controlBake(parts: Mesh[], cz: number): LightmapManifest {
    const entries: LightmapManifest["sets"]["control"] = {
      image: "control.png",
      encoding: "rgbd",
      size: 2,
      sun: false,
      verify: "topology",
      uv2: "control_uv2.bin",
      parts: {},
    };
    let off = 0;
    for (const p of parts) {
      const pos = p.getVerticesData("position")!;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i++) {
        const v = pos[i] - (i % 3 === 2 ? cz : 0);
        lo[i % 3] = Math.min(lo[i % 3], v);
        hi[i % 3] = Math.max(hi[i % 3], v);
      }
      const nv = p.getTotalVertices();
      entries.parts[p.name] = {
        hash: "position hash not used",
        topoHash: topologyHash(nv, p.getIndices()!),
        bbox: [...lo, ...hi],
        vertexCount: nv,
        uv2Offset: off,
      };
      off += nv * 2;
    }
    return { version: 1, sets: { control: entries } };
  }

  it("accepts the same room at another hall length, rejects a moved piece", async () => {
    const ref = world();
    const manifest = controlBake(buildControl(ref, 41.37), 41.37);
    const uv2 = new Float32Array(10000).buffer;
    const w = world();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: io(manifest, uv2),
    });
    const moved = buildControl(w, 58.913, 0);
    expect(
      moved.every((p) => lightmapPluginOf(p.material as PBRMaterial)),
    ).toBe(true);
    expect(bl.stats().active).toEqual(["control"]);
    const w2 = world();
    const bl2 = await BakedLighting.load(w2.scene, w2.materials, w2.lighting, {
      io: io(manifest, uv2),
    });
    const shifted = buildControl(w2, 58.913, 0.05);
    const oak = shifted.find((p) => p.name === "controlInt:mat:oak")!;
    expect(lightmapPluginOf(oak.material as PBRMaterial)).toBeNull();
    expect(bl2.stats().mismatched).toEqual(["control:controlInt:mat:oak"]);
  });
});

describe("LightmapPlugin defines never change", () => {
  async function settle(mesh: Mesh, mat: PBRMaterial): Promise<boolean> {
    for (let i = 0; i < 80; i++) {
      mesh.getScene().incrementRenderId();
      if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0])) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  it("frozen baked material: same effect across a lightmap swap and a context restore", async () => {
    const { manifest, uv2 } = referenceBake();
    const w = world();
    const feed = io(manifest, uv2);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      io: feed,
    });
    const [floor] = buildLobby(w);
    const mat = floor.material as PBRMaterial;
    expect(await settle(floor, mat)).toBe(true);
    const sub = floor.subMeshes[0];
    const effect = sub.effect;
    const defines = sub.materialDefines?.toString();
    expect(defines).toMatch(/BAKED_LIGHTMAP/);
    expect(defines).toMatch(/#define UV2\b/);
    w.materials.freezeAll();
    expect(await settle(floor, mat)).toBe(true);
    const tex = lightmapPluginOf(mat)!.texture;
    const before = tex.getInternalTexture();
    // Context restore: the lightmap is fetched again and swapped in place.
    w.engine.onContextRestoredObservable.notifyObservers(w.engine);
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.images).toBe(2);
    expect(tex.getInternalTexture()).not.toBe(before);
    expect(mat.isFrozen).toBe(true);
    expect(mat.isReadyForSubMesh(floor, sub)).toBe(true);
    expect(sub.effect).toBe(effect);
    expect(sub.materialDefines?.toString()).toBe(defines);
    expect(bl.stats().active).toEqual(["lobby"]);
  });

  it("is ready before the lightmap arrives (1×1 neutral) and stays ready after", async () => {
    const w = world();
    const m = new PBRMaterial("mat:t", w.scene);
    const bl = await BakedLighting.load(w.scene, w.materials, w.lighting, {
      fixture: true,
    });
    const parts = buildLobby(w);
    const floor = parts[0];
    expect(bl.stats()).toMatchObject({ fixture: true, active: ["lobby"] });
    const mat = floor.material as PBRMaterial;
    expect(await settle(floor, mat)).toBe(true);
    const plugin = lightmapPluginOf(mat)!;
    expect(plugin.texture.isReady()).toBe(true);
    const effect = floor.subMeshes[0].effect;
    plugin.setLevels(1.3, 0.2);
    expect(await settle(floor, mat)).toBe(true);
    expect(floor.subMeshes[0].effect).toBe(effect);
    m.dispose();
  });
});
