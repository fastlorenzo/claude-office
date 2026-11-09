/**
 * Lightmap export (tools/lightmaps): serialise one bake set — its
 * layout-invariant merged meshes (the bake targets), the static scene around
 * them (occluders / bounce / emitters), and the lights that reach them — as
 * the JSON source `tools/lightmaps/bake.py` reads.
 *
 * Coordinates stay Babylon's (left-handed, Y up, metres); bake.py converts.
 * Matrices are Babylon world matrices (row-vector convention, translation in
 * elements 12..14), one per drawn instance.
 *
 * Sets (lightmap contract, see tools/lightmaps/README.md):
 *   modules   the 5 ShellModule prefabs, one atlas; vertex data in prefab
 *             space (thin instances). Baked on one representative ("hero")
 *             instance per kind inside the full building, without the sun.
 *   lobby     Building's lobby batcher (world space), with the sun.
 *   entrance  EntranceHall's static batcher (frame-local), with the sun.
 *   control   Building `control` + ControlRoomShell + ControlRoom interior
 *             (world space, hashed relative to the drum centre), lit by the
 *             control room's own zone lights only.
 */
import {
  Matrix,
  PBRMaterial,
  PointLight,
  SpotLight,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
  type Material,
  type Mesh,
  type Scene,
} from "@/engine/babylon";
import { ASSET_MANIFEST, hdriPath } from "@/engine/assets/manifest";
import type { BuildingLayout } from "@/engine/contracts";
import { FixturePoint, type Lighting } from "@/engine/fx/Lighting";
import { controlPlan } from "@/engine/world/controlRoomPlan";
import { partHash, topologyHash } from "@/engine/bake/hash";
import { bakeParts } from "@/engine/bake/parts";

export type BakeSetName = "modules" | "lobby" | "entrance" | "control";

export interface BakeSetSpec {
  frame: "module-local" | "world" | "control-local";
  /** Daylight (sun lamp + exterior sky through the glazing) baked in. */
  sun: boolean;
  /** Atlas edge (px). */
  size: number;
}

export const BAKE_SETS: Record<BakeSetName, BakeSetSpec> = {
  modules: {
    frame: "module-local",
    sun: false,
    size: 2048,
  },
  lobby: { frame: "world", sun: true, size: 2048 },
  entrance: { frame: "world", sun: true, size: 2048 },
  control: {
    frame: "control-local",
    sun: false,
    size: 2048,
  },
};

export const BAKE_SET_NAMES = Object.keys(BAKE_SETS) as BakeSetName[];

/** Context radius (m) around a set's targets: occluders, bounce, lights. */
const CONTEXT_R = 14;

/** Origin of the set's hash frame (control: the drum centre). */
export function setOrigin(
  set: BakeSetName,
  layout: BuildingLayout,
): { x: number; y: number; z: number } {
  if (set !== "control") return { x: 0, y: 0, z: 0 };
  const p = controlPlan(layout);
  return { x: p.cx, y: 0, z: p.cz };
}

/**
 * Merged meshes of a set, in registration order: the parts the batchers
 * registered with `build({ bake })` (engine/bake/parts.ts) — exactly what the
 * runtime offers to the manifest.
 */
export function setMeshes(scene: Scene, set: BakeSetName): Mesh[] {
  return bakeParts(scene, set)
    .map((p) => p.mesh)
    .filter((m) => m.getTotalVertices() > 0);
}

/** Parts that get a lightmap (not unlit emitters, not alpha-blended glass). */
export function isLightmapped(mesh: AbstractMesh): boolean {
  const mat = mesh.material;
  if (!mat) return false;
  if ((mat as { disableLighting?: boolean }).disableLighting) return false;
  return !mat.needAlphaBlending();
}

export interface PartHashInfo {
  name: string;
  hash: string;
  vertexCount: number;
}

/** Hash every lightmapped part of a set (the manifest's `parts`). */
export function hashSet(
  scene: Scene,
  set: BakeSetName,
  layout: BuildingLayout,
): PartHashInfo[] {
  const origin = setOrigin(set, layout);
  return setMeshes(scene, set)
    .filter(isLightmapped)
    .map((m) => ({
      name: m.name,
      hash: partHash(
        m.getVerticesData("position") ?? [],
        m.getIndices() ?? [],
        origin,
      ),
      vertexCount: m.getTotalVertices(),
    }));
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export interface ExportMesh {
  material: string;
  /** Linear albedo (bounce colour; the lightmap itself has no albedo). */
  albedo: [number, number, number];
  roughness: number;
  metallic: number;
  /** Linear emitted radiance (Babylon emissive × intensity), or null. */
  emissive: [number, number, number] | null;
  /** Alpha-blended (glass): light passes through in the bake. */
  transparent: boolean;
  alpha: number;
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface ExportTarget {
  name: string;
  hash: string;
  /** Topology hash (sets verified by topology: control). */
  topoHash?: string;
  /** Set-frame bounds [minX,minY,minZ,maxX,maxY,maxZ] (topology sets). */
  bbox?: number[];
  vertexCount: number;
  /** World matrix the hero copy is baked at. */
  matrix: number[];
}

export interface ExportLight {
  type: "spot" | "point";
  kind: string;
  pos: [number, number, number];
  /** Emission axis (spot); Babylon physical falloff 2^(6.64·(cosθ−1)). */
  dir: [number, number, number] | null;
  /** Linear colour. */
  color: [number, number, number];
  /** Babylon intensity (radiant intensity, W/sr equivalent). */
  intensity: number;
  range: number;
  /** Luminaire size (m) for softer shadows (linear fixtures). */
  size: { w: number; d: number; yaw: number } | null;
}

export interface ExportSet {
  version: 1;
  set: BakeSetName;
  frame: BakeSetSpec["frame"];
  /** How the runtime verifies parts: position hash, or topology (control). */
  verify: "position" | "topology";
  /** The build the bake was made on (demo campus size). */
  layout: string;
  size: number;
  origin: [number, number, number];
  sun: {
    dir: [number, number, number];
    intensity: number;
    color: [number, number, number];
  } | null;
  world: {
    /** Path under frontend/public. */
    hdri: string;
    strength: number;
    /** Babylon `rotationY` of the cube (radians). */
    rotationY: number;
    /** Clamp the HDRI radiance (removes the sun disc where a sun lamp exists). */
    clamp: number;
  };
  meshes: Record<string, ExportMesh>;
  /** Bake targets in manifest order (one hero copy each). */
  targets: ExportTarget[];
  /** Everything drawn around them (instances of `meshes`). */
  instances: { name: string; matrices: number[][] }[];
  lights: ExportLight[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Bake passes (one image): each bakes the targets whose name starts with
   * one of `targets` while meshes starting with one of `hide` are left out.
   * Absent: one pass, everything visible.
   */
  passes?: { targets: string[]; hide: string[] }[];
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const v3 = (v: {
  x: number;
  y: number;
  z: number;
}): [number, number, number] => [r5(v.x), r5(v.y), r5(v.z)];
const c3 = (c: {
  r: number;
  g: number;
  b: number;
}): [number, number, number] => [r4(c.r), r4(c.g), r4(c.b)];

function materialInfo(
  mat: Material | null,
): Omit<ExportMesh, "positions" | "normals" | "indices"> {
  const name = mat?.name ?? "";
  const transparent = mat?.needAlphaBlending() ?? false;
  const alpha = mat?.alpha ?? 1;
  if (mat instanceof PBRMaterial) {
    const unlit = mat.disableLighting;
    const e = mat.emissiveColor.scale(mat.emissiveIntensity);
    // Screen canvases: content varies, assume a mid-grey average picture.
    if (mat.emissiveTexture) e.scaleInPlace(0.3);
    const lum = e.r + e.g + e.b;
    return {
      material: name,
      albedo: c3(mat.albedoColor),
      roughness: r4(mat.roughness ?? 1),
      metallic: r4(mat.metallic ?? 0),
      emissive: lum > 1e-4 || unlit ? c3(e) : null,
      transparent,
      alpha,
    };
  }
  if (mat instanceof StandardMaterial) {
    const e = mat.emissiveColor.clone();
    if (mat.emissiveTexture || mat.diffuseTexture) e.scaleInPlace(0.3);
    const unlit = mat.disableLighting;
    return {
      material: name,
      albedo: c3(mat.diffuseColor),
      roughness: 0.8,
      metallic: 0,
      emissive: unlit || e.r + e.g + e.b > 1e-4 ? c3(e) : null,
      transparent,
      alpha,
    };
  }
  return {
    material: name,
    albedo: [0.5, 0.5, 0.5],
    roughness: 0.8,
    metallic: 0,
    emissive: null,
    transparent,
    alpha,
  };
}

export function serialiseMesh(mesh: Mesh): ExportMesh {
  return {
    ...materialInfo(mesh.material),
    positions: Array.from(mesh.getVerticesData("position") ?? [], r5),
    normals: Array.from(mesh.getVerticesData("normal") ?? [], r4),
    indices: Array.from(mesh.getIndices() ?? []),
  };
}

/** World matrices of every drawn copy (thin instances or the mesh itself). */
function worldMatrices(mesh: Mesh): Matrix[] {
  if (mesh.hasThinInstances) {
    if (!mesh.thinInstanceCount) return [];
    return mesh.thinInstanceGetWorldMatrices();
  }
  return [mesh.computeWorldMatrix(true).clone()];
}

const mat16 = (m: Matrix) => Array.from(m.toArray(), r5);

/** Medoid instance: the most central copy (most neighbours around it). */
function heroIndex(ms: Matrix[]): number {
  let best = 0;
  let bestD = Infinity;
  const t = ms.map((m) => m.getTranslation());
  // Prefer the side (sign of x) with more copies.
  const east = t.filter((p) => p.x >= 0).length;
  const side = east >= t.length - east ? 1 : -1;
  t.forEach((p, i) => {
    if (Math.sign(p.x || 1) !== side) return;
    let d = 0;
    for (const q of t)
      if (Math.sign(q.x || 1) === side) d += Vector3.Distance(p, q);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Is `m` part of the static scene the bake should see? */
function isStatic(m: AbstractMesh): m is Mesh {
  if (m.isDisposed() || !m.isEnabled() || !m.isVisible) return false;
  if (!m.material || m.getTotalVertices() < 3) return false;
  if (!(m.getIndices()?.length ?? 0)) return false;
  if (m.visibility <= 0) return false;
  // Collider proxies, sky, contact-shadow blobs.
  if (/^(col|skybox|exterior:shadows|opsMonPick)/.test(m.name)) return false;
  return true;
}

function expand(
  min: Vector3,
  max: Vector3,
  r: number,
): { min: Vector3; max: Vector3 } {
  return {
    min: min.subtract(new Vector3(r, r, r)),
    max: max.add(new Vector3(r, r, r)),
  };
}

function boxesTouch(
  a: { min: Vector3; max: Vector3 },
  b: { min: Vector3; max: Vector3 },
): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

/** Vertex-data bounds minus the set origin (mm-rounded). */
function setBox(mesh: Mesh, o: { x: number; y: number; z: number }): number[] {
  const b = localBox(mesh);
  const r3 = (v: number) => Math.round(v * 1e3) / 1e3;
  return [
    b.min.x - o.x,
    b.min.y - o.y,
    b.min.z - o.z,
    b.max.x - o.x,
    b.max.y - o.y,
    b.max.z - o.z,
  ].map(r3);
}

/** Local AABB of a mesh's vertex data. */
function localBox(mesh: Mesh): { min: Vector3; max: Vector3 } {
  const p = mesh.getVerticesData("position") ?? [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < p.length; i += 3) {
    min.minimizeInPlaceFromFloats(p[i], p[i + 1], p[i + 2]);
    max.maximizeInPlaceFromFloats(p[i], p[i + 1], p[i + 2]);
  }
  return { min, max };
}

function worldBox(
  box: { min: Vector3; max: Vector3 },
  m: Matrix,
): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const c = new Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    const w = Vector3.TransformCoordinates(c, m);
    min.minimizeInPlace(w);
    max.maximizeInPlace(w);
  }
  return { min, max };
}

/**
 * The light a fixture gets at runtime, read back from the live Lighting
 * (its KIND table + configure()): one fixture, one dynamic light, two updates.
 */
export function fixtureLights(
  lighting: Lighting,
  scene: Scene,
  fixtures: readonly FixturePoint[],
): ExportLight[] {
  const out: ExportLight[] = [];
  lighting.setMaxDynamicLights(1);
  for (const f of fixtures) {
    lighting.setFixtures([f]);
    lighting.update(1, f);
    lighting.update(1, f);
    const l = scene.lights.find(
      (x): x is SpotLight =>
        x instanceof SpotLight &&
        /^fixture\d+$/.test(x.name) &&
        x.intensity > 0 &&
        Vector3.DistanceSquared(x.position, f) < 1e-8,
    );
    if (!l) continue;
    const s = f.spec.size;
    out.push({
      type: "spot",
      kind: f.spec.kind,
      pos: v3(f),
      dir: v3(l.direction.normalizeToNew()),
      color: c3(l.diffuse),
      intensity: r4(l.intensity),
      range: r4(l.range),
      size: s ? { w: s.w, d: s.d, yaw: s.yaw ?? 0 } : null,
    });
  }
  lighting.setFixtures([]);
  lighting.setMaxDynamicLights(0);
  return out;
}

/** The control room's zone point lights (Lighting.isolateZone). */
function zoneLights(scene: Scene): ExportLight[] {
  return scene.lights
    .filter(
      (l): l is PointLight =>
        l instanceof PointLight && /^zone\d+$/.test(l.name),
    )
    .map((l) => ({
      type: "point" as const,
      kind: "zone",
      pos: v3(l.position),
      dir: null,
      color: c3(l.diffuse),
      intensity: r4(l.intensity),
      range: r4(l.range),
      size: null,
    }));
}

/** Interior IBL (Lighting.loadInterior) and exterior sky. */
export const BAKE_WORLD = {
  interior: {
    hdri: hdriPath(ASSET_MANIFEST.hdri.id, "assets"),
    strength: 0.42,
    rotationY: Math.PI * 0.35,
    clamp: 1e9,
  },
  exterior: {
    hdri: hdriPath(
      ASSET_MANIFEST.exteriorHdri.id,
      "assets",
      ASSET_MANIFEST.exteriorHdri.res,
    ),
    strength: 1,
    rotationY: 0,
    // The sun lamp carries the direct sun: clip the HDRI's sun disc.
    clamp: 8,
  },
} as const;

export interface ExportInput {
  scene: Scene;
  lighting: Lighting;
  layout: BuildingLayout;
  /** Every luminaire of the build (world space). */
  fixtures: readonly FixturePoint[];
  /** Precomputed `fixtureLights` (shared by all sets). */
  lights?: ExportLight[];
  /** Label of the build (manifest `bake.layout`). */
  label?: string;
}

/** Serialise one bake set (targets + context + lights). */
export function exportSet(input: ExportInput, set: BakeSetName): ExportSet {
  const { scene, lighting, layout } = input;
  const spec = BAKE_SETS[set];
  const origin = setOrigin(set, layout);
  const members = setMeshes(scene, set);
  const targetsMeshes = members.filter(isLightmapped);
  const verify = spec.frame === "control-local" ? "topology" : "position";
  const meshes: Record<string, ExportMesh> = {};
  const targets: ExportTarget[] = [];
  /** Copies baked as the hero, per mesh name (excluded from context). */
  const heroOf = new Map<Mesh, number>();
  if (set === "modules") {
    // Hero per prefab kind (its parts share the instance list).
    const byKind = new Map<string, Mesh[]>();
    for (const m of members) {
      const k = m.name.split(":")[0];
      byKind.set(k, [...(byKind.get(k) ?? []), m]);
    }
    for (const parts of byKind.values()) {
      const ms = worldMatrices(parts[0]);
      const i = ms.length ? heroIndex(ms) : -1;
      for (const p of parts) heroOf.set(p, i);
    }
  }
  const tmin = new Vector3(Infinity, Infinity, Infinity);
  const tmax = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of targetsMeshes) {
    const ms = worldMatrices(m);
    const hero = ms[heroOf.get(m) ?? 0];
    if (!hero) continue;
    meshes[m.name] = serialiseMesh(m);
    targets.push({
      name: m.name,
      hash: partHash(
        m.getVerticesData("position") ?? [],
        m.getIndices() ?? [],
        origin,
      ),
      ...(verify === "topology"
        ? {
            topoHash: topologyHash(m.getTotalVertices(), m.getIndices() ?? []),
            bbox: setBox(m, origin),
          }
        : {}),
      vertexCount: m.getTotalVertices(),
      matrix: mat16(hero),
    });
    const wb = worldBox(localBox(m), hero);
    tmin.minimizeInPlace(wb.min);
    tmax.maximizeInPlace(wb.max);
  }
  const zone = expand(tmin, tmax, CONTEXT_R);
  const targetNames = new Set(targets.map((t) => t.name));
  const instances: ExportSet["instances"] = [];
  for (const m of scene.meshes) {
    if (!isStatic(m)) continue;
    const box = localBox(m);
    const all = worldMatrices(m);
    const keep = all.filter((w, i) => {
      if (targetNames.has(m.name) && i === (heroOf.get(m) ?? 0)) return false;
      return boxesTouch(worldBox(box, w), zone);
    });
    if (!keep.length) continue;
    if (!meshes[m.name]) meshes[m.name] = serialiseMesh(m);
    instances.push({ name: m.name, matrices: keep.map(mat16) });
  }
  // Merged meshes of the set that are not lightmapped (emitters, glass) are
  // context like any other mesh (already in `instances` above).

  const near = (p: [number, number, number], reach: number) =>
    p[0] >= tmin.x - reach &&
    p[0] <= tmax.x + reach &&
    p[1] >= tmin.y - reach &&
    p[1] <= tmax.y + reach &&
    p[2] >= tmin.z - reach &&
    p[2] <= tmax.z + reach;
  let lights: ExportLight[];
  if (set === "control") lights = zoneLights(scene);
  else {
    const all =
      input.lights ??
      fixtureLights(lighting, scene, input.fixtures as FixturePoint[]);
    // Window portals fake the sky: sets with real daylight (sun + exterior
    // sky through the glazing) leave them out.
    lights = all.filter(
      (l) =>
        (!spec.sun || l.kind !== "window") &&
        near(l.pos, Math.min(l.range, CONTEXT_R) + 2),
    );
  }
  const sun = spec.sun
    ? {
        dir: v3(lighting.sun.direction.normalizeToNew()),
        intensity: r4(lighting.sun.intensity),
        color: c3(lighting.sun.diffuse),
      }
    : null;
  return {
    version: 1,
    set,
    frame: spec.frame,
    verify,
    layout: input.label ?? "",
    size: spec.size,
    origin: [origin.x, origin.y, origin.z],
    sun,
    world: { ...(spec.sun ? BAKE_WORLD.exterior : BAKE_WORLD.interior) },
    meshes,
    targets,
    instances,
    lights,
    bounds: { min: v3(tmin), max: v3(tmax) },
    // Pod furniture only exists in occupied bays: the shell prefabs (shared
    // by occupied and vacant bays) are baked without it, so a vacant bay has
    // no rug-shaped shadow; the pod itself is baked inside the room.
    ...(set === "modules"
      ? {
          passes: [
            {
              targets: ["projEntry:", "projBay:", "projEnd:", "projDivider:"],
              hide: ["podZone:"],
            },
            { targets: ["podZone:"], hide: [] },
          ],
        }
      : {}),
  };
}

/** Fixture points of a build as FixturePoints (World.updateFixtures order). */
export function asFixturePoints(points: readonly Vector3[]): FixturePoint[] {
  return points.map((p) =>
    p instanceof FixturePoint ? p : new FixturePoint(p.x, p.y, p.z),
  );
}
