/**
 * In-world wayfinding signs (U3): black plates with light text and an arrow,
 * hung from the ceilings at the decision points — the reception stair heads
 * ("Factory floor ↓"), the hall start ("Control room ↑" / "Reception"), each
 * spine-well head ("Factory floor ↓"), each spine-stair foot ("Offices ↑")
 * and over the factory door ("Reception · Exit").
 *
 * One builder = one atlas texture + one merged mesh = ONE draw for all of its
 * signs; the plates' frames and drop rods go into the caller's ArtBatcher
 * (existing materials, no extra draw). Placement is pure (`hallSigns`,
 * `entranceSigns`, Node-testable); the texture needs a 2D canvas, so the
 * mesh is skipped where there is none (headless tests).
 */
import {
  Color3,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  Texture,
  VertexData,
  type Scene,
} from "@/engine/babylon";
import type { ArtBatcher } from "@/engine/art/geometry";
import {
  FLOOR_Y,
  SPINE_STAIR,
  type EntranceLayout,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import { v3 } from "@/engine/util/MeshBatcher";
import { drawWayfinding } from "@/engine/world/architecture";
import { onWorldLocale, worldT } from "@/engine/world/worldLocale";
import type { TranslationKey } from "@/i18n";

export interface SignFace {
  titleKey: TranslationKey;
  subKey: TranslationKey;
  arrow: string;
}

/** Every sign face in the world (atlas slot order). */
export const SIGN_FACES = {
  factoryDown: {
    titleKey: "world.sign.factory",
    subKey: "world.sign.sub.factoryDown",
    arrow: "↓",
  },
  spineDown: {
    titleKey: "world.sign.factory",
    subKey: "world.sign.sub.spine",
    arrow: "↓",
  },
  officesUp: {
    titleKey: "world.sign.offices",
    subKey: "world.sign.sub.officesUp",
    arrow: "↑",
  },
  controlRoom: {
    titleKey: "world.sign.controlRoom",
    subKey: "world.sign.sub.controlRoom",
    arrow: "↑",
  },
  reception: {
    titleKey: "world.sign.reception",
    subKey: "world.sign.sub.reception",
    arrow: "↑",
  },
  receptionExit: {
    titleKey: "world.sign.receptionExit",
    subKey: "world.sign.sub.receptionExit",
    arrow: "",
  },
} as const satisfies Record<string, SignFace>;

export type SignFaceId = keyof typeof SIGN_FACES;

/** Plate size (m): 4 : 1, title ≈ 0.13 m — readable from 6 m and more. */
export const SIGN_W = 1.4;
export const SIGN_H = 0.35;

export interface SignSpec {
  /** Plate centre. */
  x: number;
  y: number;
  z: number;
  /** Front-face normal direction (0 → +z): the reader stands that way. */
  yaw: number;
  front: SignFaceId;
  /** Back face (double-sided hanging sign), or none (wall-mounted). */
  back?: SignFaceId;
  /** Drop rods up to this y (hanging); omitted → wall-mounted. */
  hangTo?: number;
}

const HANG_Y = 2.55;

/**
 * Hall- and factory-level signs (pure): the hall start (double-sided), each
 * spine-well head (double-sided, hung over the head), each spine-stair foot
 * (hung from the hall soffit) and the factory side of the factory door.
 */
export function hallSigns(fl: FactoryLayout, wallH: number): SignSpec[] {
  const out: SignSpec[] = [
    // Hall start, over the glass strip: read from the reception (−z side)
    // and walking back down the hall (+z side).
    {
      x: 0,
      y: HANG_Y,
      z: 0.6,
      yaw: Math.PI,
      front: "controlRoom",
      back: "reception",
      hangTo: wallH,
    },
  ];
  for (const st of fl.spineStairs) {
    const x = st.top.x;
    out.push({
      x,
      y: HANG_Y,
      z: st.rect.z0 - 0.35,
      yaw: Math.PI,
      front: "spineDown",
      back: "spineDown",
      hangTo: wallH,
    });
    // Foot: hung from the hall soffit, read arriving from the north.
    out.push({
      x,
      y: FLOOR_Y + 2.7,
      z: st.rect.z0 + SPINE_STAIR.RUN + 0.4,
      yaw: 0,
      front: "officesUp",
      back: "officesUp",
      hangTo: -0.45,
    });
  }
  // Factory side of the factory door, above the opening on the wall.
  const fd = fl.entrance.factoryDoor;
  out.push({
    x: fd.x,
    y: FLOOR_Y + fd.height + 0.45,
    z: fd.z + 0.03,
    yaw: 0,
    front: "receptionExit",
  });
  return out;
}

/**
 * Reception-level signs at both stair heads (pure, entrance frame: local
 * y 0 = the lobby floor, `up` = the reception floor): hung over the head,
 * "Factory floor ↓" for people in the reception, "Offices ↑" for people
 * arriving up the stairs.
 */
export function entranceSigns(
  e: EntranceLayout,
  up: number,
  ceil: number,
): SignSpec[] {
  return e.stairs.map((st) => ({
    x: (st.upper.x0 + st.upper.x1) / 2,
    y: up + HANG_Y,
    z: st.rect.z1 + 0.5,
    yaw: 0,
    front: "factoryDown",
    back: "officesUp",
    hangTo: ceil,
  }));
}

/** Black frame, back plate and drop rods of every sign (into `b`). */
export function signHardware(b: ArtBatcher, specs: readonly SignSpec[]): void {
  for (const s of specs) {
    const c = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    const depth = s.back ? 0.03 : 0.02;
    // Frame (slightly larger than the faces), centred on the plate; for a
    // wall sign it sits against the wall behind the face.
    const off = s.back ? 0 : -depth / 2;
    b.box(
      "blackMetal",
      v3(s.x + sn * off, s.y, s.z + c * off),
      v3(
        Math.abs(c) * (SIGN_W + 0.04) + Math.abs(sn) * depth,
        SIGN_H + 0.04,
        Math.abs(sn) * (SIGN_W + 0.04) + Math.abs(c) * depth,
      ),
    );
    if (s.hangTo === undefined) continue;
    const y0 = s.y + SIGN_H / 2 + 0.02;
    const len = s.hangTo - y0;
    if (len <= 0.01) continue;
    for (const k of [-1, 1]) {
      const along = k * (SIGN_W / 2 - 0.12);
      b.cylinder(
        "blackMetal",
        v3(s.x + c * along, y0 + len / 2, s.z - sn * along),
        len,
        0.008,
        0.008,
        6,
      );
    }
  }
}

/** Atlas slot layout: 2 columns × up to 4 rows of 1024 × 256 px. */
const COLS = 2;
const MAX_ROWS = 4;
/** Atlas rows needed for `faces` distinct faces (rows nobody uses cost VRAM). */
export function signAtlasRows(faces: number): number {
  return Math.max(1, Math.min(MAX_ROWS, Math.ceil(faces / COLS)));
}
const SW = 1024;
const SH = 256;

/**
 * One merged, unlit mesh with every face of `specs` (one draw), mapped into
 * an atlas of the faces it uses. Null without a 2D canvas (headless).
 */
export function buildSignMesh(
  scene: Scene,
  name: string,
  specs: readonly SignSpec[],
): { mesh: Mesh; texture: DynamicTexture } | null {
  if (!specs.length || typeof document === "undefined") return null;
  const used: SignFaceId[] = [];
  for (const s of specs)
    for (const f of [s.front, s.back]) if (f && !used.includes(f)) used.push(f);
  if (used.length > COLS * MAX_ROWS) throw new Error("sign atlas full");
  const ROWS = signAtlasRows(used.length);
  const tex = new DynamicTexture(
    `${name}:atlas`,
    { width: SW * COLS, height: SH * ROWS },
    scene,
    true,
  );
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const paint = () => {
    ctx.clearRect(0, 0, SW * COLS, SH * ROWS);
    used.forEach((id, i) => {
      const f: SignFace = SIGN_FACES[id];
      ctx.save();
      ctx.translate((i % COLS) * SW, Math.floor(i / COLS) * SH);
      drawWayfinding(
        ctx,
        SW,
        SH,
        worldT(f.titleKey),
        worldT(f.subKey),
        f.arrow,
      );
      ctx.restore();
    });
    tex.update(true);
  };
  paint();
  // Baked once, re-baked when the UI language changes.
  const off = onWorldLocale(paint);
  tex.onDisposeObservable.add(off);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (s: SignSpec, id: SignFaceId, yaw: number, d: number) => {
    const i = used.indexOf(id);
    // Texture v runs top → bottom in canvas space; Babylon's v is flipped
    // for DynamicTexture (invertY), so the top row of the canvas is v = 1.
    const u0 = (i % COLS) / COLS;
    const u1 = u0 + 1 / COLS;
    const v1 = 1 - Math.floor(i / COLS) / ROWS;
    const v0 = v1 - 1 / ROWS;
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    // Right-hand direction for a reader facing the plate (looking along −n).
    const rx = -nz;
    const rz = nx;
    const cx = s.x + nx * d;
    const cz = s.z + nz * d;
    const hw = SIGN_W / 2;
    const hh = SIGN_H / 2;
    const base = pos.length / 3;
    const corners: [number, number, number, number][] = [
      [-hw, -hh, u0, v0],
      [hw, -hh, u1, v0],
      [hw, hh, u1, v1],
      [-hw, hh, u0, v1],
    ];
    for (const [a, h, u, v] of corners) {
      pos.push(cx + rx * a, s.y + h, cz + rz * a);
      nrm.push(nx, 0, nz);
      uv.push(u, v);
    }
    // Front-facing toward +n (Babylon: clockwise seen from the front).
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (const s of specs) {
    const d = s.back ? 0.016 : 0.002;
    quad(s, s.front, s.yaw, d);
    if (s.back) quad(s, s.back, s.yaw + Math.PI, d);
  }
  const mesh = new Mesh(`${name}:signs`, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.uvs = uv;
  vd.indices = idx;
  vd.applyToMesh(mesh);
  const mat = new PBRMaterial(`${name}:signs:mat`, scene);
  mat.albedoColor = Color3.Black();
  mat.emissiveTexture = tex;
  mat.emissiveColor = Color3.White();
  mat.emissiveIntensity = 0.85;
  mat.disableLighting = true;
  mat.environmentIntensity = 0;
  // Faces are offset out of the frame on both sides; draw both windings.
  mat.backFaceCulling = false;
  mat.freeze();
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.freezeWorldMatrix();
  return { mesh, texture: tex };
}
