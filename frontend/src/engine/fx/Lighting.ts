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
import { refreezeStale } from "@/engine/materials/staleEffects";
import { look } from "@/engine/fx/look";

/** Safety-net period of the stale frozen-effect scan (ms). */
const STALE_SCAN_MS = 2000;

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
  // 3700 K LED (not tungsten).
  down: { color: "#FFEBD6", intensity: 5.5, range: 6.5, exponent: 2.2 },
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

/** Static daylight map: coalesce re-renders (rooms arrive in bursts). */
const STATIC_DEBOUNCE_MS = 1500;
/** Render the static map anyway if casters are still compiling after this. */
const STATIC_READY_TIMEOUT_MS = 6000;
/** Baked sky brightness relative to the bake (windows read as daylight). */
const SKY_GAIN = 1.6;
/** IBL level without the reflection probes (of LOOK env), see applyEnvIntensity. */
const NO_PROBE_ENV = 0.65;
/** Ambient compensation factors (of LOOK fill / key), see compensateAmbient. */
const LOW_FILL = 1.2;
const LOW_KEY = 0.75;
const NO_SUN_FILL = 1.6;
const NO_FIXTURE_FILL = 1.8;
/** Clustered fixture lights per `maxDynamicLights` step (realtime / baked). */
const POOL_PER_LIGHT = 20;
const BAKED_POOL_PER_LIGHT = 10;
/** Per-fixture intensity cap without shadows / AO (no hard hotspots). */
const LOW_TIER_LIGHT_CAP = 3.5;

/**
 * Fixture lights for a `maxDynamicLights` budget: clustered, 20 luminaires
 * per step near the player (cap 160); the forward fallback hops min(n, 4).
 * Lightmapped architecture takes no fixture light (bakeExclude): the pool
 * then only lights furniture, characters and the realtime hall around the
 * player, so half as many luminaires suffice.
 */
export function fixturePoolSize(
  maxLights: number,
  clustered: boolean,
  baked: boolean,
): number {
  if (maxLights <= 0) return 0;
  if (!clustered) return Math.min(4, maxLights);
  const per = baked ? BAKED_POOL_PER_LIGHT : POOL_PER_LIGHT;
  return Math.min(160, maxLights * per);
}

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
  /** When the static map was first marked dirty (debounce + readiness wait). */
  private staticDirtyAt = 0;
  private staticRenderedAt = -Infinity;
  /** Shadow quality applied yet? Until the first plan, no generators exist. */
  private configured = false;
  private shadowQuality: ShadowQuality = "high";
  private readonly slots: Slot[] = [];
  private container: ClusteredLightContainer | null = null;
  private clustered = false;
  private fixtures: FixturePoint[] = [];
  private poolIntensity = 1;
  private maxLights = 0;
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
  /** Lights were added / removed / toggled since the last frame. */
  private lightsChanged = false;
  private lastStaleScanAt = 0;
  private readonly lightObservers: (() => void)[] = [];
  /** Frozen materials thawed because their effect no longer matched the lights. */
  staleRefreezes = 0;
  private staleWarned = false;

  constructor(private readonly scene: Scene) {
    // Daylight: low-ish warm sun from the south-east (enters the lobby facade
    // and the east window bands).
    this.sun = new DirectionalLight("sun", SUN_DIR.clone(), scene);
    this.sun.position = SUN_DIR.scale(-90);
    this.sun.intensity = 3.4;
    this.sun.diffuse = lin("#FFE2C2");
    this.sun.specular = lin("#FFE2C2");
    // Extents follow the casters only on the frame the static map renders
    // (maybeRenderStatic): between renders the lookup projection must stay
    // the one the map was drawn with, even while the caster list grows.
    this.sun.autoUpdateExtends = false;
    this.sun.autoCalcShadowZBounds = true;
    this.sun.shadowEnabled = true;

    // Overhead key: weak, near vertical, for contact shadows only.
    this.key = new DirectionalLight(
      "key",
      new Vector3(0.12, -1, 0.08).normalize(),
      scene,
    );
    this.key.position = new Vector3(10, 60, 10);
    this.key.intensity = look("key");
    this.key.diffuse = lin("#FFF1E2");
    this.key.specular = lin("#FFF1E2").scale(0.25);

    // Bounce: light coming *up* from the floors lights the ceilings and the
    // undersides of things (no real GI) — the ground colour does the work.
    this.fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    this.fill.intensity = look("fill");
    this.fill.diffuse = lin("#DCE6F2");
    this.fill.groundColor = lin("#E8DCCB");
    this.fill.specular = Color3.Black();

    this.initFixtureLights();
    this.watchLights();
    this.beforeRender = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      // Frozen materials keep the effect of the light set they compiled
      // with: after any light change, thaw the stale ones before drawing
      // (else WebGL rejects their draws: the vanishing shell). A 2 s scan
      // catches any change that bypassed the observers.
      if (this.lightsChanged || now - this.lastStaleScanAt > STALE_SCAN_MS) {
        const expected = this.lightsChanged;
        this.lightsChanged = false;
        this.lastStaleScanAt = now;
        let example = "";
        const n = refreezeStale(scene, false, (mesh, mat, why) => {
          if (!example && !why.includes("ignored"))
            example = `"${mesh.name}" (${why})`;
        });
        this.staleRefreezes += n;
        // After an observed light change this is the expected fix-up. Found
        // by the safety scan, some path changed lights unseen: say so once.
        if (n && example && !expected && !this.staleWarned) {
          this.staleWarned = true;
          console.warn(
            `[lighting] ${n} frozen material(s) kept a stale effect after an unobserved light change, e.g. ${example}: thawed`,
          );
        }
      }
      if (this.staticDirty) this.maybeRenderStatic(now);
      else if (this.skippedStatic.length && now - this.skippedAt > 500)
        this.checkSkipped(now);
      if (this.probesDirty && now - this.probesAt > 1500) this.flushProbes();
    });
  }

  /**
   * Any light added, removed or toggled (area lights on a tier step, the
   * fixture pool, zone lights, the sun with shadows off) and a restored
   * WebGL context (effects recompiled) flag the frozen-material check.
   */
  private watchLights(): void {
    const scene = this.scene;
    const flag = () => {
      this.lightsChanged = true;
    };
    const watch = (l: Light) => {
      const o = l.onEnabledStateChangedObservable.add(flag);
      l.onDisposeObservable.addOnce(() =>
        l.onEnabledStateChangedObservable.remove(o),
      );
    };
    for (const l of scene.lights) watch(l);
    const added = scene.onNewLightAddedObservable.add((l) => {
      watch(l);
      flag();
    });
    const removed = scene.onLightRemovedObservable.add(flag);
    const engine = scene.getEngine();
    // Context restored: effects were recompiled (frozen materials must
    // re-check them) and the render-once targets came back empty (the sun's
    // static map, the zone probes): render them again.
    const restored = engine.onContextRestoredObservable.add(() => {
      this.refreezeMaterials();
      this.markStaticDirty();
      this.staticRenderedAt = -Infinity;
      this.refreshProbes();
    });
    this.lightObservers.push(
      () => scene.onNewLightAddedObservable.remove(added),
      () => scene.onLightRemovedObservable.remove(removed),
      () => engine.onContextRestoredObservable.remove(restored),
    );
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
      if (!this.scene.isDisposed) this.useFallbackAmbient();
      return false;
    }
    if (this.scene.isDisposed) {
      tex.dispose();
      return false;
    }
    this.env = tex;
    this.scene.environmentTexture = tex;
    this.applyEnvIntensity();
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

  /**
   * Interior IBL level. Without the zone probes (low tier) the glossy floors
   * and glass reflect this generic HDRI instead of the room: it reads much
   * brighter than the probe (lobby terrazzo + glass strip +4 % mean at the
   * spawn), so it is dimmed then (low within 15 % of high, WS5).
   */
  private applyEnvIntensity(): void {
    if (!this.env) return;
    this.scene.environmentIntensity =
      look("env") * (this.probesOn ? 1 : NO_PROBE_ENV);
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
    // Daylight is several times brighter than the interior: through the
    // glazing the sky must read as noon, not dusk (same exposure inside).
    mat.environmentIntensity = SKY_GAIN;
    mat.freeze();
    internal.incrementReferences();
    const refl = new BaseTexture(this.scene, internal);
    refl.name = "sky:reflection";
    refl.gammaSpace = false;
    refl.coordinatesMode = Texture.INVCUBIC_MODE;
    this.skyReflection?.dispose();
    this.skyReflection = refl;
    this.onSkyBaked?.(refl);
    // The baked cube replaced the HDRI everywhere (skybox, glass): free it.
    this.skyView?.dispose();
    this.skyView = null;
    this.exterior?.dispose();
    this.exterior = null;
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
    // Before the first plan nothing is allocated (the real tier may be low).
    if (this.configured) this.applyShadows();
  }

  setShadowQuality(q: ShadowQuality): void {
    this.shadowQuality = q;
    this.configured = true;
    this.applyShadows();
    this.compensateAmbient();
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
    const csm0 = this.csm;
    const sun0 = this.sunShadow;
    this.rebuildShadows();
    if (this.csm !== csm0 || this.sunShadow !== sun0) this.refreezeMaterials();
  }

  /**
   * Frozen materials keep the effect compiled against the old shadow
   * generators (cascade count, sampler set). After a live generator change
   * (quality step) that effect is stale and the opaque shell stops drawing,
   * so thaw and re-freeze: the next isReady() recompiles with current lights.
   */
  private refreezeMaterials(): void {
    for (const m of this.scene.materials) {
      if (!m.isFrozen) continue;
      m.unfreeze();
      m.freeze();
    }
  }

  private rebuildShadows(): void {
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
    if (!this.configured) return;
    this.sun.setEnabled(true);
    const p = SHADOW_PRESET[q];
    // Dynamic cascades (characters + furniture contact shadows).
    if (this.camera) {
      const want = `${p.csm}:${p.cascades}:${p.pcss}`;
      if (!this.csm || this.csmKey !== want) {
        this.csm?.dispose();
        // Red-only map: a depth needs one channel (RGBA32F is 4×). PCF
        // compares against the depth-stencil texture and never samples the
        // colour target, so it can be half float; PCSS (ultra) reads it for
        // the blocker search and keeps full float.
        const csm = new CascadedShadowGenerator(
          p.csm,
          this.key,
          p.pcss,
          this.camera,
          true,
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
        // Full-strength contact shadows (furniture must not float).
        csm.setDarkness(0);
        csm.transparencyShadow = false;
        for (const m of this.casters) csm.addShadowCaster(m, false);
        this.csm = csm;
      }
    }
    // Static daylight map.
    if (!this.sunShadow || this.sunShadow.mapSize !== p.sun) {
      this.sunShadow?.dispose();
      // PCF: the colour target is never sampled (half float, red only).
      const sg = new ShadowGenerator(p.sun, this.sun, false, undefined, true);
      // PCF (not PCSS): contact hardening on this render-once map left the
      // whole lobby unoccluded under SwiftShader (WS5 L1 shots).
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
      this.syncStaticList();
      this.markStaticDirty();
      // A fresh generator renders as soon as its casters are ready.
      this.staticRenderedAt = -Infinity;
    } else if (this.sunShadow.mapSize === p.sun) {
      // Same map (e.g. medium <-> high share 2048): filtering follows the tier.
      this.markStaticDirty();
    }
  }

  private markStaticDirty(): void {
    if (!this.staticDirty) this.staticDirtyAt = performance.now();
    this.staticDirty = true;
  }

  /**
   * The static map renders ONCE per change, so it must not render while a
   * caster's shadow effect is still compiling (that caster would be missing
   * until the next change — the "first run has no mullion shadows, a tier
   * round trip does" bug). Coalesced to one render per STATIC_DEBOUNCE_MS.
   */
  private maybeRenderStatic(now: number): void {
    const sg = this.sunShadow;
    const map = sg?.getShadowMap();
    if (!sg || !map) return;
    if (now - this.staticRenderedAt < STATIC_DEBOUNCE_MS) return;
    const list = this.staticCasterList();
    const waited = now - this.staticDirtyAt;
    if (waited < STATIC_READY_TIMEOUT_MS && !this.castersReady(sg, list))
      return;
    this.staticDirty = false;
    this.staticRenderedAt = now;
    map.renderList = list;
    // Fit the ortho extents to the casters for this render only.
    this.sun.autoUpdateExtends = true;
    map.onAfterRenderObservable.addOnce(() => {
      this.sun.autoUpdateExtends = false;
    });
    map.resetRefreshCounter();
    // Hidden zones (visibility culling) are not drawn into the map: render
    // again once one of them is shown.
    this.skippedStatic = list.filter((m) => !m.isEnabled());
    this.skippedAt = now;
  }

  private skippedStatic: AbstractMesh[] = [];
  private skippedAt = 0;

  private checkSkipped(now: number): void {
    this.skippedAt = now;
    if (this.skippedStatic.some((m) => !m.isDisposed() && m.isEnabled()))
      this.markStaticDirty();
  }

  /**
   * Keep the static map's render list populated from the first caster on.
   * Babylon only compiles a receiver's sun-shadow lookup (SHADOW<n>) while
   * the generator's render list is non-empty, and the static materials are
   * frozen (P6): a list left empty until the readiness-gated first render
   * left every surface compiled without the sun shadow - the lobby lit
   * through its ceiling (WS5b). When the list first fills, receivers that
   * already compiled are marked light-dirty and re-frozen.
   */
  private syncStaticList(): void {
    const map = this.sunShadow?.getShadowMap();
    if (!map) return;
    const was = map.renderList?.length ?? 0;
    map.renderList = this.staticCasterList();
    if (was === 0 && map.renderList.length > 0) {
      (
        this.sun as unknown as { _markMeshesAsLightDirty(): void }
      )._markMeshesAsLightDirty();
      this.refreezeMaterials();
    }
  }

  private staticCasterList(): AbstractMesh[] {
    const out: AbstractMesh[] = [];
    for (const m of this.staticCasters)
      if (!m.isDisposed() && !m.material?.needAlphaBlending()) out.push(m);
    return out;
  }

  private castersReady(sg: ShadowGenerator, list: AbstractMesh[]): boolean {
    for (const m of list) {
      if (!m.isEnabled() || !m.isVisible || !m.subMeshes) continue;
      const inst =
        (m as Mesh).hasThinInstances || ((m as Mesh).hasInstances ?? false);
      for (const sub of m.subMeshes)
        if (!sg.isReady(sub, inst, false)) return false;
    }
    return true;
  }

  /** Static-map state for tests / diagnostics. */
  get staticShadowState(): {
    dirty: boolean;
    casters: number;
    listed: number;
  } {
    return {
      dirty: this.staticDirty,
      casters: this.staticCasters.size,
      listed: this.sunShadow?.getShadowMap()?.renderList?.length ?? 0,
    };
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
        this.markStaticDirty();
      });
    }
    this.syncStaticList();
    this.markStaticDirty();
  }

  /** Re-render the daylight shadow map (rooms / props changed; coalesced). */
  invalidateStaticShadows(): void {
    this.markStaticDirty();
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
      this.zoneLights.push(l);
      this.includeZone(l);
    });
    // Excluded / included lists changed the zone meshes' light sources.
    this.lightsChanged = true;
  }

  /** Meshes lit by a baked lightmap (see bakeExclude). */
  private readonly baked = new Set<AbstractMesh>();

  /**
   * A zone light lights the zone's unbaked meshes (the bake has its light).
   * All baked: the light is off (an empty include list would mean "all").
   */
  private includeZone(l: Light): void {
    if (this.baked.size === 0) {
      l.includedOnlyMeshes = [...this.zoneMeshes];
      return;
    }
    const live = this.zoneMeshes.filter(
      (m) => !this.baked.has(m) && !m.isDisposed(),
    );
    l.includedOnlyMeshes = live;
    l.setEnabled(live.length > 0);
  }

  /**
   * Meshes lit by a baked lightmap (fx/BakedLighting): the bake carries the
   * bounce (`fill`), the luminaires (fixture container / forward pool, zone
   * lights) and, for sets baked with daylight (`sun: true`), the sun. The
   * `key` stays (its cascades draw character / prop contact shadows on baked
   * floors) and so do the RectAreaLights (glossy highlights). Static sun
   * casters are never removed (else daylight leaks through the ceilings onto
   * the realtime hall). Thaws stale frozen materials (`lightsChanged`).
   */
  bakeExclude(meshes: AbstractMesh[], opts: { sun: boolean }): void {
    if (meshes.length === 0) return;
    const first = this.baked.size === 0;
    for (const m of meshes) this.baked.add(m);
    const exclude = (l: Light) => {
      const list = l.excludedMeshes.filter((m) => !m.isDisposed());
      for (const m of meshes) if (!list.includes(m)) list.push(m);
      l.excludedMeshes = list;
    };
    exclude(this.fill);
    if (this.container) exclude(this.container);
    for (const s of this.slots) if (!this.clustered) exclude(s.light);
    if (opts.sun) exclude(this.sun);
    for (const l of this.zoneLights) this.includeZone(l);
    for (const m of [...this.baked]) if (m.isDisposed()) this.baked.delete(m);
    this.lightsChanged = true;
    if (first) {
      // Smaller fixture pool and the baked-aware ambient (see poolSize).
      this.resizePool();
      this.compensateAmbient();
    }
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
    return fixturePoolSize(this.maxLights, this.clustered, this.baked.size > 0);
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
      else light.excludedMeshes.push(...this.zoneMeshes, ...this.baked);
      this.slots.push({ light, target: null, level: 0 });
    }
    this.assignedKey = "";
  }

  /** Ceiling fixture positions (FixturePoint carries kind / colour). */
  setFixtures(points: Vector3[]): void {
    this.fixtures = points.map((p) =>
      p instanceof FixturePoint ? p : new FixturePoint(p.x, p.y, p.z),
    );
    this.linearFixtures = this.fixtures.filter(
      (f) => f.spec.size && f.spec.kind === "down",
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

  /**
   * Without fixture lights (or without the sun, which needs shadows to stay
   * out of the ceilings) the interior needs more ambient to stay readable.
   * A pure function of (maxLights, pool, shadows): a tier round trip
   * restores exactly the same values.
   */
  private compensateAmbient(): void {
    const noFixtures = this.maxLights === 0 || this.poolIntensity === 0;
    const noSun = this.configured && this.shadowQuality === "off";
    const fill0 = look("fill");
    const key0 = look("key");
    let fill = fill0;
    let key = key0;
    if (noSun && noFixtures) {
      // The low tier. Since the sun map occludes properly (WS5b) the high
      // spawn lost its through-the-ceiling daylight (mean 109.8 -> 94.6),
      // and 0.62 / 0.82 left low 32 % brighter (124.7); target within 15 %
      // (fill 0.3 / key 0.6 at the old 0.25 / 0.8 levels). With lightmaps
      // the baked surfaces get neither fill nor fixtures at any tier: the
      // key stays, so baked rooms look the same at low as at high.
      fill = fill0 * LOW_FILL;
      key = this.baked.size > 0 ? key0 : key0 * LOW_KEY;
    } else if (noSun) fill = Math.max(fill, fill0 * NO_SUN_FILL);
    else if (noFixtures) fill = Math.max(fill, fill0 * NO_FIXTURE_FILL);
    this.fill.intensity = fill;
    this.key.intensity = key;
  }

  /** Per-light cap: low tiers have no AO / shadow to break a hotspot. */
  private lightCap(): number {
    return this.shadowQuality === "off" || this.shadowQuality === "low"
      ? LOW_TIER_LIGHT_CAP
      : Infinity;
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
      this.assignedKey = "assigned";
      nearest = this.nearestFixtures(eye, this.slots.length);
    } else nearest = this.lastNearest;
    const want = this.wantSet;
    if (this.wantFrom !== nearest || want.size !== nearest.length) {
      want.clear();
      for (const p of nearest) want.add(p);
      this.wantFrom = nearest;
    }
    const claimed = this.claimed;
    claimed.clear();
    for (const s of this.slots)
      if (s.target && want.has(s.target)) claimed.add(s.target);
    const cap = this.lightCap();
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
        s.level *
        Math.min(cap, base * (s.target?.spec.intensity ?? 1)) *
        this.poolIntensity;
    }
  }

  private lastNearest: FixturePoint[] = [];
  private readonly wantSet = new Set<FixturePoint>();
  private wantFrom: FixturePoint[] | null = null;
  private readonly claimed = new Set<FixturePoint>();
  private readonly distScratch: number[] = [];

  /** The `k` fixtures nearest `eye` (insertion into a k-list, no full sort). */
  private nearestFixtures(eye: Vector3, k: number): FixturePoint[] {
    const out: FixturePoint[] = [];
    const d = this.distScratch;
    d.length = 0;
    for (const p of this.fixtures) {
      const dist = Vector3.DistanceSquared(p, eye);
      if (out.length === k && dist >= d[k - 1]) continue;
      let i = Math.min(out.length, k - 1);
      while (i > 0 && d[i - 1] > dist) {
        d[i] = d[i - 1];
        out[i] = out[i - 1];
        i--;
      }
      d[i] = dist;
      out[i] = p;
    }
    // A new array per reassignment (2.5 Hz): the want-set refreshes on it.
    this.lastNearest = out;
    return out;
  }

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

  private linearFixtures: FixturePoint[] = [];

  private updateArea(eye: Vector3): void {
    if (!this.areaOn || this.areaLights.length === 0) return;
    // The two nearest linear luminaires, no allocation.
    let f0: FixturePoint | null = null;
    let f1: FixturePoint | null = null;
    let d0 = Infinity;
    let d1 = Infinity;
    for (const f of this.linearFixtures) {
      const d = Vector3.DistanceSquared(f, eye);
      if (d < d0) {
        f1 = f0;
        d1 = d0;
        f0 = f;
        d0 = d;
      } else if (d < d1) {
        f1 = f;
        d1 = d;
      }
    }
    this.areaLights.forEach((a, i) => {
      const hit = i === 0 ? f0 : f1;
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
    const base = [...materials, ...(this.probeExtras.get(name) ?? [])];
    const all = [...base, ...base.flatMap((m) => this.variants.get(m) ?? [])];
    const spec: ProbeSpec = {
      center,
      size,
      materials: [...new Set(all)],
      renderList,
      probe: null,
    };
    this.probes.set(name, spec);
    if (this.probesOn) this.buildProbe(name, spec);
  }

  private readonly probeExtras = new Map<string, PBRMaterial[]>();

  /**
   * Extra materials that take a zone probe's reflection when it registers
   * (glass partitions reflect the hall, drum glazing the control room).
   */
  attachToProbe(name: string, materials: PBRMaterial[]): void {
    const list = this.probeExtras.get(name) ?? [];
    for (const m of materials) if (!list.includes(m)) list.push(m);
    this.probeExtras.set(name, list);
    const spec = this.probes.get(name);
    if (spec) {
      for (const m of materials)
        if (!spec.materials.includes(m)) spec.materials.push(m);
      if (this.probesOn) this.buildProbe(name, spec);
    }
  }

  /** Baked (lightmapped) variants per realtime material (Materials.baked). */
  private readonly variants = new Map<PBRMaterial, PBRMaterial[]>();

  /**
   * A baked variant takes the probes (and probe extras) of its realtime
   * original: same reflection, never drawn into the probe it samples.
   */
  addMaterialVariant(orig: PBRMaterial, variant: PBRMaterial): void {
    const list = this.variants.get(orig) ?? [];
    if (!list.includes(variant)) list.push(variant);
    this.variants.set(orig, list);
    for (const extra of this.probeExtras.values())
      if (extra.includes(orig) && !extra.includes(variant)) extra.push(variant);
    for (const spec of this.probes.values()) {
      if (!spec.materials.includes(orig) || spec.materials.includes(variant))
        continue;
      spec.materials.push(variant);
      if (spec.probe) {
        const frozen = variant.isFrozen;
        if (frozen) variant.unfreeze();
        variant.reflectionTexture = spec.probe.cubeTexture;
        if (frozen) variant.freeze();
        this.fillProbeList(spec, spec.probe.renderList!);
      }
    }
  }

  /** A probe never draws the surfaces that sample it (GL feedback loop). */
  private fillProbeList(spec: ProbeSpec, list: AbstractMesh[]): void {
    list.length = 0;
    for (const m of spec.renderList())
      if (!spec.materials.includes(m.material as PBRMaterial)) list.push(m);
    if (this.skybox) list.push(this.skybox);
  }

  setReflectionProbes(on: boolean): void {
    if (on === this.probesOn) return;
    this.probesOn = on;
    this.applyEnvIntensity();
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
    this.fillProbeList(spec, probe.renderList!);
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
      this.fillProbeList(spec, probe.renderList!);
      probe.cubeTexture.resetRefreshCounter();
    }
  }

  dispose(): void {
    if (this.beforeRender)
      this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    for (const off of this.lightObservers.splice(0)) off();
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
