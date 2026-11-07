/**
 * Architectural building blocks shared by Building and Room: walls with
 * openings, window units with deep reveals and slim black frames (plus their
 * daylight "portal" lights), frameless-look glazed partitions with black
 * mullions and a frosted manifestation band, recessed door frames, and the
 * luminaires (suspended linear pendants, recessed slots, downlights) that
 * return the FixturePoints the Lighting turns into real lights.
 *
 * Everything is emitted into a MeshBatcher / ArtBatcher (merged per
 * material) plus static colliders. Signage textures live at the bottom.
 */
import {
  Color3,
  CreatePlane,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  Vector3,
} from "@/engine/babylon";
import type { ColliderSink } from "@/engine/physics/Colliders";
import type { SurfaceKey } from "@/engine/materials/Materials";
import { fixture, type FixturePoint } from "@/engine/fx/Lighting";
import { ArtBatcher } from "@/engine/art/geometry";
import { MeshBatcher, v3 } from "@/engine/util/MeshBatcher";

export interface Opening {
  /** Along-wall start/end (metres, wall local axis). */
  a0: number;
  a1: number;
  /** Vertical start/end. */
  y0: number;
  y1: number;
}

/** Frosted manifestation band on glazed partitions (height range, metres). */
export const MANIFEST_Y0 = 1.0;
export const MANIFEST_H = 0.3;

/**
 * Axis-aligned wall segment with rectangular openings.
 * axis "z": wall runs along Z at fixed x (thickness along X); "x": along X at fixed z.
 */
export function wallWithOpenings(
  b: MeshBatcher,
  cols: ColliderSink | null,
  group: string,
  mat: SurfaceKey,
  axis: "x" | "z",
  fixed: number,
  thickness: number,
  a0: number,
  a1: number,
  height: number,
  openings: Opening[] = [],
  colliderFull = true,
): void {
  const box = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
    const c = (s0 + s1) / 2;
    const len = s1 - s0;
    const cy = (y0 + y1) / 2;
    const h = y1 - y0;
    if (axis === "z") b.box(mat, v3(fixed, cy, c), v3(thickness, h, len));
    else b.box(mat, v3(c, cy, fixed), v3(len, h, thickness));
  };
  const ops = [...openings].sort((p, q) => p.a0 - q.a0);
  let cursor = a0;
  for (const o of ops) {
    box(cursor, o.a0, 0, height);
    box(o.a0, o.a1, 0, o.y0);
    box(o.a0, o.a1, o.y1, height);
    cursor = o.a1;
  }
  box(cursor, a1, 0, height);
  if (cols && colliderFull) {
    const c = (a0 + a1) / 2;
    const len = a1 - a0;
    if (axis === "z")
      cols.addBox(
        group,
        new Vector3(fixed, height / 2, c),
        new Vector3(thickness, height, len),
      );
    else
      cols.addBox(
        group,
        new Vector3(c, height / 2, fixed),
        new Vector3(len, height, thickness),
      );
  }
}

/**
 * Window: slim black frame set in the middle of the wall depth (deep plaster
 * reveals), mullions roughly every `pitch` metres, exterior glass, and a
 * white solid-surface sill on the inside. Returns daylight portal fixtures
 * (cool, aimed into the room) — `inward` = ±1 along the wall normal towards
 * the interior.
 */
export function windowUnit(
  b: MeshBatcher,
  axis: "x" | "z",
  fixed: number,
  o: Opening,
  opts: {
    pitch?: number;
    inward?: 1 | -1;
    wallT?: number;
    portals?: boolean;
  } = {},
): FixturePoint[] {
  const pitch = opts.pitch ?? 1.4;
  const inward = opts.inward ?? 1;
  const T = opts.wallT ?? 0.2;
  const f = 0.045; // frame face
  const d = 0.07; // frame depth
  const put = (
    mat: SurfaceKey,
    a: number,
    y: number,
    len: number,
    h: number,
    depth: number,
    off = 0,
  ) => {
    if (axis === "z") b.box(mat, v3(fixed + off, y, a), v3(depth, h, len));
    else b.box(mat, v3(a, y, fixed + off), v3(len, h, depth));
  };
  const w = o.a1 - o.a0;
  const h = o.y1 - o.y0;
  const cy = (o.y0 + o.y1) / 2;
  const ca = (o.a0 + o.a1) / 2;
  put("blackMetal", o.a0 + f / 2, cy, f, h, d);
  put("blackMetal", o.a1 - f / 2, cy, f, h, d);
  put("blackMetal", ca, o.y0 + f / 2, w, f, d);
  put("blackMetal", ca, o.y1 - f / 2, w, f, d);
  const n = Math.max(1, Math.round(w / pitch));
  for (let i = 1; i < n; i++)
    put("blackMetal", o.a0 + (w * i) / n, cy, 0.035, h, 0.06);
  // Interior sill (solid surface), projecting 25 mm past the inner face.
  const sillDepth = T / 2 + 0.025;
  put(
    "quartz",
    ca,
    o.y0 - 0.012,
    w + 0.04,
    0.025,
    sillDepth,
    inward * (sillDepth / 2),
  );
  put("glassExterior", ca, cy, w - 2 * f, h - 2 * f, 0.012);
  if (opts.portals === false) return [];
  const pts: FixturePoint[] = [];
  const m = Math.max(1, Math.round(w / 2.6));
  for (let i = 0; i < m; i++) {
    const a = o.a0 + (w * (i + 0.5)) / m;
    const inset = T / 2 + 0.35;
    const y = Math.min(o.y1 - 0.2, o.y0 + 1.3);
    const dir =
      axis === "z"
        ? new Vector3(inward, -0.45, 0)
        : new Vector3(0, -0.45, inward);
    pts.push(
      axis === "z"
        ? fixture(fixed + inward * inset, y, a, { kind: "window", dir })
        : fixture(a, y, fixed + inward * inset, { kind: "window", dir }),
    );
  }
  return pts;
}

/**
 * Floor-to-ceiling glazed partition along `axis` with black head / base
 * tracks, slim mullions, a frosted manifestation band and an optional
 * recessed door frame (black jambs, transom glass).
 */
export function glassPartition(
  b: MeshBatcher,
  cols: ColliderSink | null,
  group: string,
  axis: "x" | "z",
  fixed: number,
  a0: number,
  a1: number,
  height: number,
  door: { a0: number; a1: number; h: number } | null,
  opts: {
    pitch?: number;
    glass?: SurfaceKey;
    frame?: SurfaceKey;
    frostBand?: boolean;
    solid?: Opening[];
  } = {},
): void {
  const pitch = opts.pitch ?? 1.25;
  const glass = opts.glass ?? "glass";
  const frame = opts.frame ?? "blackMetal";
  const put = (
    mat: SurfaceKey,
    a: number,
    y: number,
    len: number,
    h: number,
    depth: number,
  ) => {
    if (len <= 0.002 || h <= 0.002) return;
    if (axis === "z") b.box(mat, v3(fixed, y, a), v3(depth, h, len));
    else b.box(mat, v3(a, y, fixed), v3(len, h, depth));
  };
  const runs: [number, number][] = [];
  const solids = opts.solid ?? [];
  const cuts = [
    ...(door ? [{ a0: door.a0, a1: door.a1 }] : []),
    ...solids.map((s) => ({ a0: s.a0, a1: s.a1 })),
  ].sort((p, q) => p.a0 - q.a0);
  let c = a0;
  for (const cut of cuts) {
    if (cut.a0 > c) runs.push([c, cut.a0]);
    c = Math.max(c, cut.a1);
  }
  if (a1 > c) runs.push([c, a1]);

  for (const [r0, r1] of runs) {
    const w = r1 - r0;
    put(frame, (r0 + r1) / 2, 0.02, w, 0.04, 0.06); // base track
    put(frame, (r0 + r1) / 2, height - 0.035, w, 0.07, 0.07); // head track
    put(glass, (r0 + r1) / 2, height / 2, w, height - 0.1, 0.012);
    if (opts.frostBand)
      put(
        "glassFrosted",
        (r0 + r1) / 2,
        MANIFEST_Y0 + MANIFEST_H / 2,
        w - 0.04,
        MANIFEST_H,
        0.016,
      );
    const n = Math.max(1, Math.round(w / pitch));
    for (let i = 0; i <= n; i++)
      put(
        frame,
        r0 + (w * i) / n,
        height / 2,
        i === 0 || i === n ? 0.04 : 0.025,
        height,
        0.05,
      );
    if (cols) {
      const cc = (r0 + r1) / 2;
      if (axis === "z")
        cols.addBox(
          group,
          new Vector3(fixed, height / 2, cc),
          new Vector3(0.1, height, w),
          0,
          { seeThrough: true },
        );
      else
        cols.addBox(
          group,
          new Vector3(cc, height / 2, fixed),
          new Vector3(w, height, 0.1),
          0,
          { seeThrough: true },
        );
    }
  }
  if (door) {
    const w = door.a1 - door.a0;
    // Recessed door frame: deep black jambs + head, transom glass above.
    put(frame, door.a0 + 0.03, door.h / 2, 0.06, door.h, 0.16);
    put(frame, door.a1 - 0.03, door.h / 2, 0.06, door.h, 0.16);
    put(frame, (door.a0 + door.a1) / 2, door.h + 0.03, w, 0.06, 0.16);
    put(
      glass,
      (door.a0 + door.a1) / 2,
      (door.h + height) / 2,
      w,
      height - door.h - 0.08,
      0.012,
    );
    if (cols) {
      const cc = (door.a0 + door.a1) / 2;
      const hy = (door.h + height) / 2;
      const hh = height - door.h;
      if (axis === "z")
        cols.addBox(group, new Vector3(fixed, hy, cc), new Vector3(0.1, hh, w));
      else
        cols.addBox(group, new Vector3(cc, hy, fixed), new Vector3(w, hh, 0.1));
    }
  }
}

/**
 * Colliders matching `glassPartition` (for modules whose geometry is shared
 * and built without colliders).
 */
export function partitionColliders(
  cols: ColliderSink,
  group: string,
  axis: "x" | "z",
  fixed: number,
  a0: number,
  a1: number,
  height: number,
  door: { a0: number; a1: number; h: number } | null,
  solids: { a0: number; a1: number }[] = [],
): void {
  const cuts = [...(door ? [door] : []), ...solids].sort((p, q) => p.a0 - q.a0);
  const runs: [number, number][] = [];
  let c = a0;
  for (const cut of cuts) {
    if (cut.a0 > c) runs.push([c, cut.a0]);
    c = Math.max(c, cut.a1);
  }
  if (a1 > c) runs.push([c, a1]);
  const box = (cc: number, y: number, len: number, h: number, see: boolean) =>
    axis === "z"
      ? cols.addBox(
          group,
          new Vector3(fixed, y, cc),
          new Vector3(0.1, h, len),
          0,
          see ? { seeThrough: true } : undefined,
        )
      : cols.addBox(
          group,
          new Vector3(cc, y, fixed),
          new Vector3(len, h, 0.1),
          0,
          see ? { seeThrough: true } : undefined,
        );
  for (const [r0, r1] of runs)
    box((r0 + r1) / 2, height / 2, r1 - r0, height, true);
  if (door)
    box(
      (door.a0 + door.a1) / 2,
      (door.h + height) / 2,
      door.a1 - door.a0,
      height - door.h,
      false,
    );
}

// ---------------------------------------------------------------------------
// Luminaires
// ---------------------------------------------------------------------------

/**
 * Suspended linear pendant: black aluminium profile with an opal diffuser,
 * steel cables and ceiling canopies. Returns one fixture per ~1.3 m.
 */
export function linearPendant(
  b: ArtBatcher,
  x: number,
  z: number,
  ceilingY: number,
  len: number,
  axis: "x" | "z",
  hang = 0.55,
  diffuser: SurfaceKey = "lightPanel",
): FixturePoint[] {
  const y = ceilingY - hang;
  const size = axis === "x" ? v3(len, 0.05, 0.065) : v3(0.065, 0.05, len);
  b.rbox("blackMetal", v3(x, y, z), size, { r: 0.008 });
  const ds =
    axis === "x" ? v3(len - 0.03, 0.006, 0.045) : v3(0.045, 0.006, len - 0.03);
  b.box(diffuser, v3(x, y - 0.026, z), ds, { keepUVs: true });
  for (const s of [-1, 1]) {
    const o = s * (len / 2 - 0.15);
    const cx = axis === "x" ? x + o : x;
    const cz = axis === "x" ? z : z + o;
    b.cylinder(
      "blackMetal",
      v3(cx, (y + ceilingY) / 2, cz),
      hang,
      0.004,
      0.004,
      4,
    );
    b.cylinder(
      "blackMetal",
      v3(cx, ceilingY - 0.008, cz),
      0.016,
      0.07,
      0.07,
      16,
    );
  }
  const n = Math.max(1, Math.round(len / 1.3));
  // Indirect component: the profile also throws light onto the ceiling.
  const pts: FixturePoint[] = [
    fixture(x, y + 0.04, z, {
      kind: "accent",
      dir: new Vector3(0, 1, 0),
      intensity: 0.55 * len,
      range: 3.2,
      color: "#FFE6CC",
    }),
  ];
  for (let i = 0; i < n; i++) {
    const t = -len / 2 + (len * (i + 0.5)) / n;
    pts.push(
      fixture(axis === "x" ? x + t : x, y - 0.06, axis === "x" ? z : z + t, {
        kind: "down",
        size: { w: len / n, d: 0.05, yaw: axis === "x" ? 0 : Math.PI / 2 },
      }),
    );
  }
  return pts;
}

/**
 * Recessed linear LED slot flush with a ceiling at `y`: black shadow-gap
 * channel with an inset diffuser. Returns fixtures every `step` metres.
 */
export function recessedSlot(
  b: MeshBatcher,
  axis: "x" | "z",
  cross: number,
  a0: number,
  a1: number,
  y: number,
  step = 2.4,
  width = 0.09,
  intensity = 1,
): FixturePoint[] {
  const len = a1 - a0;
  const c = (a0 + a1) / 2;
  const put = (
    mat: SurfaceKey,
    w: number,
    yy: number,
    h: number,
    keep = false,
  ) => {
    if (axis === "z")
      b.box(mat, v3(cross, yy, c), v3(w, h, len), { keepUVs: keep });
    else b.box(mat, v3(c, yy, cross), v3(len, h, w), { keepUVs: keep });
  };
  put("shadowGap", width, y - 0.003, 0.006);
  put("lightPanel", width * 0.55, y - 0.008, 0.004, true);
  const pts: FixturePoint[] = [];
  const n = Math.max(1, Math.round(len / step));
  for (let i = 0; i < n; i++) {
    const t = a0 + (len * (i + 0.5)) / n;
    pts.push(
      axis === "z"
        ? fixture(cross, y - 0.05, t, {
            kind: "down",
            intensity,
            size: { w: len / n, d: width, yaw: Math.PI / 2 },
          })
        : fixture(t, y - 0.05, cross, {
            kind: "down",
            intensity,
            size: { w: len / n, d: width, yaw: 0 },
          }),
    );
  }
  return pts;
}

/** Recessed round downlight (black trim, warm diffuser). */
export function downlight(
  b: MeshBatcher,
  x: number,
  z: number,
  y: number,
  intensity = 0.8,
): FixturePoint {
  b.cylinder("blackMetal", v3(x, y - 0.004, z), 0.008, 0.13, 0.13, 24, {
    keepUVs: true,
  });
  b.cylinder("lightPanel", v3(x, y - 0.009, z), 0.004, 0.085, 0.085, 24, {
    keepUVs: true,
  });
  return fixture(x, y - 0.05, z, { kind: "down", intensity });
}

/**
 * Grid of recessed light panels (legacy). Kept for callers that still want
 * panels; new rooms use pendants + downlights.
 */
export function ceilingPanels(
  b: MeshBatcher,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  panel: { w: number; d: number },
  count: { x: number; z: number },
  mat: SurfaceKey = "lightPanel",
): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i < count.x; i++)
    for (let j = 0; j < count.z; j++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / count.x;
      const z = z0 + ((j + 0.5) * (z1 - z0)) / count.z;
      b.box(
        "shadowGap",
        v3(x, y - 0.004, z),
        v3(panel.w + 0.03, 0.008, panel.d + 0.03),
      );
      b.box(mat, v3(x, y - 0.01, z), v3(panel.w, 0.006, panel.d), {
        keepUVs: true,
      });
      pts.push(
        fixture(x, y - 0.1, z, {
          kind: "down",
          size: { w: panel.w, d: panel.d },
        }),
      );
    }
  return pts;
}

// ---------------------------------------------------------------------------
// Textures: signage
// ---------------------------------------------------------------------------

export const FONT_STACK =
  '"Inter", "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", sans-serif';

type Ctx2D = CanvasRenderingContext2D;

export function makeTexture(
  scene: Scene,
  name: string,
  w: number,
  h: number,
  draw: (ctx: Ctx2D, w: number, h: number) => void,
  opts: { mipmaps?: boolean; alpha?: boolean } = {},
): DynamicTexture {
  const tex = new DynamicTexture(
    name,
    { width: w, height: h },
    scene,
    opts.mipmaps ?? true,
  );
  const ctx = tex.getContext() as unknown as Ctx2D;
  ctx.clearRect(0, 0, w, h);
  draw(ctx, w, h);
  tex.update(true);
  tex.hasAlpha = opts.alpha ?? false;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

/** Unlit textured plane (signage, backdrops). */
export function texturedPlane(
  scene: Scene,
  name: string,
  tex: DynamicTexture,
  w: number,
  h: number,
  opts: {
    emissive?: number;
    alpha?: boolean;
    lit?: boolean;
    roughness?: number;
  } = {},
): Mesh {
  const plane = CreatePlane(name, { width: w, height: h }, scene);
  const mat = new PBRMaterial(`${name}:mat`, scene);
  if (opts.lit) {
    mat.albedoTexture = tex;
    mat.roughness = opts.roughness ?? 0.6;
    mat.metallic = 0;
  } else {
    mat.albedoColor = Color3.Black();
    mat.emissiveTexture = tex;
    mat.emissiveColor = Color3.White();
    mat.emissiveIntensity = opts.emissive ?? 1;
    mat.disableLighting = true;
    mat.environmentIntensity = 0;
  }
  if (opts.alpha) {
    tex.hasAlpha = true;
    mat.opacityTexture = tex;
    mat.useAlphaFromAlbedoTexture = !!opts.lit;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  }
  plane.material = mat;
  plane.isPickable = false;
  plane.receiveShadows = false;
  return plane;
}

export function roundRect(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The Claude "spark" mark: tapered rays around a centre. */
export function drawSpark(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  const rays = 12;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + (i % 2) * 0.08;
    const len = r * (i % 3 === 0 ? 1 : i % 3 === 1 ? 0.78 : 0.88);
    const w = r * 0.13;
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-w * 0.35, 0);
    ctx.quadraticCurveTo(-w, len * 0.45, 0, len);
    ctx.quadraticCurveTo(w, len * 0.45, w * 0.35, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Lobby logo: orange spark + warm-white "Claude Office" wordmark on transparent. */
export function drawLogo(ctx: Ctx2D, w: number, h: number): void {
  const r = h * 0.36;
  drawSpark(ctx, r + h * 0.08, h / 2, r, "#E8875F");
  ctx.fillStyle = "#FFF6EC";
  ctx.textBaseline = "middle";
  ctx.font = `500 ${Math.round(h * 0.44)}px ${FONT_STACK}`;
  ctx.fillText(
    "Claude Office",
    r * 2 + h * 0.3,
    h / 2 + h * 0.02,
    w - r * 2 - h * 0.35,
  );
}

/**
 * Halo behind stand-off letters (the light they throw onto the wall):
 * soft warm glow shaped like the logo, used on an additive emissive plane.
 */
export function drawLogoHalo(ctx: Ctx2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.filter = `blur(${Math.round(h * 0.06)}px)`;
  const r = h * 0.3;
  const pad = h * 0.18;
  drawSpark(ctx, pad + r + h * 0.08, h / 2, r * 1.1, "rgba(217,119,87,0.95)");
  ctx.fillStyle = "rgba(255,214,180,0.55)";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.37)}px ${FONT_STACK}`;
  ctx.fillText(
    "Claude Office",
    pad + r * 2 + h * 0.3,
    h / 2,
    w - r * 2 - pad * 2,
  );
  ctx.filter = "none";
}

/** Wayfinding sign (black plate, light text, optional arrow). */
export function drawWayfinding(
  ctx: Ctx2D,
  w: number,
  h: number,
  title: string,
  sub: string,
  arrow: string,
): void {
  ctx.fillStyle = "#151618";
  roundRect(ctx, 0, 0, w, h, h * 0.06);
  ctx.fill();
  ctx.fillStyle = "#D97757";
  ctx.fillRect(h * 0.18, h * 0.24, h * 0.04, h * 0.52);
  ctx.fillStyle = "#F2EFEA";
  ctx.textBaseline = "middle";
  ctx.font = `500 ${Math.round(h * 0.32)}px ${FONT_STACK}`;
  ctx.fillText(title, h * 0.4, h * 0.4, w * 0.7);
  ctx.fillStyle = "#9A968F";
  ctx.font = `400 ${Math.round(h * 0.17)}px ${FONT_STACK}`;
  ctx.fillText(sub, h * 0.4, h * 0.72, w * 0.7);
  if (arrow) {
    ctx.fillStyle = "#F2EFEA";
    ctx.font = `300 ${Math.round(h * 0.5)}px ${FONT_STACK}`;
    ctx.textAlign = "right";
    ctx.fillText(arrow, w - h * 0.25, h * 0.5);
    ctx.textAlign = "left";
  }
}

/** Room nameplate: label + "ROOM 0N" caption, status accent bar. */
export function drawNameplate(
  ctx: Ctx2D,
  w: number,
  h: number,
  label: string,
  index: number,
  accent: string,
  selected: boolean,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#151618";
  roundRect(ctx, 0, 0, w, h, h * 0.08);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(0, h - h * 0.06, w, h * 0.06);
  if (selected) {
    ctx.strokeStyle = "#D97757";
    ctx.lineWidth = h * 0.04;
    roundRect(ctx, h * 0.03, h * 0.03, w - h * 0.06, h - h * 0.06, h * 0.07);
    ctx.stroke();
  }
  ctx.fillStyle = "#8E8A84";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.15)}px ${FONT_STACK}`;
  ctx.fillText(
    `ROOM ${String(index + 1).padStart(2, "0")}`,
    h * 0.16,
    h * 0.28,
  );
  ctx.fillStyle = "#F4F1EC";
  let size = Math.round(h * 0.34);
  ctx.font = `500 ${size}px ${FONT_STACK}`;
  while (ctx.measureText(label).width > w - h * 0.32 && size > 12) {
    size -= 2;
    ctx.font = `500 ${size}px ${FONT_STACK}`;
  }
  ctx.fillText(label, h * 0.16, h * 0.62);
}
