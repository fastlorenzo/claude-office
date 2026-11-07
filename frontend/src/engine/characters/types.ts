/**
 * Character rig contracts shared by the procedural mannequin and the optional
 * glTF rig. The world drives rigs only through this interface.
 */

import type { AbstractMesh, TransformNode } from "../babylon";
import type { CharacterPose } from "../contracts";

/** Level of detail for animation / screen updates. */
export type Lod = "near" | "mid" | "far";

export interface CharacterRig {
  /** Rig root at floor level; position/yaw are owned by the caller. */
  readonly root: TransformNode;
  /** Point just above the head (nameplates and bubbles link here). */
  readonly headAnchor: TransformNode;
  /** Cross-fade to a pose over blendSec (default ~0.35 s). */
  setPose(pose: CharacterPose, blendSec?: number): void;
  /** Locomotion speed in m/s; 0 = stand. Drives the walk cycle layer. */
  setMoving(speed: number): void;
  /** Outfit accent colour (#rrggbb). */
  setTint(hex: string): void;
  /** far = frozen, mid = ~15 Hz, near = every frame. */
  update(dt: number, lod: Lod): void;
  /** Optional: hide fine detail (lanyard) when not near the camera. */
  setDetail?(full: boolean): void;
  /** Visible meshes (shadow casters, feed render lists, picking). */
  getMeshes(): AbstractMesh[];
  dispose(): void;
}
