/**
 * Render-readiness diagnostics: Babylon silently skips every sub-mesh whose
 * material is not ready (a texture still loading or failed, a light texture
 * missing, an effect compiling), so a stuck texture makes whole surface sets
 * vanish without an error. This module makes that visible:
 *
 *   noteTextureFailure(url)   records a texture URL that failed for good
 *                             (console.warn once per URL)
 *   ReadinessMonitor.scan()   enabled, visible meshes whose material has
 *                             not been ready for more than `STUCK_MS`
 *                             (console.warn once per material)
 *
 * Both feed `window.__worldStats.notReady` / `.texFail`.
 */
import type {
  AbstractMesh,
  BaseTexture,
  Material,
  Scene,
} from "@/engine/babylon";

/** A material not ready for longer than this counts as stuck (ms). */
export const STUCK_MS = 3000;

const failed = new Set<string>();

/** Record a texture URL that failed after its retries (warns once per URL). */
export function noteTextureFailure(url: string, reason?: unknown): void {
  if (failed.has(url)) return;
  failed.add(url);
  const why =
    reason instanceof Error
      ? reason.message.replace(`texture ${url} `, "")
      : String(reason ?? "");
  console.warn(
    `[materials] texture failed, neutral fallback in use: ${url} (${why})`,
  );
}

/** A texture that failed earlier loaded after all (quality swap / retry). */
export function noteTextureRecovered(url: string): void {
  failed.delete(url);
}

/** URLs of textures that failed for good (fallback in use). */
export function failedTextureUrls(): string[] {
  return [...failed];
}

/** Test hook. */
export function resetTextureFailures(): void {
  failed.clear();
}

// ---------------------------------------------------------------------------
// Failure injection (world-debug ?texfail=): deterministic repro of transient
// asset failures. Inert unless armed.
// ---------------------------------------------------------------------------

interface Injection {
  re: RegExp;
  /** Fail the first n attempts per URL. */
  n: number;
  active: boolean;
  counts: Map<string, number>;
}

let injection: Injection | null = null;

/** Arm the injection: loads whose URL matches `re` fail (first `n` per URL). */
export function armTextureFailures(
  re: RegExp,
  n = Infinity,
  active = true,
): void {
  injection = { re, n, active, counts: new Map() };
}

export function setTextureFailuresActive(on: boolean): void {
  if (injection) injection.active = on;
}

export function disarmTextureFailures(): void {
  injection = null;
}

/** True when this load attempt of `url` must fail (counts the attempt). */
export function injectedTextureFailure(url: string): boolean {
  const inj = injection;
  if (!inj || !inj.active || !inj.re.test(url)) return false;
  const base = url.replace(/[?#].*$/, "");
  const k = inj.counts.get(base) ?? 0;
  if (k >= inj.n) return false;
  inj.counts.set(base, k + 1);
  return true;
}

export interface StuckReport {
  /** Enabled, visible meshes whose material has not been ready for > STUCK_MS. */
  n: number;
  /** "mesh|material" for the first few. */
  meshes: string[];
  /** Names of the not-ready textures on those materials. */
  textures: string[];
  /** Duration of the last scan (ms). */
  ms: number;
}

interface Drawable {
  isEnabled(): boolean;
  isVisible: boolean;
  isDisposed(): boolean;
  visibility: number;
  name: string;
  material: Material | null;
  subMeshes?: { getMaterial(): Material | null }[];
  hasThinInstances?: boolean;
  thinInstanceCount?: number;
  instances?: unknown[];
  getTotalVertices?(): number;
  getClassName(): string;
}

/** True when Babylon would draw `mesh` with its material this frame. */
export function meshMaterialReady(
  mesh: AbstractMesh,
  instancedArrays = true,
): boolean {
  const m = mesh as unknown as Drawable;
  const subs = m.subMeshes;
  if (!subs || subs.length === 0) return true;
  const inst =
    instancedArrays && (!!m.hasThinInstances || (m.instances?.length ?? 0) > 0);
  for (const sub of subs) {
    const mat = sub.getMaterial();
    if (!mat) continue;
    const ok = (mat as unknown as { _storeEffectOnSubMeshes?: boolean })
      ._storeEffectOnSubMeshes
      ? mat.isReadyForSubMesh(
          mesh,
          sub as Parameters<Material["isReadyForSubMesh"]>[1],
          inst,
        )
      : mat.isReady(mesh, inst);
    if (!ok) return false;
  }
  return true;
}

/** Textures of `mat` that would block it (not ready, not failed). */
export function blockingTextures(mat: Material): BaseTexture[] {
  return mat
    .getActiveTextures()
    .filter((t) => t.isBlocking && !t.isReady() && !t.loadingError);
}

/** Candidate for the scan: something Babylon would try to draw. */
function drawable(mesh: AbstractMesh): boolean {
  const m = mesh as unknown as Drawable;
  if (m.isDisposed() || !m.isVisible || m.visibility <= 0) return false;
  if (!m.material || !m.subMeshes?.length) return false;
  if (m.getClassName() === "InstancedMesh") return false; // the source counts
  if (m.hasThinInstances && (m.thinInstanceCount ?? 0) === 0) return false;
  if ((m.getTotalVertices?.() ?? 1) === 0) return false;
  return m.isEnabled();
}

/**
 * The meshes Babylon tried to draw last frame (frustum-culled, enabled);
 * instances map to their source mesh, whose material decides.
 */
export function activeDrawList(scene: Scene): AbstractMesh[] {
  const list = scene.getActiveMeshes();
  const out = new Set<AbstractMesh>();
  for (let i = 0; i < list.length; i++) {
    const m = list.data[i];
    const src = (m as unknown as { sourceMesh?: AbstractMesh }).sourceMesh;
    out.add(m.getClassName() === "InstancedMesh" && src ? src : m);
  }
  return [...out];
}

/**
 * Periodic scan for meshes that would draw but cannot because their material
 * is not ready. The World passes the active list (what Babylon tried to draw:
 * no shader is compiled early for off-screen meshes); default: every mesh.
 * Cheap at 1 Hz: frozen / previously-ready materials answer from the cache.
 */
export class ReadinessMonitor {
  private since = new Map<AbstractMesh, number>();
  private readonly warned = new Set<string>();
  private report: StuckReport = { n: 0, meshes: [], textures: [], ms: 0 };

  get last(): StuckReport {
    return this.report;
  }

  scan(
    scene: Scene,
    nowMs: number,
    candidates: readonly AbstractMesh[] = scene.meshes,
  ): StuckReport {
    const t0Scan = performance.now();
    const engine = scene.getEngine();
    const caps = engine.getCaps();
    const pass = engine.currentRenderPassId;
    engine.currentRenderPassId = scene.activeCamera?.renderPassId ?? pass;
    const meshes: string[] = [];
    const textures = new Set<string>();
    let n = 0;
    // Only meshes not ready in this scan carry their start time forward.
    const prev = this.since;
    const next = new Map<AbstractMesh, number>();
    this.since = next;
    try {
      for (const mesh of candidates) {
        if (next.has(mesh) || !drawable(mesh)) continue;
        if (meshMaterialReady(mesh, !!caps.instancedArrays)) continue;
        const t0 = prev.get(mesh) ?? nowMs;
        next.set(mesh, t0);
        if (t0 === nowMs) continue;
        if (nowMs - t0 <= STUCK_MS) continue;
        n += 1;
        const mat = mesh.material!;
        if (meshes.length < 12) meshes.push(`${mesh.name}|${mat.name}`);
        const blocking = blockingTextures(mat).map((t) => t.name || "?");
        for (const b of blocking) textures.add(b);
        if (!this.warned.has(mat.name)) {
          this.warned.add(mat.name);
          console.warn(
            `[materials] "${mesh.name}" not drawn for ${Math.round((nowMs - t0) / 1000)} s: material "${mat.name}" not ready` +
              (blocking.length ? ` (textures: ${blocking.join(", ")})` : ""),
          );
        }
      }
    } finally {
      engine.currentRenderPassId = pass;
    }
    this.report = {
      n,
      meshes,
      textures: [...textures].slice(0, 12),
      ms: Math.round((performance.now() - t0Scan) * 10) / 10,
    };
    return this.report;
  }
}
