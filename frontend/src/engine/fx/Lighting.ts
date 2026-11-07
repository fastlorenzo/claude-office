/**
 * Scene lighting — "archviz-lite": every light has a physical reason to exist.
 *
 *  Daylight (static)
 *    `sun`      raking warm directional light that only enters through the
 *               glazing: its shadow map contains the whole static building
 *               (walls, ceilings, mullions, furniture) and is rendered ONCE
 *               (re-rendered when the building / rooms change), so the
 *               ceilings occlude it and floors get crisp window patches
 *               instead of the old evenly-lit "sun through the roof".
 *    skybox     the exterior HDRI (Poly Haven, urban, CC0) at infinity —
 *               parallax-correct through every window — also reflected by
 *               exterior glass.
 *    window     cool "portal" spot lights just inside each window band
 *    portals    (fixtures of kind "window"): the blue sky bounce that makes
 *               the warm/cool balance of a real office.
 *
 *  Electric light
 *    fixtures   one spot light per ceiling luminaire (pendants, slots,
 *               downlights) aimed down with a cos² falloff → bright pools
 *               under fixtures, darker corners, wall grazing. Rendered by a
 *               ClusteredLightContainer (forward+, one shader light for all
 *               of them); without clustering support a small pool of forward
 *               lights hops to the fixtures nearest the player.
 *    key        soft near-vertical directional key with cascaded shadows for
 *               characters + furniture (contact shadows), deliberately weak.
 *    fill       hemispheric bounce (floor-coloured ground term lights the
 *               ceilings and undersides).
 *    IBL        interior HDRI at low intensity (bounce + generic reflections);
 *               box-projected reflection probes override it on the big glossy
 *               floors (hall microcement, lobby terrazzo, control room).
 *
 * ---------------------------------------------------------------------------
 * Graphics API (wired by GraphicsController, all safe to call any time):
 *   setShadowQuality(q)      "off" | "low" | "medium" | "high" | "ultra"
 *                            off: no shadows, daylight patches disabled
 *                            low: CSM 1024 ×2, sun 2048 · medium: 2048 ×2, 2048
 *                            high: 2048 ×3, 4096 · ultra: 4096 ×3 PCSS, 4096
 *   setAreaLights(on)        2 RectAreaLights follow the nearest linear
 *                            luminaires (true rectangular highlights on glossy
 *                            floors / desks). LTC tables load from the Babylon
 *                            asset CDN on first use.
 *   setReflectionProbes(on)  box-projected cube probes (rendered once) on the
 *                            hall / lobby / control-room floors; off → IBL.
 *   setMaxDynamicLights(n)   0–8. 0 = no fixture lights (ambient compensates);
 *                            clustered: up to 20·n luminaires near the player;
 *                            forward fallback: min(n, 4) hopping lights.
 * ---------------------------------------------------------------------------
 */
import {
  BaseTexture,
  CascadedShadowGenerator,
  ClusteredLightContainer,
  Color3,
  CreateBox,
  DirectionalLight,
  HDRCubeTexture,
  HemisphericLight,
  Mesh,
  PBRMaterial,
  PointLight,
  RectAreaLight,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  SpotLight,
  Texture,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Camera,
  type Light,
  type Observer,
} from "@/engine/babylon";
import { ASSET_MANIFEST, hdriPath } from "@/engine/assets/manifest";
import { lin } from "@/engine/materials/Materials";

export type ShadowQuality = "off" | "low" | "medium" | "high" | "ultra";

export interface FixtureSpec {
  /** down: ceiling luminaire · window: daylight portal · accent: wall washer */
  kind: "down" | "window" | "accent";
  color?: string;
  /** Multiplier on the kind's base intensity. */
  intensity?: number;
  /** Emission direction (default straight down). */
  dir?: Vector3;
  range?: number;
  /** Luminaire size (m) — linear fixtures are eligible for area lights. */
  size?: { w: number; d: number; yaw?: number };
}

/** A fixture position carrying its light description (still a Vector3). */
export class FixturePoint extends Vector3 {
  constructor(
    x: number,
    y: number,
    z: number,
    public spec: FixtureSpec = { kind: "down" },
  ) {
    super(x, y, z);
  }
}

export function fixture(
  x: number,
  y: number,
  z: number,
  spec?: FixtureSpec,
): FixturePoint {
  return new FixturePoint(x, y, z, spec);
}

const KIND: Record<
  FixtureSpec["kind"],
  { color: string; intensity: number; range: number; exponent: number }
> = {
  down: { color: "#FFE4C4", intensity: 5.5, range: 6.5, exponent: 2.2 },
  window: { color: "#CFE0FF", intensity: 3.2, range: 6, exponent: 1.4 },
  accent: { color: "#FFD9B0", intensity: 3, range: 4, exponent: 3 },
};

interface Slot {
  light: SpotLight | PointLight;
  target: FixturePoint | null;
  level: number; // 0..1 fade
}

interface ProbeSpec {
  center: Vector3;
  size: Vector3;
  materials: PBRMaterial[];
  renderList: () => AbstractMesh[];
  probe: ReflectionProbe | null;
}

const SHADOW_PRESET: Record<
  Exclude<ShadowQuality, "off">,
  { csm: number; cascades: number; sun: number; pcss: boolean }
> = {
  low: { csm: 1024, cascades: 2, sun: 2048, pcss: false },
  medium: { csm: 2048, cascades: 2, sun: 2048, pcss: false },
  high: { csm: 2048, cascades: 2, sun: 4096, pcss: false },
  ultra: { csm: 4096, cascades: 3, sun: 4096, pcss: true },
};

const SUN_DIR = new Vector3(-0.5, -0.62, 0.6).normalize();

export class Lighting {
  /** Interior HDRI (IBL). */
  env: HDRCubeTexture | null = null;
  /** Exterior HDRI cube (city backdrop + glass reflections). */
  exterior: HDRCubeTexture | null = null;
  /** Raking daylight; static whole-building shadow map. */
  readonly sun: DirectionalLight;
  /** Soft overhead key with cascaded (dynamic) shadows. */
  readonly key: DirectionalLight;
  readonly fill: HemisphericLight;
  private skybox: Mesh | null = null;
  private skyView: BaseTexture | null = null;
  private csm: CascadedShadowGenerator | null = null;
  private csmKey = "";
  private sunShadow: ShadowGenerator | null = null;
  private readonly casters = new Set<AbstractMesh>();
  private readonly staticCasters = new Set<AbstractMesh>();
  private staticDirty = false;
  private shadowQuality: ShadowQuality = "high";
  private readonly slots: Slot[] = [];
  private container: ClusteredLightContainer | null = null;
  private clustered = false;
  private fixtures: FixturePoint[] = [];
  private poolIntensity = 1;
  private maxLights = 4;
  private assignAt = 0;
  private assignedKey = "";
  private camera: Camera | null = null;
  private zoneLights: PointLight[] = [];
  private zoneMeshes: AbstractMesh[] = [];
  private readonly probes = new Map<string, ProbeSpec>();
  private probesOn = true;
  private areaOn = false;
  private readonly areaLights: { node: TransformNode; light: RectAreaLight }[] =
    [];
  private readonly beforeRender: Observer<Scene> | null;

  constructor(private readonly scene: Scene) {
    // Daylight: low-ish warm sun from the south-east (enters the lobby facade
    // and the east window bands).
    this.sun = new DirectionalLight("sun", SUN_DIR.clone(), scene);
    this.sun.position = SUN_DIR.scale(-90);
    this.sun.intensity = 3.4;
    this.sun.diffuse = lin("#FFE2C2");
    this.sun.specular = lin("#FFE2C2");
    this.sun.autoUpdateExtends = true;
    this.sun.autoCalcShadowZBounds = true;
    this.sun.shadowEnabled = true;

    // Overhead key: weak, near vertical, for contact shadows only.
    this.key = new DirectionalLight(
      "key",
      new Vector3(0.12, -1, 0.08).normalize(),
      scene,
    );
    this.key.position = new Vector3(10, 60, 10);
    this.key.intensity = 0.55;
    this.key.diffuse = lin("#FFF1E2");
    this.key.specular = lin("#FFF1E2").scale(0.25);

    // Bounce: light coming *up* from the floors lights the ceilings and the
    // undersides of things (no real GI) — the ground colour does the work.
    this.fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    this.fill.intensity = 0.32;
    this.fill.diffuse = lin("#DCE6F2");
    this.fill.groundColor = lin("#E8DCCB");
    this.fill.specular = Color3.Black();

    this.initFixtureLights();
    this.beforeRender = scene.onBeforeRenderObservable.add(() => {
      if (this.staticDirty) {
        this.staticDirty = false;
        this.renderStaticShadows();
      }
      if (this.probesDirty && performance.now() - this.probesAt > 1500)
        this.flushProbes();
    });
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  /** Interior IBL + exterior HDRI (skybox, glass reflections). */
  async loadEnvironment(assetBase: string, size = 256): Promise<boolean> {
    const [interior] = await Promise.all([
      this.loadInterior(assetBase, size),
      this.loadExterior(assetBase, 1024),
    ]);
    return interior;
  }

  private async loadInterior(
    assetBase: string,
    size: number,
  ): Promise<boolean> {
    const url = hdriPath(ASSET_MANIFEST.hdri.id, assetBase);
    const tex = await loadHdr(this.scene, url, size, true);
    if (!tex) {
      this.useFallbackAmbient();
      return false;
    }
    this.env = tex;
    this.scene.environmentTexture = tex;
    this.scene.environmentIntensity = 0.42;
    tex.rotationY = Math.PI * 0.35;
    return true;
  }

  private async loadExterior(assetBase: string, size: number): Promise<void> {
    const { id, res } = ASSET_MANIFEST.exteriorHdri;
    const tex = await loadHdr(
      this.scene,
      hdriPath(id, assetBase, res),
      size,
      false,
    );
    if (!tex || this.scene.isDisposed) return;
    this.exterior = tex;
    // Skybox: a second view of the same GPU cube in SKYBOX mode.
    const internal = tex.getInternalTexture();
    if (!internal) return;
    internal.incrementReferences();
    const view = new BaseTexture(this.scene, internal);
    view.name = "sky:view";
    view.gammaSpace = false;
    view.coordinatesMode = Texture.SKYBOX_MODE;
    view.level = 1.5; // bright daytime sky at the interior exposure
    this.skyView = view;
    // Must stay inside the camera far plane (Player maxZ 220): half-diagonal of
    // a 180 m cube is 156 m. infiniteDistance keeps it centred on the eye.
    const box = CreateBox(
      "skybox",
      { size: 180, sideOrientation: Mesh.BACKSIDE },
      this.scene,
    );
    box.infiniteDistance = true;
    box.isPickable = false;
    box.applyFog = false;
    const mat = new PBRMaterial("sky:mat", this.scene);
    mat.backFaceCulling = false;
    mat.reflectionTexture = view;
    mat.microSurface = 1;
    mat.disableLighting = true;
    mat.albedoColor = Color3.Black();
    mat.reflectivityColor = Color3.White();
    mat.environmentIntensity = 1;
    mat.twoSidedLighting = true;
    mat.disableDepthWrite = true;
    box.material = mat;
    // Rendered first, never culled.
    box.renderingGroupId = 0;
    box.alwaysSelectAsActiveMesh = true;
    mat.freeze();
    this.skybox = box;
  }

  private useFallbackAmbient(): void {
    this.fill.intensity = 0.7;
    this.scene.environmentIntensity = 0;
  }

  /**
   * Replace the skybox content with a baked cube (Exterior: sky + hills + far park +
   * aerial haze). Also returns a CUBIC view of it for glass reflections.
   */
  setSkyTexture(cube: BaseTexture): BaseTexture | null {
    const mat = this.skybox?.material as PBRMaterial | null | undefined;
    const internal = cube.getInternalTexture();
    if (!mat || !internal) return null;
    cube.coordinatesMode = Texture.SKYBOX_MODE;
    // Render-target cubes come out Y-flipped relative to file cubes: flip the
    // skybox lookup (mesh) and use INVCUBIC for reflections.
    if (this.skybox) this.skybox.scaling.y = -1;
    mat.unfreeze();
    mat.reflectionTexture = cube;
    mat.freeze();
    internal.incrementReferences();
    const refl = new BaseTexture(this.scene, internal);
    refl.name = "sky:reflection";
    refl.gammaSpace = false;
    refl.coordinatesMode = Texture.INVCUBIC_MODE;
    this.skyReflection?.dispose();
    this.skyReflection = refl;
    this.onSkyBaked?.(refl);
    return refl;
  }

  /** Baked sky + city cube in CUBIC mode (exterior glass reflections). */
  skyReflection: BaseTexture | null = null;
  /** Called once the skyline bake replaced the sky. */
  onSkyBaked: ((reflection: BaseTexture) => void) | null = null;

  /** Skybox mesh (probes that see windows include it). */
  get sky(): Mesh | null {
    return this.skybox;
  }

  // -------------------------------------------------------------------------
  // Shadows
  // -------------------------------------------------------------------------

  /** Camera the shadow cascades are fitted to (re-creates the CSM if needed). */
  setCamera(camera: Camera): void {
    this.camera = camera;
    if (this.csm) {
      this.csm.dispose();
      this.csm = null;
    }
    this.applyShadows();
  }

  setShadowQuality(q: ShadowQuality): void {
    this.shadowQuality = q;
    this.applyShadows();
  }

  /** Legacy API: enable at a CSM map size (maps to a preset). */
  enableShadows(mapSize: number): void {
    this.setShadowQuality(
      mapSize >= 4096 ? "ultra" : mapSize >= 2048 ? "high" : "low",
    );
  }

  disableShadows(): void {
    this.setShadowQuality("off");
  }

  get shadowsEnabled(): boolean {
    return !!this.csm;
  }

  private applyShadows(): void {
    const q = this.shadowQuality;
    if (q === "off") {
      this.csm?.dispose();
      this.csm = null;
      this.sunShadow?.dispose();
      this.sunShadow = null;
      // No occlusion → no daylight patches (it would light through ceilings).
      this.sun.setEnabled(false);
      return;
    }
    this.sun.setEnabled(true);
    const p = SHADOW_PRESET[q];
    // Dynamic cascades (characters + furniture contact shadows).
    if (this.camera) {
      const want = `${p.csm}:${p.cascades}:${p.pcss}`;
      if (!this.csm || this.csmKey !== want) {
        this.csm?.dispose();
        const csm = new CascadedShadowGenerator(
          p.csm,
          this.key,
          true,
          this.camera,
        );
        this.csmKey = want;
        csm.numCascades = p.cascades;
        csm.lambda = 0.85;
        csm.shadowMaxZ = 26;
        csm.cascadeBlendPercentage = 0.12;
        csm.stabilizeCascades = true;
        if (p.pcss) {
          csm.useContactHardeningShadow = true;
          csm.contactHardeningLightSizeUVRatio = 0.06;
        } else {
          csm.usePercentageCloserFiltering = true;
        }
        csm.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
        csm.forceBackFacesOnly = true;
        csm.bias = 0.005;
        csm.normalBias = 0.03;
        csm.depthClamp = true;
        csm.setDarkness(0.15);
        csm.transparencyShadow = false;
        for (const m of this.casters) csm.addShadowCaster(m, false);
        this.csm = csm;
      }
    }
    // Static daylight map.
    if (!this.sunShadow || this.sunShadow.mapSize !== p.sun) {
      this.sunShadow?.dispose();
      const sg = new ShadowGenerator(p.sun, this.sun, true);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality =
        q === "low"
          ? ShadowGenerator.QUALITY_LOW
          : ShadowGenerator.QUALITY_HIGH;
      // Closed static geometry: render back faces only into the map, which
      // removes acne / sawtooth bands on thin frames and metal door leaves.
      sg.forceBackFacesOnly = true;
      sg.bias = 0.003;
      sg.normalBias = 0.035;
      sg.setDarkness(0);
      sg.transparencyShadow = false;
      const map = sg.getShadowMap();
      if (map) map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      this.sunShadow = sg;
      this.staticDirty = true;
    }
  }

  private renderStaticShadows(): void {
    const sg = this.sunShadow;
    const map = sg?.getShadowMap();
    if (!sg || !map) return;
    map.renderList = [...this.staticCasters].filter(
      (m) => !m.isDisposed() && !m.material?.needAlphaBlending(),
    );
    map.resetRefreshCounter();
  }

  /** Dynamic caster (characters, furniture): cascaded overhead shadows. */
  addShadowCaster(mesh: AbstractMesh): void {
    if (this.casters.has(mesh)) return;
    const meta = mesh.metadata as {
      staticCaster?: boolean;
      noDynamicShadow?: boolean;
    } | null;
    if (meta?.staticCaster) this.addStaticCasters([mesh]);
    if (meta?.noDynamicShadow) return;
    this.casters.add(mesh);
    this.csm?.addShadowCaster(mesh, false);
    mesh.onDisposeObservable.addOnce(() => this.removeShadowCaster(mesh));
  }

  removeShadowCaster(mesh: AbstractMesh): void {
    if (!this.casters.delete(mesh)) return;
    this.csm?.removeShadowCaster(mesh, false);
  }

  /** Static architecture / furniture occluding the daylight. */
  addStaticCasters(meshes: AbstractMesh[]): void {
    for (const m of meshes) {
      if (this.staticCasters.has(m)) continue;
      this.staticCasters.add(m);
      m.onDisposeObservable.addOnce(() => {
        this.staticCasters.delete(m);
        this.staticDirty = true;
      });
    }
    this.staticDirty = true;
  }

  /** Re-render the daylight shadow map next frame (rooms / props changed). */
  invalidateStaticShadows(): void {
    this.staticDirty = true;
  }

  // -------------------------------------------------------------------------
  // Zones
  // -------------------------------------------------------------------------

  /**
   * Light a zone separately (control room): excluded from daylight, key and
   * fixtures, lit by its own cool point lights.
   */
  isolateZone(
    meshes: AbstractMesh[],
    lights: { pos: Vector3; color: string; intensity: number; range: number }[],
  ): void {
    for (const l of this.zoneLights) l.dispose();
    this.zoneLights = [];
    this.zoneMeshes = meshes;
    const exclude = (l: Light) => {
      l.excludedMeshes = l.excludedMeshes.filter((m) => !m.isDisposed());
      l.excludedMeshes.push(...meshes);
    };
    exclude(this.sun);
    exclude(this.key);
    if (this.container) exclude(this.container);
    for (const s of this.slots) if (!this.clustered) exclude(s.light);
    lights.forEach((spec, i) => {
      const l = new PointLight(`zone${i}`, spec.pos, this.scene);
      l.diffuse = lin(spec.color);
      l.specular = lin(spec.color).scale(0.6);
      l.intensity = spec.intensity;
      l.range = spec.range;
      l.includedOnlyMeshes = [...meshes];
      this.zoneLights.push(l);
    });
  }

  // -------------------------------------------------------------------------
  // Fixture lights
  // -------------------------------------------------------------------------

  private initFixtureLights(): void {
    try {
      const c = new ClusteredLightContainer("fixtures", [], this.scene);
      if (c.isSupported) {
        c.maxRange = 8;
        this.container = c;
        this.clustered = true;
      } else c.dispose();
    } catch {
      this.container = null;
      this.clustered = false;
    }
    this.resizePool();
  }

  private poolSize(): number {
    if (this.maxLights <= 0) return 0;
    return this.clustered
      ? Math.min(160, this.maxLights * 20)
      : Math.min(4, this.maxLights);
  }

  private resizePool(): void {
    const want = this.poolSize();
    while (this.slots.length > want) {
      const s = this.slots.pop()!;
      if (this.container) this.container.removeLight(s.light);
      s.light.dispose();
    }
    while (this.slots.length < want) {
      const i = this.slots.length;
      const light = new SpotLight(
        `fixture${i}`,
        new Vector3(0, -100, 0),
        new Vector3(0, -1, 0),
        Math.PI,
        2,
        this.scene,
      );
      light.intensity = 0;
      light.range = 6.5;
      // Physical size of the emitter: softens specular glints on bumpy floors.
      light.radius = 0.45;
      light.shadowEnabled = false;
      if (this.clustered && this.container) this.container.addLight(light);
      else light.excludedMeshes.push(...this.zoneMeshes);
      this.slots.push({ light, target: null, level: 0 });
    }
    this.assignedKey = "";
  }

  /** Ceiling fixture positions (FixturePoint carries kind / colour). */
  setFixtures(points: Vector3[]): void {
    this.fixtures = points.map((p) =>
      p instanceof FixturePoint ? p : new FixturePoint(p.x, p.y, p.z),
    );
    for (const s of this.slots) s.target = null;
    this.assignedKey = "";
    this.assignAt = 0;
  }

  setPoolIntensity(v: number): void {
    this.poolIntensity = v;
    this.compensateAmbient();
  }

  setMaxDynamicLights(n: number): void {
    this.maxLights = Math.max(0, Math.round(n));
    this.resizePool();
    this.compensateAmbient();
  }

  /** Without fixture lights the interior needs more ambient to stay readable. */
  private compensateAmbient(): void {
    const off = this.maxLights === 0 || this.poolIntensity === 0;
    this.fill.intensity = off ? 0.75 : 0.32;
    this.key.intensity = off ? 0.9 : 0.55;
  }

  /** Assign lights to the fixtures nearest `eye` (fading on reassignment). */
  update(dt: number, eye: Vector3): void {
    this.updateArea(eye);
    if (this.slots.length === 0 || this.fixtures.length === 0) return;
    const now = performance.now();
    let nearest: FixturePoint[];
    if (this.fixtures.length <= this.slots.length) nearest = this.fixtures;
    else if (now - this.assignAt > 400 || !this.assignedKey) {
      this.assignAt = now;
      nearest = [...this.fixtures]
        .map((p) => ({ p, d: Vector3.DistanceSquared(p, eye) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.slots.length)
        .map((x) => x.p);
      this.lastNearest = nearest;
    } else nearest = this.lastNearest;
    const want = new Set(nearest);
    const claimed = new Set<FixturePoint>();
    for (const s of this.slots)
      if (s.target && want.has(s.target)) claimed.add(s.target);
    const instant = this.clustered && this.fixtures.length <= this.slots.length;
    for (const s of this.slots) {
      const keep = s.target && want.has(s.target);
      if (!keep) {
        s.level = instant ? 0 : Math.max(0, s.level - dt * 3);
        if (s.level === 0) {
          const next = nearest.find((p) => !claimed.has(p)) ?? null;
          s.target = next;
          if (next) {
            claimed.add(next);
            this.configure(s, next);
          }
        }
      } else {
        s.level = instant ? 1 : Math.min(1, s.level + dt * 2);
      }
      const base = s.target ? KIND[s.target.spec.kind].intensity : 0;
      s.light.intensity =
        s.level * base * (s.target?.spec.intensity ?? 1) * this.poolIntensity;
    }
  }

  private lastNearest: FixturePoint[] = [];

  private configure(s: Slot, f: FixturePoint): void {
    const k = KIND[f.spec.kind];
    const l = s.light;
    l.position.copyFrom(f);
    const col = lin(f.spec.color ?? k.color);
    l.diffuse = col;
    l.specular = col;
    l.range = f.spec.range ?? k.range;
    if (l instanceof SpotLight) {
      l.direction = (f.spec.dir ?? new Vector3(0, -1, 0)).normalize();
      l.angle = Math.PI;
      l.exponent = k.exponent;
    }
  }

  // -------------------------------------------------------------------------
  // Area lights
  // -------------------------------------------------------------------------

  setAreaLights(on: boolean): void {
    if (on === this.areaOn) return;
    this.areaOn = on;
    if (!on) {
      for (const a of this.areaLights) {
        a.light.dispose();
        a.node.dispose();
      }
      this.areaLights.length = 0;
      return;
    }
    for (let i = 0; i < 2; i++) {
      const node = new TransformNode(`area${i}`, this.scene);
      node.rotation.x = Math.PI / 2; // emit along -Z → straight down
      const light = new RectAreaLight(
        `areaL${i}`,
        Vector3.Zero(),
        1.2,
        0.08,
        this.scene,
      );
      light.parent = node;
      light.intensity = 0;
      light.diffuse = lin(KIND.down.color);
      light.specular = lin(KIND.down.color);
      this.areaLights.push({ node, light });
    }
  }

  private updateArea(eye: Vector3): void {
    if (!this.areaOn || this.areaLights.length === 0) return;
    const linear = this.fixtures
      .filter((f) => f.spec.size && f.spec.kind === "down")
      .map((f) => ({ f, d: Vector3.DistanceSquared(f, eye) }))
      .sort((a, b) => a.d - b.d);
    this.areaLights.forEach((a, i) => {
      const hit = linear[i]?.f;
      if (!hit || !hit.spec.size) {
        a.light.intensity = 0;
        return;
      }
      a.node.position.set(hit.x, hit.y + 0.28, hit.z);
      a.node.rotation.y = hit.spec.size.yaw ?? 0;
      a.light.width = hit.spec.size.w;
      a.light.height = hit.spec.size.d;
      a.light.intensity = 6 * this.poolIntensity;
    });
  }

  // -------------------------------------------------------------------------
  // Reflection probes
  // -------------------------------------------------------------------------

  /**
   * Register a box-projected probe (rendered once) for glossy floors. When
   * probes are off (or the probe fails), materials fall back to the IBL.
   */
  registerProbe(
    name: string,
    center: Vector3,
    size: Vector3,
    materials: PBRMaterial[],
    renderList: () => AbstractMesh[],
  ): void {
    this.disposeProbe(name);
    const spec: ProbeSpec = {
      center,
      size,
      materials,
      renderList,
      probe: null,
    };
    this.probes.set(name, spec);
    if (this.probesOn) this.buildProbe(name, spec);
  }

  setReflectionProbes(on: boolean): void {
    if (on === this.probesOn) return;
    this.probesOn = on;
    for (const [name, spec] of this.probes) {
      if (on) this.buildProbe(name, spec);
      else this.releaseProbe(spec);
    }
  }

  private buildProbe(name: string, spec: ProbeSpec): void {
    this.releaseProbe(spec);
    const probe = new ReflectionProbe(
      `probe:${name}`,
      256,
      this.scene,
      true,
      true,
    );
    probe.position.copyFrom(spec.center);
    probe.position.y = Math.min(spec.center.y, 1.6);
    probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    const list = probe.renderList!;
    for (const m of spec.renderList()) list.push(m);
    if (this.skybox) list.push(this.skybox);
    const cube = probe.cubeTexture;
    cube.boundingBoxSize = spec.size.clone();
    cube.boundingBoxPosition = spec.center.clone();
    for (const mat of spec.materials) {
      const frozen = mat.isFrozen;
      if (frozen) mat.unfreeze();
      mat.reflectionTexture = cube;
      if (frozen) mat.freeze();
    }
    spec.probe = probe;
  }

  private releaseProbe(spec: ProbeSpec): void {
    if (!spec.probe) return;
    for (const mat of spec.materials) {
      const frozen = mat.isFrozen;
      if (frozen) mat.unfreeze();
      mat.reflectionTexture = null;
      if (frozen) mat.freeze();
    }
    spec.probe.dispose();
    spec.probe = null;
  }

  private disposeProbe(name: string): void {
    const spec = this.probes.get(name);
    if (spec) this.releaseProbe(spec);
    this.probes.delete(name);
  }

  /** Re-render every probe (after a rebuild). */
  refreshProbes(): void {
    // Coalesced: rooms arriving in a burst re-render the probes once.
    this.probesDirty = true;
  }

  private probesDirty = false;
  private probesAt = 0;

  private flushProbes(): void {
    this.probesDirty = false;
    this.probesAt = performance.now();
    for (const spec of this.probes.values()) {
      const probe = spec.probe;
      if (!probe) continue;
      const list = probe.renderList!;
      list.length = 0;
      for (const m of spec.renderList()) list.push(m);
      if (this.skybox) list.push(this.skybox);
      probe.cubeTexture.resetRefreshCounter();
    }
  }

  dispose(): void {
    if (this.beforeRender)
      this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.csm?.dispose();
    this.sunShadow?.dispose();
    this.csm = null;
    this.sunShadow = null;
    for (const name of [...this.probes.keys()]) this.disposeProbe(name);
    this.setAreaLights(false);
    this.skybox?.material?.dispose();
    this.skybox?.dispose();
    this.skyView?.dispose();
    this.skyReflection?.dispose();
    this.env?.dispose();
    this.exterior?.dispose();
    this.env = null;
    this.exterior = null;
    this.sun.dispose();
    this.key.dispose();
    this.fill.dispose();
    for (const s of this.slots) s.light.dispose();
    this.slots.length = 0;
    this.container?.dispose();
    for (const l of this.zoneLights) l.dispose();
    this.casters.clear();
    this.staticCasters.clear();
  }
}

async function loadHdr(
  scene: Scene,
  url: string,
  size: number,
  harmonics: boolean,
): Promise<HDRCubeTexture | null> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const tex = new HDRCubeTexture(
      url,
      scene,
      size,
      false,
      harmonics,
      false,
      harmonics,
      () => resolve(tex),
      () => {
        tex.dispose();
        resolve(null);
      },
    );
  });
}
