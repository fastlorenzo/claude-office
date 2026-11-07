/**
 * Realistic glTF character rig (Microsoft Rocketbox avatars, MIT) — see
 * engine/assets/characters.ts for the cast and clip manifest.
 *
 * - Each avatar GLB loads once per scene into an AssetContainer and is cloned
 *   per actor with instantiateModelsToScene({ doNotInstantiate: true }) so
 *   every actor owns its skeleton.
 * - The shared animation GLB per gender (same 3ds Max Biped skeleton) loads
 *   once; per actor each template clip is retargeted onto the clone by node
 *   name and SPLIT into an upper-body layer (clavicles, arms, neck, head) and a
 *   lower-body layer (root, pelvis, spine, legs). A pose picks one clip per
 *   layer, so seated poses can borrow standing gestures: raiseHand = sitIdle
 *   legs/spine + raiseHand arms; celebrating = sitIdle + cheer arms.
 * - Layers cross-fade independently with weights. Seated clips lower the model
 *   so the pelvis lands on the chair (CHARACTER_SIT_PELVIS_HEIGHT).
 * - Tint: a lanyard + badge in the agent colour (Rocketbox outfits share one
 *   texture atlas, so clothes are not recoloured).
 * - Until the files are loaded (or when they 404) a procedural MannequinRig is
 *   shown; the rig swaps to the avatar once ready (meshesChanged hook).
 */

import {
  AbstractMesh,
  AnimationGroup,
  AssetContainer,
  Color3,
  CreateBox,
  LoadAssetContainerAsync,
  Mesh,
  Node,
  Scene,
  StandardMaterial,
  TransformNode,
  type Material,
} from "../babylon";
import type { CharacterPose } from "../contracts";
import {
  BOSS_AVATAR_ID,
  CHARACTER_ANIMATIONS,
  CHARACTER_ASSET_DIR,
  CHARACTER_AVATARS,
  CHARACTER_FACING_YAW_OFFSET,
  CHARACTER_ONE_SHOT_CLIPS,
  CHARACTER_SIT_PELVIS_HEIGHT,
  CHARACTER_WALK_SPEED,
  pickAvatar,
  type CharacterAvatar,
  type CharacterClip,
} from "../assets/characters";
import { MannequinRig, type MannequinOptions } from "./MannequinRig";
import {
  isUpperBodyBone,
  POSE_LAYERS,
  SEATED_CLIPS,
  type AnyClip,
} from "./gltfLayers";
import { CLAUDE_ORANGE } from "./identity";
import { SEAT_HEIGHT } from "./poses";
import type { CharacterRig, Lod } from "./types";

type Layer = "upper" | "lower";

const HEAD_BONE = "Bip01 Head";
const BADGE_BONE = "Bip01 Spine2";

// ---------------------------------------------------------------------------
// Per-scene registry + loading
// ---------------------------------------------------------------------------

interface PackState {
  avatars: Map<string, Promise<AssetContainer | null>>;
  anims: Map<"m" | "f", Promise<AssetContainer | null>>;
}

const packs = new WeakMap<Scene, PackState>();

function loadContainer(
  scene: Scene,
  url: string,
): Promise<AssetContainer | null> {
  return LoadAssetContainerAsync(url, scene).then(
    (c) => c,
    (err: unknown) => {
      console.warn(
        `[characters] failed to load ${url}; using the mannequin`,
        err,
      );
      return null;
    },
  );
}

function avatarContainer(
  scene: Scene,
  st: PackState,
  a: CharacterAvatar,
): Promise<AssetContainer | null> {
  let p = st.avatars.get(a.id);
  if (!p) {
    p = loadContainer(scene, `${CHARACTER_ASSET_DIR}/${a.file}`);
    st.avatars.set(a.id, p);
  }
  return p;
}

function animContainer(
  scene: Scene,
  st: PackState,
  g: "m" | "f",
): Promise<AssetContainer | null> {
  let p = st.anims.get(g);
  if (!p) {
    p = loadContainer(
      scene,
      `${CHARACTER_ASSET_DIR}/${CHARACTER_ANIMATIONS[g].file}`,
    ).then((c) => {
      for (const ag of c?.animationGroups ?? []) ag.stop();
      return c;
    });
    st.anims.set(g, p);
  }
  return p;
}

/**
 * Opt a scene into realistic characters: registers the pack and starts
 * loading both animation libraries + the boss avatar. Actors created after
 * this call use GltfRig (mannequin until their avatar is loaded). Resolves
 * true when the animation libraries loaded.
 */
export async function preloadCharacterPack(scene: Scene): Promise<boolean> {
  let st = packs.get(scene);
  if (!st) {
    st = { avatars: new Map(), anims: new Map() };
    packs.set(scene, st);
  }
  const boss = CHARACTER_AVATARS.find((a) => a.id === BOSS_AVATAR_ID);
  const [m, f] = await Promise.all([
    animContainer(scene, st, "m"),
    animContainer(scene, st, "f"),
    boss ? avatarContainer(scene, st, boss) : Promise.resolve(null),
  ]);
  return !!m && !!f;
}

/** A GltfRig when the scene opted in via preloadCharacterPack, else null. */
export function tryCreateGltfRig(
  scene: Scene,
  opts: MannequinOptions,
): CharacterRig | null {
  const st = packs.get(scene);
  return st ? new GltfRig(scene, st, opts) : null;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const badgeMaterials = new WeakMap<Scene, Map<string, Material>>();

interface LayerClip {
  group: AnimationGroup;
  weight: number;
}

export class GltfRig implements CharacterRig {
  readonly root: TransformNode;
  readonly headAnchor: TransformNode;
  /** Set by the actor: called when the visible meshes change (fallback swap). */
  meshesChanged: ((meshes: AbstractMesh[]) => void) | null = null;
  private readonly scene: Scene;
  private readonly opts: MannequinOptions;
  private readonly avatar: CharacterAvatar;
  private fallback: MannequinRig | null;
  private model: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private headNode: TransformNode | null = null;
  private readonly layers: Record<Layer, Map<AnyClip, LayerClip>> = {
    upper: new Map(),
    lower: new Map(),
  };
  private extras: AbstractMesh[] = [];
  private pose: CharacterPose = "idle";
  private blend = 0.35;
  private speed = 0;
  private tint: string;
  private sitOffset = 0;
  private paused = false;
  private disposed = false;

  constructor(scene: Scene, st: PackState, opts: MannequinOptions) {
    this.scene = scene;
    this.opts = opts;
    this.tint = opts.boss ? CLAUDE_ORANGE : opts.color;
    this.avatar = opts.boss
      ? (CHARACTER_AVATARS.find((a) => a.id === BOSS_AVATAR_ID) ??
        pickAvatar(opts.id))
      : pickAvatar(
          opts.id,
          CHARACTER_AVATARS.filter((a) => a.id !== BOSS_AVATAR_ID),
        );
    this.root = new TransformNode(`gchar_${opts.id}`, scene);
    this.headAnchor = new TransformNode(`gcharHead_${opts.id}`, scene);
    this.fallback = new MannequinRig(scene, opts);
    this.fallback.root.parent = this.root;
    this.headAnchor.parent = this.fallback.headAnchor;

    void Promise.all([
      avatarContainer(scene, st, this.avatar),
      animContainer(scene, st, this.avatar.gender),
    ]).then(([avatar, anims]) => {
      if (this.disposed || !avatar || !anims) return;
      try {
        this.build(avatar, anims);
      } catch (err) {
        console.warn(
          "[characters] avatar build failed; keeping the mannequin",
          err,
        );
      }
    });
  }

  setPose(pose: CharacterPose, blendSec = 0.35): void {
    this.fallback?.setPose(pose, blendSec);
    if (pose === this.pose && blendSec !== 0) return;
    this.pose = pose;
    this.blend = Math.max(0.01, blendSec);
    // One-shot gestures restart when re-entered.
    const [, upper] = POSE_LAYERS[pose];
    const u = this.layers.upper.get(upper);
    if (u && CHARACTER_ONE_SHOT_CLIPS.has(upper as CharacterClip))
      this.playOnce(u.group, upper);
    if (blendSec === 0) this.updateWeights(0, true);
  }

  setMoving(speed: number): void {
    this.speed = speed;
    this.fallback?.setMoving(speed);
    const ratio =
      speed > 0.05
        ? Math.min(
            1.8,
            Math.max(0.5, speed / CHARACTER_WALK_SPEED[this.avatar.gender]),
          )
        : 1;
    for (const layer of ["upper", "lower"] as const) {
      const w = this.layers[layer].get("walk");
      if (w) w.group.speedRatio = ratio;
    }
  }

  setTint(hex: string): void {
    this.fallback?.setTint(hex);
    const next = this.opts.boss ? CLAUDE_ORANGE : hex;
    if (next === this.tint) return;
    this.tint = next;
    const mat = this.badgeMaterial();
    for (const m of this.extras) m.material = mat;
  }

  update(dt: number, lod: Lod): void {
    if (this.disposed) return;
    if (this.fallback) {
      this.fallback.update(dt, lod);
      return;
    }
    const freeze = lod === "far";
    if (freeze !== this.paused) {
      this.paused = freeze;
      for (const layer of Object.values(this.layers)) {
        for (const c of layer.values()) {
          if (freeze) c.group.pause();
          else if (c.weight > 0) c.group.play(c.group.loopAnimation);
        }
      }
    }
    if (!freeze) this.updateWeights(dt, false);
    if (this.headNode) {
      this.headNode.computeWorldMatrix(true);
      const p = this.headNode.getAbsolutePosition();
      this.headAnchor.position.set(p.x, p.y + 0.3, p.z);
    }
  }

  getMeshes(): AbstractMesh[] {
    return this.fallback
      ? this.fallback.getMeshes()
      : [...this.meshes, ...this.extras];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fallback?.dispose();
    for (const layer of Object.values(this.layers)) {
      for (const c of layer.values()) c.group.dispose();
      layer.clear();
    }
    for (const m of this.extras) m.dispose();
    this.model?.dispose(false, false);
    this.headAnchor.dispose();
    this.root.dispose();
  }

  // -------------------------------------------------------------------------

  private build(avatar: AssetContainer, anims: AssetContainer): void {
    const suffix = `__${this.opts.id}`;
    const entries = avatar.instantiateModelsToScene((n) => n + suffix, false, {
      doNotInstantiate: true,
    });
    const model = new TransformNode(`gcharModel_${this.opts.id}`, this.scene);
    model.parent = this.root;
    model.rotation.y = CHARACTER_FACING_YAW_OFFSET;
    this.model = model;
    for (const n of entries.rootNodes) n.parent = model;
    for (const g of entries.animationGroups) g.dispose(); // avatar-embedded clips unused

    const byName = new Map<string, Node>();
    const all: Node[] = [];
    for (const r of entries.rootNodes) {
      for (const n of [r, ...r.getDescendants(false)]) {
        const base = n.name.endsWith(suffix)
          ? n.name.slice(0, -suffix.length)
          : n.name;
        if (!byName.has(base)) byName.set(base, n);
        all.push(n);
      }
    }
    this.meshes = all.filter(
      (n): n is AbstractMesh =>
        n instanceof AbstractMesh && n.getTotalVertices() > 0,
    );
    for (const m of this.meshes) {
      m.receiveShadows = true;
      m.isPickable = false;
    }
    const head = byName.get(HEAD_BONE);
    this.headNode = head instanceof TransformNode ? head : null;

    // Retarget + split every clip we may use into upper / lower layers.
    const set = CHARACTER_ANIMATIONS[this.avatar.gender];
    const names: Partial<Record<AnyClip, string>> = {
      ...set.clips,
      ...set.extraClips,
    };
    const wanted = new Set<AnyClip>(Object.values(POSE_LAYERS).flat());
    for (const clip of wanted) {
      const tpl = anims.animationGroups.find((g) => g.name === names[clip]);
      if (!tpl) continue;
      for (const layer of ["upper", "lower"] as const) {
        const g = new AnimationGroup(
          `${tpl.name}_${layer}${suffix}`,
          this.scene,
        );
        for (const ta of tpl.targetedAnimations) {
          const srcName = (ta.target as { name?: string }).name ?? "";
          if (isUpperBodyBone(srcName) !== (layer === "upper")) continue;
          const target = byName.get(srcName);
          if (target) g.addTargetedAnimation(ta.animation, target);
        }
        if (g.targetedAnimations.length === 0) {
          g.dispose();
          continue;
        }
        g.normalize(tpl.from, tpl.to);
        g.loopAnimation = !CHARACTER_ONE_SHOT_CLIPS.has(clip as CharacterClip);
        g.weight = 0;
        this.layers[layer].set(clip, { group: g, weight: 0 });
      }
    }

    // Bind-pose world matrices for badge placement.
    for (const n of [model, ...model.getDescendants(false)]) {
      if (n instanceof TransformNode) n.computeWorldMatrix(true);
    }
    this.buildBadge(byName.get(BADGE_BONE));

    // Swap out the fallback mannequin.
    const fb = this.fallback;
    this.fallback = null;
    if (fb) {
      this.headAnchor.parent = null;
      fb.dispose();
    }
    this.setPose(this.pose, 0);
    this.meshesChanged?.(this.getMeshes());
  }

  private playOnce(g: AnimationGroup, clip: AnyClip): void {
    g.stop();
    g.loopAnimation = false;
    g.start(false, 1, g.from, g.to);
    g.onAnimationGroupEndObservable.addOnce(() => {
      if (this.disposed) return;
      // Hold the final frame while the pose stays active.
      if (POSE_LAYERS[this.pose][1] === clip)
        g.start(true, 1, Math.max(g.from, g.to - 1), g.to);
    });
  }

  private targets(): Record<Layer, AnyClip> {
    if (this.speed > 0.05) return { lower: "walk", upper: "walk" };
    const [lower, upper] = POSE_LAYERS[this.pose];
    return { lower, upper };
  }

  private updateWeights(dt: number, snap: boolean): void {
    const tgt = this.targets();
    const step = snap ? 1 : dt / this.blend;
    for (const layer of ["upper", "lower"] as const) {
      let want: AnyClip = tgt[layer];
      if (!this.layers[layer].has(want))
        want = SEATED_CLIPS.has(tgt.lower) ? "sitIdle" : "idle";
      for (const [clip, c] of this.layers[layer]) {
        const goal = clip === want ? 1 : 0;
        const next =
          goal > c.weight
            ? Math.min(goal, c.weight + step)
            : Math.max(goal, c.weight - step);
        if (next === c.weight && !(goal > 0 && !c.group.isPlaying)) continue;
        c.weight = next;
        c.group.weight = next;
        if (next > 0 && !c.group.isPlaying) {
          if (c.group.loopAnimation) c.group.play(true);
          else this.playOnce(c.group, clip);
        } else if (next === 0 && c.group.isPlaying) {
          c.group.pause();
        }
      }
    }
    // Lower the model while the legs play a seated clip.
    const seated = SEATED_CLIPS.has(tgt.lower) && this.speed <= 0.05;
    const goal = seated
      ? SEAT_HEIGHT + 0.08 - CHARACTER_SIT_PELVIS_HEIGHT[this.avatar.gender]
      : 0;
    this.sitOffset = snap
      ? goal
      : this.sitOffset + (goal - this.sitOffset) * Math.min(1, step);
    if (this.model) this.model.position.y = this.sitOffset;
  }

  private buildBadge(parent: Node | undefined): void {
    if (!(parent instanceof TransformNode) || !this.model) return;
    const H = this.avatar.heightM;
    // Model-space points in the bind pose (feet at 0, facing +Z).
    const chestZ = this.avatar.gender === "f" ? 0.165 : 0.16;
    const top = { x: 0.0, y: H * 0.69, z: chestZ + 0.008 };
    const parts: Mesh[] = [];
    const badge = CreateBox(
      `gcharBadge_${this.opts.id}`,
      { width: 0.062, height: 0.088, depth: 0.006 },
      this.scene,
    );
    badge.parent = this.model;
    badge.position.set(top.x, top.y - 0.046, top.z + 0.002);
    badge.rotation.x = -0.12;
    parts.push(badge);
    for (const side of [-1, 1]) {
      const a = { x: side * 0.062, y: H * 0.815, z: 0.05 };
      const d = {
        x: top.x + side * 0.012 - a.x,
        y: top.y - a.y,
        z: top.z - a.z,
      };
      const len = Math.hypot(d.x, d.y, d.z);
      const strap = CreateBox(
        `gcharStrap_${this.opts.id}_${side}`,
        { width: 0.009, height: len, depth: 0.003 },
        this.scene,
      );
      strap.parent = this.model;
      strap.position.set(a.x + d.x / 2, a.y + d.y / 2, a.z + d.z / 2);
      // Align the box's +Y with the segment (rotation order Z, X, Y).
      strap.rotation.set(Math.acos(d.y / len), Math.atan2(d.x, d.z), 0);
      parts.push(strap);
    }
    for (const p of parts) p.computeWorldMatrix(true);
    const merged = Mesh.MergeMeshes(parts, true, true);
    if (!merged) return;
    merged.name = `gcharLanyard_${this.opts.id}`;
    merged.material = this.badgeMaterial();
    merged.isPickable = false;
    merged.setParent(parent);
    this.extras.push(merged);
  }

  private badgeMaterial(): Material {
    let cache = badgeMaterials.get(this.scene);
    if (!cache) {
      cache = new Map();
      badgeMaterials.set(this.scene, cache);
    }
    let m = cache.get(this.tint);
    if (!m || !this.scene.materials.includes(m)) {
      const sm = new StandardMaterial(`badge_${this.tint}`, this.scene);
      const c = Color3.FromHexString(this.tint);
      sm.diffuseColor = c;
      sm.emissiveColor = c.scale(0.25);
      sm.specularColor = new Color3(0.2, 0.2, 0.2);
      m = sm;
      cache.set(this.tint, m);
    }
    return m;
  }
}
