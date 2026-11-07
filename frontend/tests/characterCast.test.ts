import { describe, expect, it } from "vitest";
import {
  castChain,
  pickCastMember,
  pickStable,
  resolvePack,
} from "@/engine/characters/castPlan";
import {
  detectScheme,
  mapToCanonical,
  normalizeBoneName,
} from "@/engine/characters/boneMaps";
import {
  forwardKinematics,
  qfromTo,
  qmul,
  qrot,
  retargetClip,
  type Joint,
  type Quat,
} from "@/engine/characters/retarget";
import {
  isPlayable,
  resolveClipSources,
  validateCustomPack,
} from "@/engine/assets/customPack";
import {
  applyPreset,
  defaultGraphicsSettings,
  parseGraphicsSettings,
  serializeGraphicsSettings,
  updateSetting,
} from "@/engine/fx/graphicsSettings";
import { MPFB_CHARACTER_AVATARS } from "@/engine/assets/charactersMpfb";

describe("cast plan", () => {
  it("mixed = Rocketbox boss, MPFB agents; every chain falls back", () => {
    expect(castChain("mixed", "boss")).toEqual(["rocketbox", "mpfb"]);
    expect(castChain("mixed", "agent")).toEqual(["mpfb", "rocketbox"]);
    expect(castChain("mpfb", "boss")).toEqual(["mpfb", "rocketbox"]);
    expect(castChain("custom", "agent")).toEqual([
      "custom",
      "mpfb",
      "rocketbox",
    ]);
  });

  it("resolvePack waits for a preferred pack that is still probing", () => {
    const chain = castChain("custom", "agent");
    expect(resolvePack(chain, () => "unknown")).toEqual({
      kind: null,
      wait: true,
    });
    expect(
      resolvePack(chain, (k) => (k === "custom" ? "missing" : "ready")),
    ).toEqual({ kind: "mpfb", wait: false });
    expect(resolvePack(chain, () => "missing")).toEqual({
      kind: null,
      wait: false,
    });
  });

  it("picks are deterministic, salted and keep agents off the boss avatar", () => {
    const ids = MPFB_CHARACTER_AVATARS;
    const a = pickCastMember("sess_agent-7", ids, {
      boss: false,
      bossId: "office_m04",
    });
    expect(
      pickCastMember("sess_agent-7", ids, {
        boss: false,
        bossId: "office_m04",
      }),
    ).toBe(a);
    expect(
      pickCastMember("x", ids, { boss: true, bossId: "office_m04" }).id,
    ).toBe("office_m04");
    for (let i = 0; i < 50; i++)
      expect(
        pickCastMember(`a${i}`, ids, { boss: false, bossId: "office_m04" }).id,
      ).not.toBe("office_m04");
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) seen.add(pickStable(`id${i}`, [0, 1, 2, 3]));
    expect(seen.size).toBe(4);
  });
});

describe("graphics setting characterCast", () => {
  it("defaults to mixed, is personal and roundtrips", () => {
    const d = defaultGraphicsSettings();
    expect(d.characterCast).toBe("mixed");
    const s = updateSetting(applyPreset("high", d), "characterCast", "mpfb");
    expect(s.preset).toBe("high"); // personal: no flip to custom
    expect(applyPreset("low", s).characterCast).toBe("mpfb");
    expect(
      parseGraphicsSettings(serializeGraphicsSettings(s)).characterCast,
    ).toBe("mpfb");
    expect(
      parseGraphicsSettings('{"characterCast":"metahuman"}').characterCast,
    ).toBe("mixed");
  });
});

describe("bone maps", () => {
  it("normalises exporter variants", () => {
    expect(normalizeBoneName("mixamorig:LeftArm")).toBe("leftarm");
    expect(normalizeBoneName("mixamorig_LeftArm")).toBe("leftarm");
    expect(normalizeBoneName("mixamorig1:LeftArm")).toBe("leftarm");
    expect(normalizeBoneName("CC_Base_L_Upperarm.001")).toBe("ccbaselupperarm");
  });

  it("maps Mixamo, CC4 and Unreal names to canonical MPFB joints", () => {
    const mix = mapToCanonical(
      [
        "mixamorig:Hips",
        "mixamorig_LeftForeArm",
        "mixamorig:RightHandIndex2",
        "Armature",
      ],
      "mixamo",
    );
    expect(mix.get("mixamorig:Hips")).toBe("pelvis");
    expect(mix.get("mixamorig_LeftForeArm")).toBe("lowerarm_l");
    expect(mix.get("mixamorig:RightHandIndex2")).toBe("index_02_r");
    expect(mix.has("Armature")).toBe(false);
    const cc = mapToCanonical(
      [
        "CC_Base_Hip",
        "CC_Base_Pelvis",
        "CC_Base_Waist",
        "CC_Base_L_Forearm",
        "CC_Base_R_Mid1",
      ],
      "cc",
    );
    expect(cc.get("CC_Base_Hip")).toBe("pelvis");
    expect(cc.has("CC_Base_Pelvis")).toBe(false); // follows the hip rigidly
    expect(cc.get("CC_Base_Waist")).toBe("spine_01");
    expect(cc.get("CC_Base_L_Forearm")).toBe("lowerarm_l");
    expect(cc.get("CC_Base_R_Mid1")).toBe("middle_01_r");
    expect(mapToCanonical(["upperarm_l"], "unreal").get("upperarm_l")).toBe(
      "upperarm_l",
    );
    // overrides win
    expect(
      mapToCanonical(["Bacino"], "mixamo", { pelvis: "Bacino" }).get("Bacino"),
    ).toBe("pelvis");
  });

  it("detects the scheme from bone names", () => {
    const cc = [
      "CC_Base_Hip",
      "CC_Base_Waist",
      "CC_Base_Spine01",
      "CC_Base_Spine02",
      "CC_Base_Head",
      "CC_Base_L_Upperarm",
      "CC_Base_L_Forearm",
      "CC_Base_L_Hand",
      "CC_Base_R_Thigh",
      "CC_Base_R_Calf",
    ];
    expect(detectScheme(cc)).toBe("cc");
    expect(detectScheme(["foo", "bar"])).toBeNull();
  });
});

// A tiny two-bone arm: shoulder at the origin, elbow 0.3 m along the bone.
function arm(restShoulder: Quat, boneAxis: [number, number, number]): Joint[] {
  return [
    { name: "hips", parent: -1, t: [0, 1, 0], r: [0, 0, 0, 1], s: 1 },
    { name: "upper", parent: 0, t: [0, 0.4, 0], r: restShoulder, s: 1 },
    {
      name: "lower",
      parent: 1,
      t: [boneAxis[0] * 0.3, boneAxis[1] * 0.3, boneAxis[2] * 0.3],
      r: [0, 0, 0, 1],
      s: 1,
    },
    {
      name: "hand",
      parent: 2,
      t: [boneAxis[0] * 0.25, boneAxis[1] * 0.25, boneAxis[2] * 0.25],
      r: [0, 0, 0, 1],
      s: 1,
    },
  ];
}

const close = (a: number[], b: number[], eps = 1e-4) =>
  a.every((v, i) => Math.abs(v - b[i]) < eps);

describe("retargeting", () => {
  const canon = new Map([
    ["hips", "pelvis"],
    ["upper", "upperarm_l"],
    ["lower", "lowerarm_l"],
    ["hand", "hand_l"],
  ]);
  const rot = (axis: [number, number, number], ang: number): Quat => {
    const s = Math.sin(ang / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
  };

  it("is the identity on the same skeleton", () => {
    const sk = arm([0, 0, 0, 1], [1, 0, 0]);
    const q = rot([0, 0, 1], 0.7);
    const out = retargetClip({
      src: sk,
      tgt: sk,
      srcCanon: canon,
      tgtCanon: canon,
      tracks: [{ joint: "upper", times: [0, 1], rotations: [[0, 0, 0, 1], q] }],
    });
    const upper = out.find((t) => t.joint === "upper")!;
    expect(close(upper.rotations![upper.rotations!.length - 1], q)).toBe(true);
  });

  it("matches world bone directions across different local axes and rest poses", () => {
    // Source: bones along +X (T-pose). Target: bones along +Y in local space,
    // rotated so the rest arm hangs 45° down (A-pose).
    const src = arm([0, 0, 0, 1], [1, 0, 0]);
    const tgtRest = qmul(
      rot([0, 0, 1], -Math.PI / 4),
      rot([0, 0, 1], -Math.PI / 2),
    );
    const tgt = arm(tgtRest, [0, 1, 0]);
    const lift = rot([0, 0, 1], Math.PI / 3); // raise the arm 60° above horizontal
    const out = retargetClip({
      src,
      tgt,
      srcCanon: canon,
      tgtCanon: canon,
      tracks: [
        { joint: "upper", times: [0, 1], rotations: [[0, 0, 0, 1], lift] },
      ],
    });
    const last = (j: string) => {
      const tr = out.find((t) => t.joint === j)!;
      return tr.rotations![tr.rotations!.length - 1];
    };
    const ws = forwardKinematics(src, (i) => (i === 1 ? lift : undefined));
    const wt = forwardKinematics(tgt, (i) =>
      i === 1 ? last("upper") : i === 2 ? last("lower") : undefined,
    );
    const dir = (w: ReturnType<typeof forwardKinematics>) => {
      const d = [
        w.t[2][0] - w.t[1][0],
        w.t[2][1] - w.t[1][1],
        w.t[2][2] - w.t[1][2],
      ];
      const n = Math.hypot(d[0], d[1], d[2]);
      return d.map((v) => v / n);
    };
    expect(close(dir(wt), dir(ws), 1e-3)).toBe(true);
  });

  it("transfers hips translation scaled by hips height", () => {
    const src = arm([0, 0, 0, 1], [1, 0, 0]);
    const tgt = arm([0, 0, 0, 1], [1, 0, 0]).map((j) =>
      j.name === "hips"
        ? { ...j, t: [0, 0.5, 0] as [number, number, number] }
        : j,
    );
    const out = retargetClip({
      src,
      tgt,
      srcCanon: canon,
      tgtCanon: canon,
      tracks: [
        {
          joint: "hips",
          times: [0, 1],
          rotations: [
            [0, 0, 0, 1],
            [0, 0, 0, 1],
          ],
          translations: [
            [0, 1, 0],
            [0, 0.6, 0.2],
          ],
        },
      ],
    });
    const hips = out.find((t) => t.joint === "hips")!;
    const t = hips.translations![hips.translations!.length - 1];
    expect(close(t, [0, 0.3, 0.1])).toBe(true);
  });

  it("quaternion helpers", () => {
    const q = qfromTo([1, 0, 0], [0, 1, 0]);
    expect(close(qrot(q, [1, 0, 0]), [0, 1, 0])).toBe(true);
    const flip = qfromTo([1, 0, 0], [-1, 0, 0]);
    expect(close(qrot(flip, [1, 0, 0]), [-1, 0, 0])).toBe(true);
  });
});

describe("custom pack manifest", () => {
  const good = {
    version: 1,
    characters: [
      {
        id: "maya",
        file: "maya.glb",
        heightM: 1.68,
        gender: "f",
        role: "boss",
        skeleton: "cc",
        clips: { idle: "Idle_Loop", sit: "Sit_Loop", dance: "Dance" },
        animations: "office",
      },
      {
        id: "theo",
        file: "people/theo.glb",
        heightM: 1.8,
        skeleton: "metahuman",
      },
    ],
    animations: [
      {
        id: "office",
        file: "anims/office.glb",
        skeleton: "mixamo",
        clips: { type: "Typing" },
      },
    ],
  };

  it("accepts a valid manifest, normalises aliases and defaults", () => {
    const v = validateCustomPack(good);
    expect(v.errors).toEqual([]);
    const m = v.manifest!;
    expect(m.characters[0].clips).toEqual({
      idle: "Idle_Loop",
      sitIdle: "Sit_Loop",
    });
    expect(v.warnings.some((w) => w.includes("dance"))).toBe(true);
    expect(m.characters[1]).toMatchObject({
      skeleton: "unreal",
      gender: "x",
      role: "any",
      scale: 1,
      animations: [],
    });
    expect(m.borrowMpfb).toBe(true);
  });

  it("rejects bad input with readable errors", () => {
    expect(validateCustomPack(null).manifest).toBeNull();
    expect(validateCustomPack({ characters: [] }).errors).toContain(
      "characters must be a non-empty array",
    );
    const bad = validateCustomPack({
      characters: [
        { id: "a", file: "../../etc/passwd.glb", heightM: 1.7, skeleton: "cc" },
        {
          id: "a",
          file: "a.fbx",
          heightM: 9,
          skeleton: "daz",
          animations: ["nope"],
        },
      ],
    });
    expect(bad.manifest).toBeNull();
    const text = bad.errors.join("\n");
    expect(text).toMatch(/characters\[0\]\.file/);
    expect(text).toMatch(/duplicated/);
    expect(text).toMatch(/heightM/);
    expect(text).toMatch(/skeleton must be one of/);
    expect(text).toMatch(/unknown animation set "nope"/);
  });

  it("resolves clip sources: embedded → shared set → borrowed MPFB", () => {
    const m = validateCustomPack(good).manifest!;
    const src = resolveClipSources(m.characters[0], m, true);
    expect(src.idle).toEqual({ from: "embedded", name: "Idle_Loop" });
    expect(src.type).toEqual({
      from: "animation",
      set: "office",
      name: "Typing",
    });
    expect(src.walk).toEqual({ from: "mpfb", name: "walk" });
    expect(isPlayable(src)).toBe(true);
    const noBorrow = resolveClipSources(m.characters[1], m, false);
    expect(isPlayable(noBorrow)).toBe(false);
  });
});
