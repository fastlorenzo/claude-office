/**
 * Post-processing bound to the player camera only (feed cameras stay raw):
 * DefaultRenderingPipeline (ACES, exposure/contrast, bloom, MSAA or FXAA,
 * vignette, light sharpen), SSAO2 on the high tier, a GlowLayer for emissive
 * lamps/signage (included-only), and the HighlightLayer used for the
 * interactable under the crosshair.
 */
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  GlowLayer,
  HighlightLayer,
  ImageProcessingConfiguration,
  SSAO2RenderingPipeline,
  Scene,
  type AbstractMesh,
  type Camera,
  type Mesh,
} from "@/engine/babylon";

export interface FxSettings {
  ssao: boolean;
  msaa: boolean;
  glow: boolean;
  bloom: boolean;
}

export class PostFx {
  readonly pipeline: DefaultRenderingPipeline;
  readonly highlight: HighlightLayer;
  private glow: GlowLayer | null = null;
  private readonly glowMeshes = new Set<Mesh>();

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    const p = new DefaultRenderingPipeline("post", true, scene, [camera]);
    p.imageProcessingEnabled = true;
    const ip = p.imageProcessing;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.05;
    ip.contrast = 1.12;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.6;
    ip.vignetteStretch = 0.4;
    ip.vignetteColor = new Color4(0.05, 0.04, 0.03, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

    p.bloomEnabled = true;
    p.bloomThreshold = 0.8;
    p.bloomWeight = 0.22;
    p.bloomKernel = 64;
    p.bloomScale = 0.5;

    p.sharpenEnabled = true;
    p.sharpen.edgeAmount = 0.18;
    p.sharpen.colorAmount = 1;

    p.chromaticAberrationEnabled = false;
    p.grainEnabled = false;
    p.depthOfFieldEnabled = false;
    this.pipeline = p;

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

  /**
   * The single place where per-tier pipelines are built and torn down.
   * Optional pipelines live in `OPTIONAL`; add new ones (TAA, SSR, ...) there.
   */
  apply(s: FxSettings): void {
    const p = this.pipeline;
    p.samples = s.msaa ? 4 : 1;
    p.fxaaEnabled = !s.msaa;
    p.bloomEnabled = s.bloom;
    for (const def of this.optional) {
      const want = def.wanted(s);
      const live = this.built.get(def.name);
      if (want && !live) {
        const handle = def.build();
        if (handle) this.built.set(def.name, handle);
      } else if (!want && live) {
        live.dispose();
        this.built.delete(def.name);
      }
    }
  }

  private readonly built = new Map<string, { dispose(): void }>();

  private readonly optional: {
    name: string;
    wanted: (s: FxSettings) => boolean;
    build: () => { dispose(): void } | null;
  }[] = [
    {
      name: "ssao",
      wanted: (s) => s.ssao && SSAO2RenderingPipeline.IsSupported,
      build: () => {
        // Geometry-buffer path: the prepass path produced blotchy AO with effect layers.
        const ssao = new SSAO2RenderingPipeline(
          "ssao",
          this.scene,
          { ssaoRatio: 0.5, blurRatio: 0.5 },
          [this.camera],
          true,
        );
        ssao.radius = 0.9;
        ssao.totalStrength = 1.1;
        ssao.base = 0.12;
        ssao.samples = 16;
        ssao.maxZ = 60;
        ssao.minZAspect = 0.4;
        ssao.expensiveBlur = true;
        return {
          dispose: () => {
            this.scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline(
              "ssao",
              [this.camera],
            );
            ssao.dispose();
          },
        };
      },
    },
    {
      name: "glow",
      wanted: (s) => s.glow,
      build: () => {
        const g = new GlowLayer("glow", this.scene, {
          mainTextureRatio: 0.5,
          blurKernelSize: 48,
          camera: this.camera,
        });
        g.intensity = 0.55;
        for (const m of this.glowMeshes)
          if (m !== this.suppressed) g.addIncludedOnlyMesh(m);
        this.glow = g;
        return {
          dispose: () => {
            g.dispose();
            this.glow = null;
          },
        };
      },
    },
  ];

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
    for (const h of this.built.values()) h.dispose();
    this.built.clear();
    this.highlight.dispose();
    this.pipeline.dispose();
    this.glowMeshes.clear();
  }
}
