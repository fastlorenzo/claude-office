import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@/engine/babylon";
import { MannequinRig } from "@/engine/characters/MannequinRig";
import { FeedScheduler } from "@/engine/screens/FeedScheduler";

describe("MannequinRig (NullEngine)", () => {
  it("builds one skinned mesh, animates every pose and disposes cleanly", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const before = scene.meshes.length;
    const rig = new MannequinRig(scene, {
      id: "a1",
      boss: false,
      color: "#3B82F6",
    });
    const boss = new MannequinRig(scene, {
      id: "boss",
      boss: true,
      color: "#000000",
    });
    expect(rig.getMeshes()).toHaveLength(1);
    expect(rig.getMeshes()[0].skeleton?.bones.length).toBe(17);
    expect(rig.getMeshes()[0].subMeshes).toHaveLength(1); // 1 draw call
    // Shared material across characters.
    expect(rig.getMeshes()[0].material).toBe(boss.getMeshes()[0].material);
    for (const p of [
      "idle",
      "walking",
      "sitting",
      "typing",
      "thinking",
      "raiseHand",
      "celebrating",
    ] as const) {
      rig.setPose(p, 0.2);
      rig.update(0.1, "near");
      rig.update(0.1, "mid");
      rig.update(0.1, "far");
    }
    rig.setMoving(1.4);
    rig.setTint("#EF4444");
    rig.update(0.5, "near");
    rig.dispose();
    boss.dispose();
    expect(scene.meshes.length).toBe(before);
    expect(scene.skeletons.length).toBe(0);
    scene.dispose();
    engine.dispose();
  });
});

describe("FeedScheduler (NullEngine)", () => {
  it("adds feeds, toggles customRenderTargets and removes cleanly", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const feeds = new FeedScheduler(scene);
    const changed: string[] = [];
    feeds.onChanged.add((id) => changed.push(id));
    const rtt = feeds.addFeed(
      "s1",
      { position: { x: 0, y: 2, z: 0 }, target: { x: 1, y: 0, z: 1 } },
      () => [],
    );
    expect(feeds.getTexture("s1")).toBe(rtt);
    expect(scene.customRenderTargets).not.toContain(rtt);
    feeds.setActive(true);
    expect(scene.customRenderTargets).toContain(rtt);
    feeds.update();
    feeds.setActive(false);
    expect(scene.customRenderTargets).not.toContain(rtt);
    feeds.removeFeed("s1");
    expect(feeds.getTexture("s1")).toBeNull();
    expect(changed).toEqual(["s1", "s1"]);
    feeds.dispose();
    scene.dispose();
    engine.dispose();
  });
});
