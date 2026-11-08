/**
 * Workpiece pool: pull requests as physical pallets riding the factory lanes.
 *
 * Seven thin-instance parts (<= 8 draws for any piece count):
 *   pallet, 4 body variants (crate -> machined block -> assembly -> large
 *   assembly, picked by size class), status band (per-instance colour) and a
 *   tag plate (billboarded in the vertex shader, text from one DynamicTexture
 *   atlas). Drafts swap the body for a translucent outlined shell (an 8th
 *   mesh, only enabled while a draft exists); bots carry a robot glyph on
 *   their plate.
 *
 * Cost model:
 *   - `set()` computes a signature per piece; when nothing changed it returns
 *     before touching a buffer (stats().bufferWrites does not move).
 *   - Tag text is drawn into an atlas cell only when that piece's text / look
 *     changes. Nothing is ever redrawn per frame.
 *   - Tag plates exist only within 10 m of the camera (LOD: 0-5 m number +
 *     title, 5-10 m number only); the compact tag buffer is rebuilt only when
 *     that visible set changes.
 */
import {
  BoundingInfo,
  Color3,
  Constants,
  CreateBox,
  CreateCylinder,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  ShaderMaterial,
  StandardMaterial,
  Texture,
  Vector2,
  Vector3,
  VertexData,
  type Observer,
  type Scene,
} from "@/engine/babylon";
import {
  fitText,
  roundRect,
  screenFonts,
  whenFontsReady,
} from "@/engine/screens/canvasKit";
import type { InteractionTarget } from "@/engine/contracts";
import {
  registerThinResolver,
  unregisterThinResolver,
} from "@/engine/interaction/factoryTargets";
import {
  BELT_HEIGHT,
  BODY_DIMS,
  PALLET_TOP,
  packPieces,
  pieceSignature,
  writePackedMatrices,
  resolvePiece,
  signaturesChanged,
  splitTag,
  tagLod,
  writeMatrix,
  type Packed,
  type PieceInstance,
  type Placed,
  type ResolvedPiece,
  type Vec3,
} from "./workpiecePlacement";

export type { PieceInstance, PieceSize, Vec3 } from "./workpiecePlacement";

export interface WorkpiecesOptions {
  /**
   * Tag atlas cells: tags shown at once (plates exist only within 10 m;
   * cells are assigned on demand, nearest first). Default 64 (1024×1280).
   */
  maxTags?: number;
  /** Belt surface above a lane path's floor level. Default 0.85 m. */
  beltHeight?: number;
}

export interface WorkpieceStats {
  pieces: number;
  /** Meshes currently enabled with at least one instance (= draw calls). */
  draws: number;
  /** thinInstanceSetBuffer calls (new GPU buffers) since creation. */
  bufferWrites: number;
  /** In-place buffer updates (moving pieces, tag positions) since creation. */
  bufferUpdates: number;
  /** Atlas cell redraws since creation. */
  textDraws: number;
  /** Tag plates currently shown. */
  tagsVisible: number;
}

// ---------------------------------------------------------------------------
// Geometry (metres; origin = bottom centre, +X = travel direction)
// ---------------------------------------------------------------------------

type Part =
  | { k: "b"; w: number; h: number; d: number; x: number; y: number; z: number }
  | {
      k: "c";
      r: number;
      h: number;
      x: number;
      y: number;
      z: number;
      rz?: number;
    };

const box = (
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): Part => ({ k: "b", w, h, d, x, y: y + h / 2, z });
const cyl = (
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rz?: number,
): Part => ({ k: "c", r, h, x, y: y + h / 2, z, rz });

function build(name: string, scene: Scene, parts: Part[]): Mesh {
  const meshes = parts.map((p, i) => {
    if (p.k === "b") {
      const m = CreateBox(
        `${name}${i}`,
        { width: p.w, height: p.h, depth: p.d },
        scene,
      );
      m.position.set(p.x, p.y, p.z);
      return m;
    }
    const m = CreateCylinder(
      `${name}${i}`,
      { diameter: p.r * 2, height: p.h, tessellation: 16 },
      scene,
    );
    m.position.set(p.x, p.y, p.z);
    if (p.rz) m.rotation.z = p.rz;
    return m;
  });
  const merged = Mesh.MergeMeshes(meshes, true, true) as Mesh;
  merged.name = name;
  merged.isPickable = false;
  merged.alwaysSelectAsActiveMesh = true;
  merged.doNotSyncBoundingInfo = true;
  return merged;
}

/** Pallet 0.8 x 0.6 m, deck top at PALLET_TOP. */
function palletParts(): Part[] {
  const p: Part[] = [];
  for (let i = -2; i <= 2; i++)
    p.push(box(0.8, 0.025, 0.1, 0, 0.115, i * 0.125));
  for (const z of [-0.25, 0, 0.25]) p.push(box(0.8, 0.09, 0.07, 0, 0.025, z));
  for (const x of [-0.34, 0, 0.34]) p.push(box(0.1, 0.025, 0.6, x, 0, 0));
  return p;
}

/** Status ring light hugging the pallet's mid height. */
function bandParts(): Part[] {
  const y = 0.062;
  const h = 0.036;
  return [
    box(0.81, h, 0.008, 0, y, 0.304),
    box(0.81, h, 0.008, 0, y, -0.304),
    box(0.008, h, 0.608, 0.404, y, 0),
    box(0.008, h, 0.608, -0.404, y, 0),
  ];
}

function bodyParts(variant: number): Part[] {
  switch (variant) {
    case 0: {
      // Crate: plank box with corner battens and a lid frame.
      const p: Part[] = [
        box(0.5, 0.38, 0.4, 0, 0, 0),
        box(0.54, 0.03, 0.44, 0, 0.37, 0),
      ];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          p.push(box(0.035, 0.38, 0.035, sx * 0.255, 0, sz * 0.205));
      p.push(
        box(0.52, 0.03, 0.02, 0, 0.17, 0.21),
        box(0.52, 0.03, 0.02, 0, 0.17, -0.21),
      );
      return p;
    }
    case 1: {
      // Machined block: stepped slab with a groove band and bolt heads.
      const p: Part[] = [
        box(0.62, 0.22, 0.46, 0, 0, 0),
        box(0.56, 0.1, 0.4, 0, 0.22, 0),
        box(0.64, 0.02, 0.48, 0, 0.1, 0),
        box(0.34, 0.02, 0.3, 0.05, 0.32, 0),
      ];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          p.push(cyl(0.022, 0.03, sx * 0.25, 0.3, sz * 0.17));
      return p;
    }
    case 2: {
      // Assembly: base, housing, rotary head, side pipe.
      return [
        box(0.64, 0.1, 0.48, 0, 0, 0),
        box(0.46, 0.22, 0.34, -0.06, 0.1, 0),
        box(0.4, 0.04, 0.3, -0.06, 0.32, 0),
        cyl(0.11, 0.12, 0.12, 0.32, 0),
        cyl(0.05, 0.05, 0.12, 0.44, 0),
        cyl(0.03, 0.4, 0.27, 0.1, 0.16, Math.PI / 2),
        box(0.12, 0.18, 0.1, 0.24, 0.1, -0.18),
      ];
    }
    default: {
      // Large assembly: twin towers, bridge, drum, mast.
      return [
        box(0.72, 0.1, 0.52, 0, 0, 0),
        box(0.2, 0.4, 0.34, -0.22, 0.1, 0),
        box(0.2, 0.34, 0.34, 0.22, 0.1, 0),
        box(0.64, 0.07, 0.3, 0, 0.5, 0),
        cyl(0.12, 0.2, 0.0, 0.1, 0.0),
        cyl(0.08, 0.07, 0.0, 0.57, 0),
        cyl(0.012, 0.16, -0.22, 0.5, 0.1),
        box(0.08, 0.02, 0.08, -0.22, 0.65, 0.1),
        cyl(0.035, 0.3, 0.0, 0.1, 0.0, Math.PI / 2),
        box(0.14, 0.2, 0.1, 0.0, 0.1, 0.22),
      ];
    }
  }
}

// Tag plate geometry: 0.7 x 0.22 m quad, centred.
const PLATE_W = 0.7;
const PLATE_H = 0.22;

function plateMesh(scene: Scene): Mesh {
  const m = new Mesh("wpTag", scene);
  const vd = new VertexData();
  vd.positions = [
    -PLATE_W / 2,
    -PLATE_H / 2,
    0,
    PLATE_W / 2,
    -PLATE_H / 2,
    0,
    PLATE_W / 2,
    PLATE_H / 2,
    0,
    -PLATE_W / 2,
    PLATE_H / 2,
    0,
  ];
  vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  vd.indices = [0, 1, 2, 0, 2, 3];
  vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
  vd.applyToMesh(m);
  m.isPickable = false;
  m.alwaysSelectAsActiveMesh = true;
  m.doNotSyncBoundingInfo = true;
  return m;
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

const COLS = 4;
const CELL_W = 256;
const CELL_H = 80;

const VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 atlas;
uniform mat4 viewProjection;
uniform vec3 camPos;
varying vec2 vUV;
varying vec2 vCell;
varying float vLod;
void main() {
  mat4 w = mat4(world0, world1, world2, world3);
  vec3 c = w[3].xyz;
  float sx = length(w[0].xyz);
  float sy = length(w[1].xyz);
  vec3 toCam = camPos - c;
  toCam.y = 0.0;
  float l = length(toCam);
  toCam = l > 1e-4 ? toCam / l : vec3(0.0, 0.0, -1.0);
  vec3 right = vec3(-toCam.z, 0.0, toCam.x);
  vec3 p = c + right * position.x * sx + vec3(0.0, 1.0, 0.0) * position.y * sy;
  gl_Position = viewProjection * vec4(p, 1.0);
  vUV = uv;
  vCell = atlas.xy;
  vLod = atlas.z;
}`;

const FRAG = `
precision highp float;
uniform sampler2D atlasTex;
uniform vec2 grid;
varying vec2 vUV;
varying vec2 vCell;
varying float vLod;
void main() {
  vec2 uv = vec2(clamp(vUV.x, 0.004, 0.996), vUV.y);
  if (vLod < 1.5) uv.y = 0.46 + uv.y * 0.54;
  uv.y = clamp(uv.y, 0.006, 0.994);
  vec2 t = vec2((vCell.x + uv.x) / grid.x, 1.0 - (vCell.y + 1.0 - uv.y) / grid.y);
  vec4 c = texture2D(atlasTex, t);
  if (c.a < 0.02) discard;
  gl_FragColor = vec4(c.rgb, c.a);
}`;

function drawRobot(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#3b82f6";
  roundRect(ctx, 0, 8, 34, 26, 6);
  ctx.fill();
  ctx.fillStyle = "#0b1220";
  roundRect(ctx, 5, 14, 24, 12, 4);
  ctx.fill();
  ctx.fillStyle = "#7dd3fc";
  ctx.fillRect(10, 18, 5, 5);
  ctx.fillRect(20, 18, 5, 5);
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(15.5, 1, 3, 8);
  ctx.beginPath();
  ctx.arc(17, 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-3, 16, 3, 10);
  ctx.fillRect(34, 16, 3, 10);
  ctx.restore();
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  slot: number,
  r: ResolvedPiece,
): void {
  const ox = (slot % COLS) * CELL_W;
  const oy = Math.floor(slot / COLS) * CELL_H;
  ctx.clearRect(ox, oy, CELL_W, CELL_H);
  const { num, title } = splitTag(r.tag);
  const { sans } = screenFonts();
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = "rgba(9,14,24,0.94)";
  roundRect(ctx, 3, 3, CELL_W - 6, CELL_H - 6, 10);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(148,163,184,0.45)";
  ctx.stroke();
  ctx.fillStyle = r.color;
  roundRect(ctx, 3, 3, 8, CELL_H - 6, 4);
  ctx.fill();
  ctx.fillStyle = r.accent;
  ctx.fillRect(18, CELL_H - 9, CELL_W - 36, 3);
  let x = 22;
  if (r.bot) {
    drawRobot(ctx, 22, 4);
    x = 66;
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f8fafc";
  ctx.font = `700 34px ${sans}`;
  ctx.fillText(fitText(ctx, num, CELL_W - x - 14), x, 38);
  ctx.fillStyle = "#cbd5e1";
  ctx.font = `500 17px ${sans}`;
  if (title) ctx.fillText(fitText(ctx, title, CELL_W - 36), 22, 62);
  ctx.restore();
}

function ghostTexture(scene: Scene): DynamicTexture {
  const t = new DynamicTexture(
    "wpGhostTex",
    { width: 64, height: 64 },
    scene,
    true,
  );
  t.hasAlpha = true;
  const ctx = t.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, 59, 59);
  t.update(true);
  return t;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class Workpieces {
  private readonly scene: Scene;
  private readonly beltHeight: number;
  private readonly maxTags: number;
  private readonly pallet: Mesh;
  private readonly bodies: Mesh[];
  private readonly band: Mesh;
  private readonly ghost: Mesh;
  private readonly tag: Mesh;
  private readonly tagMat: ShaderMaterial;
  private readonly atlas: DynamicTexture;
  private readonly mats: (PBRMaterial | StandardMaterial)[] = [];
  private readonly ghostTex: DynamicTexture;
  private readonly obs: Observer<Scene>;

  private queue: Vec3[] = [];
  private lastInput: PieceInstance[] = [];
  private resolved: ResolvedPiece[] = [];
  private sigs = new Map<string, string>();
  private packed: Packed | undefined;
  private slotOf = new Map<string, number>();
  private slotKey: string[];
  private freeSlots: number[] = [];
  private lods = new Uint8Array(0);
  private tagCount = 0;
  private tagM = new Float32Array(0);
  private tagA = new Float32Array(0);
  private writes = 0;
  private draws = 0;
  private disposed = false;

  constructor(scene: Scene, opts: WorkpiecesOptions = {}) {
    this.scene = scene;
    this.beltHeight = opts.beltHeight ?? BELT_HEIGHT;
    this.maxTags = Math.max(8, opts.maxTags ?? 64);
    this.slotKey = new Array<string>(this.maxTags).fill("");
    for (let i = this.maxTags - 1; i >= 0; i--) this.freeSlots.push(i);

    const body = new PBRMaterial("wpBody", scene);
    body.albedoColor = Color3.White();
    body.metallic = 0.55;
    body.roughness = 0.42;
    const palletMat = new PBRMaterial("wpPallet", scene);
    palletMat.albedoColor = new Color3(0.16, 0.18, 0.21);
    palletMat.metallic = 0.5;
    palletMat.roughness = 0.5;
    const bandMat = new StandardMaterial("wpBand", scene);
    bandMat.disableLighting = true;
    bandMat.emissiveColor = new Color3(0.8, 0.8, 0.8);
    bandMat.diffuseColor = Color3.Black();
    bandMat.specularColor = Color3.Black();
    this.ghostTex = ghostTexture(scene);
    const ghostMat = new StandardMaterial("wpGhost", scene);
    ghostMat.disableLighting = true;
    ghostMat.emissiveColor = new Color3(0.9, 0.9, 0.9);
    ghostMat.diffuseTexture = this.ghostTex;
    ghostMat.useAlphaFromDiffuseTexture = true;
    ghostMat.backFaceCulling = false;
    ghostMat.disableDepthWrite = true;
    ghostMat.alpha = 0.85;
    this.mats.push(body, palletMat, bandMat, ghostMat);

    this.pallet = build("wpPallet", scene, palletParts());
    this.pallet.material = palletMat;
    this.bodies = [0, 1, 2, 3].map((v) => {
      const m = build(`wpBody${v}`, scene, bodyParts(v));
      m.material = body;
      return m;
    });
    this.band = build("wpBand", scene, bandParts());
    this.band.material = bandMat;
    this.ghost = CreateBox("wpGhost", { size: 1 }, scene);
    this.ghost.material = ghostMat;
    this.ghost.isPickable = false;
    this.ghost.alwaysSelectAsActiveMesh = true;
    this.ghost.doNotSyncBoundingInfo = true;

    const rows = Math.ceil(this.maxTags / COLS);
    this.atlas = new DynamicTexture(
      "wpAtlas",
      { width: COLS * CELL_W, height: rows * CELL_H },
      scene,
      false,
    );
    this.atlas.hasAlpha = true;
    this.atlas.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
    this.atlas.wrapU = this.atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.tagMat = new ShaderMaterial(
      "wpTagMat",
      scene,
      { vertexSource: VERT, fragmentSource: FRAG },
      {
        attributes: ["position", "uv", "atlas"],
        uniforms: ["viewProjection", "camPos", "grid"],
        samplers: ["atlasTex"],
        needAlphaBlending: true,
      },
    );
    this.tagMat.setTexture("atlasTex", this.atlas);
    this.tagMat.setVector2("grid", new Vector2(COLS, rows));
    this.tagMat.backFaceCulling = false;
    this.tagMat.alphaMode = Constants.ALPHA_COMBINE;
    this.tagMat.forceDepthWrite = false;
    this.tag = plateMesh(scene);
    this.tag.material = this.tagMat;
    this.tag.renderingGroupId = 0;

    for (const m of [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
      this.tag,
    ]) {
      m.setEnabled(false);
    }
    this.uploadEmpty();

    whenFontsReady(() => {
      if (this.disposed) return;
      this.slotKey.fill("");
      this.drawTags();
    });
    this.obs = scene.onBeforeRenderObservable.add(() => this.updateLod());
  }

  /** Staging rack slots (floor/rack surface points); pieces with `queueSlot` use them. */
  setQueue(points: Vec3[]): void {
    this.queue = points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    this.set(this.lastInput);
  }

  /** Replace the full piece set. A no-op (no buffer writes) when nothing changed. */
  set(pieces: PieceInstance[]): void {
    this.lastInput = pieces;
    const resolved = pieces.map((p) =>
      resolvePiece(p, this.queue, this.beltHeight),
    );
    const sigs = new Map<string, string>();
    for (const r of resolved) sigs.set(r.id, pieceSignature(r));
    if (!signaturesChanged(this.sigs, sigs)) return;
    this.sigs = sigs;
    // Keep the LOD of pieces that stay (tag hysteresis, slot ownership).
    const prevLod = new Map<string, number>();
    this.resolved.forEach((r, i) => prevLod.set(r.id, this.lods[i] ?? 0));
    this.resolved = resolved;
    this.upload(resolved);
    this.syncSlots(resolved);
    this.drawTags(); // text / look changes of pieces holding a cell
    this.lods = new Uint8Array(resolved.length);
    resolved.forEach((r, i) => (this.lods[i] = prevLod.get(r.id) ?? 0));
    this.updateLod(undefined, true);
  }

  /**
   * Moving-pieces fast path: the same pieces (ids, order, looks) as the last
   * `set`, new lane poses (path frame; the belt height is added). Writes the
   * matrices into the existing arrays and flags the existing GPU buffers — no
   * new buffers, no signature strings, no allocation. Returns false when the
   * piece count does not match (call `set`).
   */
  move(poses: readonly Placed[]): boolean {
    const rs = this.resolved;
    const pk = this.packed;
    if (!pk || poses.length !== rs.length || this.disposed) return false;
    const h = this.beltHeight;
    for (let i = 0; i < rs.length; i++) {
      const p = poses[i];
      const q = rs[i].placed;
      q.x = p.x;
      q.y = p.y + h;
      q.z = p.z;
      q.yaw = p.yaw;
    }
    writePackedMatrices(rs, pk);
    for (const m of this.poolMeshes)
      if (m.thinInstanceCount > 0) {
        m.thinInstanceBufferUpdated("matrix");
        this.updates++;
      }
    // Signatures are now stale: the next `set` rewrites everything.
    this.sigs = new Map();
    this.updateLod(undefined, false, true);
    return true;
  }

  stats(): WorkpieceStats {
    return {
      pieces: this.resolved.length,
      draws: this.draws,
      bufferWrites: this.writes,
      bufferUpdates: this.updates,
      textDraws: this.textDraws,
      tagsVisible: this.tagCount,
    };
  }

  /**
   * Camera-distance LOD; also runs every frame via the scene (cheap, no
   * writes unless the visible set changes). Atlas cells are assigned to
   * pieces entering tag range (a cell keeps its text after the piece leaves,
   * so coming back costs nothing unless another piece took it). `moved`:
   * the pieces moved, visible plates must follow.
   */
  updateLod(cam?: Vec3, force = false, moved = false): void {
    if (this.disposed) return;
    const c = cam ?? this.scene.activeCamera?.globalPosition;
    if (!c) return;
    this.camV.set(c.x, c.y, c.z);
    this.tagMat.setVector3("camPos", this.camV);
    const rs = this.resolved;
    if (this.lods.length !== rs.length) this.lods = new Uint8Array(rs.length);
    let changed = force;
    let cells = false;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      let lod = 0;
      if (r.tag !== "") {
        const p = r.placed;
        lod = tagLod(
          Math.hypot(p.x - c.x, p.y + 0.7 - c.y, p.z - c.z),
          this.lods[i],
        );
        if (lod > 0 && !this.slotOf.has(r.id)) {
          if (this.acquireSlot(r.id)) cells = true;
          else lod = 0; // atlas full of nearer tags
        }
      }
      if (lod !== this.lods[i]) {
        this.lods[i] = lod;
        changed = true;
      }
    }
    if (cells) this.drawTags();
    if (changed) this.uploadTags();
    else if (moved && this.tagCount > 0) {
      this.writeTags();
      this.tag.thinInstanceBufferUpdated("matrix");
      this.updates++;
    }
  }

  /** A cell for `id`: a free one, else one held by a piece out of range. */
  private acquireSlot(id: string): boolean {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      const rs = this.resolved;
      for (let i = 0; i < rs.length && slot === undefined; i++) {
        if (this.lods[i] > 0) continue;
        const s = this.slotOf.get(rs[i].id);
        if (s === undefined) continue;
        this.slotOf.delete(rs[i].id);
        slot = s;
      }
    }
    if (slot === undefined) return false;
    this.slotOf.set(id, slot);
    return true;
  }

  /**
   * Thin-instance picking: F on a pallet / body / status band resolves the
   * piece id through `fn` (null = not interactable); `null` turns it off.
   * Instance order mirrors `packPieces` (pallet / band = input order, bodies
   * = pieces of that variant, drafts excluded). The pool meshes keep their
   * base geometry's bounds (no per-frame sync), which Babylon tests before
   * any instance: `bounds` (world AABB of where pieces can be) makes them
   * pickable.
   */
  setPicker(
    fn: ((id: string) => InteractionTarget | null) | null,
    bounds?: { min: Vector3; max: Vector3 },
  ): void {
    const parts: [Mesh, (i: number) => string | undefined][] = [
      [this.pallet, (i) => this.resolved[i]?.id],
      [this.band, (i) => this.resolved[i]?.id],
      ...this.bodies.map((m, v): [Mesh, (i: number) => string | undefined] => [
        m,
        (i) => this.nthId((r) => !r.draft && r.variant === v, i),
      ]),
    ];
    for (const [mesh, idAt] of parts) {
      if (!fn) {
        unregisterThinResolver(mesh);
        mesh.isPickable = false;
        continue;
      }
      if (bounds)
        mesh.setBoundingInfo(new BoundingInfo(bounds.min, bounds.max));
      registerThinResolver(mesh, (_m, i) => {
        const id = idAt(i);
        return id ? fn(id) : null;
      });
    }
  }

  private nthId(
    pred: (r: ResolvedPiece) => boolean,
    n: number,
  ): string | undefined {
    let k = 0;
    for (const r of this.resolved)
      if (pred(r)) {
        if (k === n) return r.id;
        k++;
      }
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.scene.onBeforeRenderObservable.remove(this.obs);
    for (const m of [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
      this.tag,
    ]) {
      m.dispose(false, false);
    }
    for (const m of this.mats) m.dispose();
    this.tagMat.dispose();
    this.atlas.dispose();
    this.ghostTex.dispose();
  }

  // -- internals ------------------------------------------------------------

  private textDraws = 0;
  private updates = 0;
  private readonly camV = new Vector3();

  private get poolMeshes(): Mesh[] {
    return (this.poolList ??= [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
    ]);
  }
  private poolList: Mesh[] | null = null;

  private setBuf(
    mesh: Mesh,
    kind: string,
    data: Float32Array,
    stride: number,
  ): void {
    mesh.thinInstanceSetBuffer(kind, data, stride, false);
    this.writes++;
  }

  private uploadEmpty(): void {
    const e = new Float32Array(16);
    for (const m of [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
      this.tag,
    ]) {
      m.thinInstanceSetBuffer("matrix", e, 16, false);
    }
    this.tag.thinInstanceSetBuffer("atlas", new Float32Array(4), 4, false);
    for (const m of [...this.bodies, this.band, this.ghost]) {
      m.thinInstanceSetBuffer("color", new Float32Array(4), 4, false);
    }
    for (const m of [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
      this.tag,
    ]) {
      m.thinInstanceCount = 0;
    }
  }

  private upload(rs: ResolvedPiece[]): void {
    const pk = packPieces(rs, this.packed);
    this.packed = pk;
    const set = (
      mesh: Mesh,
      count: number,
      m: Float32Array,
      c?: Float32Array,
    ) => {
      if (count > 0) {
        this.setBuf(mesh, "matrix", m, 16);
        if (c) this.setBuf(mesh, "color", c, 4);
      }
      mesh.thinInstanceCount = count;
      mesh.setEnabled(count > 0);
    };
    set(this.pallet, pk.count, pk.pallet);
    pk.bodies.forEach((b, i) => set(this.bodies[i], b.count, b.m, b.c));
    set(this.band, pk.band.count, pk.band.m, pk.band.c);
    set(this.ghost, pk.ghost.count, pk.ghost.m, pk.ghost.c);
    this.draws = [this.pallet, ...this.bodies, this.band, this.ghost].filter(
      (m) => m.isEnabled(false),
    ).length;
  }

  /** Release the cells of pieces that left (or lost their tag). */
  private syncSlots(rs: ResolvedPiece[]): void {
    const live = new Set<string>();
    for (const r of rs) if (r.tag !== "") live.add(r.id);
    for (const [id, slot] of this.slotOf) {
      if (live.has(id)) continue;
      this.slotOf.delete(id);
      this.freeSlots.push(slot);
    }
  }

  /** Draw only atlas cells whose text / look changed; one texture upload per batch. */
  private drawTags(): void {
    const ctx = this.atlas.getContext() as unknown as CanvasRenderingContext2D;
    let dirty = false;
    for (const r of this.resolved) {
      const slot = this.slotOf.get(r.id);
      if (slot === undefined || this.slotKey[slot] === r.tagKey) continue;
      drawCell(ctx, slot, r);
      this.slotKey[slot] = r.tagKey;
      this.textDraws++;
      dirty = true;
    }
    if (dirty) this.atlas.update(true);
  }

  /** Plate matrices + atlas cells of the visible tags (in place). */
  private writeTags(): number {
    const rs = this.resolved;
    let n = 0;
    for (let i = 0; i < rs.length; i++) if (this.lods[i] > 0) n++;
    if (this.tagM.length < n * 16) {
      this.tagM = new Float32Array(Math.max(n * 16, 256));
      this.tagA = new Float32Array(Math.max(n * 4, 64));
    }
    let k = 0;
    for (let i = 0; i < rs.length; i++) {
      const lod = this.lods[i];
      if (lod === 0) continue;
      const r = rs[i];
      const p = r.placed;
      const top = p.y + PALLET_TOP + BODY_DIMS[r.variant].h + 0.28;
      writeMatrix(
        this.tagM,
        k * 16,
        p.x,
        top,
        p.z,
        0,
        1,
        lod === 2 ? 1 : 0.55,
        1,
      );
      const slot = this.slotOf.get(r.id) ?? 0;
      const o = k * 4;
      this.tagA[o] = slot % COLS;
      this.tagA[o + 1] = Math.floor(slot / COLS);
      this.tagA[o + 2] = lod;
      this.tagA[o + 3] = 0;
      k++;
    }
    return n;
  }

  private uploadTags(): void {
    const n = this.writeTags();
    this.tagCount = n;
    if (n > 0) {
      this.setBuf(this.tag, "matrix", this.tagM, 16);
      this.setBuf(this.tag, "atlas", this.tagA, 4);
    }
    this.tag.thinInstanceCount = n;
    this.tag.setEnabled(n > 0);
    this.draws = [
      this.pallet,
      ...this.bodies,
      this.band,
      this.ghost,
      this.tag,
    ].filter((m) => m.isEnabled(false)).length;
  }
}
