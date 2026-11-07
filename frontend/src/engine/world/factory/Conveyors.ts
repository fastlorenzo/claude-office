/**
 * Conveyors — ONE thin-instanced pool for every belt of the plant (lanes,
 * project trunks, the main line): 3 draw calls in total.
 *
 *   belt   rubber (shared PBR, procedural ribbed albedo + normal). The UV
 *          scroll is a per-instance float attribute ("beltScroll", added to
 *          the albedo / normal UVs by a PBR material plugin), so every lane
 *          has its own speed while all belts stay ONE draw call
 *   frame  satin metal unit box, per-instance colour (skirts, legs, feet,
 *          braces, rail brackets, end covers)
 *   guard  satin polymer unit cylinder, per-instance colour (guide rails,
 *          safety-yellow end bumpers)
 *
 * `setPaths()` rebuilds the buffers only when the path set's key changes;
 * `update(dt)` advances the moving lanes only (`setLaneSpeed`, 0 = stopped)
 * and uploads the belt scroll attribute only while something moves.
 * Geometry planning lives in `conveyorPlan.ts` (pure, unit-tested).
 */
import {
  Color3,
  Constants,
  CreateBoxVertexData,
  CreateCylinderVertexData,
  Matrix,
  MaterialPluginBase,
  Mesh,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  VertexData,
} from "@/engine/babylon";
import { LaneScroll } from "./factoryAnim";
import {
  buildConveyorSegments,
  conveyorKey,
  packBoxes,
  type BoxInstance,
  type ConveyorPath,
  type ConveyorSegments,
} from "./conveyorPlan";

export type { ConveyorPath } from "./conveyorPlan";

export interface ConveyorStats {
  draws: number;
  belt: number;
  frame: number;
  guard: number;
  rebuilds: number;
  bufferWrites: number;
  /** Lanes (paths) currently moving, and scroll attribute uploads so far. */
  lanesMoving: number;
  scrollUploads: number;
}

/**
 * PBR plugin: adds the per-instance "beltScroll" attribute (in UV units) to
 * the albedo / normal-map V coordinate. GLSL only (the engine is WebGL).
 */
class BeltScrollPlugin extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, "BeltScroll", 210, { BELT_SCROLL: false });
    this._enable(true);
  }

  override getClassName(): string {
    return "BeltScrollPlugin";
  }

  override prepareDefines(defines: Record<string, unknown>): void {
    defines["BELT_SCROLL"] = true;
  }

  override getAttributes(attributes: string[]): void {
    attributes.push("beltScroll");
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_DEFINITIONS: "attribute float beltScroll;",
      CUSTOM_VERTEX_MAIN_END: `
#ifdef MAINUV1
vMainUV1.y += beltScroll;
#endif
#if defined(ALBEDO) && ALBEDODIRECTUV == 0
vAlbedoUV.y += beltScroll;
#endif
#if defined(BUMP) && BUMPDIRECTUV == 0
vBumpUV.y += beltScroll;
#endif
`,
    };
  }
}

/** Ribs per texture tile (one tile ≈ one 1 m slice). */
const RIBS = 16;

class BoxPool {
  private mats = new Float32Array(0);
  private cols: Float32Array | null = null;
  count = 0;

  constructor(
    readonly mesh: Mesh,
    private readonly colored: boolean,
  ) {
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.receiveShadows = true;
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
  }

  /** Returns the number of GPU buffer writes performed. */
  write(list: readonly BoxInstance[]): number {
    const n = list.length;
    if (n * 16 > this.mats.length) {
      const cap = Math.max(64, Math.ceil(n * 1.25));
      this.mats = new Float32Array(cap * 16);
      if (this.colored) this.cols = new Float32Array(cap * 4);
    }
    packBoxes(list, this.mats, this.cols);
    let writes = 0;
    this.mesh.thinInstanceSetBuffer("matrix", this.mats, 16, true);
    writes++;
    if (this.cols) {
      this.mesh.thinInstanceSetBuffer("color", this.cols, 4, true);
      writes++;
    }
    this.mesh.thinInstanceCount = n;
    this.count = n;
    this.mesh.setEnabled(n > 0);
    return writes;
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}

export class Conveyors {
  private readonly belt: BoxPool;
  private readonly frame: BoxPool;
  private readonly guard: BoxPool;
  private readonly rubber: PBRMaterial;
  private readonly textures: Texture[] = [];
  private key: string | null = null;
  private readonly lanes = new LaneScroll();
  private scrollUploads = 0;
  private rebuilds = 0;
  private bufferWrites = 0;
  private last: ConveyorSegments | null = null;

  constructor(private readonly scene: Scene) {
    // ---- belt: unit box, UV v along +X (belt travel), u across
    const beltMesh = new Mesh("conveyorBelt", scene);
    const bvd = CreateBoxVertexData({ size: 1 });
    remapBeltUVs(bvd);
    bvd.applyToMesh(beltMesh, false);
    this.rubber = new PBRMaterial("conveyorRubber", scene);
    const { albedo, normal } = rubberTextures(scene);
    this.textures.push(albedo, normal);
    this.rubber.albedoTexture = albedo;
    this.rubber.bumpTexture = normal;
    // Fine ribs alias into moiré at grazing angles: soft normal, specular
    // anti-aliasing, max anisotropy (see rubberTextures for the profile).
    normal.level = 0.4;
    this.rubber.enableSpecularAntiAliasing = true;
    new BeltScrollPlugin(this.rubber);
    this.rubber.albedoColor = Color3.White();
    this.rubber.metallic = 0;
    this.rubber.roughness = 0.66;
    this.rubber.environmentIntensity = 0.8;
    beltMesh.material = this.rubber;
    this.belt = new BoxPool(beltMesh, false);

    // ---- frame: unit box, satin metal, instance colours
    const frameMesh = new Mesh("conveyorFrame", scene);
    CreateBoxVertexData({ size: 1 }).applyToMesh(frameMesh, false);
    const fm = new PBRMaterial("conveyorFrameMat", scene);
    fm.albedoColor = Color3.White();
    fm.metallic = 0.72;
    fm.roughness = 0.36;
    frameMesh.material = fm;
    this.frame = new BoxPool(frameMesh, true);

    // ---- guard: unit cylinder along +X, satin polymer, instance colours
    const guardMesh = new Mesh("conveyorGuard", scene);
    const gvd = CreateCylinderVertexData({
      height: 1,
      diameter: 1,
      tessellation: 12,
    });
    gvd.transform(Matrix.RotationZ(Math.PI / 2));
    gvd.applyToMesh(guardMesh, false);
    const gm = new PBRMaterial("conveyorGuardMat", scene);
    gm.albedoColor = Color3.White();
    gm.metallic = 0.05;
    gm.roughness = 0.32;
    guardMesh.material = gm;
    this.guard = new BoxPool(guardMesh, true);
  }

  /** Rebuilds only when the set changed. Returns true when rebuilt. */
  setPaths(paths: readonly ConveyorPath[]): boolean {
    const key = conveyorKey(paths);
    if (key === this.key) return false;
    this.key = key;
    const seg = buildConveyorSegments(paths);
    this.last = seg;
    this.bufferWrites += this.belt.write(seg.belt);
    this.lanes.setRanges(seg.beltRanges, seg.belt.length);
    this.bindScroll(seg.belt.length);
    this.bufferWrites += this.frame.write(seg.frame);
    this.bufferWrites += this.guard.write(seg.guard);
    this.rebuilds++;
    return true;
  }

  /** Default belt surface speed (m/s) for lanes without their own speed. */
  setSpeed(mps: number): void {
    this.lanes.setDefault(mps);
  }

  /** Belt speed (m/s) of one path (lane / trunk / main); 0 stops it. */
  setLaneSpeed(pathId: string, mps: number): void {
    this.lanes.setLane(pathId, mps);
  }

  /** Advance moving lanes; stopped lanes cost nothing (no buffer writes). */
  update(dt: number): void {
    if (this.lanes.step(Math.min(dt, 0.1)) === 0) return;
    this.belt.mesh.thinInstancePartialBufferUpdate(
      "beltScroll",
      this.lanes.hi - this.lanes.lo,
      this.lanes.lo,
    );
    this.scrollUploads++;
  }

  /** (Re)attach the per-instance scroll attribute to the belt mesh. */
  private bindScroll(n: number): void {
    if (n === 0) return;
    this.belt.mesh.thinInstanceSetBuffer(
      "beltScroll",
      this.lanes.offsets,
      1,
      false,
    );
  }

  setVisible(on: boolean): void {
    for (const p of [this.belt, this.frame, this.guard])
      p.mesh.setEnabled(on && p.count > 0);
  }

  /** Last planned segments (merges / geometry), for debugging and tests. */
  get segments(): ConveyorSegments | null {
    return this.last;
  }

  meshes(): Mesh[] {
    return [this.belt.mesh, this.frame.mesh, this.guard.mesh];
  }

  stats(): ConveyorStats {
    const pools = [this.belt, this.frame, this.guard];
    return {
      draws: pools.filter((p) => p.count > 0).length,
      belt: this.belt.count,
      frame: this.frame.count,
      guard: this.guard.count,
      rebuilds: this.rebuilds,
      bufferWrites: this.bufferWrites,
      lanesMoving: this.lanes.moving(),
      scrollUploads: this.scrollUploads,
    };
  }

  dispose(): void {
    for (const p of [this.belt, this.frame, this.guard]) {
      const m = p.mesh.material;
      p.dispose();
      m?.dispose();
    }
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    void this.scene;
  }
}

/** Box UVs: v along local X on every face, u across (Z, or Y on ±Z faces). */
function remapBeltUVs(vd: VertexData): void {
  const p = vd.positions!;
  const n = vd.normals!;
  const uv = new Float32Array((p.length / 3) * 2);
  for (let i = 0; i < p.length / 3; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const ax = Math.abs(n[i * 3]);
    const az = Math.abs(n[i * 3 + 2]);
    if (ax > 0.5) {
      uv[i * 2] = z + 0.5;
      uv[i * 2 + 1] = y + 0.5;
    } else if (az > 0.5) {
      uv[i * 2] = y + 0.5;
      uv[i * 2 + 1] = x + 0.5;
    } else {
      uv[i * 2] = z + 0.5;
      uv[i * 2 + 1] = x + 0.5;
    }
  }
  vd.uvs = uv;
}

/** Procedural ribbed rubber: albedo (sRGB) + tangent-space normal map. */
function rubberTextures(scene: Scene): { albedo: Texture; normal: Texture } {
  const W = 32;
  const H = 512;
  const alb = new Uint8Array(W * H * 4);
  const nrm = new Uint8Array(W * H * 4);
  const height = (v: number) => {
    // Rib profile: flat land with a soft groove, RIBS per tile.
    const ph = (v * RIBS) % 1;
    const d = Math.abs(ph - 0.5) * 2; // 0 at groove centre
    return d < 0.35 ? Math.cos((d / 0.35) * Math.PI) * -0.5 - 0.5 : 0;
  };
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let j = 0; j < H; j++) {
    const v = j / H;
    const h = height(v);
    const dh = (height((j + 1) / H) - height((j - 1 + H) / H)) * (H / 2);
    for (let i = 0; i < W; i++) {
      const u = i / W;
      const edge = u < 0.035 || u > 0.965;
      const n = (rnd() - 0.5) * 6;
      const base = edge ? 52 : 38 + h * 14 + n;
      const k = (j * W + i) * 4;
      alb[k] = alb[k + 1] = Math.max(0, Math.min(255, base));
      alb[k + 2] = Math.max(0, Math.min(255, base + 2));
      alb[k + 3] = 255;
      // Normal: slope along v only (ribs run across the belt).
      const sy = edge ? 0 : -dh * 0.003;
      const len = Math.hypot(sy, 1);
      nrm[k] = 128;
      nrm[k + 1] = Math.round(128 + (sy / len) * 127);
      nrm[k + 2] = Math.round(128 + (1 / len) * 127);
      nrm[k + 3] = 255;
    }
  }
  const mk = (data: Uint8Array, name: string, srgb: boolean): Texture => {
    const t = new RawTexture(
      data,
      W,
      H,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.name = name;
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.gammaSpace = srgb;
    t.anisotropicFilteringLevel = 16;
    return t;
  };
  return {
    albedo: mk(alb, "conveyorRubberAlbedo", true),
    normal: mk(nrm, "conveyorRubberNormal", false),
  };
}
