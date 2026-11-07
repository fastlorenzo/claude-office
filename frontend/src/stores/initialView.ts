import type { BuildingConfig, ViewMode } from "@/types/navigation";

/**
 * View to land on once the building config has loaded.
 *
 * Pixel renderer: floors-first (a configured building opens the building view
 * when we are still on "single"). 3D renderer: the world already shows every
 * session, so stay put; building/floor views remain optional navigation.
 */
export function initialView(
  renderer: "3d" | "pixel",
  config: BuildingConfig,
  current: ViewMode,
): ViewMode {
  if (current !== "single") return current;
  if (renderer === "pixel" && config.floors.length > 0) return "building";
  return current;
}
