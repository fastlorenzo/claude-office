/**
 * Procedural stylised human ("designer toy" proportions, ~1.75 m).
 *
 * One skinned mesh + 17-bone skeleton per character, one shared PBR material
 * per scene (vertex colours for the outfit, a 4×1 roughness texture indexed
 * by UV for cloth / skin / hair / gloss) → 1 draw call per character.
 * Animation is fully procedural (see poses.ts) and cross-faded per joint.
 */

import {
  AbstractMesh,
  Bone,
  BoundingInfo,
  Mesh,
  PBRMaterial,
  Quaternion,
  RawTexture,
  Scene,
  Skeleton,
  Matrix,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  Space,
} from "../babylon";
import type { CharacterPose } from "../contracts";
import {
  CLAUDE_ORANGE,
  hexToRgb,
  pickAppearance,
  seed01,
  shadeHex,
  toLinear,
  type Appearance,
} from "./identity";
import {
  buildMannequinGeometry,
  COLOR_KEYS,
  SLOT_COUNT,
  SLOT_ROUGHNESS,
  type ColorKey,
  type MannequinGeometry,
} from "./mannequinGeometry";
import { JOINTS, PoseBlender, SKELETON, type PoseFrame } from "./poses";
import type { CharacterRig, Lod } from "./types";

const MID_STEP = 1 / 15;

// ---------------------------------------------------------------------------
// Shared per-scene resources
// ---------------------------------------------------------------------------

const materialCache = new WeakMap<Scene, PBRMaterial>();
const geometryCache = new Map<string, MannequinGeometry>();

function sharedMaterial(scene: Scene): PBRMaterial {
  const cached = materialCache.get(scene);
  if (cached && cached.getScene() === scene && scene.materials.includes(cached))
    return cached;
  const data = new Uint8Array(SLOT_COUNT * 4);
  for (let i = 0; i < SLOT_COUNT; i++) {
    data[i * 4] = 255; // R: AO (unused)
    data[i * 4 + 1] = Math.round(SLOT_ROUGHNESS[i] * 255); // G: roughness
    data[i * 4 + 2] = 0; // B: metallic
    data[i * 4 + 3] = 255;
  }
  const tex = RawTexture.CreateRGBATexture(
    data,
    SLOT_COUNT,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  tex.name = "mannequinRoughness";
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  const mat = new PBRMaterial("mannequinBody", scene);
  mat.albedoColor.set(1, 1, 1);
  mat.metallic = 1;
  mat.roughness = 1;
  mat.metallicTexture = tex;
  mat.useRoughnessFromMetallicTextureGreen = true;
  mat.useMetallnessFromMetallicTextureBlue = true;
  mat.useAmbientOcclusionFromMetallicTextureRed = false;
  mat.environmentIntensity = 0.7;
  mat.directIntensity = 1.0;
  materialCache.set(scene, mat);
  return mat;
}

function geometryFor(boss: boolean, hairStyle: number): MannequinGeometry {
  const key = `${boss ? 1 : 0}:${hairStyle}`;
  let g = geometryCache.get(key);
  if (!g) {
    g = buildMannequinGeometry({ boss, hairStyle: hairStyle as 0 | 1 | 2 });
    geometryCache.set(key, g);
  }
  return g;
}

export interface MannequinOptions {
  id: string;
  boss: boolean;
  color: string;
}

export class MannequinRig implements CharacterRig {
  readonly root: TransformNode;
  readonly headAnchor: TransformNode;
  private readonly mesh: Mesh;
  private readonly skeleton: Skeleton;
  private readonly bones: Bone[];
  private readonly blender: PoseBlender;
  private readonly geom: MannequinGeometry;
  private readonly colors: Float32Array;
  private readonly appearance: Appearance;
  private readonly isBoss: boolean;
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private tint: string;
  private midAcc = 0;
  private disposed = false;

  constructor(scene: Scene, opts: MannequinOptions) {
    this.isBoss = opts.boss;
    this.appearance = pickAppearance(opts.id, opts.boss);
    this.tint = opts.boss ? CLAUDE_ORANGE : opts.color;
    this.blender = new PoseBlender(seed01(opts.id));

    this.root = new TransformNode(`char_${opts.id}`, scene);
    this.geom = geometryFor(opts.boss, this.appearance.hairStyle);

    this.mesh = new Mesh(`charBody_${opts.id}`, scene);
    this.mesh.parent = this.root;
    if (opts.boss) this.mesh.scaling.setAll(1.05);
    const vd = new VertexData();
    vd.positions = this.geom.positions;
    vd.normals = this.geom.normals;
    vd.uvs = this.geom.uvs;
    vd.indices = this.geom.indices;
    vd.matricesIndices = this.geom.matricesIndices;
    vd.matricesWeights = this.geom.matricesWeights;
    this.colors = new Float32Array(this.geom.vertexCount * 4);
    vd.colors = this.colors;
    vd.applyToMesh(this.mesh, false);
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true);
    this.mesh.hasVertexAlpha = false;
    this.mesh.useVertexColors = true;
    this.mesh.material = sharedMaterial(scene);
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = true;

    this.skeleton = new Skeleton(
      `charSkel_${opts.id}`,
      `charSkel_${opts.id}`,
      scene,
    );
    this.bones = [];
    for (const j of JOINTS) {
      const s = SKELETON[j];
      const parent = s.parent ? this.bones[JOINTS.indexOf(s.parent)] : null;
      this.bones.push(
        new Bone(
          j,
          this.skeleton,
          parent,
          Matrix.Translation(s.offset[0], s.offset[1], s.offset[2]),
        ),
      );
    }
    this.mesh.skeleton = this.skeleton;
    this.mesh.numBoneInfluencers = 2;
    // Skinned pose extends beyond the rest box (seated legs, raised arms).
    this.mesh.setBoundingInfo(
      new BoundingInfo(
        new Vector3(-0.75, 0, -0.6),
        new Vector3(0.75, 2.2, 0.95),
      ),
    );

    this.headAnchor = new TransformNode(`charHead_${opts.id}`, scene);
    this.headAnchor.attachToBone(this.bones[JOINTS.indexOf("head")], this.mesh);
    this.headAnchor.position.set(0, 0.32, 0);

    this.recolor();
    this.applyFrame(this.blender.update(0));
  }

  setPose(pose: CharacterPose, blendSec = 0.35): void {
    this.blender.setPose(pose, blendSec);
  }

  setMoving(speed: number): void {
    this.blender.setMoving(speed);
  }

  setTint(hex: string): void {
    const next = this.isBoss ? CLAUDE_ORANGE : hex;
    if (next === this.tint) return;
    this.tint = next;
    this.recolor();
  }

  update(dt: number, lod: Lod): void {
    if (this.disposed || lod === "far") return;
    let step = dt;
    if (lod === "mid") {
      this.midAcc += dt;
      if (this.midAcc < MID_STEP) return;
      step = this.midAcc;
      this.midAcc = 0;
    }
    this.applyFrame(this.blender.update(step));
  }

  getMeshes(): AbstractMesh[] {
    return [this.mesh];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.headAnchor.detachFromBone();
    this.headAnchor.dispose();
    this.mesh.dispose(false, false);
    this.skeleton.dispose();
    this.root.dispose();
  }

  // -------------------------------------------------------------------------

  private applyFrame(f: PoseFrame): void {
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      const o = i * 3;
      Quaternion.RotationYawPitchRollToRef(
        f.rot[o + 1],
        f.rot[o],
        f.rot[o + 2],
        this.q,
      );
      bones[i].setRotationQuaternion(this.q, Space.LOCAL);
    }
    this.v.set(f.hips[0], f.hips[1], f.hips[2]);
    bones[0].setPosition(this.v, Space.LOCAL);
  }

  private recolor(): void {
    const a = this.appearance;
    const palette: Record<ColorKey, string> = {
      shirt: this.tint,
      collar: shadeHex(this.tint, 0.72),
      trousers: a.trousers,
      skin: a.skin,
      lip: shadeHex(a.skin, 0.78),
      hair: a.hair,
      brow: shadeHex(a.hair, 0.8),
      shoes: a.shoes,
      sole: "#D9D6D0",
      eyes: "#17171C",
      belt: "#1B1A1C",
      headset: "#2A2D33",
      accent: CLAUDE_ORANGE,
    };
    const lin = COLOR_KEYS.map((k) => hexToRgb(palette[k]).map(toLinear));
    const keys = this.geom.keys;
    const c = this.colors;
    for (let v = 0; v < keys.length; v++) {
      const rgb = lin[keys[v]];
      c[v * 4] = rgb[0];
      c[v * 4 + 1] = rgb[1];
      c[v * 4 + 2] = rgb[2];
      c[v * 4 + 3] = 1;
    }
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, c);
  }
}
