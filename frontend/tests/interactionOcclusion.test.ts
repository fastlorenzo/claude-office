/**
 * WS2 P10: the interaction probe picks interactables only and tests opaque
 * static colliders from the registry list (glass stays see-through).
 */
import { describe, expect, it } from "vitest";
import {
  CreatePlane,
  NullEngine,
  Scene,
  UniversalCamera,
  Vector3,
} from "@/engine/babylon";
import type { WorldEvents } from "@/engine/contracts";
import { Interaction } from "@/engine/interaction/Interaction";
import { Colliders } from "@/engine/physics/Colliders";
import { Emitter } from "@/engine/util/Emitter";

function setup() {
  const scene = new Scene(new NullEngine());
  const cam = new UniversalCamera("cam", new Vector3(0, 1.6, 0), scene);
  cam.setTarget(new Vector3(0, 1.6, 10));
  scene.activeCamera = cam;
  const screen = CreatePlane("screen", { size: 1 }, scene);
  screen.position.set(0, 1.6, 2.5);
  screen.metadata = {
    interact: { kind: "screen", sessionId: "s1", roomLabel: "r" },
  };
  screen.isPickable = true;
  const colliders = new Colliders(scene);
  const events = new Emitter<WorldEvents>();
  const seen: (string | null)[] = [];
  events.on("interaction", (e) => seen.push(e ? e.target.kind : null));
  const ia = new Interaction(
    scene,
    () => cam,
    null,
    events,
    () => cam.position.clone(),
  );
  let t = 0;
  const tick = () => {
    t += 200;
    scene.render(); // world matrices, bounds and camera matrices
    ia.update(t);
  };
  return { scene, colliders, seen, tick };
}

describe("interaction occlusion via the collider registry", () => {
  it("registers itself per scene", () => {
    const { scene, colliders } = setup();
    expect(Colliders.of(scene)).toBe(colliders);
    colliders.dispose();
    expect(Colliders.of(scene)).toBeNull();
  });

  it("targets the screen with nothing in between", () => {
    const { seen, tick } = setup();
    tick();
    expect(seen.at(-1)).toBe("screen");
  });

  it("an opaque collider in front hides it; glass does not", () => {
    const a = setup();
    a.colliders.addBox(
      "wall",
      new Vector3(0, 1.5, 1.2),
      new Vector3(3, 3, 0.1),
    );
    a.tick();
    expect(a.seen.at(-1) ?? null).toBeNull();
    expect(a.colliders.occluders()).toHaveLength(1);

    const b = setup();
    b.colliders.addBox(
      "glass",
      new Vector3(0, 1.5, 1.2),
      new Vector3(3, 3, 0.1),
      0,
      { seeThrough: true },
    );
    b.tick();
    expect(b.seen.at(-1)).toBe("screen");
    expect(b.colliders.occluders()).toHaveLength(0);
  });

  it("a collider behind the target does not hide it", () => {
    const { colliders, seen, tick } = setup();
    colliders.addBox("back", new Vector3(0, 1.5, 3.2), new Vector3(3, 3, 0.1));
    tick();
    expect(seen.at(-1)).toBe("screen");
  });

  it("disposing the occluder's group restores the target", () => {
    const { colliders, seen, tick } = setup();
    colliders.addBox("wall", new Vector3(0, 1.5, 1.2), new Vector3(3, 3, 0.1));
    tick();
    expect(seen.at(-1) ?? null).toBeNull();
    colliders.disposeGroup("wall");
    tick();
    expect(seen.at(-1)).toBe("screen");
  });

  it("collider proxies are invisible, unpickable and keep static bounds", () => {
    const { colliders } = setup();
    const m = colliders.addBox("w", new Vector3(5, 1, 7), new Vector3(1, 2, 1));
    expect(m.isVisible).toBe(false);
    expect(m.isPickable).toBe(false);
    expect(m.doNotSyncBoundingInfo).toBe(true);
    const c = m.getBoundingInfo().boundingBox.centerWorld;
    expect([c.x, c.y, c.z]).toEqual([5, 1, 7]);
  });
});
