/**
 * Small 2D-canvas drawing kit for in-world screens (DynamicTexture contexts)
 * plus the shared bezel/frame geometry used by monitors and wall screens.
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
  type Material,
} from "../babylon";

export type Ctx2D = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function cssVarFont(name: string): string | null {
  if (typeof document === "undefined") return null;
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || null;
}

let fontCache: { mono: string; sans: string; hand: string } | null = null;

/** Resolved font stacks (Geist from next/font when present). */
export function screenFonts(): { mono: string; sans: string; hand: string } {
  if (fontCache) return fontCache;
  const geistMono = cssVarFont("--font-geist-mono");
  const geistSans = cssVarFont("--font-geist-sans");
  const mono = `${geistMono ? geistMono + ", " : ""}"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  const sans = `${geistSans ? geistSans + ", " : ""}Inter, "Segoe UI", system-ui, "DejaVu Sans", sans-serif`;
  const hand = `"Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Neue", "Marker Felt", ${sans}`;
  fontCache = { mono, sans, hand };
  return fontCache;
}

let fontsState: "idle" | "loading" | "ready" = "idle";
let fontWaiters: (() => void)[] = [];

/**
 * Calls cb once web fonts have loaded (so screens can redraw crisp). One
 * shared load for the page: callbacks queued before it resolves run once and
 * are dropped; screens created afterwards already draw with the web fonts,
 * so later calls are no-ops.
 */
export function whenFontsReady(cb: () => void): void {
  if (typeof document === "undefined" || !document.fonts) return;
  if (fontsState === "ready") return;
  fontWaiters.push(cb);
  if (fontsState === "loading") return;
  fontsState = "loading";
  const f = screenFonts();
  void Promise.all([
    document.fonts.load(`20px ${f.mono}`),
    document.fonts.load(`20px ${f.sans}`),
  ])
    .then(() => document.fonts.ready)
    .then(
      () => {
        fontsState = "ready";
        const list = fontWaiters;
        fontWaiters = [];
        for (const w of list) w();
      },
      () => {
        fontsState = "ready";
        fontWaiters = [];
      },
    );
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

export function roundRect(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Truncate text with an ellipsis so it fits maxWidth (current ctx font). */
export function fitText(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

/** Greedy word wrap using canvas metrics; last line ellipsised. */
export function wrapText(
  ctx: Ctx2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxWidth || !cur) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines) {
      lines[maxLines - 1] = fitText(
        ctx,
        `${lines[maxLines - 1]} ${words.slice(i).join(" ")}`,
        maxWidth,
      );
      return lines;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).join(" ");
    lines.length = maxLines - 1;
    lines.push(fitText(ctx, rest, maxWidth));
  }
  return lines.map((l) => fitText(ctx, l, maxWidth));
}

export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------------------
// Textures / materials
// ---------------------------------------------------------------------------

export function createScreenTexture(
  name: string,
  scene: Scene,
  w: number,
  h: number,
  alpha = false,
): DynamicTexture {
  const dt = new DynamicTexture(
    name,
    { width: w, height: h },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  dt.anisotropicFilteringLevel = 8;
  // Named in the `?drawdbg=1` texture breakdown (internal textures are anonymous).
  const internal = dt.getInternalTexture();
  if (internal) internal.label = name;
  dt.hasAlpha = alpha;
  dt.wrapU = Texture.CLAMP_ADDRESSMODE;
  dt.wrapV = Texture.CLAMP_ADDRESSMODE;
  return dt;
}

/**
 * Screen glass: a glossy black dielectric (anti-glare coat, rough 0.12) that
 * reflects the room through the IBL, with the picture as its emission. A
 * real display is never an unlit sticker — the reflection is what sells it.
 * Kept out of the SSAO/SSR G-buffer (`metadata.noGBuffer`): the IBL already
 * gives the reflection and a screen must not occlude AO.
 */
function screenGlass(name: string, scene: Scene, rough = 0.12): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = new Color3(0.01, 0.012, 0.015);
  m.metallic = 0;
  m.roughness = rough;
  m.environmentIntensity = 0.6;
  m.enableSpecularAntiAliasing = true;
  m.maxSimultaneousLights = 4;
  m.metadata = { noGBuffer: true };
  return m;
}

/** Glow of a screen with no picture bound (the backlight through black). */
const NO_SIGNAL = new Color3(0.02, 0.025, 0.035);

/** Emissive screen material showing a texture (monitors, wall screens). */
export function createEmissiveMaterial(
  name: string,
  scene: Scene,
  tex: Texture | null,
): PBRMaterial {
  const m = screenGlass(name, scene);
  setScreenTexture(m, tex);
  return m;
}

/**
 * Bind (or clear) a screen's picture. PBR multiplies emissiveColor with the
 * emissive texture, so the colour is white with a picture and the dark
 * backlight without one. Frozen screen materials thaw and re-freeze.
 */
export function setScreenTexture(
  m: PBRMaterial,
  tex: Texture | null,
  noSignal: Color3 = NO_SIGNAL,
): void {
  thawed(m, () => {
    m.emissiveTexture = tex;
    m.emissiveColor = tex ? Color3.White() : noSignal.clone();
  });
}

/**
 * Mutate a (possibly frozen) material: thaw, apply, re-freeze. Frozen
 * materials ignore property changes, so every swap on a frozen screen /
 * sign material goes through here.
 */
export function thawed(m: Material, apply: () => void): void {
  const frozen = m.isFrozen;
  if (frozen) m.unfreeze();
  apply();
  if (frozen) m.freeze();
}

type SharedKey = "bezel" | "screenOff" | "screenIdle" | "frame";
const shared = new WeakMap<Scene, Map<SharedKey, PBRMaterial>>();

/** Per-scene shared materials for screen hardware. */
export function sharedScreenMaterial(
  scene: Scene,
  key: SharedKey,
): PBRMaterial {
  let map = shared.get(scene);
  if (!map) {
    map = new Map();
    shared.set(scene, map);
  }
  const hit = map.get(key);
  if (hit && scene.materials.includes(hit)) return hit;
  let m: PBRMaterial;
  if (key === "bezel") {
    // Satin black ABS (dielectric).
    m = new PBRMaterial(`screens_${key}`, scene);
    m.albedoColor = new Color3(0.03, 0.032, 0.036);
    m.metallic = 0;
    m.roughness = 0.45;
  } else if (key === "frame") {
    // Anodised aluminium whiteboard / sign frame.
    m = new PBRMaterial(`screens_${key}`, scene);
    m.albedoColor = new Color3(0.72, 0.74, 0.77);
    m.metallic = 1;
    m.roughness = 0.35;
  } else {
    m = screenGlass(`screens_${key}`, scene);
    m.emissiveColor =
      key === "screenIdle"
        ? new Color3(0.035, 0.05, 0.075)
        : new Color3(0.006, 0.007, 0.01);
  }
  // Static hardware: never changes after creation.
  m.freeze();
  map.set(key, m);
  return m;
}

/**
 * Monitor hardware (thin bezel + back shell + stand + base) as ONE merged
 * mesh, in local space with the screen front facing +Z, screen centre at 0.
 * `drop` = distance from the screen's bottom edge down to the desk top.
 */
export function buildMonitorBody(
  name: string,
  scene: Scene,
  w: number,
  h: number,
  drop: number,
): Mesh {
  const parts: Mesh[] = [];
  const bezel = CreateBox(
    `${name}_bezel`,
    { width: w + 0.022, height: h + 0.022, depth: 0.016 },
    scene,
  );
  bezel.position.z = -0.0085;
  parts.push(bezel);
  const back = CreateBox(
    `${name}_back`,
    { width: w * 0.62, height: h * 0.56, depth: 0.03 },
    scene,
  );
  back.position.set(0, -h * 0.04, -0.03);
  parts.push(back);
  if (drop > 0.01) {
    const neck = CreateBox(
      `${name}_neck`,
      { width: 0.045, height: drop + h * 0.3, depth: 0.02 },
      scene,
    );
    neck.position.set(0, -h / 2 - drop / 2 + h * 0.15, -0.052);
    parts.push(neck);
    const base = CreateCylinder(
      `${name}_base`,
      {
        height: 0.012,
        diameterTop: 0.2,
        diameterBottom: 0.21,
        tessellation: 24,
      },
      scene,
    );
    base.scaling.z = 0.75;
    base.position.set(0, -h / 2 - drop + 0.006, -0.05);
    parts.push(base);
  }
  const merged = Mesh.MergeMeshes(parts, true, true) as Mesh;
  merged.name = `${name}_body`;
  merged.material = sharedScreenMaterial(scene, "bezel");
  merged.isPickable = false;
  return merged;
}
