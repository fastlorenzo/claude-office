/**
 * Per-scene registry of character actors. Every frame it assigns each actor a
 * LOD tier from its distance to the eye (see lod.ts), toggles the skinned
 * meshes / shadow casting accordingly and maintains thin-instanced meshes
 * shared by ALL characters:
 *   - impostors  low-poly capsule (tinted torso, dark legs) + skin-tone head
 *                for tier "far" (two thin-instanced parts, one matrix buffer)
 *   - blobs      contact-shadow discs for visible characters that do not cast
 *                a real shadow
 * so a whole crowd costs three draw calls instead of 3-5 per person.
 */

import {
  CreateCapsule,
  CreateDisc,
  CreateSphere,
  Mesh,
  Scene,
  StandardMaterial,
  Color3,
  VertexData,
  Vector3,
  type AbstractMesh,
} from "../babylon";
import {
  characterBudget,
  selectTier,
  type CharacterDetail,
  wantsShadow,
  type ActorTier,
  type RoomDetailLevel,
} from "./lod";

/** What the hub needs from an actor (implemented by CharacterActor). */
export interface HubActor {
  readonly sessionId: string;
  /** World position of the feet. */
  readonly feet: Vector3;
  /** Linear-ish hex colour used for the impostor. */
  readonly tintHex: string;
  readonly seatedNow: boolean;
  /** Meshes that should cast shadows (skinned body + extras). */
  shadowMeshes(): AbstractMesh[];
  /** Apply a tier (enable / disable meshes, pause animation). */
  applyTier(tier: ActorTier): void;
  /** Optional skin tone (#rrggbb) for the impostor head. */
  readonly skinHex?: string;
  /** Smooth opacity 0..1 (spawn / depart fade) for blob + impostor. */
  readonly presence: number;
  readonly isGone: boolean;
}

export interface ShadowSink {
  add(m: AbstractMesh): void;
  remove(m: AbstractMesh): void;
}

interface Slot {
  tier: ActorTier;
  shadow: boolean;
}

const hubs = new WeakMap<Scene, ActorHub>();
const MAX = 128;

function hexToRgb(hex: string): [number, number, number] {
  const c = Color3.FromHexString(/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#6B8FB5");
  // Desaturate a little towards a neutral office grey so far people look like
  // people, not coloured pegs.
  const k = 0.55;
  return [
    c.r * k + 0.35 * (1 - k),
    c.g * k + 0.35 * (1 - k),
    c.b * k + 0.35 * (1 - k),
  ];
}

export class ActorHub {
  private readonly actors = new Map<HubActor, Slot>();
  private readonly detail = new Map<string, RoomDetailLevel>();
  private feedMode = false;
  /** Debug: bypass all LOD (every actor stays a full skinned mesh). */
  bypass = false;
  private budget = characterBudget("high");
  private shadows: ShadowSink | null = null;
  private readonly impostor: Mesh;
  private readonly impHead: Mesh;
  private readonly headCol = new Float32Array(MAX * 4);
  private readonly blob: Mesh;
  private readonly impBuf = new Float32Array(MAX * 16);
  private readonly impCol = new Float32Array(MAX * 4);
  private readonly blobBuf = new Float32Array(MAX * 16);
  private lastEye = new Vector3();

  static get(scene: Scene): ActorHub {
    let h = hubs.get(scene);
    if (!h) {
      h = new ActorHub(scene);
      hubs.set(scene, h);
      scene.onDisposeObservable.addOnce(() => hubs.delete(scene));
    }
    return h;
  }

  private constructor(scene: Scene) {
    // Impostor: capsule body (vertex colours: white torso takes the agent
    // tint, darker legs) + a separate thin-instanced head in a skin tone. Both
    // share the matrix buffer, so a crowd is still one draw call per part.
    const body = CreateCapsule(
      "actorImpostor",
      { height: 1.45, radius: 0.22, tessellation: 8, subdivisions: 2 },
      scene,
    );
    body.position.y = 0.725;
    body.bakeCurrentTransformIntoVertices();
    const bp = body.getVerticesData("position")!;
    const bc = new Float32Array((bp.length / 3) * 4);
    for (let i = 0; i < bp.length / 3; i++) {
      // Hips at ~0.78 m: legs below fade to 35 % of the tint.
      const y = bp[i * 3 + 1];
      const k = 0.35 + 0.65 * Math.min(1, Math.max(0, (y - 0.7) / 0.16));
      bc.set([k, k, k, 1], i * 4);
    }
    body.setVerticesData("color", bc, false);
    const mat = new StandardMaterial("actorImpostorMat", scene);
    mat.diffuseColor = Color3.White();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.1, 0.1, 0.1);
    body.material = mat;
    this.impostor = this.prep(body);
    this.impostor.thinInstanceSetBuffer("matrix", this.impBuf, 16, false);
    this.impostor.thinInstanceSetBuffer("color", this.impCol, 4, false);

    const head = CreateSphere(
      "actorImpostorHead",
      { diameter: 0.24, segments: 6 },
      scene,
    );
    head.position.y = 1.58;
    head.bakeCurrentTransformIntoVertices();
    head.material = mat;
    this.impHead = this.prep(head);
    this.impHead.thinInstanceSetBuffer("matrix", this.impBuf, 16, false);
    this.impHead.thinInstanceSetBuffer("color", this.headCol, 4, false);

    // Blob shadow: flat disc on the floor, soft alpha edge via vertex colours.
    const disc = CreateDisc(
      "actorBlob",
      { radius: 0.5, tessellation: 20 },
      scene,
    );
    disc.rotation.x = Math.PI / 2;
    disc.bakeCurrentTransformIntoVertices();
    const vd = VertexData.ExtractFromMesh(disc);
    const n = vd.positions!.length / 3;
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const r =
        Math.hypot(vd.positions![i * 3], vd.positions![i * 3 + 2]) / 0.5;
      colors.set([0, 0, 0, Math.max(0, 0.42 * (1 - r * r))], i * 4);
    }
    disc.setVerticesData("color", colors, false);
    const bm = new StandardMaterial("actorBlobMat", scene);
    bm.diffuseColor = Color3.Black();
    bm.specularColor = Color3.Black();
    bm.emissiveColor = Color3.Black();
    bm.disableLighting = true;
    bm.zOffset = -2;
    disc.material = bm;
    disc.hasVertexAlpha = true;
    this.blob = this.prep(disc);
    this.blob.thinInstanceSetBuffer("matrix", this.blobBuf, 16, false);
    this.blob.renderingGroupId = 0;
    this.blob.alphaIndex = 5;
  }

  private prep(m: Mesh): Mesh {
    m.isPickable = false;
    m.alwaysSelectAsActiveMesh = true;
    m.doNotSyncBoundingInfo = true;
    m.receiveShadows = false;
    m.thinInstanceCount = 0;
    m.setEnabled(false);
    return m;
  }

  setShadowSink(s: ShadowSink | null): void {
    this.shadows = s;
  }

  add(a: HubActor): void {
    this.actors.set(a, { tier: "near", shadow: false });
  }

  remove(a: HubActor): void {
    const slot = this.actors.get(a);
    if (slot?.shadow && this.shadows)
      for (const m of a.shadowMeshes()) this.shadows.remove(m);
    this.actors.delete(a);
  }

  setRoomDetail(sessionId: string, d: RoomDetailLevel): void {
    this.detail.set(sessionId, d);
  }

  forgetRoom(sessionId: string): void {
    this.detail.delete(sessionId);
  }

  /** Graphics setting: LOD distance bias + skinned-character budget. */
  setDetail(d: CharacterDetail): void {
    this.budget = characterBudget(d);
  }

  /** Feeds need real actors in every room: nobody is impostor / hidden. */
  setFeedMode(on: boolean): void {
    this.feedMode = on;
  }

  /** Counts for debugging / tests. */
  stats(): Record<ActorTier, number> & { shadows: number } {
    const out = { near: 0, mid: 0, far: 0, hidden: 0, shadows: 0 };
    for (const s of this.actors.values()) {
      out[s.tier]++;
      if (s.shadow) out.shadows++;
    }
    return out;
  }

  /** Call once per frame after the rooms have updated. */
  update(eye: Vector3): void {
    this.lastEye.copyFrom(eye);
    if (this.bypass) return;
    let ni = 0;
    let nb = 0;
    const order: { a: HubActor; slot: Slot; dist: number }[] = [];
    for (const [a, slot] of this.actors) {
      const f = a.feet;
      const dist = Math.hypot(eye.x - f.x, eye.y - 1.2 - f.y, eye.z - f.z);
      order.push({ a, slot, dist });
    }
    order.sort((x, y) => x.dist - y.dist);
    let skinned = 0;
    for (const { a, slot, dist } of order) {
      const f = a.feet;
      const detail = this.detail.get(a.sessionId) ?? "full";
      let tier = this.feedMode
        ? "near"
        : selectTier(slot.tier, dist, detail, this.budget.scale);
      // Skinned-character budget: only the nearest N keep their skinned mesh.
      if (!this.feedMode && (tier === "near" || tier === "mid")) {
        if (++skinned > this.budget.maxSkinned) tier = "far";
      }
      if (tier !== slot.tier) {
        slot.tier = tier;
        a.applyTier(tier);
      }
      // Real shadows: only close characters.
      const wantShadow =
        !this.feedMode && tier === "near" && wantsShadow(slot.shadow, dist);
      slot.shadow = wantShadow;
      // Idempotent: also overrides the room's own caster toggling.
      if (this.shadows)
        for (const m of a.shadowMeshes())
          if (wantShadow) this.shadows.add(m);
          else this.shadows.remove(m);
      if (a.isGone || tier === "hidden") continue;
      const p = a.presence;
      // Contact shadow for every visible character without a real one.
      if (!slot.shadow && nb < MAX && p > 0.01) {
        const s = (a.seatedNow ? 0.8 : 1) * (0.6 + 0.4 * p);
        writeMatrix(this.blobBuf, nb++, f.x, f.y + 0.012, f.z, s, 1, s, 0);
      }
      if (tier === "far" && ni < MAX && p > 0.01) {
        const sy = a.seatedNow ? 0.72 : 1;
        writeMatrix(this.impBuf, ni, f.x, f.y, f.z, p, sy * p, p, 0);
        const [r, g, b] = hexToRgb(a.tintHex);
        this.impCol.set([r, g, b, 1], ni * 4);
        const skin = Color3.FromHexString(
          a.skinHex && /^#[0-9a-f]{6}$/i.test(a.skinHex)
            ? a.skinHex
            : "#D9A882",
        );
        this.headCol.set([skin.r, skin.g, skin.b, 1], ni * 4);
        ni++;
      }
    }
    this.flush(this.impostor, this.impBuf, ni, this.impCol);
    this.flush(this.impHead, this.impBuf, ni, this.headCol);
    this.flush(this.blob, this.blobBuf, nb);
  }

  private flush(m: Mesh, buf: Float32Array, n: number, col?: Float32Array) {
    if (n !== m.thinInstanceCount) {
      m.thinInstanceCount = n;
      m.setEnabled(n > 0);
    }
    if (n === 0) return;
    m.thinInstanceBufferUpdated("matrix");
    if (col) m.thinInstanceBufferUpdated("color");
    void buf;
  }
}

function writeMatrix(
  buf: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw: number,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const o = i * 16;
  buf[o] = c * sx;
  buf[o + 1] = 0;
  buf[o + 2] = -s * sx;
  buf[o + 3] = 0;
  buf[o + 4] = 0;
  buf[o + 5] = sy;
  buf[o + 6] = 0;
  buf[o + 7] = 0;
  buf[o + 8] = s * sz;
  buf[o + 9] = 0;
  buf[o + 10] = c * sz;
  buf[o + 11] = 0;
  buf[o + 12] = x;
  buf[o + 13] = y;
  buf[o + 14] = z;
  buf[o + 15] = 1;
}
