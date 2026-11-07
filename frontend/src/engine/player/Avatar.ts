/**
 * Third-person player avatar: an adapter over the actors agent's
 * `CharacterRig` (procedural MannequinRig today, GltfRig when available).
 */
import type { AbstractMesh, Scene, TransformNode } from "@/engine/babylon";
import { MannequinRig } from "@/engine/characters/MannequinRig";
import { tryCreateGltfRig } from "@/engine/characters/GltfRig";
import type { CharacterRig } from "@/engine/characters/types";

export interface PlayerAvatar {
  readonly root: TransformNode;
  setMoving(speed: number): void;
  update(dt: number): void;
  getMeshes(): AbstractMesh[];
  setVisible(on: boolean): void;
  dispose(): void;
}

export class RigAvatar implements PlayerAvatar {
  private moving = false;

  constructor(private readonly rig: CharacterRig) {
    rig.setPose("idle", 0);
    for (const m of rig.getMeshes()) m.isPickable = false;
  }

  get root(): TransformNode {
    return this.rig.root;
  }

  setMoving(speed: number): void {
    const moving = speed > 0.2;
    this.rig.setMoving(speed);
    if (moving !== this.moving) {
      this.moving = moving;
      this.rig.setPose(moving ? "walking" : "idle", 0.25);
    }
  }

  update(dt: number): void {
    this.rig.update(dt, "near");
  }

  getMeshes(): AbstractMesh[] {
    return this.rig.getMeshes();
  }

  setVisible(on: boolean): void {
    this.rig.root.setEnabled(on);
  }

  dispose(): void {
    this.rig.dispose();
  }
}

export function createPlayerAvatar(scene: Scene): PlayerAvatar {
  const opts = { id: "player", boss: false, color: "#5B7C99" };
  return new RigAvatar(
    tryCreateGltfRig(scene, opts) ?? new MannequinRig(scene, opts),
  );
}
