/**
 * Post-processing bound to the player camera only (feed cameras stay raw).
 *
 * The camera chain is built from ordered stages, applied from a pure `FxPlan`:
 *
 *   fsr → ssao → ssr → taa → motionBlur → default
 *
 *  - fsr must be first: its upscale pass owns the (smaller) scene render target.
 *  - ssao / ssr read the geometry buffer and work on linear HDR colour, before
 *    tone mapping; taa accumulates the lit result (SSR/SSAO included) so their
 *    noise is resolved; the default pipeline (bloom, DoF, ACES + colour
 *    curves, FXAA, grain, ...) is last.
 * Changing one stage's structural key tears down that stage and every later
 * one, then rebuilds them in order; everything else is updated in place.
 * Scene MSAA is applied to the first post-process of the camera chain.
 *
 * Also owns the GlowLayer (emissive lamps) and the HighlightLayer (crosshair).
 */
import {
  Color3,
  Color4,
  ColorCurves,
  Constants,
  DefaultRenderingPipeline,
  DepthOfFieldEffectBlurLevel,
  FSR1RenderingPipeline,
  GlowLayer,
  HighlightLayer,
  ImageProcessingConfiguration,
  MotionBlurPostProcess,
  type PostProcess,
  SSAO2RenderingPipeline,
  SSRRenderingPipeline,
  TAARenderingPipeline,
  Vector3,
  Scene,
  type AbstractMesh,
  type Camera,
  type Mesh,
} from "@/engine/babylon";
import {
  STAGES,
  firstChangedStage,
  structuralKeys,
  type FxPlan,
  type StageName,
} from "@/engine/fx/fxPlan";

interface Handle {
  dispose(): void;
  /** Apply non-structural parameters from the plan. */
  update?(plan: FxPlan): void;
}

const HDR = Constants.TEXTURETYPE_HALF_FLOAT;
/** DoF lens size at full strength (inspect) and in "always" mode. */
const DOF_LENS_INSPECT = 60;
const DOF_LENS_ALWAYS = 22;

function makeColorCurves(): ColorCurves {
  // Subtle filmic grade: cool shadows, slightly warm highlights, a touch of
  // density in the mids.
  const c = new ColorCurves();
  c.globalSaturation = 6;
  c.shadowsHue = 215;
  c.shadowsDensity = 22;
  c.shadowsSaturation = 14;
  c.shadowsExposure = -4;
  c.highlightsHue = 38;
  c.highlightsDensity = 24;
  c.highlightsSaturation = 14;
  c.highlightsExposure = 2;
  return c;
}

/** Extra half-angle (rad) around the target's cone for highlight occluders. */
const HL_CONE_MARGIN = 0.05;
/** Merged meshes larger than this (bounding radius, m) never occlude the target. */
const HL_MAX_OCCLUDER_R = 12.5;
/** Glow halo range (m). */
const GLOW_MAX_M = 12;

/** Base-geometry radius of a thin-instanced mesh around its instance origin. */
const thinRadii = new WeakMap<Mesh, number>();
function thinRadius(m: Mesh): number {
  const hit = thinRadii.get(m);
  if (hit !== undefined) return hit;
  const pos = m.geometry?.getVerticesData("position");
  let r2 = 0;
  if (pos)
    for (let i = 0; i < pos.length; i += 3)
      r2 = Math.max(r2, pos[i] ** 2 + pos[i + 1] ** 2 + pos[i + 2] ** 2);
  const r = pos ? Math.sqrt(r2) : 1e3;
  thinRadii.set(m, r);
  return r;
}

/** Distinct RTT names so the draw breakdown can tell the effect layers apart. */
function nameMainTexture(layer: unknown, name: string): void {
  const t = (layer as { _mainTexture?: { name: string } | null })._mainTexture;
  if (t) t.name = name;
}

export class PostFx {
  private glow: GlowLayer | null = null;
  private readonly glowMeshes = new Set<Mesh>();
  private plan: FxPlan | null = null;
  private keys: Record<StageName, string> | null = null;
  private readonly handles = new Map<StageName, Handle>();
  private defaultPipeline: DefaultRenderingPipeline | null = null;
  private readonly colorCurves = makeColorCurves();
  /** DoF stage present in the default pipeline (runtime for inspectOnly). */
  private dofLive = false;
  private dofStrength = 0;
  private dofFocusM = 4;
  /** Number of camera post-processes created, for diagnostics. */
  stageNames: string[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    this.highlight = new HighlightLayer("interactHL", scene, {
      camera,
      mainTextureRatio: 0.5,
      blurHorizontalSize: 0.35,
      blurVerticalSize: 0.35,
    });
    this.highlight.innerGlow = false;
    this.highlight.outerGlow = true;
    // An enabled effect layer re-renders every active mesh; keep it off until needed.
    this.highlight.isEnabled = false;
    nameMainTexture(this.highlight, "highlightRTT");
    this.limitHighlightOccluders();
  }

  /**
   * The highlight layer draws every active mesh into its mask (the others as
   * black occluders): a full extra scene pass (~120 draws in a team room)
   * whenever a character is targeted. Only meshes inside the cone from the
   * eye to the target, and nearer than its far side, can hide part of it:
   * keep those (thin instances tested per instance) plus the target.
   */
  private limitHighlightOccluders(): void {
    const thin = (
      this.highlight as unknown as {
        _thinEffectLayer?: { _shouldRenderMesh(m: AbstractMesh): boolean };
      }
    )._thinEffectLayer;
    if (!thin || typeof thin._shouldRenderMesh !== "function") return;
    const base = thin._shouldRenderMesh.bind(thin);
    thin._shouldRenderMesh = (m: AbstractMesh): boolean => {
      if (!base(m)) return false;
      if (this.highlighted.has(m)) return true;
      // Glass and other blended surfaces do not hide the target.
      const mat = m.material;
      if (mat && mat.needAlphaBlendingForMesh(m)) return false;
      if (m.infiniteDistance) return false; // sky
      this.updateCone();
      const eye = this.camera.globalPosition;
      const bi = m.getBoundingInfo();
      const bs = bi.boundingSphere;
      // Building-scale merged shells (façade, factory hall, hall shell): the
      // target is within interaction reach (3.5 m) and was hit by an
      // occlusion-tested ray; such batches practically never sit between.
      if (!(m as Mesh).hasThinInstances && bs.radiusWorld > HL_MAX_OCCLUDER_R)
        return false;
      const ok = (m as Mesh).hasThinInstances
        ? this.thinInCone(m as Mesh, eye)
        : this.inCone(bs.centerWorld, bs.radiusWorld, eye) &&
          this.boxOnSegment(
            bi.boundingBox.minimumWorld,
            bi.boundingBox.maximumWorld,
            eye,
          );
      if (ok && this.debugOccluders) {
        const k = m.name.replace(/[_:.\d].*$/, "");
        this.occluderKinds[k] = (this.occluderKinds[k] ?? 0) + 1;
      }
      return ok;
    };
  }

  private updateCone(): void {
    const frame = this.scene.getFrameId();
    if (frame === this.hlFrame) return;
    this.hlFrame = frame;
    const eye = this.camera.globalPosition;
    let cx = 0,
      cy = 0,
      cz = 0,
      n = 0;
    for (const h of this.highlighted) {
      const c = h.getBoundingInfo().boundingSphere.centerWorld;
      cx += c.x;
      cy += c.y;
      cz += c.z;
      n++;
    }
    if (!n) return;
    this.hlAxis.set(cx / n - eye.x, cy / n - eye.y, cz / n - eye.z);
    const d = Math.max(1e-3, this.hlAxis.length());
    this.hlAxis.scaleInPlace(1 / d);
    let r = 0;
    for (const h of this.highlighted) {
      const bs = h.getBoundingInfo().boundingSphere;
      const c = bs.centerWorld;
      r = Math.max(
        r,
        Math.hypot(c.x - cx / n, c.y - cy / n, c.z - cz / n) + bs.radiusWorld,
      );
    }
    this.hlHalf = Math.min(1.4, Math.atan(r / d) + HL_CONE_MARGIN);
    this.hlRadius = r;
    this.hlFar = d + r;
  }

  /** Sphere (centre, radius) intersects the target cone before its far side. */
  private inCone(
    c: { x: number; y: number; z: number },
    r: number,
    eye: Vector3,
  ): boolean {
    const vx = c.x - eye.x;
    const vy = c.y - eye.y;
    const vz = c.z - eye.z;
    const d = Math.hypot(vx, vy, vz);
    if (d <= r) return true; // contains the eye
    if (d - r > this.hlFar) return false;
    const a = this.hlAxis;
    const cosC = (vx * a.x + vy * a.y + vz * a.z) / d;
    // Angle to the axis minus the sphere's angular radius < cone half-angle.
    const ang = Math.acos(Math.max(-1, Math.min(1, cosC)));
    return ang - Math.asin(Math.min(1, r / d)) < this.hlHalf;
  }

  /**
   * World AABB (inflated by the target radius) crosses the segment from the
   * eye to the target's far side — the tight test for big merged meshes whose
   * sphere contains the eye (lobby, factory hall, sky, exterior).
   */
  private boxOnSegment(
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
    eye: Vector3,
  ): boolean {
    const r = this.hlRadius;
    const a = this.hlAxis;
    const len = this.hlFar;
    let t0 = 0;
    let t1 = len;
    const axes: [number, number, number, number][] = [
      [eye.x, a.x, min.x - r, max.x + r],
      [eye.y, a.y, min.y - r, max.y + r],
      [eye.z, a.z, min.z - r, max.z + r],
    ];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return false;
        continue;
      }
      let u = (lo - o) / d;
      let v = (hi - o) / d;
      if (u > v) [u, v] = [v, u];
      t0 = Math.max(t0, u);
      t1 = Math.min(t1, v);
      if (t0 > t1) return false;
    }
    return true;
  }

  private thinInCone(m: Mesh, eye: Vector3): boolean {
    const st = (
      m as unknown as {
        _thinInstanceDataStorage?: {
          matrixData: Float32Array | null;
          instancesCount: number;
        };
      }
    )._thinInstanceDataStorage;
    const data = st?.matrixData;
    const count = Math.min(st?.instancesCount ?? 0, m.thinInstanceCount);
    if (!data || count <= 0) return false;
    const r = thinRadius(m);
    const w = m.getWorldMatrix().m;
    const p = this.hlPoint;
    for (let i = 0; i < count; i++) {
      const o = i * 16;
      const lx = data[o + 12];
      const ly = data[o + 13];
      const lz = data[o + 14];
      p.x = lx * w[0] + ly * w[4] + lz * w[8] + w[12];
      p.y = lx * w[1] + ly * w[5] + lz * w[9] + w[13];
      p.z = lx * w[2] + ly * w[6] + lz * w[10] + w[14];
      if (this.inCone(p, r, eye)) return true;
    }
    return false;
  }

  private readonly hlPoint = { x: 0, y: 0, z: 0 };

  readonly highlight: HighlightLayer;
  /** Debug (drawdbg): highlight occluders accepted, by mesh-name prefix. */
  debugOccluders = false;
  occluderKinds: Record<string, number> = {};
  /** Meshes currently highlighted (crosshair target). */
  private readonly highlighted = new Set<AbstractMesh>();
  /** Target cone (eye → highlighted bounds), refreshed once per frame. */
  private hlFrame = -1;
  private readonly hlAxis = new Vector3();
  private hlHalf = 0;
  private hlRadius = 0;
  private hlFar = 0;

  /** Active camera post-processes (diagnostics). */
  get postProcessCount(): number {
    return this.chain().length;
  }

  get dofActive(): boolean {
    return this.dofLive;
  }

  /** Apply a plan: rebuild changed stages, update parameters in place. */
  apply(plan: FxPlan): void {
    this.plan = plan;
    this.sync();
    this.setGlow(plan.glow);
  }

  /**
   * DoF driver (0..1 strength, focus distance in metres). For "inspectOnly" the
   * DoF stage exists only while strength > 0.
   */
  setDof(strength: number, focusM: number): void {
    this.dofStrength = strength;
    this.dofFocusM = focusM;
    const mode = this.plan?.dofMode ?? "off";
    const want =
      mode === "always" || (mode === "inspectOnly" && strength > 0.01);
    if (want !== this.dofLive) {
      this.dofLive = want;
      this.sync();
      return;
    }
    this.updateDof();
  }

  private updateDof(): void {
    const p = this.defaultPipeline;
    if (!p || !this.dofLive || !this.plan) return;
    const lens =
      this.plan.dofMode === "always"
        ? DOF_LENS_ALWAYS * Math.max(0.35, this.dofStrength)
        : DOF_LENS_INSPECT * this.dofStrength;
    const d = p.depthOfField;
    d.focusDistance = this.dofFocusM * 1000;
    d.lensSize = lens;
  }

  private sync(): void {
    const plan = this.plan;
    if (!plan) return;
    const mode = plan.dofMode;
    if (mode === "off") this.dofLive = false;
    else if (mode === "always") this.dofLive = true;
    else this.dofLive = this.dofLive && this.dofStrength > 0.01;
    const next = structuralKeys(plan, this.dofLive);
    const from = firstChangedStage(this.keys, next);
    if (from >= 0) {
      // Tear down changed + later stages (last first), rebuild in order.
      for (let i = STAGES.length - 1; i >= from; i--) {
        const h = this.handles.get(STAGES[i]);
        if (h) {
          h.dispose();
          this.handles.delete(STAGES[i]);
        }
      }
      for (let i = from; i < STAGES.length; i++) {
        const st = STAGES[i];
        if (!next[st] && st !== "default") continue;
        const h = this.build(st, plan);
        if (h) this.handles.set(st, h);
      }
      this.keys = next;
      this.applySamples(plan);
      this.stageNames = this.chain().map((x) => x.name);
    }
    for (const h of this.handles.values()) h.update?.(plan);
    this.updateDof();
  }

  /** Scene MSAA lives on the first post-process of the chain. */
  private applySamples(plan: FxPlan): void {
    this.chain().forEach((pp, i) => {
      pp.samples = i === 0 ? plan.msaa : 1;
    });
  }

  /**
   * Glass panes are transparent but glossy: left in the G-buffer they act as
   * mirrors for SSR (black windows) and darken under SSAO. Opaque only.
   */
  private leanGBuffer(): void {
    // Linear depth is read as .r only (SSAO, SSR): one 32-bit channel. Normals
    // fit half float. Two RGBA32F targets (32 B/px) become R32F + RGBA16F (12 B/px).
    this.scene.enableGeometryBufferRenderer(1, undefined, {
      0: {
        // GeometryBufferRenderer.DEPTH_TEXTURE_TYPE
        textureType: Constants.TEXTURETYPE_FLOAT,
        textureFormat: Constants.TEXTUREFORMAT_RED,
      },
      1: {
        // NORMAL_TEXTURE_TYPE
        textureType: HDR,
        textureFormat: Constants.TEXTUREFORMAT_RGBA,
      },
    });
  }

  private opaqueGBuffer(): void {
    const g = this.scene.geometryBufferRenderer;
    if (g) g.renderTransparentMeshes = false;
  }

  private chain(): PostProcess[] {
    return this.camera._postProcesses.filter((x): x is PostProcess => !!x);
  }

  private build(stage: StageName, plan: FxPlan): Handle | null {
    const scene = this.scene;
    const cam = this.camera;
    const detach = (name: string): void =>
      scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline(
        name,
        [cam],
      );
    switch (stage) {
      case "fsr": {
        if (!plan.fsr) return null;
        const f = new FSR1RenderingPipeline("fsr", scene, [cam]);
        if (!f.isSupported) {
          f.dispose();
          return null;
        }
        f.scaleFactor = plan.fsr.scaleFactor;
        f.samples = 1;
        // Keep HDR through the upscale so tone mapping still sees linear light.
        const priv = f as unknown as {
          _upscalePostProcess?: { _textureType: number } | null;
          _sharpenPostProcess?: { _textureType: number } | null;
        };
        if (priv._upscalePostProcess)
          priv._upscalePostProcess._textureType = HDR;
        if (priv._sharpenPostProcess)
          priv._sharpenPostProcess._textureType = HDR;
        return {
          dispose: () => {
            detach("fsr");
            f.dispose();
          },
          update: (p) => {
            f.sharpnessStops = 0.8 * (1 - p.sharpen);
          },
        };
      }
      case "ssao": {
        const o = plan.ssao;
        if (!o || !SSAO2RenderingPipeline.IsSupported) return null;
        // Geometry-buffer path: the prepass path produced blotchy AO with effect layers.
        this.leanGBuffer();
        const ssao = new SSAO2RenderingPipeline(
          "ssao",
          scene,
          { ssaoRatio: o.ratio, blurRatio: o.blurRatio },
          [cam],
          true,
          HDR,
        );
        ssao.radius = 0.9;
        ssao.totalStrength = 1.1;
        ssao.base = 0.12;
        ssao.samples = o.samples;
        ssao.maxZ = 60;
        ssao.minZAspect = 0.4;
        ssao.expensiveBlur = o.expensiveBlur;
        this.opaqueGBuffer();
        return {
          dispose: () => {
            detach("ssao");
            ssao.dispose();
          },
        };
      }
      case "ssr": {
        const o = plan.ssr;
        if (!o) return null;
        this.leanGBuffer();
        const ssr = new SSRRenderingPipeline("ssr", scene, [cam], true, HDR);
        if (!ssr.isSupported) {
          ssr.dispose();
          return null;
        }
        ssr.inputTextureColorIsInGammaSpace = false;
        ssr.generateOutputInGammaSpace = false;
        ssr.enableSmoothReflections = false;
        ssr.attenuateScreenBorders = true;
        ssr.attenuateFacingCamera = true;
        ssr.attenuateIntersectionDistance = true;
        ssr.clipToFrustum = true;
        ssr.maxDistance = 40;
        ssr.selfCollisionNumSkip = 2;
        // Only clearly glossy surfaces (floors, glass-topped desks); plain paint stays untouched.
        ssr.reflectivityThreshold = 0.25;
        ssr.step = o.step;
        ssr.maxSteps = o.maxSteps;
        ssr.thickness = o.thickness;
        ssr.strength = o.strength;
        ssr.roughnessFactor = o.roughnessFactor;
        ssr.ssrDownsample = o.downsample;
        ssr.blurDispersionStrength = o.blur;
        ssr.blurDownsample = o.downsample > 0 ? 1 : 0;
        this.opaqueGBuffer();
        // No environment fallback: misses keep the original pixel (the IBL cube made windows black).
        return {
          dispose: () => {
            detach("ssr");
            ssr.dispose();
          },
        };
      }
      case "taa": {
        if (!plan.taa) return null;
        const taa = new TAARenderingPipeline("taa", scene, [cam], HDR);
        if (!taa.isSupported) {
          taa.dispose();
          return null;
        }
        taa.samples = plan.taa.samples;
        taa.msaaSamples = 1;
        // Static camera: accumulate (jittered). Moving camera: TAA is bypassed
        // (factor 1) so there is no ghosting; FXAA covers motion in taa+fxaa.
        taa.disableOnCameraMove = true;
        taa.clampHistory = true;
        taa.factor = 0.08;
        return {
          dispose: () => {
            detach("taa");
            taa.dispose();
          },
        };
      }
      case "motionBlur": {
        if (!plan.motionBlur) return null;
        const mb = new MotionBlurPostProcess(
          "motionBlur",
          scene,
          1.0,
          cam,
          undefined,
          undefined,
          undefined,
          HDR,
          false,
          true,
        );
        mb.isObjectBased = false;
        mb.motionStrength = 0.6;
        mb.motionBlurSamples = 16;
        return { dispose: () => mb.dispose(cam) };
      }
      case "default":
        return this.buildDefault(plan);
    }
  }

  private buildDefault(plan: FxPlan): Handle {
    const p = new DefaultRenderingPipeline(
      "post",
      true,
      this.scene,
      [this.camera],
      false,
    );
    p.imageProcessingEnabled = true;
    // The pipeline's post-process doesn't exist before prepare(): use the shared config.
    const ip = this.scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.05;
    ip.vignetteWeight = 0.9; // a lens falloff, not an iris
    ip.vignetteStretch = 0.4;
    ip.vignetteColor = new Color4(0.05, 0.04, 0.03, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
    ip.colorCurves = this.colorCurves;

    p.bloomEnabled = plan.bloom;
    p.bloomThreshold = 0.8;
    p.bloomWeight = 0.22;
    p.bloomKernel = 32; // perf: half the blur taps (P11)
    p.bloomScale = 0.5;

    p.fxaaEnabled = plan.fxaa;
    p.sharpenEnabled = plan.sharpenOn;
    p.sharpen.colorAmount = 1;
    p.chromaticAberrationEnabled = plan.chromaticAberration;
    if (plan.chromaticAberration) {
      p.chromaticAberration.aberrationAmount = 18;
      p.chromaticAberration.radialIntensity = 1.2;
    }
    p.grainEnabled = plan.grain;
    if (plan.grain) {
      p.grain.intensity = 9;
      p.grain.animated = true;
    }
    p.depthOfFieldEnabled = this.dofLive;
    if (this.dofLive) {
      p.depthOfFieldBlurLevel = DepthOfFieldEffectBlurLevel.Medium;
      p.depthOfField.focalLength = 50;
      p.depthOfField.fStop = 1.4;
    }
    p.prepare();
    this.defaultPipeline = p;
    return {
      dispose: () => {
        p.dispose();
        this.defaultPipeline = null;
      },
      update: (pl) => {
        const ipc = this.scene.imageProcessingConfiguration;
        ipc.vignetteEnabled = pl.vignette;
        ipc.colorCurvesEnabled = pl.colorGrading;
        ipc.contrast = pl.colorGrading ? 1.16 : 1.1;
        if (pl.sharpenOn) p.sharpen.edgeAmount = pl.sharpen * 0.72;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Glow + highlight
  // -------------------------------------------------------------------------

  private setGlow(on: boolean): void {
    if (on && !this.glow) {
      const g = new GlowLayer("glow", this.scene, {
        mainTextureRatio: 0.5,
        blurKernelSize: 48,
        camera: this.camera,
      });
      g.intensity = 0.55;
      nameMainTexture(g, "glowRTT");
      this.limitGlowRange(g);
      for (const m of this.glowMeshes)
        if (m !== this.suppressed) g.addIncludedOnlyMesh(m);
      this.glow = g;
    } else if (!on && this.glow) {
      this.glow.dispose();
      this.glow = null;
    }
  }

  /**
   * Only glowing meshes within GLOW_MAX_M of the eye render into the glow
   * pass (included-only meshes, so skipping one only drops its halo, which
   * is a few pixels at that distance anyway).
   */
  private limitGlowRange(g: GlowLayer): void {
    const thin = (
      g as unknown as {
        _thinEffectLayer?: { _shouldRenderMesh(m: AbstractMesh): boolean };
      }
    )._thinEffectLayer;
    if (!thin || typeof thin._shouldRenderMesh !== "function") return;
    const base = thin._shouldRenderMesh.bind(thin);
    const max2 = GLOW_MAX_M * GLOW_MAX_M;
    thin._shouldRenderMesh = (m: AbstractMesh): boolean => {
      if (!base(m)) return false;
      const eye = this.camera.globalPosition;
      const bs = m.getBoundingInfo().boundingSphere;
      const c = bs.centerWorld;
      const d = Math.max(
        0,
        Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z) - bs.radiusWorld,
      );
      return d * d < max2;
    };
  }

  addGlow(mesh: Mesh): void {
    if (this.glowMeshes.has(mesh)) return;
    this.glowMeshes.add(mesh);
    this.glow?.addIncludedOnlyMesh(mesh);
    mesh.onDisposeObservable.addOnce(() => this.removeGlow(mesh));
  }

  private suppressed: Mesh | null = null;

  /** Temporarily drop a glowing mesh from the glow (the focused screen stays crisp). */
  suppressGlow(mesh: Mesh | null): void {
    if (mesh === this.suppressed) return;
    if (this.suppressed && this.glowMeshes.has(this.suppressed))
      this.glow?.addIncludedOnlyMesh(this.suppressed);
    this.suppressed = mesh && this.glowMeshes.has(mesh) ? mesh : null;
    if (this.suppressed) this.glow?.removeIncludedOnlyMesh(this.suppressed);
  }

  removeGlow(mesh: Mesh): void {
    if (!this.glowMeshes.delete(mesh)) return;
    this.glow?.removeIncludedOnlyMesh(mesh);
  }

  /**
   * Crosshair target (characters): soft outer glow (see
   * limitHighlightOccluders for the occluder set).
   */
  setHighlight(meshes: AbstractMesh[], color: string): void {
    this.highlight.removeAllMeshes();
    this.highlighted.clear();
    const c = Color3.FromHexString(color);
    let any = false;
    for (const m of meshes) {
      if ("subMeshes" in m && (m as Mesh).getClassName() === "Mesh") {
        this.highlight.addMesh(m as Mesh, c);
        this.highlighted.add(m);
        any = true;
      }
    }
    this.hlFrame = -1;
    this.highlight.isEnabled = any;
  }

  dispose(): void {
    for (let i = STAGES.length - 1; i >= 0; i--)
      this.handles.get(STAGES[i])?.dispose();
    this.handles.clear();
    this.glow?.dispose();
    this.glow = null;
    this.highlight.dispose();
    this.glowMeshes.clear();
  }
}
