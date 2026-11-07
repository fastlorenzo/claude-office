import type { IWorld } from "@/engine/contracts";

/**
 * Module-level handle to the live world so HUD components (minimap teleport,
 * touch controls) can drive it without prop drilling. Written only by
 * WorldCanvas; never use it to render.
 */
let current: IWorld | null = null;

export function setWorld(world: IWorld | null): void {
  current = world;
}

export function getWorld(): IWorld | null {
  return current;
}
