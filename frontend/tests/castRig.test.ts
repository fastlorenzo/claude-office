import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Animation,
  AnimationGroup,
  AssetContainer,
  CreateBox,
  NullEngine,
  Quaternion,
  Scene,
  Skeleton,
  Bone,
  TransformNode,
  Matrix,
  Vector3,
  VertexBuffer,
} from "@/engine/babylon";
import { CastRig, tryCreateGltfRig } from "@/engine/characters/CastRig";
import {
  enablePacks,
  extractJoints,
  setCharacterCast,
  type PackIo,
} from "@/engine/characters/characterPacks";

/**
 * Synthetic glTF-like avatar container: __root__ → Armature → bone nodes, a
 * skinned box bound to a skeleton whose bones are linked to the nodes, and
 * optional named clips rotating the second bone.
 */
function makeAvatar(
  scene: Scene,
  bones: string[],
  clips: string[],
): AssetContainer {
  const root = new TransformNode("__root__", scene);
  const armature = new TransformNode("Armature", scene);
  armature.parent = root;
  const nodes: TransformNode[] = [];
  bones.forEach((name, i) => {
    const n = new TransformNode(name, scene);
    n.parent = i === 0 ? armature : nodes[i - 1];
    n.position.set(0, i === 0 ? 1 : 0.3, 0);
    n.rotationQuaternion = Quaternion.Identity();
    nodes.push(n);
  });
  const sk = new Skeleton("sk", "sk", scene);
  const bjs: Bone[] = [];
  nodes.forEach((n, i) => {
    const b = new Bone(
      n.name,
      sk,
      i === 0 ? null : bjs[i - 1],
      Matrix.Identity(),
    );
    b.linkTransformNode(n);
    bjs.push(b);
  });
  const mesh = CreateBox("body", { size: 0.3 }, scene);
  mesh.parent = armature;
  const nv = mesh.getTotalVertices();
  mesh.setVerticesData(
    VertexBuffer.MatricesIndicesKind,
    new Array(nv * 4).fill(0),
  );
  mesh.setVerticesData(
    VertexBuffer.MatricesWeightsKind,
    Array.from({ length: nv * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  );
  mesh.skeleton = sk;
  const groups = clips.map((name) => {
    const g = new AnimationGroup(name, scene);
    const a = new Animation(
      `${name}_r`,
      "rotationQuaternion",
      60,
      Animation.ANIMATIONTYPE_QUATERNION,
    );
    a.setKeys([
      { frame: 0, value: Quaternion.Identity() },
      { frame: 30, value: Quaternion.RotationAxis(new Vector3(0, 0, 1), 0.5) },
    ]);
    g.addTargetedAnimation(a, nodes[1]);
    const p = new Animation(
      `${name}_t`,
      "position",
      60,
      Animation.ANIMATIONTYPE_VECTOR3,
    );
    p.setKeys([
      { frame: 0, value: new Vector3(0, 1, 0) },
      { frame: 30, value: new Vector3(0, 0.6, 0.1) },
    ]);
    g.addTargetedAnimation(p, nodes[0]);
    return g;
  });
  const c = new AssetContainer(scene);
  c.meshes.push(mesh);
  c.transformNodes.push(root, armature, ...nodes);
  c.skeletons.push(sk);
  c.animationGroups.push(...groups);
  c.removeAllFromScene();
  return c;
}

const MPFB_BONES = [
  "pelvis",
  "spine_01",
  "spine_02",
  "spine_03",
  "neck_01",
  "head",
];
const BIPED_BONES = [
  "Bip01 Pelvis",
  "Bip01 Spine",
  "Bip01 Spine1",
  "Bip01 Spine2",
  "Bip01 Neck",
  "Bip01 Head",
];
const MIXAMO_BONES = [
  "mixamorig:Hips",
  "mixamorig:Spine",
  "mixamorig:Spine1",
  "mixamorig:Spine2",
  "mixamorig:Neck",
  "mixamorig:Head",
];
const OFFICE = [
  "idle",
  "idleSubtle",
  "walk",
  "sitIdle",
  "type",
  "thinking",
  "raiseHand",
  "cheer",
];

function io(
  scene: Scene,
  avail: { rocketbox?: boolean; mpfb?: boolean; custom?: unknown },
): PackIo {
  return {
    loadContainer: async (url) => {
      if (url.includes("characters-mpfb/") && avail.mpfb)
        return makeAvatar(scene, MPFB_BONES, OFFICE);
      if (url.includes("characters-custom/") && avail.custom)
        return makeAvatar(scene, MIXAMO_BONES, []);
      if (url.includes("/characters/") && avail.rocketbox)
        return url.includes("animations_")
          ? makeAvatar(scene, BIPED_BONES, OFFICE)
          : makeAvatar(scene, BIPED_BONES, []);
      return null;
    },
    fetchJson: async (url) => {
      if (url.includes("characters-mpfb/") && avail.mpfb)
        return { avatars: [] };
      if (url.includes("characters-custom/")) return avail.custom ?? null;
      return null;
    },
  };
}

async function flush(
  rigs: CastRig[],
  want?: (r: CastRig) => boolean,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (want ? rigs.every(want) : false) return;
  }
}

function counts(scene: Scene) {
  return {
    meshes: scene.meshes.length,
    skeletons: scene.skeletons.length,
    groups: scene.animationGroups.length,
    nodes: scene.transformNodes.length,
  };
}

const opts = (id: string, boss = false) => ({ id, boss, color: "#3B82F6" });

describe("CastRig (NullEngine)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clones per actor, swaps live on a cast change and leaks nothing", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    enablePacks(scene, io(scene, { rocketbox: true, mpfb: true }));
    const before = counts(scene);

    const boss = tryCreateGltfRig(scene, opts("s1_boss", true))!;
    const a1 = tryCreateGltfRig(scene, opts("s1_a1"))!;
    const a2 = tryCreateGltfRig(scene, opts("s1_a2"))!;
    expect(boss).toBeInstanceOf(CastRig);
    expect(a1.shownKey).toBe("mannequin");
    const swapped: string[] = [];
    a1.meshesChanged = () => swapped.push(a1.shownKey);
    await flush([boss, a1, a2], (r) => r.shownKey !== "mannequin");

    // mixed: Rocketbox hero boss, MPFB agents
    expect(boss.shownKey).toBe("rocketbox:business_male_01");
    expect(a1.shownKey.startsWith("mpfb:")).toBe(true);
    expect(swapped).toEqual([a1.shownKey]);
    // every actor owns its skeleton (no shared pose)
    const sk1 = a1.getMeshes().find((m) => m.skeleton)?.skeleton;
    const sk2 = a2.getMeshes().find((m) => m.skeleton)?.skeleton;
    expect(sk1).toBeTruthy();
    expect(sk1).not.toBe(sk2);
    for (const p of [
      "idle",
      "walking",
      "typing",
      "thinking",
      "raiseHand",
      "celebrating",
    ] as const) {
      a1.setPose(p, 0.25);
      a1.update(0.1, "near");
      a1.update(0.1, "mid");
    }
    a1.setMoving(1.3);
    a1.update(0.1, "near");
    a1.update(0.1, "far");
    const settled = counts(scene);

    // live switch: everyone Rocketbox, then back to mixed
    setCharacterCast(scene, "rocketbox");
    await flush([a1, a2], (r) => r.shownKey.startsWith("rocketbox:"));
    expect(a1.shownKey.startsWith("rocketbox:")).toBe(true);
    expect(boss.shownKey).toBe("rocketbox:business_male_01"); // unchanged, not rebuilt
    setCharacterCast(scene, "mixed");
    await flush([a1, a2], (r) => r.shownKey.startsWith("mpfb:"));
    expect(counts(scene)).toEqual(settled);

    for (const r of [boss, a1, a2]) r.dispose();
    expect(counts(scene)).toEqual(before);
    scene.dispose();
    engine.dispose();
  });

  it("falls back mpfb → rocketbox → mannequin without errors when packs are missing", async () => {
    const err = vi.spyOn(console, "error");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    enablePacks(scene, io(scene, { rocketbox: true }));
    setCharacterCast(scene, "mpfb");
    const a = tryCreateGltfRig(scene, opts("s2_a1"))!;
    await flush([a], (r) => r.shownKey !== "mannequin");
    expect(a.shownKey.startsWith("rocketbox:")).toBe(true);
    a.dispose();

    const scene2 = new Scene(engine);
    enablePacks(scene2, io(scene2, {}));
    const b = tryCreateGltfRig(scene2, opts("s3_a1"))!;
    await flush([b]);
    expect(b.shownKey).toBe("mannequin");
    expect(b.getMeshes().length).toBeGreaterThan(0);
    b.dispose();
    expect(err).not.toHaveBeenCalled();
    scene.dispose();
    scene2.dispose();
    engine.dispose();
  });

  it("custom pack borrows MPFB clips by retargeting onto a Mixamo skeleton", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const manifest = {
      version: 1,
      characters: [
        { id: "c1", file: "c1.glb", heightM: 1.7, skeleton: "mixamo" },
      ],
    };
    enablePacks(scene, io(scene, { mpfb: true, custom: manifest }));
    setCharacterCast(scene, "custom");
    const a = tryCreateGltfRig(scene, opts("s4_a1"))!;
    await flush([a], (r) => r.shownKey !== "mannequin");
    expect(a.shownKey).toBe("custom:c1");
    // the borrowed clips drive the Mixamo bones
    const groups = scene.animationGroups.filter((g) =>
      g.name.endsWith("__s4_a1"),
    );
    const targets = new Set(
      groups.flatMap((g) =>
        g.targetedAnimations.map((t) => (t.target as { name: string }).name),
      ),
    );
    expect([...targets].some((n) => n.startsWith("mixamorig:Spine"))).toBe(
      true,
    );
    a.setPose("typing", 0);
    a.update(0.2, "near");
    a.dispose();

    // invalid manifest → falls back to MPFB
    const scene2 = new Scene(engine);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    enablePacks(
      scene2,
      io(scene2, { mpfb: true, custom: { characters: "nope" } }),
    );
    setCharacterCast(scene2, "custom");
    const b = tryCreateGltfRig(scene2, opts("s5_a1"))!;
    await flush([b], (r) => r.shownKey !== "mannequin");
    expect(b.shownKey.startsWith("mpfb:")).toBe(true);
    expect(warn).toHaveBeenCalled();
    b.dispose();
    scene.dispose();
    scene2.dispose();
    engine.dispose();
  });

  it("extracts joints below __root__ in parent order", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const c = makeAvatar(scene, MPFB_BONES, []);
    const j = extractJoints(c);
    const names = j.map((x) => x.name);
    expect(names[0]).toBe("Armature");
    expect(names).toContain("head");
    for (const [i, x] of j.entries()) expect(x.parent).toBeLessThan(i);
    scene.dispose();
    engine.dispose();
  });
});
