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

export class PostFx {
  readonly highlight: HighlightLayer;
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
  }

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
    ip.vignetteWeight = 1.6;
    ip.vignetteStretch = 0.4;
    ip.vignetteColor = new Color4(0.05, 0.04, 0.03, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
    ip.colorCurves = this.colorCurves;

    p.bloomEnabled = plan.bloom;
    p.bloomThreshold = 0.8;
    p.bloomWeight = 0.22;
    p.bloomKernel = 64;
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
      for (const m of this.glowMeshes)
        if (m !== this.suppressed) g.addIncludedOnlyMesh(m);
      this.glow = g;
    } else if (!on && this.glow) {
      this.glow.dispose();
      this.glow = null;
    }
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

  setHighlight(meshes: AbstractMesh[], color: string): void {
    this.highlight.removeAllMeshes();
    const c = Color3.FromHexString(color);
    let any = false;
    for (const m of meshes) {
      if ("subMeshes" in m && (m as Mesh).getClassName() === "Mesh") {
        this.highlight.addMesh(m as Mesh, c);
        any = true;
      }
    }
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
