/**
 * Realistic glTF character rig, driven by a RigSpec (see characterPacks.ts):
 * Microsoft Rocketbox (MIT), the MPFB2 cast (CC0) or a user's custom pack.
 *
 * - The avatar GLB loads once per scene into an AssetContainer and is cloned
 *   per actor with instantiateModelsToScene({ doNotInstantiate: true }): every
 *   actor owns its meshes AND a cloned skeleton (skinned meshes never share a
 *   pose). Embedded animation groups are not cloned (predicate).
 * - Clip templates (plain {target name, Animation} lists) come from the spec:
 *   Rocketbox = shared per-gender library, MPFB = clips embedded in each GLB,
 *   custom = embedded / shared / borrowed from MPFB via retargeting. Per actor
 *   every template is bound to the clone by node name and SPLIT into an
 *   upper-body layer and a lower-body layer; a pose picks one clip per layer
 *   (raiseHand = sitIdle legs + raiseHand arms) and layers cross-fade
 *   independently with weights.
 * - Seated clips move the model so the pelvis lands on the chair: down by
 *   (seat + clearance - sitPelvisHeight) and forward by sitPelvisBack.
 * - Tint: a lanyard + badge in the agent colour.
 * - The rig has no meshes until `ready` resolves true; CastRig shows the
 *   previous rig / a mannequin meanwhile and swaps when ready.
 *
 * The cast wrapper and pack registry live in CastRig.ts / characterPacks.ts.
 */

import {
  AbstractMesh,
  AnimationGroup,
  AssetContainer,
  Color3,
  CreateBox,
  Mesh,
  Node,
  Scene,
  Skeleton,
  StandardMaterial,
  TransformNode,
  type Animation,
  type Material,
} from "../babylon";
import type { CharacterPose } from "../contracts";
import type { MannequinOptions } from "./MannequinRig";
import type { RigClip } from "./gltfLayers";
import { CLAUDE_ORANGE } from "./identity";
import { SEAT_HEIGHT } from "./poses";
import type { CharacterRig, Lod } from "./types";

type Layer = "upper" | "lower";

/** A clip as plain data: animations keyed by target node (base) name. */
export interface TemplateClip {
  from: number;
  to: number;
  tracks: { target: string; animation: Animation }[];
}

export type ClipTemplates = Map<RigClip, TemplateClip>;

export interface RigSpec {
  /** unique per avatar (cache + "same rig" checks), e.g. "mpfb:office_m01" */
  key: string;
  avatar: Promise<AssetContainer | null>;
  templates: Promise<ClipTemplates | null>;
  heightM: number;
  gender: "m" | "f" | "x";
  /** radians added so the model faces +Z */
  facingYaw: number;
  scale: number;
  headBone: string;
  badgeBone: string | null;
  /** model-space chest depth for the badge (m, bind pose) */
  badgeChestZ: number;
  /** badge-top height as a fraction of heightM (default 0.69) */
  badgeHeightFrac?: number;
  /** pelvis height above the origin in seated clips (m) */
  sitPelvisHeightM: number;
  /** pelvis offset behind the origin in seated clips (m, model -Z) */
  sitPelvisBackM: number;
  /** pelvis clearance above the seat top (m) */
  sitClearanceM: number;
  /** in-place walk speed at speedRatio 1 (m/s) */
  walkSpeedMps: number;
  isUpper(boneName: string): boolean;
  poseLayers: Record<CharacterPose, [RigClip, RigClip]>;
  seatedClips: ReadonlySet<RigClip>;
  oneShot: ReadonlySet<RigClip>;
  /** fallback clips when a pose's clip is missing */
  standFallback: RigClip;
  sitFallback: RigClip;
}

interface LayerClip {
  group: AnimationGroup;
  weight: number;
}

const badgeMaterials = new WeakMap<Scene, Map<string, Material>>();

export class GltfRig implements CharacterRig {
  readonly root: TransformNode;
  readonly headAnchor: TransformNode;
  /** Resolves true once the avatar is built, false if it can't be. */
  readonly ready: Promise<boolean>;
  readonly spec: RigSpec;
  private readonly scene: Scene;
  private readonly opts: MannequinOptions;
  private model: TransformNode | null = null;
  private skeletons: Skeleton[] = [];
  private meshes: AbstractMesh[] = [];
  private headNode: TransformNode | null = null;
  private readonly layers: Record<Layer, Map<RigClip, LayerClip>> = {
    upper: new Map(),
    lower: new Map(),
  };
  private extras: AbstractMesh[] = [];
  private pose: CharacterPose = "idle";
  private blend = 0.25;
  private speed = 0;
  private tint: string;
  private sitOffset = 0;
  private paused = false;
  private midAcc = 0;
  private detailFull = true;
  private disposed = false;

  constructor(scene: Scene, spec: RigSpec, opts: MannequinOptions) {
    this.scene = scene;
    this.spec = spec;
    this.opts = opts;
    this.tint = opts.boss ? CLAUDE_ORANGE : opts.color;
    this.root = new TransformNode(`gchar_${opts.id}`, scene);
    this.headAnchor = new TransformNode(`gcharHead_${opts.id}`, scene);
    this.headAnchor.parent = this.root;
    this.headAnchor.position.y = spec.heightM + 0.3;
    this.ready = Promise.all([spec.avatar, spec.templates]).then(
      ([avatar, templates]) => {
        if (this.disposed || !avatar || !templates) return false;
        try {
          this.build(avatar, templates);
          return true;
        } catch (err) {
          console.warn(`[characters] ${spec.key}: build failed`, err);
          this.teardown();
          return false;
        }
      },
      () => false,
    );
  }

  setPose(pose: CharacterPose, blendSec = 0.25): void {
    if (pose === this.pose && blendSec !== 0) return;
    this.pose = pose;
    this.blend = Math.max(0.01, blendSec);
    // One-shot gestures restart when re-entered.
    const upper = this.spec.poseLayers[pose][1];
    const u = this.layers.upper.get(upper);
    if (u && this.spec.oneShot.has(upper)) this.playOnce(u.group, upper);
    if (blendSec === 0) this.updateWeights(0, true);
  }

  setMoving(speed: number): void {
    this.speed = speed;
    const ratio =
      speed > 0.05
        ? Math.min(1.8, Math.max(0.5, speed / this.spec.walkSpeedMps))
        : 1;
    for (const layer of ["upper", "lower"] as const) {
      const w = this.layers[layer].get("walk");
      if (w) w.group.speedRatio = ratio;
    }
  }

  setDetail(full: boolean): void {
    if (full === this.detailFull) return;
    this.detailFull = full;
    for (const m of this.extras) m.setEnabled(full);
  }

  setTint(hex: string): void {
    const next = this.opts.boss ? CLAUDE_ORANGE : hex;
    if (next === this.tint) return;
    this.tint = next;
    const mat = this.badgeMaterial();
    for (const m of this.extras) m.material = mat;
  }

  update(dt: number, lod: Lod): void {
    if (this.disposed || !this.model) return;
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
    if (freeze) return;
    // Mid tier: blend weights at ~15 Hz (the clips themselves keep playing).
    if (lod === "mid") {
      this.midAcc += dt;
      if (this.midAcc < 1 / 15) return;
      dt = this.midAcc;
    }
    this.midAcc = 0;
    this.updateWeights(dt, false);
    if (this.headNode) {
      this.headNode.computeWorldMatrix(true);
      const p = this.headNode.getAbsolutePosition();
      this.headAnchor.position.set(p.x, p.y + 0.3, p.z);
    }
  }

  getMeshes(): AbstractMesh[] {
    return [...this.meshes, ...this.extras];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.headAnchor.dispose();
    this.root.dispose();
  }

  // -------------------------------------------------------------------------

  private teardown(): void {
    for (const layer of Object.values(this.layers)) {
      for (const c of layer.values()) c.group.dispose();
      layer.clear();
    }
    for (const m of this.extras) m.dispose();
    this.extras = [];
    this.model?.dispose(false, false);
    this.model = null;
    for (const s of this.skeletons) s.dispose();
    this.skeletons = [];
    this.meshes = [];
    this.headNode = null;
  }

  private build(avatar: AssetContainer, templates: ClipTemplates): void {
    const spec = this.spec;
    const suffix = `__${this.opts.id}`;
    const entries = avatar.instantiateModelsToScene((n) => n + suffix, false, {
      doNotInstantiate: true,
      predicate: (e: unknown) => !(e instanceof AnimationGroup),
    });
    const model = new TransformNode(`gcharModel_${this.opts.id}`, this.scene);
    model.parent = this.root;
    model.rotation.y = spec.facingYaw;
    model.scaling.setAll(spec.scale);
    this.model = model;
    this.skeletons = entries.skeletons;
    for (const n of entries.rootNodes) n.parent = model;
    for (const g of entries.animationGroups) g.dispose();

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
      // Skinned bounds don't follow the pose: never cull a seated character.
      m.alwaysSelectAsActiveMesh = true;
    }
    const head = byName.get(spec.headBone);
    this.headNode = head instanceof TransformNode ? head : null;

    // Bind + split every clip the poses may use into upper / lower layers.
    const wanted = new Set<RigClip>([
      ...Object.values(spec.poseLayers).flat(),
      spec.standFallback,
      spec.sitFallback,
    ]);
    for (const clip of wanted) {
      const tpl = templates.get(clip);
      if (!tpl) continue;
      for (const layer of ["upper", "lower"] as const) {
        const g = new AnimationGroup(`${clip}_${layer}${suffix}`, this.scene);
        for (const ta of tpl.tracks) {
          if (spec.isUpper(ta.target) !== (layer === "upper")) continue;
          const target = byName.get(ta.target);
          if (target) g.addTargetedAnimation(ta.animation, target);
        }
        if (g.targetedAnimations.length === 0) {
          g.dispose();
          continue;
        }
        g.normalize(tpl.from, tpl.to);
        g.loopAnimation = !spec.oneShot.has(clip);
        g.weight = 0;
        this.layers[layer].set(clip, { group: g, weight: 0 });
      }
    }

    // Bind-pose world matrices for badge placement.
    for (const n of [model, ...model.getDescendants(false)]) {
      if (n instanceof TransformNode) n.computeWorldMatrix(true);
    }
    if (spec.badgeBone) this.buildBadge(byName.get(spec.badgeBone));
    this.headAnchor.parent = null;
    this.setPose(this.pose, 0);
    this.setMoving(this.speed);
  }

  private playOnce(g: AnimationGroup, clip: RigClip): void {
    g.stop();
    g.loopAnimation = false;
    g.start(false, 1, g.from, g.to);
    g.onAnimationGroupEndObservable.addOnce(() => {
      if (this.disposed) return;
      // Hold the final frame while the pose stays active.
      if (this.spec.poseLayers[this.pose][1] === clip)
        g.start(true, 1, Math.max(g.from, g.to - 1), g.to);
    });
  }

  private targets(): Record<Layer, RigClip> {
    if (this.speed > 0.05) return { lower: "walk", upper: "walk" };
    const [lower, upper] = this.spec.poseLayers[this.pose];
    return { lower, upper };
  }

  private updateWeights(dt: number, snap: boolean): void {
    const spec = this.spec;
    const tgt = this.targets();
    const step = snap ? 1 : dt / this.blend;
    const seatedLegs = spec.seatedClips.has(tgt.lower);
    for (const layer of ["upper", "lower"] as const) {
      let want: RigClip = tgt[layer];
      if (!this.layers[layer].has(want))
        want = seatedLegs ? spec.sitFallback : spec.standFallback;
      if (!this.layers[layer].has(want)) want = seatedLegs ? "sitIdle" : "idle";
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
    // Move the model while the legs play a seated clip.
    const seated = seatedLegs && this.speed <= 0.05;
    const goal = seated ? 1 : 0;
    this.sitOffset = snap
      ? goal
      : this.sitOffset + (goal - this.sitOffset) * Math.min(1, step);
    if (this.model) {
      const k = this.sitOffset;
      this.model.position.y =
        k * (SEAT_HEIGHT + spec.sitClearanceM - spec.sitPelvisHeightM);
      this.model.position.z = k * spec.sitPelvisBackM;
    }
  }

  private buildBadge(parent: Node | undefined): void {
    if (!(parent instanceof TransformNode) || !this.model) return;
    const H = this.spec.heightM;
    // Root-space points in the bind pose (feet at 0, facing +Z).
    const chestZ = this.spec.badgeChestZ;
    const top = {
      x: 0.0,
      y: H * (this.spec.badgeHeightFrac ?? 0.69),
      z: chestZ + 0.008,
    };
    const parts: Mesh[] = [];
    const badge = CreateBox(
      `gcharBadge_${this.opts.id}`,
      { width: 0.062, height: 0.088, depth: 0.006 },
      this.scene,
    );
    badge.parent = this.root;
    badge.position.set(top.x, top.y - 0.046, top.z + 0.002);
    badge.rotation.x = -0.12;
    parts.push(badge);
    for (const side of [-1, 1]) {
      const a = { x: side * 0.062, y: H * 0.815, z: chestZ - 0.11 };
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
      strap.parent = this.root;
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
    merged.setEnabled(this.detailFull);
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
