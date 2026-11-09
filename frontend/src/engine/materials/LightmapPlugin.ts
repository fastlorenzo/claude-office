/**
 * PBR plugin: baked irradiance lightmap (Blender Cycles, see tools/lightmaps
 * and fx/BakedLighting.ts) on the mesh's second UV set.
 *
 * Why not Babylon's own `lightmapTexture`: without `useLightmapAsShadowmap`
 * it ADDS the lightmap to the final colour (no albedo multiply), and
 * `light.lightmapMode` adds lightmap × shadow again per excluded light. The
 * bake is irradiance (no albedo), so it belongs in the diffuse term:
 *
 *   finalDiffuse    += fromRGBD(lightmap) · gain · surfaceAlbedo · AO
 *   finalIrradiance *= iblScale        (the bake already has the bounce)
 *
 * Specular (IBL / probe reflections, the lights left on the mesh) is
 * unchanged. The defines never change after creation (BAKED_LIGHTMAP is
 * always on; the sampler always has a texture: BakedLighting binds a 1×1
 * neutral internal texture first and swaps the real one into the same
 * Texture object), so a frozen material never recompiles when the PNG lands
 * or after a context restore.
 */
import {
  MaterialPluginBase,
  type BaseTexture,
  type PBRMaterial,
} from "@/engine/babylon";

/** Plugin options (gain on the decoded irradiance, kept fraction of IBL diffuse). */
export interface LightmapOptions {
  gain: number;
  iblScale: number;
}

type Defines = Record<string, unknown> & { _needUVs?: boolean };

interface PluginUbo {
  useUbo: boolean;
  isSync: boolean;
  updateFloat2(name: string, x: number, y: number): void;
  setTexture(name: string, texture: BaseTexture | null): void;
}

export class LightmapPlugin extends MaterialPluginBase {
  private gainValue: number;
  private iblValue: number;

  constructor(
    material: PBRMaterial,
    /** The set's lightmap (internal texture swapped in place on load). */
    readonly texture: BaseTexture,
    opts: LightmapOptions,
  ) {
    super(material, "BakedLightmap", 220, { BAKED_LIGHTMAP: false });
    this.gainValue = opts.gain;
    this.iblValue = opts.iblScale;
    this._enable(true);
  }

  override getClassName(): string {
    return "LightmapPlugin";
  }

  get gain(): number {
    return this.gainValue;
  }

  get iblScale(): number {
    return this.iblValue;
  }

  /**
   * Uniform values (tuning). A frozen material skips its UBO updates: thaw
   * and re-freeze so the new values are uploaded once.
   */
  setLevels(gain: number, iblScale: number): void {
    this.gainValue = gain;
    this.iblValue = iblScale;
    const m = this._material;
    if (m.isFrozen) {
      m.unfreeze();
      m.freeze();
    }
  }

  /** The PBR material declares `uv2` only when some feature needs UVs. */
  override prepareDefinesBeforeAttributes(defines: Defines): void {
    defines._needUVs = true;
  }

  override prepareDefines(defines: Defines): void {
    defines["BAKED_LIGHTMAP"] = true;
  }

  override isReadyForSubMesh(): boolean {
    return this.texture.isReady();
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("bakedLightmapSampler");
  }

  override getActiveTextures(active: BaseTexture[]): void {
    active.push(this.texture);
  }

  override hasTexture(t: BaseTexture): boolean {
    return t === this.texture;
  }

  override getUniforms(): {
    ubo: { name: string; size: number; type: string }[];
    fragment: string;
  } {
    return {
      ubo: [{ name: "vBakedLightmap", size: 2, type: "vec2" }],
      fragment: `#ifdef BAKED_LIGHTMAP
uniform vec2 vBakedLightmap;
#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: unknown): void {
    const ubo = uniformBuffer as PluginUbo;
    if (!this._material.isFrozen || !ubo.useUbo || !ubo.isSync)
      ubo.updateFloat2("vBakedLightmap", this.gainValue, this.iblValue);
    ubo.setTexture("bakedLightmapSampler", this.texture);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === "vertex")
      return {
        CUSTOM_VERTEX_DEFINITIONS: "varying vec2 vBakedUV;",
        // uv2Updated is (0,0) when the mesh has no UV2 (never for a baked part).
        CUSTOM_VERTEX_MAIN_END: "vBakedUV = uv2Updated;",
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vBakedUV;
uniform sampler2D bakedLightmapSampler;`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef BAKED_LIGHTMAP
vec3 bakedIrradiance = fromRGBD(texture2D(bakedLightmapSampler, vBakedUV)) * vBakedLightmap.x;
finalDiffuse += bakedIrradiance * surfaceAlbedo.rgb * aoOut.ambientOcclusionColor;
#ifdef REFLECTION
finalIrradiance *= vBakedLightmap.y;
#endif
#endif
`,
    };
  }
}

/** The lightmap plugin of a material, if any. */
export function lightmapPluginOf(
  material: PBRMaterial | null | undefined,
): LightmapPlugin | null {
  const p = material?.pluginManager?.getPlugin<LightmapPlugin>("BakedLightmap");
  return p ?? null;
}
