/**
 * Tiled-material texture robustness (NullEngine).
 *
 * Root cause of "floors / walls / desks / ceilings sometimes missing": after a
 * WebGL context loss Babylon rebuilds every URL texture by fetching it again;
 * when that fetch fails the internal texture is never flagged ready again,
 * so every material using it is skipped (no error, the meshes just vanish).
 * The first test pins that Babylon behaviour; the rest pin the fix in
 * Materials (neutral-first maps, retrying loader, neutral context rebuild,
 * in-place quality swaps) and the readiness diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateGround,
  NullEngine,
  PBRMaterial,
  Scene,
  Texture,
  type InternalTexture,
} from "@/engine/babylon";
import { Materials } from "@/engine/materials/Materials";
import {
  ReadinessMonitor,
  STUCK_MS,
  armTextureFailures,
  blockingTextures,
  disarmTextureFailures,
  failedTextureUrls,
  resetTextureFailures,
} from "@/engine/materials/readiness";
import { TextureLoadError, fetchImage } from "@/engine/materials/textureLoader";

/** NullEngine whose URL loads matching `fail` never complete (as on error). */
class FlakyEngine extends NullEngine {
  fail: RegExp | null = null;
  override createTexture(
    ...args: Parameters<NullEngine["createTexture"]>
  ): InternalTexture {
    const [url] = args;
    if (this.fail && this.fail.test(String(url))) {
      const t = super.createTexture(String(url), !!args[1], args[2], args[3]);
      t.isReady = false; // Babylon removes the onLoad observer on error
      return t;
    }
    return super.createTexture(...args);
  }
}

type FetchFn = (url: string, init?: { method?: string }) => Promise<unknown>;

const okBlob = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([new Uint8Array(4)])),
  });

let fetchImpl: FetchFn = (_u, init) =>
  init?.method === "HEAD"
    ? Promise.resolve({ ok: true, status: 200 })
    : okBlob();
const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  resetTextureFailures();
  disarmTextureFailures();
  fetchImpl = (_u, init) =>
    init?.method === "HEAD"
      ? Promise.resolve({ ok: true, status: 200 })
      : okBlob();
  vi.stubGlobal("fetch", (u: string, init?: { method?: string }) => {
    urls.push(u);
    return fetchImpl(u, init);
  });
  vi.stubGlobal("createImageBitmap", () =>
    Promise.resolve({ width: 4, height: 4, close: () => undefined }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  disarmTextureFailures();
});

const flush = async (ms = 30) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms / 5));
};

function setup(engine = new NullEngine()) {
  const scene = new Scene(engine);
  const materials = new Materials(scene, "/assets");
  materials.loaderOptions = { delays: [0, 0] };
  return { engine, scene, materials };
}

describe("root cause: Babylon context-restore re-fetch", () => {
  it("a URL texture whose re-fetch fails is never ready again and its material is skipped", async () => {
    const engine = new FlakyEngine();
    const scene = new Scene(engine);
    const mat = new PBRMaterial("floor", scene);
    const tex = new Texture("/assets/materials2/Carpet012/albedo.webp", scene);
    mat.albedoTexture = tex;
    const mesh = CreateGround("g", { width: 2, height: 2 }, scene);
    mesh.material = mat;
    await flush();
    expect(tex.isReady()).toBe(true);
    // Context restored, the server is busy: the re-fetch fails.
    engine.fail = /Carpet012/;
    tex.getInternalTexture()!._rebuild();
    scene.markAllMaterialsAsDirty(1);
    await flush();
    expect(tex.isReady()).toBe(false);
    expect(mat.isReadyForSubMesh(mesh, mesh.subMeshes[0])).toBe(false);
    expect(blockingTextures(mat)).toContain(tex);
    scene.dispose();
    engine.dispose();
  });
});

describe("Materials texture slots", () => {
  it("maps start on a ready neutral texture (a surface never waits for the network)", () => {
    fetchImpl = () => new Promise(() => undefined); // nothing ever arrives
    const { scene, materials } = setup();
    const floor = materials.get("floorRoom");
    // Apply textures as loadTextures does once the HEAD probes answer.
    (materials as unknown as { available: Set<string> }).available = new Set([
      "Carpet012",
    ]);
    (
      materials as unknown as {
        applyTextures(m: PBRMaterial, s: unknown): void;
      }
    ).applyTextures(floor, {
      color: "#5A5B5E",
      roughness: 0.95,
      role: "floorCarpet",
      bumpLevel: 0.9,
    });
    for (const t of [
      floor.albedoTexture,
      floor.bumpTexture,
      floor.metallicTexture,
    ])
      expect(t?.isReady()).toBe(true);
    expect(blockingTextures(floor)).toEqual([]);
    expect(materials.textureStats().neutral).toBe(3);
    scene.dispose();
  });

  it("bump levels get their own slot, never a clone of a loading map", async () => {
    const { scene, materials } = setup();
    await materials.loadTextures();
    const hall = materials.get("floorHall");
    const wall = materials.get("wall");
    expect(hall.bumpTexture!.level).toBeCloseTo(0.12);
    expect(wall.bumpTexture!.level).toBeCloseTo(0.22);
    for (const m of [hall, wall]) expect(m.bumpTexture!.isReady()).toBe(true);
    scene.dispose();
  });

  it("loads the real maps and swaps them in place (same Texture object)", async () => {
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const floor = materials.get("floorHall");
    const tex = floor.albedoTexture!;
    const it0 = tex.getInternalTexture()!;
    expect(it0.url).toMatch(/materials2\/.+\/albedo\.webp$/);
    expect(materials.textureStats().neutral).toBe(0);
    expect(failedTextureUrls()).toEqual([]);
    scene.dispose();
  });

  it("retries transient failures with backoff and recovers", async () => {
    armTextureFailures(/Carpet012\/albedo/, 2);
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const floor = materials.get("floorRoom");
    expect(floor.albedoTexture!.getInternalTexture()!.url).toMatch(
      /Carpet012\/albedo\.webp$/,
    );
    expect(failedTextureUrls()).toEqual([]);
    scene.dispose();
  });

  it("a failed map keeps the neutral texture, is reported once and the surface stays drawable", async () => {
    armTextureFailures(/Carpet012\/albedo/);
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const floor = materials.get("floorRoom");
    const tex = floor.albedoTexture!;
    expect(tex.isReady()).toBe(true);
    expect(tex.getInternalTexture()!.width).toBe(1); // neutral 1x1
    expect(blockingTextures(floor)).toEqual([]);
    expect(failedTextureUrls()).toEqual([
      "/assets/materials2/Carpet012/albedo.webp",
    ]);
    const warns = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => String(c[0]).includes("Carpet012/albedo"));
    expect(warns.length).toBe(1);
    scene.dispose();
  });

  it("context loss: maps rebuild to a ready neutral pixel, then reload through the loader", async () => {
    const { engine, scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const tex = materials.get("wall").albedoTexture!;
    const before = tex.getInternalTexture()!;
    const url = before.url;
    // Re-fetch would fail (busy server): the neutral rebuild never fetches.
    before._rebuild();
    expect(before.isReady).toBe(true);
    expect(before.url).toBe(`${url}#lost`);
    expect(tex.isReady()).toBe(true);
    urls.length = 0;
    engine.onContextRestoredObservable.notifyObservers(engine);
    await flush();
    const after = tex.getInternalTexture()!;
    expect(after).not.toBe(before);
    expect(after.url).toBe(url);
    expect(urls).toContain(url);
    scene.dispose();
  });

  it("a quality swap keeps the shown map until the new one is uploaded", async () => {
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const tex = materials.get("floorHall").albedoTexture!;
    const high = tex.getInternalTexture()!;
    const held: (() => void)[] = [];
    const release = () => held.splice(0).forEach((f) => f());
    fetchImpl = () =>
      new Promise((r) => {
        held.push(() => void okBlob().then(r));
      });
    materials.setTextureQuality("low");
    await flush();
    expect(tex.getInternalTexture()).toBe(high);
    expect(tex.isReady()).toBe(true);
    release();
    await flush();
    const low = tex.getInternalTexture()!;
    expect(low).not.toBe(high);
    expect(low.url).toMatch(/albedo\.webp#256$/);
    scene.dispose();
  });

  it("reloading a map the cache still holds keeps the reference count", async () => {
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const tex = materials.get("floorHall").albedoTexture!;
    const it0 = tex.getInternalTexture()!;
    const refs = (it0 as unknown as { _references: number })._references;
    (materials as unknown as { reloadAll(f: boolean): void }).reloadAll(true);
    await flush();
    expect(tex.getInternalTexture()).toBe(it0);
    expect((it0 as unknown as { _references: number })._references).toBe(refs);
    scene.dispose();
  });

  it("a failed quality swap keeps the previous map", async () => {
    const { scene, materials } = setup();
    await materials.loadTextures();
    await flush();
    const tex = materials.get("floorHall").albedoTexture!;
    const high = tex.getInternalTexture()!;
    fetchImpl = () => Promise.reject(new Error("ECONNRESET"));
    materials.setTextureQuality("medium");
    await flush();
    expect(tex.getInternalTexture()).toBe(high);
    expect(tex.isReady()).toBe(true);
    expect(failedTextureUrls().length).toBeGreaterThan(0);
    scene.dispose();
  });
});

describe("texture loader", () => {
  it("retries every attempt and throws a TextureLoadError at the end (never swallowed)", async () => {
    let n = 0;
    fetchImpl = () => {
      n += 1;
      return Promise.resolve({ ok: false, status: 503 });
    };
    await expect(
      fetchImage("/x.webp", { delays: [0, 0, 0] }),
    ).rejects.toBeInstanceOf(TextureLoadError);
    expect(n).toBe(4);
  });
});

describe("readiness monitor", () => {
  it("counts enabled meshes whose material stays not ready for > 3 s and warns once", async () => {
    const engine = new FlakyEngine();
    engine.fail = /never/;
    const scene = new Scene(engine);
    const mat = new PBRMaterial("stuck", scene);
    mat.albedoTexture = new Texture("/never.webp", scene);
    const mesh = CreateGround("floor", { width: 2, height: 2 }, scene);
    mesh.material = mat;
    const hidden = CreateGround("hidden", { width: 2, height: 2 }, scene);
    hidden.material = mat;
    hidden.setEnabled(false);
    const mon = new ReadinessMonitor();
    expect(mon.scan(scene, 0).n).toBe(0);
    expect(mon.scan(scene, STUCK_MS - 1).n).toBe(0);
    const r = mon.scan(scene, STUCK_MS + 1);
    expect(r.n).toBe(1);
    expect(r.meshes).toEqual(["floor|stuck"]);
    expect(r.textures).toEqual(["/never.webp"]);
    mon.scan(scene, STUCK_MS + 2000);
    const warns = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => String(c[0]).includes('material "stuck"'));
    expect(warns.length).toBe(1);
    scene.dispose();
    engine.dispose();
  });
});
