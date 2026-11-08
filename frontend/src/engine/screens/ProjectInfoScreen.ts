/**
 * Wall-mounted info screen beside each team-room door (hall side): one row
 * per session — name, summary, phase + elapsed, context bar + tokens,
 * model / effort, cost. The LED panel over the door carries the project name
 * and aggregate status, so neither appears here (no duplication).
 *
 * One plane + slim housing, one DynamicTexture redrawn only when the rows
 * change (`infoKey`), freed at LOD "far".
 */
import {
  Color3,
  CreateBox,
  CreatePlane,
  Scene,
  StandardMaterial,
  TransformNode,
  type AbstractMesh,
  type DynamicTexture,
  type Mesh,
} from "../babylon";
import {
  STATUS_COLORS,
  type InteractionTarget,
  type Panel,
} from "../contracts";
import type { Lod } from "../characters/types";
import { DASH, infoKey, type InfoRow } from "../logic/projectInfo";
import { PHASE_COLORS } from "../world/RoomSign";
import {
  createScreenTexture,
  fitText,
  roundRect,
  screenFonts,
  sharedScreenMaterial,
  thawed,
  whenFontsReady,
  withAlpha,
  type Ctx2D,
} from "./canvasKit";

export class ProjectInfoScreen {
  readonly pivot: TransformNode;
  private readonly surface: Mesh;
  private readonly body: Mesh;
  private readonly mat: StandardMaterial;
  private readonly texW = 1024;
  private readonly texH: number;
  private tex: DynamicTexture | null = null;
  private rows: InfoRow[] = [];
  private more = 0;
  private key = "\u0000";
  private dirty = true;
  private lod: Lod = "near";
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    name: string,
    panel: Panel,
    readonly interact: InteractionTarget,
  ) {
    const { width: w, height: h } = panel;
    this.texH = Math.max(256, Math.round((this.texW * h) / w / 8) * 8);
    const id = `infoScreen_${name}`;
    this.pivot = new TransformNode(id, scene);
    this.pivot.position.set(
      panel.position.x,
      panel.position.y,
      panel.position.z,
    );
    this.pivot.rotation.y = panel.yaw;
    this.body = CreateBox(
      `${id}_body`,
      { width: w + 0.05, height: h + 0.05, depth: 0.035 },
      scene,
    );
    this.body.parent = this.pivot;
    this.body.position.z = -0.012;
    this.body.material = sharedScreenMaterial(scene, "bezel");
    this.body.metadata = { interact };
    this.body.receiveShadows = true;
    this.surface = CreatePlane(`${id}_surface`, { width: w, height: h }, scene);
    this.surface.parent = this.pivot;
    this.surface.rotation.y = Math.PI;
    this.surface.position.z = 0.0075;
    this.surface.metadata = { interact };
    this.mat = new StandardMaterial(`${id}_mat`, scene);
    this.mat.disableLighting = true;
    this.mat.diffuseColor = Color3.Black();
    this.mat.specularColor = Color3.Black();
    this.mat.emissiveColor = new Color3(0.02, 0.025, 0.035);
    this.surface.material = this.mat;
    this.mat.freeze(); // swaps below thaw and re-freeze
    this.render(true);
    whenFontsReady(() => {
      this.dirty = true;
      this.render(true);
    });
  }

  setRows(rows: InfoRow[], more: number): void {
    if (this.disposed) return;
    const key = infoKey(rows, more);
    if (key === this.key) return;
    this.key = key;
    this.rows = rows;
    this.more = more;
    this.dirty = true;
    this.render(false);
  }

  setLod(lod: Lod): void {
    if (lod === this.lod) return;
    this.lod = lod;
    if (lod === "far") {
      this.release();
      return;
    }
    this.render(!this.tex);
  }

  getMeshes(): AbstractMesh[] {
    return [this.body, this.surface];
  }

  get mesh(): Mesh {
    return this.surface;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.mat.dispose();
    this.pivot.dispose(false, false);
  }

  private release(): void {
    if (!this.tex) return;
    thawed(this.mat, () => {
      this.mat.emissiveTexture = null;
      this.mat.emissiveColor = new Color3(0.02, 0.025, 0.035);
    });
    this.tex.dispose();
    this.tex = null;
    this.dirty = true;
  }

  private render(force: boolean): void {
    if (this.disposed || !this.dirty || this.lod === "far") return;
    if (this.lod === "mid" && !force) return;
    if (!this.tex) {
      this.tex = createScreenTexture(
        `${this.surface.name}_tex`,
        this.scene,
        this.texW,
        this.texH,
      );
      // StandardMaterial ADDS emissiveColor to the emissive texture: keep it black.
      const tex = this.tex;
      thawed(this.mat, () => {
        this.mat.emissiveColor = Color3.Black();
        this.mat.emissiveTexture = tex;
      });
    }
    const ctx = this.tex.getContext() as unknown as Ctx2D;
    ctx.save();
    drawProjectInfo(ctx, this.texW, this.texH, this.rows, this.more);
    ctx.restore();
    this.tex.update(true);
    this.dirty = false;
  }
}

/** Pure 2D drawing (exported for previews / tests). */
export function drawProjectInfo(
  ctx: Ctx2D,
  W: number,
  H: number,
  rows: readonly InfoRow[],
  more: number,
): void {
  const F = screenFonts();
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#10141C");
  bg.addColorStop(1, "#0A0D13");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const pad = Math.round(W * 0.03);
  const headH = Math.round(H * 0.085);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 ${Math.round(headH * 0.5)}px ${F.sans}`;
  ctx.fillStyle = "#7D8796";
  ctx.fillText("SESSIONS IN THIS ROOM", pad, headH * 0.6);
  ctx.textAlign = "right";
  ctx.fillText("CONTEXT · MODEL · COST", W - pad, headH * 0.6);
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(148,163,184,0.18)";
  ctx.fillRect(pad, headH, W - pad * 2, 2);

  const slots = Math.max(3, rows.length) + (more ? 0.5 : 0);
  const rowH = (H - headH - pad * 0.5) / slots;
  rows.forEach((r, i) => {
    const y0 = headH + 6 + i * rowH;
    drawRow(ctx, F, pad, y0, W - pad * 2, rowH - 8, r);
  });
  if (more) {
    ctx.font = `500 ${Math.round(rowH * 0.2)}px ${F.sans}`;
    ctx.fillStyle = "#7D8796";
    ctx.fillText(
      `+${more} more`,
      pad,
      headH + 6 + rows.length * rowH + rowH * 0.22,
    );
  }
  if (!rows.length) {
    ctx.font = `500 ${Math.round(H * 0.06)}px ${F.sans}`;
    ctx.fillStyle = "#5B6472";
    ctx.textAlign = "center";
    ctx.fillText("No sessions", W / 2, H / 2);
  }
}

function drawRow(
  ctx: Ctx2D,
  F: { mono: string; sans: string },
  x: number,
  y: number,
  w: number,
  h: number,
  r: InfoRow,
): void {
  const accent = STATUS_COLORS[r.status];
  roundRect(ctx, x, y, w, h, Math.min(10, h * 0.12));
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y + h * 0.12, Math.max(5, w * 0.007), h * 0.76);
  const ix = x + w * 0.025;
  const right = x + w - w * 0.02;
  const l1 = y + h * 0.27;
  const l2 = y + h * 0.56;
  const l3 = y + h * 0.82;

  // Line 1: session name (left) + phase pill (right).
  const pf = Math.round(h * 0.17);
  ctx.font = `700 ${pf}px ${F.sans}`;
  const phaseColor = PHASE_COLORS[r.phaseKind] ?? accent;
  const phaseText = fitText(ctx, r.phase, w * 0.42);
  const pw = ctx.measureText(phaseText).width + pf * 1.3;
  const ph = pf * 1.45;
  roundRect(ctx, right - pw, l1 - ph / 2, pw, ph, ph / 2);
  ctx.fillStyle = withAlpha(phaseColor, 0.18);
  ctx.fill();
  ctx.fillStyle = phaseColor;
  ctx.textAlign = "center";
  ctx.fillText(phaseText, right - pw / 2, l1 + 1);
  ctx.textAlign = "left";
  ctx.font = `700 ${Math.round(h * 0.23)}px ${F.sans}`;
  ctx.fillStyle = "#F1F5F9";
  ctx.fillText(fitText(ctx, r.name, right - pw - ix - w * 0.02), ix, l1);

  // Line 2: summary.
  ctx.font = `500 ${Math.round(h * 0.17)}px ${F.sans}`;
  ctx.fillStyle = r.summary === DASH ? "#5B6472" : "#B9C2CF";
  ctx.fillText(fitText(ctx, r.summary, right - ix), ix, l2);

  // Line 3: context bar + tokens · model · cost (right).
  const mf = Math.round(h * 0.15);
  ctx.font = `600 ${mf}px ${F.mono}`;
  const barW = w * 0.22;
  const barH = Math.max(5, h * 0.07);
  roundRect(ctx, ix, l3 - barH / 2, barW, barH, barH / 2);
  ctx.fillStyle = "rgba(148,163,184,0.22)";
  ctx.fill();
  if (r.ctxPct != null) {
    const pct = r.ctxPct / 100;
    const c = pct >= 0.8 ? "#F59E0B" : pct >= 0.6 ? "#EAB308" : "#38BDF8";
    roundRect(
      ctx,
      ix,
      l3 - barH / 2,
      Math.max(barH, barW * pct),
      barH,
      barH / 2,
    );
    ctx.fillStyle = c;
    ctx.fill();
  }
  const ctxText =
    r.ctxPct != null ? `${Math.round(r.ctxPct)}% · ${r.tokens}` : DASH;
  ctx.fillStyle = "#94A3B8";
  ctx.fillText(ctxText, ix + barW + w * 0.015, l3);
  ctx.textAlign = "right";
  ctx.fillStyle = r.cost === DASH ? "#5B6472" : "#E2E8F0";
  const costW = ctx.measureText(r.cost).width;
  ctx.fillText(r.cost, right, l3);
  ctx.fillStyle = "#94A3B8";
  ctx.fillText(fitText(ctx, r.model, w * 0.3), right - costW - w * 0.03, l3);
  ctx.textAlign = "left";
}
