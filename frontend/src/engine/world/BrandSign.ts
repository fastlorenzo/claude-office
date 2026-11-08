/**
 * Lobby neon brand sign.
 *
 * Two draws, no GlowLayer: a dark brushed-metal backplate with four standoff
 * bolts (one merged mesh) and one additive emissive plane carrying a
 * canvas-rendered neon (wide coloured halo layers -> saturated tube -> hot
 * near-white core), whose halo doubles as the light spill on the wall.
 * The plane is never added to the glow layer, so nothing smears.
 */
import {
  Color3,
  CreateBox,
  CreateCylinder,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
} from "@/engine/babylon";
import type { BrandingOptions } from "@/engine/contracts";
import {
  DEFAULT_BRANDING,
  layoutBrand,
  neonColors,
  type NeonColors,
} from "@/engine/world/brandLayout";
import { FONT_STACK, texturedPlane } from "@/engine/world/architecture";

type Ctx2D = CanvasRenderingContext2D;

/** Sign content box (m) and canvas density. */
const CONTENT_W = 5.0;
const CONTENT_H = 1.1;
const TEX_W = 2048;
const TEX_H = 768;
const PX_PER_M = 340;
const PLANE_W = TEX_W / PX_PER_M;
const PLANE_H = TEX_H / PX_PER_M;
const TUBE_PX = 11;

export interface BrandSignAnchor {
  x: number;
  y: number;
  /** Z of the wall face; the sign stands off toward -z. */
  wallZ: number;
}

export class BrandSign {
  readonly meshes: Mesh[] = [];
  readonly texture: DynamicTexture;
  private readonly mat: PBRMaterial;
  private opts: BrandingOptions;
  private logoImg: HTMLImageElement | null = null;
  private logoSrc: string | null = null;
  private token = 0;
  private t = 0;
  private lastGain = -1;

  constructor(scene: Scene, anchor: BrandSignAnchor, opts?: BrandingOptions) {
    this.opts = opts ?? DEFAULT_BRANDING;
    const { x, y, wallZ } = anchor;

    // ---- Backplate + standoffs (one merged mesh, one material)
    const plateMat = new PBRMaterial("brandPlate:mat", scene);
    plateMat.albedoColor = new Color3(0.05, 0.052, 0.058);
    // Black satin-painted backplate (dielectric).
    plateMat.metallic = 0;
    plateMat.roughness = 0.5;
    plateMat.environmentIntensity = 0.12;
    plateMat.directIntensity = 0.5;
    plateMat.freeze();
    const pw = CONTENT_W + 0.4;
    const ph = CONTENT_H + 0.3;
    const parts: Mesh[] = [
      CreateBox("brandPlate", { width: pw, height: ph, depth: 0.02 }, scene),
    ];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const bolt = CreateCylinder(
          "brandBolt",
          { diameter: 0.034, height: 0.055, tessellation: 12 },
          scene,
        );
        bolt.rotation.x = Math.PI / 2;
        bolt.position.set(sx * (pw / 2 - 0.09), sy * (ph / 2 - 0.09), -0.035);
        bolt.bakeCurrentTransformIntoVertices();
        parts.push(bolt);
        const cap = CreateCylinder(
          "brandCap",
          { diameter: 0.05, height: 0.012, tessellation: 12 },
          scene,
        );
        cap.rotation.x = Math.PI / 2;
        cap.position.set(sx * (pw / 2 - 0.09), sy * (ph / 2 - 0.09), -0.066);
        cap.bakeCurrentTransformIntoVertices();
        parts.push(cap);
      }
    }
    const plate = Mesh.MergeMeshes(parts, true, true) as Mesh;
    plate.name = "brandPlate";
    plate.material = plateMat;
    plate.position.set(x, y, wallZ - 0.02);
    plate.isPickable = false;
    plate.receiveShadows = false;
    this.meshes.push(plate);

    // ---- Neon plane (additive, unlit)
    this.texture = new DynamicTexture(
      "brandNeon",
      { width: TEX_W, height: TEX_H },
      scene,
      true,
    );
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.texture.anisotropicFilteringLevel = 8;
    const neon = texturedPlane(
      scene,
      "brandNeon",
      this.texture,
      PLANE_W,
      PLANE_H,
      { emissive: 1, alpha: true },
    );
    this.mat = neon.material as PBRMaterial;
    neon.position.set(x, y, wallZ - 0.075);
    neon.isPickable = false;
    neon.receiveShadows = false;
    neon.alphaIndex = 10;
    this.meshes.push(neon);

    this.setGain(1);
    this.redraw();
  }

  set(opts: BrandingOptions): void {
    this.opts = opts;
    if (!opts.flicker) this.setGain(1);
    if (opts.logo !== this.logoSrc) {
      this.logoSrc = opts.logo;
      this.logoImg = null;
      const my = ++this.token;
      if (opts.logo) {
        const img = new Image();
        img.onload = () => {
          if (my !== this.token) return;
          this.logoImg = img;
          this.redraw();
        };
        img.src = opts.logo;
      }
    }
    this.redraw();
  }

  /** Per-frame: optional gentle flicker (rare dips, like a tired tube). */
  update(dt: number): void {
    if (!this.opts.flicker) return;
    this.t += dt;
    const t = this.t;
    const s = Math.sin(t * 1.3) * Math.sin(t * 0.37 + 1.2);
    let g = 1 - 0.04 * Math.sin(t * 9) * Math.sin(t * 2.3);
    if (s > 0.9) g = Math.sin(t * 71) > 0 ? 1 : 0.45;
    this.setGain(g);
  }

  private setGain(g: number): void {
    if (Math.abs(g - this.lastGain) < 0.002) return;
    this.lastGain = g;
    this.mat.emissiveIntensity = g;
  }

  private redraw(): void {
    const ctx = this.texture.getContext() as unknown as Ctx2D;
    drawNeonSign(ctx, TEX_W, TEX_H, this.opts, this.logoImg);
    this.texture.update(true);
  }
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

/** Paint callback: draw the glyphs in the given line width / colour. */
type Paint = (lw: number, color: string, fill: boolean) => void;

/** Halo layers -> saturated tube -> hot core. */
function neonPass(ctx: Ctx2D, paint: Paint, c: NeonColors, tube: number): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const layers: [number, number, number][] = [
    [tube * 14, 0.5, 1.2],
    [tube * 6, 0.65, 1.1],
    [tube * 2.4, 0.9, 1.0],
  ];
  for (const [blur, alpha, k] of layers) {
    ctx.shadowColor = c.halo;
    ctx.shadowBlur = blur;
    ctx.globalAlpha = alpha;
    paint(tube * k, c.halo, true);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  paint(tube, c.body, true);
  paint(tube * 0.38, c.core, false);
  ctx.restore();
}

/** 8-point star outline path (the default logo glyph). */
function starPath(ctx: Ctx2D, cx: number, cy: number, r: number): void {
  const n = 8;
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.46;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function drawNeonSign(
  ctx: Ctx2D,
  w: number,
  h: number,
  b: BrandingOptions,
  logoImg: HTMLImageElement | null,
): void {
  ctx.clearRect(0, 0, w, h);
  const colors = neonColors(b.color);
  const cw = CONTENT_W * PX_PER_M;
  const ch = CONTENT_H * PX_PER_M;
  const ox = (w - cw) / 2;
  const oy = (h - ch) / 2;
  const nameFont = (px: number) => `300 ${Math.round(px)}px ${FONT_STACK}`;
  const tagFont = (px: number) => `400 ${Math.round(px)}px ${FONT_STACK}`;

  // Measure with the name font for the name, tagline font for the tagline.
  const measure = (text: string, px: number): number => {
    ctx.font = text === b.tagline ? tagFont(px) : nameFont(px);
    return ctx.measureText(text).width + TUBE_PX;
  };
  const lay = layoutBrand(
    { name: b.name, tagline: b.tagline, logo: "x" },
    cw,
    ch,
    measure,
  );

  ctx.save();
  ctx.translate(ox, oy);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  if (lay.logo) {
    const { x, y, size } = lay.logo;
    if (b.logo && logoImg) {
      drawImageNeon(ctx, logoImg, x, y, size, colors);
    } else if (!b.logo) {
      const cx = x + size / 2;
      const cy = y + size / 2;
      neonPass(
        ctx,
        (lw, color, fill) => {
          ctx.lineWidth = lw;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          starPath(ctx, cx, cy, size * 0.46);
          ctx.stroke();
          if (fill) {
            ctx.globalAlpha *= 0.12;
            ctx.fill();
            ctx.globalAlpha /= 0.12;
          }
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.06, 0, Math.PI * 2);
          ctx.stroke();
        },
        colors,
        TUBE_PX,
      );
    }
  }

  const text = (
    s: string,
    t: { x: number; y: number; px: number; maxW: number },
    font: string,
    tube: number,
  ): void => {
    ctx.font = font;
    neonPass(
      ctx,
      (lw, color, fill) => {
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        // lw is the tube; strokes extend half outside the glyph.
        ctx.strokeText(s, t.x, t.y, t.maxW);
        if (fill) ctx.fillText(s, t.x, t.y, t.maxW);
      },
      colors,
      tube,
    );
  };
  if (lay.name) text(b.name, lay.name, nameFont(lay.name.px), TUBE_PX);
  if (lay.tagline)
    text(b.tagline, lay.tagline, tagFont(lay.tagline.px), TUBE_PX * 0.6);

  ctx.restore();
}

/**
 * Uploaded logo -> neon: alpha (or background-contrast) mask, edge outline
 * as tube + core, with the mask as a faint lit fill.
 */
function drawImageNeon(
  ctx: Ctx2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  size: number,
  c: NeonColors,
): void {
  const s = Math.max(64, Math.round(size));
  const iw = img.naturalWidth || 512;
  const ih = img.naturalHeight || 512;
  const k = Math.min(s / iw, s / ih);
  const dw = Math.max(1, Math.round(iw * k));
  const dh = Math.max(1, Math.round(ih * k));
  const src = document.createElement("canvas");
  src.width = s;
  src.height = s;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (!sctx) return;
  sctx.drawImage(img, (s - dw) / 2, (s - dh) / 2, dw, dh);
  const data = sctx.getImageData(0, 0, s, s);
  const px = data.data;
  const n = s * s;

  // Opaque image (JPG / flat PNG)? Key against the corner colour instead.
  let transparent = 0;
  for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 200) transparent++;
  const useAlpha = transparent > n * 0.04 + (s * s - dw * dh);
  const mask = new Uint8Array(n);
  if (useAlpha) {
    for (let i = 0; i < n; i++) mask[i] = px[i * 4 + 3] > 64 ? 1 : 0;
  } else {
    const ix = Math.floor((s - dw) / 2) * 4 + Math.floor((s - dh) / 2) * s * 4;
    const br = px[ix];
    const bg = px[ix + 1];
    const bb = px[ix + 2];
    const x0 = Math.floor((s - dw) / 2);
    const y0 = Math.floor((s - dh) / 2);
    for (let yy = y0; yy < y0 + dh; yy++)
      for (let xx = x0; xx < x0 + dw; xx++) {
        const i = yy * s + xx;
        const d =
          Math.abs(px[i * 4] - br) +
          Math.abs(px[i * 4 + 1] - bg) +
          Math.abs(px[i * 4 + 2] - bb);
        mask[i] = d > 90 ? 1 : 0;
      }
  }

  // Edge pixels of the mask -> white-alpha canvases.
  const edge = sctx.createImageData(s, s);
  const fillM = sctx.createImageData(s, s);
  for (let yy = 0; yy < s; yy++)
    for (let xx = 0; xx < s; xx++) {
      const i = yy * s + xx;
      if (!mask[i]) continue;
      fillM.data[i * 4 + 3] = 255;
      const e =
        xx === 0 ||
        yy === 0 ||
        xx === s - 1 ||
        yy === s - 1 ||
        !mask[i - 1] ||
        !mask[i + 1] ||
        !mask[i - s] ||
        !mask[i + s];
      if (e) edge.data[i * 4 + 3] = 255;
    }
  const mk = (id: ImageData): HTMLCanvasElement => {
    const cv = document.createElement("canvas");
    cv.width = s;
    cv.height = s;
    cv.getContext("2d")?.putImageData(id, 0, 0);
    return cv;
  };
  const edgeC = mk(edge);
  const fillC = mk(fillM);
  const tint = (from: HTMLCanvasElement, color: string): HTMLCanvasElement => {
    const cv = document.createElement("canvas");
    cv.width = s;
    cv.height = s;
    const t = cv.getContext("2d");
    if (!t) return cv;
    t.drawImage(from, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = color;
    t.fillRect(0, 0, s, s);
    return cv;
  };
  // Thicken the 1-px edge into a tube by stamping it on a ring of offsets.
  const thick = (from: HTMLCanvasElement, r: number): HTMLCanvasElement => {
    const cv = document.createElement("canvas");
    cv.width = s;
    cv.height = s;
    const t = cv.getContext("2d");
    if (!t) return cv;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      t.drawImage(from, Math.cos(ang) * r, Math.sin(ang) * r);
    }
    t.drawImage(from, 0, 0);
    return cv;
  };
  const tubeR = TUBE_PX * 0.42;
  const haloE = tint(thick(edgeC, tubeR * 1.2), c.halo);
  const bodyE = tint(thick(edgeC, tubeR), c.body);
  const coreE = tint(thick(edgeC, tubeR * 0.32), c.core);
  const fillT = tint(fillC, c.halo);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.drawImage(fillT, x, y, size, size);
  ctx.globalAlpha = 1;
  const layers: [number, number][] = [
    [TUBE_PX * 14, 0.5],
    [TUBE_PX * 6, 0.65],
    [TUBE_PX * 2.4, 0.9],
  ];
  for (const [blur, alpha] of layers) {
    ctx.shadowColor = c.halo;
    ctx.shadowBlur = blur;
    ctx.globalAlpha = alpha;
    ctx.drawImage(haloE, x, y, size, size);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.drawImage(bodyE, x, y, size, size);
  ctx.drawImage(coreE, x, y, size, size);
  ctx.restore();
}
