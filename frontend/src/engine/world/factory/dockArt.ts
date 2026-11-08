/**
 * Canvas painting for the dock: trailer livery, roller-door atlas, departures
 * board and release label atlas. Everything here is called on CHANGE only
 * (never per frame).
 */
import type { BrandingOptions } from "@/engine/contracts";
import { neonColors } from "@/engine/world/brandLayout";
import { FONT_STACK, roundRect } from "@/engine/world/architecture";
import { screenFonts } from "@/engine/screens/canvasKit";
import {
  doorMarkLayout,
  liveryLayout,
  shade,
  type BoardLine,
  type ShelfSlot,
} from "@/engine/world/factory/dockModel";
import { SESSION_COLORS } from "@/engine/logic/statusPalette";

type Ctx2D = CanvasRenderingContext2D;

export const LIVERY_W = 2048;
export const LIVERY_H = 400;
export const DOOR_TEX_W = 640;
export const DOOR_TEX_H = 680;
export const BOARD_TEX_W = 1472;
export const BOARD_TEX_H = 736;
export const LABEL_CELL_W = 256;
export const LABEL_CELL_H = 72;
export const LABEL_COLS = 4;
export const LABEL_ROWS = 9;

/** Accent colour used for livery / door marks / LEDs (vivid, never neon-white). */
export function accentOf(b: BrandingOptions): string {
  return neonColors(b.color).halo;
}

/** 8-point star outline (the default logo glyph, same as the lobby sign). */
export function starFill(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
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
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
}

function drawLogo(
  ctx: Ctx2D,
  img: HTMLImageElement | null,
  hasLogo: boolean,
  x: number,
  y: number,
  size: number,
  accent: string,
): void {
  if (hasLogo) {
    if (!img) return;
    const iw = img.naturalWidth || 256;
    const ih = img.naturalHeight || 256;
    const k = Math.min(size / iw, size / ih);
    ctx.drawImage(
      img,
      x + (size - iw * k) / 2,
      y + (size - ih * k) / 2,
      iw * k,
      ih * k,
    );
  } else {
    starFill(ctx, x + size / 2, y + size / 2, size * 0.46, accent);
  }
}

function measurer(
  ctx: Ctx2D,
  weight: number,
): (t: string, px: number) => number {
  return (t, px) => {
    ctx.font = `${weight} ${Math.round(px)}px ${FONT_STACK}`;
    return ctx.measureText(t).width;
  };
}

// ----------------------------------------------------------------- livery

export function drawLivery(
  ctx: Ctx2D,
  w: number,
  h: number,
  b: BrandingOptions,
  logoImg: HTMLImageElement | null,
): void {
  const accent = accentOf(b);
  const deep = shade(accent, -0.35);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#f6f7f9");
  g.addColorStop(1, "#dfe2e7");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Swooshes at both ends (the texture is shared by both trailer sides).
  const sw = w * 0.16;
  for (const flip of [false, true]) {
    ctx.save();
    if (flip) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, h * 0.45);
    ctx.lineTo(sw * 0.9, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = deep;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, h * 0.72);
    ctx.lineTo(sw * 0.46, h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Accent band along the bottom.
  const lay = liveryLayout(
    { name: b.name, tagline: b.tagline, logo: "x" },
    w,
    h,
    measurer(ctx, 700),
  );
  ctx.fillStyle = accent;
  ctx.fillRect(sw * 0.9, lay.band.y, w - sw * 1.8, lay.band.h);
  ctx.fillStyle = deep;
  ctx.fillRect(
    sw * 0.9,
    lay.band.y + lay.band.h,
    w - sw * 1.8,
    lay.band.h * 0.35,
  );

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  if (lay.brand.logo)
    drawLogo(
      ctx,
      logoImg,
      !!b.logo,
      lay.brand.logo.x,
      lay.brand.logo.y,
      lay.brand.logo.size,
      accent,
    );
  if (lay.brand.name) {
    ctx.font = `700 ${Math.round(lay.brand.name.px)}px ${FONT_STACK}`;
    ctx.fillStyle = "#15181d";
    ctx.fillText(
      b.name,
      lay.brand.name.x,
      lay.brand.name.y,
      lay.brand.name.maxW,
    );
  }
  if (lay.brand.tagline) {
    ctx.font = `500 ${Math.round(lay.brand.tagline.px)}px ${FONT_STACK}`;
    ctx.fillStyle = "#59616d";
    ctx.fillText(
      b.tagline,
      lay.brand.tagline.x,
      lay.brand.tagline.y,
      lay.brand.tagline.maxW,
    );
  }
}

// ------------------------------------------------------------------ doors

/** `count` door panels side by side: slats + brand mark + dock number. */
export function drawDoorAtlas(
  ctx: Ctx2D,
  count: number,
  b: BrandingOptions,
  logoImg: HTMLImageElement | null,
): void {
  const accent = accentOf(b);
  const mono = screenFonts().mono;
  for (let d = 0; d < count; d++) {
    const ox = d * DOOR_TEX_W;
    ctx.save();
    ctx.translate(ox, 0);
    const g = ctx.createLinearGradient(0, 0, 0, DOOR_TEX_H);
    g.addColorStop(0, "#4a5058");
    g.addColorStop(1, "#383d44");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DOOR_TEX_W, DOOR_TEX_H);
    // Slats.
    const slat = DOOR_TEX_H / 34;
    for (let i = 0; i < 34; i++) {
      const y = i * slat;
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(0, y + 1, DOOR_TEX_W, 2);
      ctx.fillStyle = "rgba(0,0,0,0.38)";
      ctx.fillRect(0, y + slat - 3, DOOR_TEX_W, 3);
    }
    // Brand mark painted over the slats (a clean plate band).
    const mx = 40;
    const mw = DOOR_TEX_W - 80;
    const my = DOOR_TEX_H * 0.24;
    const mh = DOOR_TEX_H * 0.3;
    const lay = doorMarkLayout(
      { name: b.name, logo: "x" },
      mw,
      mh,
      measurer(ctx, 700),
    );
    ctx.fillStyle = "rgba(14,17,21,0.55)";
    roundRect(ctx, mx - 8, my - 14, mw + 16, mh + 28, 16);
    ctx.fill();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    if (lay.logo)
      drawLogo(
        ctx,
        logoImg,
        !!b.logo,
        mx + lay.logo.x,
        my + lay.logo.y,
        lay.logo.size,
        accent,
      );
    if (lay.name) {
      ctx.font = `700 ${Math.round(lay.name.px)}px ${FONT_STACK}`;
      ctx.fillStyle = "#f4f6f8";
      ctx.fillText(b.name, mx + lay.name.x, my + lay.name.y, lay.name.maxW);
    }
    // Accent bar + dock number.
    ctx.fillStyle = accent;
    ctx.fillRect(mx - 8, my + mh + 30, mw + 16, 8);
    ctx.font = `700 46px ${mono}`;
    ctx.fillStyle = "#e8ebef";
    ctx.textAlign = "center";
    ctx.fillText(`DOCK ${d + 1}`, DOOR_TEX_W / 2, DOOR_TEX_H * 0.82);
    ctx.restore();
  }
}

// ------------------------------------------------------------------ board

export function drawBoard(
  ctx: Ctx2D,
  lines: readonly BoardLine[],
  brandName: string,
  accent: string,
  dotMask: HTMLCanvasElement | null,
): void {
  const W = BOARD_TEX_W;
  const H = BOARD_TEX_H;
  const mono = screenFonts().mono;
  ctx.fillStyle = "#06090d";
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";

  // Header.
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 8);
  ctx.font = `700 58px ${mono}`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#f2f5f8";
  ctx.fillText("DEPARTURES", 40, 66);
  ctx.font = `500 34px ${mono}`;
  ctx.textAlign = "right";
  ctx.fillStyle = shade(accent, 0.25);
  ctx.fillText(brandName.toUpperCase().slice(0, 24), W - 40, 66, 640);

  const cols = { type: 40, name: 250, ref: 690, status: 990, age: W - 40 };
  ctx.font = `500 26px ${mono}`;
  ctx.fillStyle = "#6c7684";
  ctx.textAlign = "left";
  ctx.fillText("TYPE", cols.type, 130);
  ctx.fillText("NAME", cols.name, 130);
  ctx.fillText("REF", cols.ref, 130);
  ctx.fillText("STATUS", cols.status, 130);
  ctx.textAlign = "right";
  ctx.fillText("AGE", cols.age, 130);
  ctx.fillStyle = "#1c232c";
  ctx.fillRect(30, 152, W - 60, 3);

  const rowH = 90;
  const y0 = 168;
  if (lines.length === 0) {
    ctx.font = `500 40px ${mono}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#6c7684";
    ctx.fillText("NO DEPARTURES SCHEDULED", W / 2, y0 + rowH * 2);
  }
  lines.forEach((ln, i) => {
    const cy = y0 + i * rowH + rowH / 2;
    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fillRect(30, y0 + i * rowH, W - 60, rowH);
    }
    ctx.font = `500 38px ${mono}`;
    ctx.textAlign = "left";
    ctx.fillStyle = ln.kind === "deploy" ? "#8fb3ff" : "#c8a8ff";
    ctx.fillText(ln.type, cols.type, cy);
    ctx.fillStyle = "#eef1f5";
    ctx.fillText(ln.name, cols.name, cy, 420);
    ctx.fillStyle = "#aab3c0";
    ctx.fillText(ln.ref, cols.ref, cy, 280);
    ctx.fillStyle = ln.color;
    ctx.beginPath();
    ctx.arc(cols.status - 22, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(ln.status, cols.status, cy, 270);
    ctx.textAlign = "right";
    ctx.fillStyle = "#8b94a1";
    ctx.fillText(ln.age, cols.age, cy);
  });

  if (dotMask) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(dotMask, 0, 0, W, H);
    ctx.restore();
  }
}

/** LED dot-grid multiply mask (bright dots, dark gaps). */
export function makeDotMask(
  w: number,
  h: number,
  pitch: number,
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = "#2a2a2a";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#ffffff";
  const r = pitch * 0.36;
  for (let y = pitch / 2; y < h; y += pitch)
    for (let x = pitch / 2; x < w; x += pitch) {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
  return cv;
}

// ----------------------------------------------------------------- labels

/** Atlas cell index -> pixel origin. */
export function labelCell(index: number): { x: number; y: number } {
  return {
    x: (index % LABEL_COLS) * LABEL_CELL_W,
    y: Math.floor(index / LABEL_COLS) * LABEL_CELL_H,
  };
}

export function drawLabelAtlas(
  ctx: Ctx2D,
  slots: readonly ShelfSlot[],
  accent: string,
): void {
  const W = LABEL_CELL_W * LABEL_COLS;
  const H = LABEL_CELL_H * LABEL_ROWS;
  const mono = screenFonts().mono;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#101419";
  ctx.fillRect(0, 0, W, H);
  slots.forEach((s, i) => {
    const { x, y } = labelCell(i);
    ctx.fillStyle = "#12171d";
    ctx.fillRect(x, y, LABEL_CELL_W, LABEL_CELL_H);
    ctx.fillStyle = s.prerelease ? SESSION_COLORS.needs_you : accent;
    ctx.fillRect(x, y + LABEL_CELL_H - 8, LABEL_CELL_W, 8);
    ctx.font = `700 40px ${mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2f5f8";
    ctx.fillText(
      s.label,
      x + LABEL_CELL_W / 2,
      y + (LABEL_CELL_H - 8) / 2 + 2,
      LABEL_CELL_W - 16,
    );
  });
}
