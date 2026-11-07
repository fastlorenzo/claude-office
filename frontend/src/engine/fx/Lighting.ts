/**
 * Scene lighting: image-based lighting from the Poly Haven interior HDRI, a
 * soft directional key (cascaded PCF shadows, explicit caster list), and a
 * small pool of warm point lights that hop to the ceiling fixtures nearest the
 * player (constant light count → no shader recompiles; moves fade through 0).
 *
 * Without the HDRI a hemispheric fill keeps the interior readable.
 */
import {
  CascadedShadowGenerator,
  Color3,
  DirectionalLight,
  HDRCubeTexture,
  HemisphericLight,
  PointLight,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type Camera,
} from "@/engine/babylon";
import { ASSET_MANIFEST, hdriPath } from "@/engine/assets/manifest";
import { lin } from "@/engine/materials/Materials";

const POOL = 3;

interface PoolLight {
  light: PointLight;
  target: Vector3 | null;
  level: number; // 0..1 fade
}

export class Lighting {
  env: HDRCubeTexture | null = null;
  readonly sun: DirectionalLight;
  readonly fill: HemisphericLight;
  private csm: CascadedShadowGenerator | null = null;
  private readonly casters = new Set<AbstractMesh>();
  private readonly pool: PoolLight[] = [];
  private fixtures: Vector3[] = [];
  private poolIntensity = 1;

  private camera: Camera | null = null;

  constructor(private readonly scene: Scene) {
    // Key: high, slightly raking "skylight / sun through the windows".
    // Key: near-vertical "overhead" light (ceiling panels / skylight feel)
    // with a slight rake so walls get gradation.
    this.sun = new DirectionalLight(
      "sun",
      new Vector3(-0.3, -1, 0.2).normalize(),
      scene,
    );
    this.sun.position = new Vector3(30, 60, 20);
    this.sun.intensity = 1.1;
    this.sun.diffuse = lin("#FFF6EC");
    this.sun.specular = lin("#FFF6EC").scale(0.6);

    // Bounce: light coming *up* from the floors lights the ceilings and the
    // undersides of things (no GI) — ground colour does the work.
    this.fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    this.fill.intensity = 0.55;
    this.fill.diffuse = lin("#E9EDF2");
    this.fill.groundColor = lin("#EAE3D8");
    this.fill.specular = Color3.Black();

    for (let i = 0; i < POOL; i++) {
      const light = new PointLight(
        `fixture${i}`,
        new Vector3(0, -100, 0),
        scene,
      );
      light.diffuse = lin("#FFE7CC");
      light.specular = lin("#FFE7CC").scale(0.4);
      light.intensity = 0;
      light.range = 9;
      light.radius = 0.4;
      this.pool.push({ light, target: null, level: 0 });
    }
  }

  async loadEnvironment(assetBase: string, size = 256): Promise<boolean> {
    const url = hdriPath(ASSET_MANIFEST.hdri.id, assetBase);
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) throw new Error(`HTTP ${head.status}`);
    } catch {
      this.useFallbackAmbient();
      return false;
    }
    return new Promise((resolve) => {
      const tex = new HDRCubeTexture(
        url,
        this.scene,
        size,
        false,
        true,
        false,
        true,
        () => {
          this.env = tex;
          this.scene.environmentTexture = tex;
          this.scene.environmentIntensity = 0.6;
          tex.rotationY = Math.PI * 0.35;
          resolve(true);
        },
        () => {
          tex.dispose();
          this.useFallbackAmbient();
          resolve(false);
        },
      );
    });
  }

  private useFallbackAmbient(): void {
    this.fill.intensity = 0.75;
    this.scene.environmentIntensity = 0;
  }

  /** Camera the shadow cascades are fitted to (re-creates the CSM if needed). */
  setCamera(camera: Camera): void {
    this.camera = camera;
    if (this.csm) {
      const size = this.csm.mapSize;
      this.disableShadows();
      this.enableShadows(size);
    }
  }

  enableShadows(mapSize: number): void {
    if (!this.camera) return;
    if (this.csm && this.csm.mapSize === mapSize) return;
    this.disableShadows();
    const csm = new CascadedShadowGenerator(
      mapSize,
      this.sun,
      true,
      this.camera,
    );
    csm.numCascades = 2;
    csm.lambda = 0.82;
    csm.shadowMaxZ = 24;
    csm.cascadeBlendPercentage = 0.12;
    csm.stabilizeCascades = true;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    csm.bias = 0.004;
    csm.normalBias = 0.012;
    csm.depthClamp = true;
    csm.setDarkness(0.35);
    csm.transparencyShadow = false;
    for (const m of this.casters) csm.addShadowCaster(m, false);
    this.csm = csm;
  }

  disableShadows(): void {
    this.csm?.dispose();
    this.csm = null;
  }

  get shadowsEnabled(): boolean {
    return !!this.csm;
  }

  addShadowCaster(mesh: AbstractMesh): void {
    if (this.casters.has(mesh)) return;
    this.casters.add(mesh);
    this.csm?.addShadowCaster(mesh, false);
    mesh.onDisposeObservable.addOnce(() => this.removeShadowCaster(mesh));
  }

  removeShadowCaster(mesh: AbstractMesh): void {
    if (!this.casters.delete(mesh)) return;
    this.csm?.removeShadowCaster(mesh, false);
  }

  private zoneLights: PointLight[] = [];

  /**
   * Light a zone separately (control room): excluded from the key + pool,
   * lit by its own cool point lights.
   */
  isolateZone(
    meshes: AbstractMesh[],
    lights: { pos: Vector3; color: string; intensity: number; range: number }[],
  ): void {
    for (const l of this.zoneLights) l.dispose();
    this.zoneLights = [];
    this.sun.excludedMeshes.push(...meshes);
    for (const p of this.pool) p.light.excludedMeshes.push(...meshes);
    lights.forEach((spec, i) => {
      const l = new PointLight(`zone${i}`, spec.pos, this.scene);
      l.diffuse = lin(spec.color);
      l.specular = lin(spec.color).scale(0.5);
      l.intensity = spec.intensity;
      l.range = spec.range;
      l.includedOnlyMeshes = [...meshes];
      this.zoneLights.push(l);
    });
  }

  /** Ceiling fixture positions the point-light pool may occupy. */
  setFixtures(points: Vector3[]): void {
    this.fixtures = points;
    for (const p of this.pool) p.target = null;
  }

  setPoolIntensity(v: number): void {
    this.poolIntensity = v;
  }

  /** Assign pool lights to the fixtures nearest `eye`, fading on reassignment. */
  update(dt: number, eye: Vector3): void {
    if (this.fixtures.length === 0) return;
    const nearest = [...this.fixtures]
      .map((p) => ({ p, d: Vector3.DistanceSquared(p, eye) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL)
      .map((x) => x.p);
    const claimed = new Set<Vector3>();
    for (const pl of this.pool)
      if (pl.target && nearest.includes(pl.target)) claimed.add(pl.target);
    for (const pl of this.pool) {
      const keep = pl.target && nearest.includes(pl.target);
      if (!keep) {
        // Fade out, then hop to an unclaimed fixture.
        pl.level = Math.max(0, pl.level - dt * 3);
        if (pl.level === 0) {
          const next = nearest.find((p) => !claimed.has(p)) ?? null;
          if (next) {
            claimed.add(next);
            pl.target = next;
            pl.light.position.copyFrom(next);
          }
        }
      } else {
        pl.level = Math.min(1, pl.level + dt * 2);
      }
      pl.light.intensity = pl.level * 6 * this.poolIntensity;
    }
  }

  dispose(): void {
    this.disableShadows();
    this.env?.dispose();
    this.env = null;
    this.sun.dispose();
    this.fill.dispose();
    for (const p of this.pool) p.light.dispose();
    for (const l of this.zoneLights) l.dispose();
    this.casters.clear();
  }
}
