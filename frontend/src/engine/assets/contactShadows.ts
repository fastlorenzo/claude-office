/**
 * Contact shadows ("blob" shadows) under floor-standing props: one
 * thin-instanced unit quad with a radial-gradient opacity, scaled per
 * placement to the prop's footprint × 1.15, 3 mm above the floor. ONE draw
 * for every prop in the building (alpha-blended, never in shadow maps,
 * probes or the G-buffer). The CSM gives the directional shadow; this is the
 * occlusion right under the object that SSAO only gives at high tiers.
 */
import {
  Color3,
  CreateGround,
  Matrix,
  Mesh,
  RawTexture,
  StandardMaterial,
  Texture,
  type Scene,
} from "@/engine/babylon";

/** Footprint enlargement (the penumbra reaches past the base). */
export const BLOB_SPREAD = 1.15;
/** Height above the floor (with a zOffset against z-fighting). */
export const BLOB_LIFT = 0.003;
/** Opacity at the centre. */
const BLOB_DARKNESS = 0.6;

/**
 * Instance matrix for one placement: unit quad → footprint (sx × sz, model
 * space) × BLOB_SPREAD, lifted, then the placement's own transform. Pure.
 */
export function blobMatrix(
  placement: Matrix,
  sx: number,
  sz: number,
  out: Matrix,
): Matrix {
  Matrix.ScalingToRef(sx * BLOB_SPREAD, 1, sz * BLOB_SPREAD, out);
  out.setTranslationFromFloats(0, BLOB_LIFT, 0);
  return out.multiplyToRef(placement, out);
}

function gradient(scene: Scene, size = 64): RawTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      // Rounded-square falloff: chairs / desks are boxes, plants round.
      const r = Math.pow(
        Math.pow(Math.abs(u), 3) + Math.pow(Math.abs(v), 3),
        1 / 3,
      );
      const t = Math.min(1, Math.max(0, (r - 0.35) / 0.65));
      const a = Math.pow(1 - t * t * (3 - 2 * t), 1.4);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = Math.round(a * 255);
    }
  const tex = RawTexture.CreateRGBATexture(
    data,
    size,
    size,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  tex.name = "contactShadow";
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.hasAlpha = true;
  return tex;
}

export class ContactShadows {
  readonly mesh: Mesh;
  private readonly mat: StandardMaterial;
  private readonly tex: RawTexture;
  private buf = new Float32Array(16);

  constructor(scene: Scene) {
    this.mesh = CreateGround(
      "contactShadows",
      { width: 1, height: 1, subdivisions: 1 },
      scene,
    );
    this.tex = gradient(scene);
    const m = new StandardMaterial("contactShadowsMat", scene);
    m.disableLighting = true;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.emissiveColor = Color3.Black();
    m.opacityTexture = this.tex;
    m.alpha = BLOB_DARKNESS;
    m.disableDepthWrite = true;
    m.zOffset = -2;
    m.backFaceCulling = true;
    m.metadata = { noGBuffer: true };
    this.mat = m;
    this.mesh.material = m;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.applyFog = false;
    this.mesh.metadata = { noProbe: true };
    this.mesh.thinInstanceSetBuffer("matrix", this.buf, 16, true);
    this.mesh.thinInstanceCount = 0;
    this.mesh.isVisible = false;
    m.freeze();
  }

  /** Replace every instance (call when placements change). */
  set(matrices: Float32Array, count: number): void {
    if (count === 0) {
      this.mesh.isVisible = false;
      this.mesh.thinInstanceCount = 0;
      return;
    }
    if (this.buf.length < count * 16) this.buf = new Float32Array(count * 16);
    this.buf.set(matrices.subarray(0, count * 16));
    this.mesh.thinInstanceSetBuffer("matrix", this.buf, 16, true);
    this.mesh.thinInstanceCount = count;
    this.mesh.thinInstanceRefreshBoundingInfo(false);
    this.mesh.isVisible = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
