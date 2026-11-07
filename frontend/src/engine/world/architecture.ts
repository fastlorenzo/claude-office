/**
 * Architectural building blocks shared by Building and Room: walls with
 * openings, glazed partitions with aluminium mullions, window frames,
 * skirting, recessed light panels, signage textures and the exterior sky /
 * skyline backdrop. Everything is emitted into a MeshBatcher (merged per
 * material) plus static colliders.
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
import { MeshBatcher, v3 } from "@/engine/util/MeshBatcher";

export interface Opening {
  /** Along-wall start/end (metres, wall local axis). */
  a0: number;
  a1: number;
  /** Vertical start/end. */
  y0: number;
  y1: number;
}

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
 * Window: aluminium frame, mullions roughly every `pitch` metres, a transom,
 * and one glass pane. Wall plane at `fixed`; `inward` = +1/-1 along the
 * wall normal toward the interior (frame sits flush on the inside face).
 */
export function windowUnit(
  b: MeshBatcher,
  axis: "x" | "z",
  fixed: number,
  o: Opening,
  pitch = 1.4,
  frameMat: SurfaceKey = "aluminium",
): void {
  const f = 0.05; // frame face
  const d = 0.12; // frame depth
  const put = (a: number, y: number, len: number, h: number, depth = d) => {
    if (axis === "z") b.box(frameMat, v3(fixed, y, a), v3(depth, h, len));
    else b.box(frameMat, v3(a, y, fixed), v3(len, h, depth));
  };
  const w = o.a1 - o.a0;
  const h = o.y1 - o.y0;
  const cy = (o.y0 + o.y1) / 2;
  put(o.a0 + f / 2, cy, f, h);
  put(o.a1 - f / 2, cy, f, h);
  put((o.a0 + o.a1) / 2, o.y0 + f / 2, w, f);
  put((o.a0 + o.a1) / 2, o.y1 - f / 2, w, f);
  const n = Math.max(1, Math.round(w / pitch));
  for (let i = 1; i < n; i++) put(o.a0 + (w * i) / n, cy, 0.04, h, 0.1);
  // Sill board
  if (axis === "z")
    b.box(
      "skirting",
      v3(fixed, o.y0 - 0.01, (o.a0 + o.a1) / 2),
      v3(0.26, 0.03, w + 0.06),
    );
  else
    b.box(
      "skirting",
      v3((o.a0 + o.a1) / 2, o.y0 - 0.01, fixed),
      v3(w + 0.06, 0.03, 0.26),
    );
  // Glass
  if (axis === "z")
    b.box(
      "glass",
      v3(fixed, cy, (o.a0 + o.a1) / 2),
      v3(0.012, h - 2 * f, w - 2 * f),
    );
  else
    b.box(
      "glass",
      v3((o.a0 + o.a1) / 2, cy, fixed),
      v3(w - 2 * f, h - 2 * f, 0.012),
    );
}

/**
 * Floor-to-ceiling glazed partition along `axis` with aluminium head/base
 * tracks, slim mullions and an optional door gap (with a frame). Returns the
 * door gap interval so callers can place signage.
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
  const frame = opts.frame ?? "aluminium";
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
    put(frame, (r0 + r1) / 2, 0.025, w, 0.05, 0.08); // base track
    put(frame, (r0 + r1) / 2, height - 0.03, w, 0.06, 0.08); // head track
    put(glass, (r0 + r1) / 2, height / 2, w, height - 0.11, 0.012);
    if (opts.frostBand)
      put("glassFrosted", (r0 + r1) / 2, 1.12, w, 0.16, 0.016);
    const n = Math.max(1, Math.round(w / pitch));
    for (let i = 0; i <= n; i++)
      put(frame, r0 + (w * i) / n, height / 2, 0.04, height, 0.07);
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
    // Door frame + transom glass above the door.
    put(frame, door.a0 + 0.03, door.h / 2, 0.06, door.h, 0.1);
    put(frame, door.a1 - 0.03, door.h / 2, 0.06, door.h, 0.1);
    put(frame, (door.a0 + door.a1) / 2, door.h, w, 0.08, 0.1);
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

/** Grid of recessed light panels on a ceiling at height `y`. */
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
        "aluminium",
        v3(x, y - 0.006, z),
        v3(panel.w + 0.05, 0.012, panel.d + 0.05),
      );
      b.box(mat, v3(x, y - 0.014, z), v3(panel.w, 0.01, panel.d));
      pts.push(new Vector3(x, y - 0.3, z));
    }
  return pts;
}

// ---------------------------------------------------------------------------
// Textures: signage + exterior
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

function roundRect(
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

/** Lobby logo: spark + "Claude Office" wordmark, white on transparent. */
export function drawLogo(ctx: Ctx2D, w: number, h: number): void {
  const r = h * 0.36;
  drawSpark(ctx, r + h * 0.08, h / 2, r, "#FFFFFF");
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.46)}px ${FONT_STACK}`;
  ctx.fillText(
    "Claude Office",
    r * 2 + h * 0.3,
    h / 2 + h * 0.02,
    w - r * 2 - h * 0.35,
  );
}

/** Wayfinding sign (charcoal plate, light text, optional arrow). */
export function drawWayfinding(
  ctx: Ctx2D,
  w: number,
  h: number,
  title: string,
  sub: string,
  arrow: string,
): void {
  ctx.fillStyle = "#24262A";
  roundRect(ctx, 0, 0, w, h, h * 0.08);
  ctx.fill();
  ctx.fillStyle = "#D97757";
  ctx.fillRect(h * 0.18, h * 0.22, h * 0.05, h * 0.56);
  ctx.fillStyle = "#F2EFEA";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.34)}px ${FONT_STACK}`;
  ctx.fillText(title, h * 0.4, h * 0.4, w * 0.7);
  ctx.fillStyle = "#A9A59F";
  ctx.font = `400 ${Math.round(h * 0.18)}px ${FONT_STACK}`;
  ctx.fillText(sub, h * 0.4, h * 0.73, w * 0.7);
  if (arrow) {
    ctx.fillStyle = "#F2EFEA";
    ctx.font = `500 ${Math.round(h * 0.5)}px ${FONT_STACK}`;
    ctx.textAlign = "right";
    ctx.fillText(arrow, w - h * 0.25, h * 0.5);
    ctx.textAlign = "left";
  }
}

/** Room nameplate: label + "SESSION" caption, status accent bar. */
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
  ctx.fillStyle = "#1F2124";
  roundRect(ctx, 0, 0, w, h, h * 0.1);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(0, h - h * 0.07, w, h * 0.07);
  if (selected) {
    ctx.strokeStyle = "#D97757";
    ctx.lineWidth = h * 0.05;
    roundRect(ctx, h * 0.03, h * 0.03, w - h * 0.06, h - h * 0.06, h * 0.08);
    ctx.stroke();
  }
  ctx.fillStyle = "#8E8A84";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.15)}px ${FONT_STACK}`;
  ctx.fillText(
    `ROOM ${String(index + 1).padStart(2, "0")}`,
    h * 0.16,
    h * 0.26,
  );
  ctx.fillStyle = "#F4F1EC";
  let size = Math.round(h * 0.36);
  ctx.font = `600 ${size}px ${FONT_STACK}`;
  while (ctx.measureText(label).width > w - h * 0.32 && size > 12) {
    size -= 2;
    ctx.font = `600 ${size}px ${FONT_STACK}`;
  }
  ctx.fillText(label, h * 0.16, h * 0.6);
}

/** Bright daylight sky with a hazy skyline; drawn once, shared by all backdrops. */
export function drawSkyline(ctx: Ctx2D, w: number, h: number, seed = 1): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#9DB9D6");
  sky.addColorStop(0.45, "#CFDDE8");
  sky.addColorStop(0.62, "#F2EDE4");
  sky.addColorStop(1, "#EAE4DA");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const horizon = h * 0.64;
  // Far layer
  for (let x = 0; x < w;) {
    const bw = 30 + rnd() * 90;
    const bh = 30 + rnd() * h * 0.22;
    ctx.fillStyle = `rgba(150,165,182,${0.55 + rnd() * 0.2})`;
    ctx.fillRect(x, horizon - bh, bw, bh + 4);
    x += bw + rnd() * 10;
  }
  // Near layer: varied facades (stone, glass, concrete) with soft window grids.
  const facades = [
    [185, 178, 166],
    [143, 163, 181],
    [167, 169, 171],
    [125, 134, 145],
    [204, 196, 182],
  ];
  for (let x = 0; x < w;) {
    const bw = 50 + rnd() * 130;
    const bh = 50 + rnd() * h * 0.28;
    const [r, g, bl] = facades[Math.floor(rnd() * facades.length)];
    const top = horizon - bh + h * 0.03;
    const grad = ctx.createLinearGradient(0, top, 0, horizon);
    grad.addColorStop(0, `rgb(${r + 12},${g + 12},${bl + 12})`);
    grad.addColorStop(1, `rgb(${r - 18},${g - 16},${bl - 12})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, top, bw, bh);
    // Shaded side for volume
    ctx.fillStyle = "rgba(40,50,60,0.12)";
    ctx.fillRect(x + bw * 0.72, top, bw * 0.28, bh);
    const glassy = g > r;
    ctx.fillStyle = glassy ? "rgba(220,232,242,0.28)" : "rgba(60,70,80,0.22)";
    const rowH = 9 + Math.floor(rnd() * 4);
    for (let wy = top + 6; wy < horizon - 4; wy += rowH)
      for (let wx = x + 5; wx < x + bw - 6; wx += 8)
        ctx.fillRect(wx, wy, 5, rowH * 0.55);
    x += bw + 4 + rnd() * 30;
  }
  // Ground haze + trees band
  const haze = ctx.createLinearGradient(0, horizon - h * 0.1, 0, h);
  haze.addColorStop(0, "rgba(242,237,228,0)");
  haze.addColorStop(0.35, "rgba(242,237,228,0.55)");
  haze.addColorStop(1, "rgba(200,196,186,1)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - h * 0.1, w, h);
  for (let x = 0; x < w; x += 5 + rnd() * 9) {
    const r = 3 + rnd() * 6;
    ctx.fillStyle = `rgba(${70 + rnd() * 30},${100 + rnd() * 30},${70 + rnd() * 20},0.9)`;
    ctx.beginPath();
    ctx.arc(x, horizon + h * 0.012 + rnd() * 3, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
