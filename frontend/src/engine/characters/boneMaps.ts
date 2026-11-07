/**
 * Pure bone-name maps between skeleton naming schemes (no Babylon).
 *
 * The canonical names are the MPFB `game_engine` rig (Unreal-mannequin style),
 * because the MPFB cast is the clip donor for packs without office clips.
 * Each scheme lists canonical → scheme bone name; lookups normalise names
 * (case, separators, "mixamorig:" / "mixamorig_" prefixes, exporter suffixes)
 * so "mixamorig:LeftArm", "mixamorig_LeftArm" and "mixamorigLeftArm" all match.
 */

export type SkeletonScheme = "mpfb" | "rocketbox" | "mixamo" | "unreal" | "cc";

export const SKELETON_SCHEMES: readonly SkeletonScheme[] = [
  "mpfb",
  "rocketbox",
  "mixamo",
  "unreal",
  "cc",
];

/** Canonical (MPFB game_engine) joints that matter for retargeting. */
export const CANONICAL_BONES = [
  "pelvis",
  "spine_01",
  "spine_02",
  "spine_03",
  "neck_01",
  "head",
  ...sided("clavicle"),
  ...sided("upperarm"),
  ...sided("lowerarm"),
  ...sided("hand"),
  ...fingers(),
  ...sided("thigh"),
  ...sided("calf"),
  ...sided("foot"),
  ...sided("ball"),
] as const;

function sided(b: string): string[] {
  return [`${b}_l`, `${b}_r`];
}

function fingers(): string[] {
  const out: string[] = [];
  for (const f of ["thumb", "index", "middle", "ring", "pinky"])
    for (const i of [1, 2, 3]) out.push(...sided(`${f}_0${i}`));
  return out;
}

type Map_ = Record<string, string>;

function build(
  fn: (canon: string, side: "l" | "r" | null, base: string) => string | null,
): Map_ {
  const out: Map_ = {};
  for (const c of CANONICAL_BONES) {
    const m = /^(.*)_([lr])$/.exec(c);
    const name = m ? fn(c, m[2] as "l" | "r", m[1]) : fn(c, null, c);
    if (name) out[c] = name;
  }
  return out;
}

const MIXAMO_FINGER: Record<string, string> = {
  thumb: "Thumb",
  index: "Index",
  middle: "Middle",
  ring: "Ring",
  pinky: "Pinky",
};

const MIXAMO = build((c, side, base) => {
  const S = side === "l" ? "Left" : "Right";
  const flat: Record<string, string> = {
    pelvis: "Hips",
    spine_01: "Spine",
    spine_02: "Spine1",
    spine_03: "Spine2",
    neck_01: "Neck",
    head: "Head",
  };
  if (!side) return flat[c] ? `mixamorig:${flat[c]}` : null;
  const limb: Record<string, string> = {
    clavicle: "Shoulder",
    upperarm: "Arm",
    lowerarm: "ForeArm",
    hand: "Hand",
    thigh: "UpLeg",
    calf: "Leg",
    foot: "Foot",
    ball: "ToeBase",
  };
  if (limb[base]) return `mixamorig:${S}${limb[base]}`;
  const f = /^(\w+)_0(\d)$/.exec(base);
  if (f && MIXAMO_FINGER[f[1]])
    return `mixamorig:${S}Hand${MIXAMO_FINGER[f[1]]}${f[2]}`;
  return null;
});

/** Character Creator 4/5 ("CC_Base_*"; also iClone / ActorCore exports). */
const CC_FINGER: Record<string, string> = {
  thumb: "Thumb",
  index: "Index",
  middle: "Mid",
  ring: "Ring",
  pinky: "Pinky",
};
const CC = build((c, side, base) => {
  const S = side === "l" ? "L" : "R";
  const flat: Record<string, string> = {
    pelvis: "CC_Base_Hip",
    spine_01: "CC_Base_Waist",
    spine_02: "CC_Base_Spine01",
    spine_03: "CC_Base_Spine02",
    neck_01: "CC_Base_NeckTwist01",
    head: "CC_Base_Head",
  };
  if (!side) return flat[c] ?? null;
  const limb: Record<string, string> = {
    clavicle: "Clavicle",
    upperarm: "Upperarm",
    lowerarm: "Forearm",
    hand: "Hand",
    thigh: "Thigh",
    calf: "Calf",
    foot: "Foot",
    ball: "ToeBase",
  };
  if (limb[base]) return `CC_Base_${S}_${limb[base]}`;
  const f = /^(\w+)_0(\d)$/.exec(base);
  if (f && CC_FINGER[f[1]]) return `CC_Base_${S}_${CC_FINGER[f[1]]}${f[2]}`;
  return null;
});

/** Unreal mannequin (UE4/UE5, MetaHuman body): same names as MPFB. */
const UNREAL = build((c) => c);
const MPFB = build((c) => c);

/** Rocketbox / 3ds Max Biped ("Bip01 ..."). */
const BIPED_FINGER: Record<string, number> = {
  thumb: 0,
  index: 1,
  middle: 2,
  ring: 3,
  pinky: 4,
};
const ROCKETBOX = build((c, side, base) => {
  const S = side === "l" ? "L" : "R";
  const flat: Record<string, string> = {
    pelvis: "Bip01 Pelvis",
    spine_01: "Bip01 Spine",
    spine_02: "Bip01 Spine1",
    spine_03: "Bip01 Spine2",
    neck_01: "Bip01 Neck",
    head: "Bip01 Head",
  };
  if (!side) return flat[c] ?? null;
  const limb: Record<string, string> = {
    clavicle: "Clavicle",
    upperarm: "UpperArm",
    lowerarm: "Forearm",
    hand: "Hand",
    thigh: "Thigh",
    calf: "Calf",
    foot: "Foot",
    ball: "Toe0",
  };
  if (limb[base]) return `Bip01 ${S} ${limb[base]}`;
  const f = /^(\w+)_0(\d)$/.exec(base);
  if (f && f[1] in BIPED_FINGER) {
    const seg = Number(f[2]) - 1;
    return `Bip01 ${S} Finger${BIPED_FINGER[f[1]]}${seg > 0 ? seg : ""}`;
  }
  return null;
});

export const BONE_MAPS: Record<SkeletonScheme, Readonly<Map_>> = {
  mpfb: MPFB,
  unreal: UNREAL,
  mixamo: MIXAMO,
  cc: CC,
  rocketbox: ROCKETBOX,
};

/**
 * Normalise a bone name for matching: drop a "mixamorig" prefix (any
 * separator), glTF exporter suffixes (".001", "_end"), and every non
 * alphanumeric character; lower-case.
 */
export function normalizeBoneName(name: string): string {
  return name
    .replace(/\.\d+$/, "")
    .replace(/^mixamorig\d*[:_ ]?/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

/**
 * Map the bones of a skeleton (`names`, in the given scheme) to canonical
 * names. `overrides` maps canonical → bone name and wins over the scheme map.
 * Returns bone name → canonical name for every bone that matched.
 */
export function mapToCanonical(
  names: readonly string[],
  scheme: SkeletonScheme,
  overrides: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const table = { ...BONE_MAPS[scheme], ...overrides };
  const byNorm = new Map<string, string>();
  for (const [canon, bone] of Object.entries(table)) {
    const n = normalizeBoneName(bone);
    if (!byNorm.has(n)) byNorm.set(n, canon);
  }
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const canon = byNorm.get(normalizeBoneName(name));
    if (canon && !used.has(canon)) {
      out.set(name, canon);
      used.add(canon);
    }
  }
  return out;
}

/**
 * Best-guess scheme from bone names (used when a manifest omits `skeleton`).
 */
export function detectScheme(names: readonly string[]): SkeletonScheme | null {
  let best: SkeletonScheme | null = null;
  let bestN = 0;
  for (const s of SKELETON_SCHEMES) {
    if (s === "unreal") continue; // identical to mpfb
    const n = mapToCanonical(names, s).size;
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return bestN >= 8 ? best : null;
}
