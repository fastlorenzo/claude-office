/**
 * Set dressing (WS6): the props real lobbies, halls, plants and loading docks
 * have, from pure per-zone plans (reception, hall, factory, dock — layout in,
 * `Piece`s out, so everything follows the session count) instantiated as thin
 * instances of procedural `PropRole`s (one draw per material per role, culled
 * by distance in the AssetLibrary). Solid pieces also get static colliders.
 *
 * `Dressing` rebuilds on every "layout" event of the world (keyed, so a no-op
 * sync costs nothing).
 */
import { Vector3 } from "@/engine/babylon";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { BuildingLayout } from "@/engine/contracts";
import {
  buildFactoryLayout,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import type { Colliders } from "@/engine/physics/Colliders";
import { dockPieces } from "./dock";
import { factoryPieces } from "./factory";
import { hallPieces } from "./hall";
import { solidBoxes, type Box, type Piece } from "./piece";
import { receptionPieces } from "./reception";

export const DRESSING_GROUP = "dressing";

/** Every piece of the building's dressing. */
export function dressingPieces(
  fl: FactoryLayout,
  building: BuildingLayout,
): Piece[] {
  return [
    ...receptionPieces(fl, building),
    ...hallPieces(fl, building),
    ...factoryPieces(fl),
    ...dockPieces(fl),
  ];
}

/** Collider boxes of the dressing (for the flood-fill tests). */
export function dressingBoxes(
  fl: FactoryLayout,
  building: BuildingLayout,
): Box[] {
  return solidBoxes(dressingPieces(fl, building));
}

export interface DressingContext {
  assets: AssetLibrary;
  colliders: Colliders;
}

export class Dressing {
  private key = "";

  /** `subscribe` registers the layout listener (returns its unsubscriber). */
  constructor(
    private readonly ctx: DressingContext,
    subscribe: (cb: (b: BuildingLayout) => void) => unknown,
  ) {
    subscribe((b) => this.build(b));
  }

  build(building: BuildingLayout): void {
    const fl = buildFactoryLayout(building);
    const pieces = dressingPieces(fl, building);
    const key = pieces
      .map(
        (p) => `${p.role}${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`,
      )
      .join("|");
    if (key === this.key) return;
    this.key = key;
    const { assets, colliders } = this.ctx;
    assets.disposeGroup(DRESSING_GROUP);
    colliders.disposeGroup(DRESSING_GROUP);
    for (const p of pieces) {
      assets.instantiate(
        p.role,
        null,
        {
          position: { x: p.x, y: p.y, z: p.z },
          yaw: p.yaw,
          ...(p.scale !== undefined
            ? {
                scale:
                  typeof p.scale === "number"
                    ? p.scale
                    : { x: p.scale[0], y: p.scale[1], z: p.scale[2] },
              }
            : {}),
        },
        { group: DRESSING_GROUP, collider: "none" },
      );
    }
    for (const b of solidBoxes(pieces))
      colliders.addBox(
        DRESSING_GROUP,
        new Vector3(b.x, b.y, b.z),
        new Vector3(b.sx, b.sy, b.sz),
        b.yaw,
      );
  }
}
