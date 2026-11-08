/**
 * "The main building shell vanished" (floors, walls, roof, room ceilings,
 * desks gone; control room, dock, props, glass and emissive strips fine).
 *
 * Root cause (reproduced on world-debug with ?gfxStep=areaLights:false@20,
 * i.e. what a tier step high -> medium does): the shared surface materials
 * are frozen; a frozen material answers isReadyForSubMesh() from its cache
 * and keeps the effect compiled for the light set of that moment. Disposing
 * a light that effect uses (area lights off, a light-pool resize) leaves the
 * effect declaring an unbound light uniform block, and WebGL rejects every
 * draw ("used but unbound uniform buffer"): counted as drawn, never seen.
 * Meshes that were not being drawn at that moment (dock hidden by the factory
 * gate, control room far) compile fresh later, which is why they survived.
 *
 * Plus the co-causes: change-only gate caches that never re-enable a node
 * switched off elsewhere, and the free-fly camera treated as "in the room"
 * below it (room sightline gate hiding the factory hall).
 */
import { describe, expect, it } from "vitest";
import {
  CreateBox,
  DirectionalLight,
  HemisphericLight,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  TransformNode,
  Vector3,
  type Mesh,
} from "@/engine/babylon";
import {
  refreezeStale,
  staleLights,
  staleMeshEffect,
} from "@/engine/materials/staleEffects";
import { Lighting } from "@/engine/fx/Lighting";
import { enforceEnabled, GateDrift } from "@/engine/world/gating";
import {
  installEnableTracking,
  lastEnable,
  vanishReport,
} from "@/engine/world/vanishDiag";
import { asGate } from "@/engine/world/gateTrace";
import {
  VisibilityController,
  visRoomsOfProjects,
  type VisRoomHandle,
} from "@/engine/world/Visibility";
import { computeBuildingVisibility } from "@/engine/world/buildingVisibility";
import { flyZoneAt } from "@/engine/world/flyZone";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, zoneAt3 } from "@/engine/layout/factoryLayout";

function litScene(): { scene: Scene; mesh: Mesh; mat: PBRMaterial } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
  new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  const mesh = CreateBox("factory:mat:wall", { size: 1 }, scene);
  const mat = new PBRMaterial("mat:wall", scene);
  mat.maxSimultaneousLights = 6;
  mesh.material = mat;
  return { scene, mesh, mat };
}

const ready = (mesh: Mesh, mat: PBRMaterial) =>
  mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]);

/** Poll until the submesh is ready (NullEngine compiles / loads the BRDF LUT async). */
async function settle(
  mesh: Mesh,
  mat: PBRMaterial,
  fresh = false,
): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    mesh.getScene().incrementRenderId(); // as each rendered frame does
    // `fresh`: until the hot-swapped effect matches the current lights.
    if (ready(mesh, mat) && (!fresh || !staleMeshEffect(mesh, false)))
      return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("frozen materials and light changes (root cause)", () => {
  it("a frozen material keeps an effect that binds a disposed light", async () => {
    const { scene, mesh, mat } = litScene();
    const area = new PointLight("areaL0", new Vector3(0, 3, 0), scene);
    expect(await settle(mesh, mat)).toBe(true);
    const compiled = mesh.subMeshes[0].effect;
    expect(staleLights(mesh, mat, compiled)).toBeNull();
    mat.freeze();
    expect(await settle(mesh, mat)).toBe(true); // freeze() forces one re-check
    area.dispose(); // tier step: area lights off
    // Babylon answers from the frozen cache at once: same effect, 3 lights bound.
    expect(ready(mesh, mat)).toBe(true);
    expect(mesh.subMeshes[0].effect).toBe(compiled);
    expect(staleLights(mesh, mat, mesh.subMeshes[0].effect)).toMatch(
      /effect binds 3 lights, mesh has 2/,
    );
    expect(staleMeshEffect(mesh)).not.toBeNull();
    scene.getEngine().dispose();
  });

  it("refreezeStale thaws exactly the stale materials and they recompile", async () => {
    const { scene, mesh, mat } = litScene();
    const other = CreateBox("control:mat:x", { size: 1 }, scene);
    const okMat = new PBRMaterial("mat:unlit", scene);
    okMat.disableLighting = true;
    other.material = okMat;
    const area = new PointLight("areaL0", new Vector3(0, 3, 0), scene);
    expect(await settle(mesh, mat)).toBe(true);
    expect(await settle(other, okMat)).toBe(true);
    mat.freeze();
    okMat.freeze();
    await settle(mesh, mat);
    area.dispose();
    expect(refreezeStale(scene)).toBe(1);
    expect(mat.isFrozen).toBe(true);
    expect(await settle(mesh, mat, true)).toBe(true);
    expect(staleLights(mesh, mat, mesh.subMeshes[0].effect)).toBeNull();
    // Nothing left to thaw: no thrash on the next scan.
    expect(refreezeStale(scene)).toBe(0);
    scene.getEngine().dispose();
  });

  it("a light added later is reported too (its light would be ignored)", async () => {
    const { scene, mesh, mat } = litScene();
    expect(await settle(mesh, mat)).toBe(true);
    mat.freeze();
    await settle(mesh, mat);
    new PointLight("areaL0", new Vector3(0, 3, 0), scene);
    expect(staleLights(mesh, mat, mesh.subMeshes[0].effect)).toMatch(/ignored/);
    scene.getEngine().dispose();
  });

  it("Lighting thaws stale frozen materials on the frame after a light change", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lighting = new Lighting(scene);
    const mesh = CreateBox("shell:mat:wall", { size: 1 }, scene);
    const mat = new PBRMaterial("mat:wall", scene);
    mat.maxSimultaneousLights = 6;
    mesh.material = mat;
    const extra = new PointLight("areaL1", new Vector3(0, 3, 0), scene);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(await settle(mesh, mat)).toBe(true);
    mat.freeze();
    await settle(mesh, mat);
    const before = lighting.staleRefreezes;
    extra.dispose();
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(lighting.staleRefreezes).toBe(before + 1);
    expect(await settle(mesh, mat, true)).toBe(true);
    expect(staleMeshEffect(mesh)).toBeNull();
    lighting.dispose();
    engine.dispose();
  });

  it("vanishReport flags the stale shell mesh", async () => {
    const { scene, mesh, mat } = litScene();
    const area = new PointLight("areaL0", new Vector3(0, 3, 0), scene);
    await settle(mesh, mat);
    mat.freeze();
    await settle(mesh, mat);
    area.dispose();
    const r = vanishReport(scene);
    expect(r.groups.main.stale).toBe(1);
    const row = r.all.find((x) => x.name === mesh.name);
    expect(row?.why.join(" ")).toMatch(/staleEffect/);
    scene.getEngine().dispose();
  });
});

describe("gates share nodes idempotently (co-cause)", () => {
  it("enforceEnabled switches only what differs and attributes the toggle", async () => {
    installEnableTracking();
    const scene = new Scene(new NullEngine());
    const a = new TransformNode("factory:a", scene);
    const b = new TransformNode("factory:b", scene);
    b.setEnabled(false);
    expect(enforceEnabled("building:factory", [a, b, null], true)).toBe(1);
    expect(b.isEnabled()).toBe(true);
    expect(enforceEnabled("building:factory", [a, b], true)).toBe(0);
    asGate("feed", () => a.setEnabled(false));
    expect(lastEnable(a)).toMatchObject({ gate: "feed", on: false });
    expect(lastEnable(b)).toMatchObject({ gate: "building:factory", on: true });
    scene.getEngine().dispose();
  });

  it("two gates on one node: the room gate heals what another switched off", async () => {
    const scene = new Scene(new NullEngine());
    const shell = new TransformNode("proj:p0", scene);
    const pod = new TransformNode("room:s0", scene);
    const deps = {
      screens: { setRoomDetail() {}, forgetRoom() {} },
      actors: { setRoomDetail() {}, forgetRoom() {} },
    } as unknown as ConstructorParameters<typeof VisibilityController>[0];
    const vc = new VisibilityController(deps);
    const handles = new Map<string, VisRoomHandle>([
      [
        "p0",
        {
          root: { setEnabled: (v) => enforceEnabled("rooms", [shell, pod], v) },
          members: ["s0"],
        },
      ],
    ]);
    const sessions = [{ id: "s0", createdAt: 0 }];
    const layout = generateLayout(allocateSlots(new Map(), sessions));
    const room = visRoomsOfProjects(layout.projects)[0];
    const inp = {
      eye: {
        x: (room.minX + room.maxX) / 2,
        y: 1.7,
        z: (room.minZ + room.maxZ) / 2,
      },
      yaw: 0,
      halfFov: 1,
      zone: {
        kind: "room" as const,
        sessionId: "s0",
        projectId: layout.projects[0].projectId,
      },
      rooms: [{ ...room, id: "p0" }],
      hallLength: layout.hall.length,
      hallHalfWidth: layout.hall.width / 2,
    };
    inp.zone.projectId = "p0";
    vc.update(0, handles, inp, false);
    expect(shell.isEnabled()).toBe(true);
    shell.setEnabled(false); // e.g. a stale handle / another system
    vc.update(1000, handles, inp, false);
    expect(shell.isEnabled()).toBe(true);
    expect(vc.drift.total).toBe(1);
    scene.getEngine().dispose();
  });

  it("GateDrift counts only nodes found off while already decided on", async () => {
    const d = new GateDrift();
    d.begin();
    d.note(undefined, true, 3); // first decision: not drift
    d.note(false, true, 2); // decision flipped on: not drift
    d.note(true, true, 1); // was on, found off: drift
    d.note(true, false, 4); // hiding: not drift
    expect(d.last).toBe(1);
  });
});

describe("free-fly camera drives visibility from where it is (co-cause)", () => {
  const sessions = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    createdAt: i,
  }));
  const layout = generateLayout(allocateSlots(new Map(), sessions));
  const fl = buildFactoryLayout(layout);
  const p = layout.projects[0];
  const above = { x: p.origin.x, y: 20, z: p.origin.z };

  it("zoneAt3 (walking query) calls a point high above a room 'room'", async () => {
    expect(zoneAt3(fl, layout, above).kind).toBe("room");
  });

  it("flyZoneAt: above the roof is outside, under it the factory volume", async () => {
    expect(flyZoneAt(fl, layout, above).kind).toBe("outside");
    expect(flyZoneAt(fl, layout, { ...above, y: 6 }).kind).toBe("factory");
    const inRoom = { x: p.origin.x, y: 1.7, z: p.origin.z };
    expect(flyZoneAt(fl, layout, inRoom)).toEqual(zoneAt3(fl, layout, inRoom));
  });

  it("an aerial fly camera keeps the whole building visible", async () => {
    const s = layout.lobby.size;
    const vis = computeBuildingVisibility({
      vis: {
        eye: above,
        yaw: Math.PI, // looking away from the room's windows
        halfFov: 0.6,
        zone: flyZoneAt(fl, layout, above),
        rooms: visRoomsOfProjects(layout.projects),
        hallLength: layout.hall.length,
        hallHalfWidth: layout.hall.width / 2,
      },
      lobbyRect: { x0: -s.x / 2, x1: s.x / 2, z0: -s.z - 4, z1: 0 },
    });
    expect(vis).toEqual({
      lobby: true,
      entrance: true,
      factory: true,
      exterior: true,
    });
  });
});
