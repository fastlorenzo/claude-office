/**
 * CastRig — the character rig actors use when realistic packs are enabled.
 * A stable root / head anchor (what the actor, labels and the ActorHub hold)
 * around a swappable inner rig:
 *
 *   mannequin ──(pack ready)──► GltfRig(spec A) ──(cast changed)──► GltfRig(spec B)
 *
 * The inner rig is resolved from the cast setting + role through the pack
 * fallback chain (castPlan.ts); a new rig loads hidden and replaces the shown
 * one only once it is built, so a live cast switch never pops through a
 * T-pose or an empty frame. Replaced rigs are disposed with their cloned
 * skeletons and animation groups.
 */

import { type AbstractMesh, Scene, TransformNode } from "../babylon";
import type { CharacterPose } from "../contracts";
import { castChain } from "./castPlan";
import { getPackRegistry, type PackRegistry } from "./characterPacks";
import { GltfRig } from "./GltfRig";
import { MannequinRig, type MannequinOptions } from "./MannequinRig";
import type { CharacterRig, Lod } from "./types";

const MANNEQUIN = "mannequin";

/** A CastRig when the scene opted in via preloadCharacterPack, else null. */
export function tryCreateGltfRig(
  scene: Scene,
  opts: MannequinOptions,
): CastRig | null {
  const reg = getPackRegistry(scene);
  return reg ? new CastRig(reg, opts) : null;
}

export class CastRig implements CharacterRig {
  readonly root: TransformNode;
  readonly headAnchor: TransformNode;
  /** Set by the actor: called when the visible meshes change (rig swap). */
  meshesChanged: ((meshes: AbstractMesh[]) => void) | null = null;
  private readonly reg: PackRegistry;
  private readonly opts: MannequinOptions;
  private current: CharacterRig;
  private currentKey = MANNEQUIN;
  private pending: { rig: GltfRig; key: string } | null = null;
  private gen = 0;
  private pose: CharacterPose = "idle";
  private speed = 0;
  private tint: string;
  private detail = true;
  private disposed = false;

  constructor(reg: PackRegistry, opts: MannequinOptions) {
    this.reg = reg;
    this.opts = opts;
    this.tint = opts.color;
    const scene = reg.scene;
    this.root = new TransformNode(`char_${opts.id}`, scene);
    this.headAnchor = new TransformNode(`charHead_${opts.id}`, scene);
    this.current = this.adopt(new MannequinRig(scene, opts));
    reg.rigs.add(this);
    this.refresh();
  }

  /** Pack key of the rig on screen ("mannequin", "mpfb:office_m01", ...). */
  get shownKey(): string {
    return this.currentKey;
  }

  /** Resolves once no swap is pending (tests / screenshots). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && this.pending; i++)
      await this.pending.rig.ready.then(
        () => new Promise((r) => setTimeout(r, 0)),
      );
  }

  /** Re-resolve the wanted rig (cast changed, pack became available). */
  refresh(): void {
    if (this.disposed) return;
    const gen = ++this.gen;
    void this.resolve(gen);
  }

  private async resolve(gen: number): Promise<void> {
    const chain = castChain(this.reg.cast, this.opts.boss ? "boss" : "agent");
    for (const kind of chain) {
      const spec = await this.reg.spec(kind, this.opts);
      if (gen !== this.gen || this.disposed) return;
      if (!spec) continue;
      if (spec.key === this.currentKey) {
        this.dropPending();
        return;
      }
      let p = this.pending;
      if (p?.key !== spec.key) {
        this.dropPending();
        const rig = new GltfRig(this.reg.scene, spec, this.opts);
        rig.root.parent = this.root;
        rig.root.setEnabled(false);
        rig.setPose(this.pose, 0);
        rig.setMoving(this.speed);
        rig.setTint(this.tint);
        rig.setDetail(this.detail);
        p = { rig, key: spec.key };
        this.pending = p;
      }
      const ok = await p.rig.ready;
      if (gen !== this.gen || this.disposed || this.pending !== p) return;
      if (ok) {
        this.swap(p.rig, p.key);
        return;
      }
      this.dropPending();
    }
    // Nothing usable: back to the mannequin.
    if (this.currentKey !== MANNEQUIN)
      this.swap(new MannequinRig(this.reg.scene, this.opts), MANNEQUIN);
  }

  private dropPending(): void {
    this.pending?.rig.dispose();
    this.pending = null;
  }

  private adopt(rig: CharacterRig): CharacterRig {
    rig.root.parent = this.root;
    this.headAnchor.parent = rig.headAnchor;
    this.headAnchor.position.setAll(0);
    return rig;
  }

  private swap(rig: CharacterRig, key: string): void {
    const old = this.current;
    if (this.pending?.rig === rig) this.pending = null;
    this.current = this.adopt(rig);
    this.currentKey = key;
    rig.root.setEnabled(true);
    rig.setPose(this.pose, 0);
    rig.setMoving(this.speed);
    rig.setTint(this.tint);
    rig.setDetail?.(this.detail);
    old.dispose();
    this.meshesChanged?.(this.getMeshes());
  }

  setPose(pose: CharacterPose, blendSec?: number): void {
    this.pose = pose;
    this.current.setPose(pose, blendSec);
    this.pending?.rig.setPose(pose, 0);
  }

  setMoving(speed: number): void {
    this.speed = speed;
    this.current.setMoving(speed);
    this.pending?.rig.setMoving(speed);
  }

  setTint(hex: string): void {
    this.tint = hex;
    this.current.setTint(hex);
    this.pending?.rig.setTint(hex);
  }

  setDetail(full: boolean): void {
    this.detail = full;
    this.current.setDetail?.(full);
  }

  update(dt: number, lod: Lod): void {
    if (!this.disposed) this.current.update(dt, lod);
  }

  getMeshes(): AbstractMesh[] {
    return this.current.getMeshes();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    this.reg.rigs.delete(this);
    this.dropPending();
    this.headAnchor.parent = null;
    this.current.dispose();
    this.headAnchor.dispose();
    this.root.dispose();
  }
}
