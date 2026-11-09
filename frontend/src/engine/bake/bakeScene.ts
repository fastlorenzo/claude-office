/**
 * Headless (NullEngine) build of a representative office for the lightmap
 * exporter (tools/lightmaps): building shell + lobby + entrance, the project
 * rooms of a demo campus (thin-instanced ShellModules), the session pods and
 * the control room. No textures, no characters, no physics, no exterior
 * skyline. Scanned props (AssetLibrary) are stubbed out: they stay realtime.
 */
import { NullEngine, Scene, type Vector3 } from "@/engine/babylon";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { BuildingLayout } from "@/engine/contracts";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { Lighting } from "@/engine/fx/Lighting";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { groupSessions } from "@/engine/logic/projectGroups";
import { Materials } from "@/engine/materials/Materials";
import { Colliders } from "@/engine/physics/Colliders";
import { FeedScheduler } from "@/engine/screens/FeedScheduler";
import { Building } from "@/engine/world/Building";
import { ControlRoom } from "@/engine/world/ControlRoom";
import { ProjectRoom } from "@/engine/world/ProjectRoom";
import { frameMatrix, ShellModule } from "@/engine/world/ProjectShell";

/** Minimal 2D canvas so DynamicTexture-based modules construct headless. */
export function stubOffscreenCanvas(): void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  if (g.OffscreenCanvas) return;
  const ctx: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "measureText"
          ? () => ({ width: 0, actualBoundingBoxAscent: 0 })
          : k === "getImageData" || k === "createImageData"
            ? () => ({ data: new Uint8ClampedArray(4) })
            : k === "createLinearGradient" ||
                k === "createRadialGradient" ||
                k === "createPattern"
              ? () => ({ addColorStop: () => undefined })
              : () => undefined,
      set: () => true,
    },
  );
  g.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return ctx;
    }
  };
}

/** The demo campus layout the world-debug page uses (`?n=`). */
export function demoBuildingLayout(n = 6): BuildingLayout {
  const d = createDemoCampus(n, 20000);
  const groups = groupSessions(d.campus, d.sessions, d.projects);
  const slots = allocateSlots(
    new Map(),
    groups.map((g) => ({
      id: g.id,
      createdAt: g.createdAt,
      sessions: g.sessionIds.length,
    })),
  );
  return generateLayout(slots, groups, allocatePods(new Map(), groups));
}

export interface BakeScene {
  engine: NullEngine;
  scene: Scene;
  materials: Materials;
  lighting: Lighting;
  layout: BuildingLayout;
  building: Building;
  /** Every luminaire of the build (world space, FixturePoint specs). */
  fixtures: Vector3[];
  dispose(): void;
}

const noAssets = {
  instantiate: () => () => undefined,
  disposeGroup: () => undefined,
  preload: async () => undefined,
} as unknown as AssetLibrary;

/** Build the static office for `layout` (default: the 6-session demo). */
export function buildBakeScene(layout = demoBuildingLayout()): BakeScene {
  stubOffscreenCanvas();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const materials = new Materials(scene, "/assets");
  const lighting = new Lighting(scene);
  const colliders = new Colliders(scene);
  const ctx = {
    scene,
    materials,
    assets: noAssets,
    colliders,
    lighting,
    fx: null,
  };
  const building = new Building(ctx);
  building.build(layout);
  const rooms = layout.projects.map((p) => new ProjectRoom(ctx, p));
  // Session pods: the "pod" prefab per pod frame (Room.ts adds only
  // characters, screens and signs on top of it).
  const pod = ShellModule.get(scene, materials, lighting, "pod");
  for (const r of layout.rooms)
    pod.add(frameMatrix({ ox: r.origin.x, oz: r.origin.z, yaw: r.yaw }));
  const feeds = new FeedScheduler(scene);
  new ControlRoom({ ...ctx, feeds }, layout, building.controlShellMeshes);
  for (const m of ShellModuleKinds)
    ShellModule.get(scene, materials, lighting, m).flush();
  const fixtures = [...building.fixtures];
  for (const r of rooms) fixtures.push(...r.getFixtures());
  return {
    engine,
    scene,
    materials,
    lighting,
    layout,
    building,
    fixtures,
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}

export const ShellModuleKinds = [
  "entry",
  "podBay",
  "endWall",
  "divider",
  "pod",
] as const;
