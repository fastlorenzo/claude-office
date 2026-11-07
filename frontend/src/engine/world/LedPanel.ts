/**
 * Digital LED panel (dot-matrix look) mounted over doors: one family for the
 * session rooms and the control room.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ ● CONTINUUM · WAITING FOR YOU  cont-lab-env  │  static line (words!)
 *   │ Retry failed webhooks · CONT-839 · Testing 2m│  ticker (scrolls via UV)
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ status-coloured LED underline
 *   └──────────────────────────────────────────────┘
 *
 * One mesh (two quads), one DynamicTexture, one material per panel. The
 * texture is redrawn only when the strings change; the ticker scrolls by
 * rewriting four UVs, never by redrawing.
 */
import {
  Color3,
  DynamicTexture,
  Mesh,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  VertexBuffer,
  VertexData,
} from "@/engine/babylon";
import type { Lod } from "@/engine/characters/types";
import { screenFonts, whenFontsReady } from "@/engine/screens/canvasKit";

export interface LedSegment {
  text: string;
  color: string;
}

export interface LedContent {
  /** Static line, e.g. [{PROJECT, white}, {" · "}, {STATUS, amber}]. */
  line: LedSegment[];
  /** Scrolling second line, coloured segments (null → empty). */
  ticker: LedSegment[] | null;
  /** Accent dot colour before the line + the LED underline (status colour). */
  dot?: string;
}

const TW = 2048;
const TH = 160;
const ROW = TH / 2;
/** Static line uses the left half of the texture width (panel aspect). */
const STATIC_U = 0.5;

export class LedPanel {
  readonly mesh: Mesh;
  private readonly root: TransformNode;
  private readonly mat: StandardMaterial;
  private tex: DynamicTexture | null = null;
  private content: LedContent = { line: [], ticker: null };
  private key = "";
  private scroll = 0;
  private scrolling = false;
  private lod: Lod = "near";
  private pulseT = 0;
  private pulsing = false;
  private readonly uvs: Float32Array;
  private readonly single: boolean;

  constructor(
    private readonly scene: Scene,
    opts: {
      name: string;
      parent?: TransformNode | null;
      x: number;
      y: number;
      z: number;
      /** Yaw in the parent frame; the face looks along local -Z. */
      yaw: number;
      width?: number;
      height?: number;
      interact?: unknown;
      /** 1 = a single static line using the full height (no ticker row). */
      rows?: 1 | 2;
    },
  ) {
    this.single = opts.rows === 1;
    const w = opts.width ?? 1.28;
    const h = opts.height ?? 0.2;
    this.root = new TransformNode(`${opts.name}:led`, scene);
    this.root.parent = opts.parent ?? null;
    this.root.position.set(opts.x, opts.y, opts.z);
    this.root.rotation.y = opts.yaw;
    const mesh = new Mesh(`${opts.name}:ledFace`, scene);
    const vd = new VertexData();
    const x0 = -w / 2;
    const x1 = w / 2;
    // Single-line mode: the static row spans the full height, ticker collapsed.
    const sy0 = this.single ? -h / 2 : 0;
    const sy1 = this.single ? h / 2 : h / 2;
    const ty0 = this.single ? 0 : -h / 2;
    vd.positions = [
      // static (top) row
      x0,
      sy0,
      0,
      x1,
      sy0,
      0,
      x1,
      sy1,
      0,
      x0,
      sy1,
      0,
      // ticker (bottom) row
      x0,
      ty0,
      0,
      x1,
      ty0,
      0,
      x1,
      0,
      0,
      x0,
      0,
      0,
    ];
    vd.normals = [
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
      0, -1,
    ];
    this.uvs = new Float32Array([
      0,
      0.5,
      STATIC_U,
      0.5,
      STATIC_U,
      1,
      0,
      1,
      0,
      0,
      STATIC_U,
      0,
      STATIC_U,
      0.5,
      0,
      0.5,
    ]);
    vd.uvs = this.uvs;
    vd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    vd.applyToMesh(mesh, true);
    mesh.parent = this.root;
    mesh.isPickable = opts.interact !== undefined;
    if (opts.interact !== undefined)
      mesh.metadata = { interact: opts.interact };
    this.mat = new StandardMaterial(`${opts.name}:ledMat`, scene);
    this.mat.disableLighting = true;
    this.mat.diffuseColor = Color3.Black();
    this.mat.specularColor = Color3.Black();
    this.mat.emissiveColor = Color3.Black();
    mesh.material = this.mat;
    this.mesh = mesh;
    whenFontsReady(() => {
      this.key = "";
      this.redraw();
    });
  }

  set(content: LedContent): void {
    this.content = content;
    this.redraw();
  }

  /** Gentle brightness pulse (needs-you). */
  setPulse(on: boolean): void {
    this.pulsing = on;
    if (!on) this.mat.emissiveColor = Color3.Black();
  }

  setLod(lod: Lod): void {
    if (lod === this.lod) return;
    this.lod = lod;
    if (lod === "far") {
      this.mat.emissiveTexture = null;
      this.tex?.dispose();
      this.tex = null;
      this.key = "";
      this.mesh.setEnabled(false);
      return;
    }
    this.mesh.setEnabled(true);
    this.redraw();
  }

  update(dt: number): void {
    if (this.lod === "far") return;
    if (this.pulsing) {
      this.pulseT += dt;
      const k = 0.08 + 0.08 * Math.sin(this.pulseT * 4);
      this.mat.emissiveColor.set(k, k * 0.6, 0);
    }
    if (!this.scrolling) return;
    this.scroll = (this.scroll + dt * 0.045) % 1;
    const u0 = this.scroll;
    const u1 = u0 + STATIC_U;
    const uv = this.uvs;
    uv[8] = u0;
    uv[10] = u1;
    uv[12] = u1;
    uv[14] = u0;
    this.mesh.updateVerticesData(VertexBuffer.UVKind, uv);
  }

  private redraw(): void {
    if (this.lod === "far") return;
    const c = this.content;
    const key = JSON.stringify(c);
    if (key === this.key && this.tex) return;
    this.key = key;
    if (!this.tex) {
      this.tex = new DynamicTexture(
        "ledPanel",
        { width: TW, height: TH },
        this.scene,
        true,
      );
      this.tex.wrapU = Texture.WRAP_ADDRESSMODE;
      this.tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.tex.anisotropicFilteringLevel = 8;
      this.mat.emissiveTexture = this.tex;
    }
    const ctx = this.tex.getContext() as unknown as CanvasRenderingContext2D;
    this.scrolling = drawLed(ctx, c, this.single) && !this.single;
    if (!this.scrolling) {
      const uv = this.uvs;
      uv[8] = 0;
      uv[10] = STATIC_U;
      uv[12] = STATIC_U;
      uv[14] = 0;
      this.mesh.updateVerticesData(VertexBuffer.UVKind, uv);
    }
    this.tex.update(true);
  }

  dispose(): void {
    this.tex?.dispose();
    this.mat.dispose();
    this.root.dispose(false, false);
  }
}

/** Draw both rows; returns true when the ticker needs to scroll. */
function drawLed(
  ctx: CanvasRenderingContext2D,
  c: LedContent,
  single = false,
): boolean {
  const { sans } = screenFonts();
  // Board: black with a dim grid of unlit LED pixels (4 px pitch).
  ctx.fillStyle = "#030304";
  ctx.fillRect(0, 0, TW, TH);
  ctx.fillStyle = "#16161A";
  for (let y = 0; y < TH; y += 4)
    for (let x = 0; x < TW; x += 4) ctx.fillRect(x + 1, y + 1, 3, 3);
  const half = TW * STATIC_U;
  ctx.textBaseline = "middle";
  // Static row
  let x = ROW * 0.35;
  if (c.dot) {
    ctx.fillStyle = c.dot;
    ctx.beginPath();
    ctx.arc(x + ROW * 0.16, ROW * 0.52, ROW * 0.16, 0, Math.PI * 2);
    ctx.fill();
    x += ROW * 0.5;
  }
  let size = Math.round(ROW * 0.66);
  const lineText = c.line.map((sg) => sg.text).join("");
  ctx.font = `700 ${size}px ${sans}`;
  while (ctx.measureText(lineText).width > half - x - ROW * 0.3 && size > 20) {
    size -= 2;
    ctx.font = `700 ${size}px ${sans}`;
  }
  for (const seg of c.line) {
    ctx.fillStyle = seg.color;
    ctx.fillText(seg.text, x, ROW * 0.54);
    x += ctx.measureText(seg.text).width;
  }
  // Ticker row (seamless loop across the full texture width)
  let scrolls = false;
  const segs = c.ticker ?? [];
  if (segs.length) {
    ctx.font = `600 ${Math.round(ROW * 0.54)}px ${sans}`;
    const widths = segs.map((sg) => ctx.measureText(sg.text).width);
    const tw = widths.reduce((a, b) => a + b, 0);
    const drawAt = (x0: number) => {
      let xx = x0;
      segs.forEach((sg, i) => {
        ctx.fillStyle = sg.color;
        ctx.fillText(sg.text, xx, ROW * 1.5);
        xx += widths[i];
      });
    };
    if (tw <= half - ROW * 0.7) drawAt(ROW * 0.35);
    else {
      scrolls = true;
      const gap = ROW * 1.4;
      const reps = Math.max(1, Math.floor(TW / (tw + gap)));
      const pitch = TW / reps; // even spacing → seamless wrap
      for (let i = 0; i < reps; i++) {
        drawAt(i * pitch + ROW * 0.35);
        ctx.fillStyle = "#5C5850";
        ctx.fillText("◆", i * pitch + pitch - gap * 0.6, ROW * 1.5);
      }
    }
  }
  // Status-coloured LED underline along the bottom edge.
  if (c.dot) {
    ctx.fillStyle = c.dot;
    ctx.fillRect(0, (single ? ROW : TH) - 7, TW, 4);
  }
  // Pixel mask: black gaps between LEDs (keeps the dot-matrix look on text).
  ctx.fillStyle = "rgba(3,3,4,0.7)";
  for (let y = 0; y < TH; y += 4) ctx.fillRect(0, y, TW, 1);
  for (let xx = 0; xx < TW; xx += 4) ctx.fillRect(xx, 0, 1, TH);
  return scrolls;
}
