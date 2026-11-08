/**
 * Wall-mounted digital door sign: a slim LED/e-ink style panel beside a room
 * door showing project label, status chip, objective (2 lines), focus (1 line),
 * git branch and a thin todo progress bar.
 *
 * Wiring: one sign per room is built and fed in `Room.ts` (position from
 * `RoomLayout.nameplate`, offset along the wall). `update()` takes the
 * session's label, status, objective, focus, todo progress and git branch and
 * is cheap: it redraws only when the data changed. `setLod()` follows the same
 * LOD pass as monitors/whiteboards ("far" frees the texture); `dispose()` when
 * the room goes away. Mesh metadata carries `interact: { kind: "screen", ... }`.
 */

import { fmtTokens, fmtUsd } from "../logic/opsModel";
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
import { STATUS_COLORS, type RoomStatus, type Vec3 } from "../contracts";
import type { Lod } from "../characters/types";
import {
  createScreenTexture,
  fitText,
  roundRect,
  screenFonts,
  sharedScreenMaterial,
  thawed,
  whenFontsReady,
  withAlpha,
  wrapText,
  type Ctx2D,
} from "./canvasKit";
import { MUTED_GREY, NEUTRAL_GREY } from "../logic/statusPalette";

export interface DoorSignOptions {
  position: Vec3;
  yaw: number;
  width?: number;
  height?: number;
  sessionId: string;
  roomLabel: string;
}

export interface DoorSignData {
  label: string;
  status: RoomStatus;
  /** Headline: objective, else focus (callers may pass sessionHeadline). */
  objective: string | null;
  focus: string | null;
  todoDone: number;
  todoTotal: number;
  gitBranch?: string | null;
  /** Session cost (USD) and context tokens from the status-line telemetry. */
  costUsd?: number | null;
  tokens?: number | null;
}

const STATUS_TEXT: Record<RoomStatus, string> = {
  needs_you: "NEEDS YOU",
  working: "WORKING",
  done: "DONE",
  ended: "ENDED",
};

const EMPTY: DoorSignData = {
  label: "",
  status: "ended",
  objective: null,
  focus: null,
  todoDone: 0,
  todoTotal: 0,
  gitBranch: null,
  costUsd: null,
  tokens: null,
};

function dataKey(d: DoorSignData): string {
  return [
    d.label,
    d.status,
    d.objective ?? "",
    d.focus ?? "",
    d.todoDone,
    d.todoTotal,
    d.gitBranch ?? "",
    d.costUsd ?? "",
    d.tokens ?? "",
  ].join("\u0001");
}

export class DoorSign {
  private readonly scene: Scene;
  private readonly pivot: TransformNode;
  private readonly surface: Mesh;
  private readonly body: Mesh;
  private readonly led: Mesh;
  private readonly mat: StandardMaterial;
  private readonly ledMat: StandardMaterial;
  private readonly texW = 512;
  private readonly texH: number;
  private tex: DynamicTexture | null = null;
  private data: DoorSignData;
  private key = "\u0000";
  private dirty = true;
  private lod: Lod = "near";
  private disposed = false;

  constructor(
    scene: Scene,
    private readonly opts: DoorSignOptions,
  ) {
    this.scene = scene;
    const w = opts.width ?? 0.9;
    const h = opts.height ?? 0.6;
    const id = `doorsign_${opts.sessionId}`;
    this.data = { ...EMPTY, label: opts.roomLabel };
    this.texH = Math.max(128, Math.round((this.texW * h) / w / 8) * 8);

    this.pivot = new TransformNode(id, scene);
    this.pivot.position.set(opts.position.x, opts.position.y, opts.position.z);
    this.pivot.rotation.y = opts.yaw;

    const interact = {
      kind: "screen",
      sessionId: opts.sessionId,
      roomLabel: opts.roomLabel,
    };

    // Slim dark housing.
    this.body = CreateBox(
      `${id}_body`,
      { width: w + 0.04, height: h + 0.04, depth: 0.03 },
      scene,
    );
    this.body.parent = this.pivot;
    this.body.material = sharedScreenMaterial(scene, "bezel");
    this.body.metadata = { interact };
    this.body.receiveShadows = true;

    // Screen (same facing convention as the whiteboard).
    this.surface = CreatePlane(`${id}_surface`, { width: w, height: h }, scene);
    this.surface.parent = this.pivot;
    this.surface.rotation.y = Math.PI;
    this.surface.position.z = 0.016;
    this.surface.metadata = { interact };
    this.mat = new StandardMaterial(`${id}_mat`, scene);
    this.mat.disableLighting = true;
    this.mat.diffuseColor = Color3.Black();
    this.mat.specularColor = Color3.Black();
    this.mat.emissiveColor = new Color3(0.02, 0.025, 0.035);
    this.surface.material = this.mat;

    // Status LED strip along the bottom edge of the housing.
    this.led = CreateBox(
      `${id}_led`,
      { width: w * 0.5, height: 0.008, depth: 0.004 },
      scene,
    );
    this.led.parent = this.pivot;
    this.led.position.set(0, -h / 2 - 0.016, 0.014);
    this.ledMat = new StandardMaterial(`${id}_ledmat`, scene);
    this.ledMat.disableLighting = true;
    this.ledMat.diffuseColor = Color3.Black();
    this.ledMat.specularColor = Color3.Black();
    this.led.material = this.ledMat;
    this.led.metadata = { interact };
    this.applyLed(this.data.status);
    // Static between status / texture changes (those thaw and re-freeze).
    this.mat.freeze();
    this.ledMat.freeze();

    this.render(true);
    whenFontsReady(() => {
      this.dirty = true;
      this.render(false);
    });
  }

  update(data: DoorSignData): void {
    if (this.disposed) return;
    const key = dataKey(data);
    if (key === this.key) return;
    this.key = key;
    this.data = { ...data };
    this.applyLed(data.status);
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
    return [this.body, this.surface, this.led];
  }

  getGlowMeshes(): AbstractMesh[] {
    return [this.led];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.mat.dispose();
    this.ledMat.dispose();
    this.pivot.dispose(false, false);
  }

  private applyLed(status: RoomStatus): void {
    thawed(this.ledMat, () => {
      this.ledMat.emissiveColor = Color3.FromHexString(STATUS_COLORS[status]);
    });
  }

  private release(): void {
    if (!this.tex) return;
    thawed(this.mat, () => (this.mat.emissiveTexture = null));
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
    drawDoorSign(ctx, this.texW, this.texH, this.data);
    ctx.restore();
    this.tex.update(true);
    this.dirty = false;
  }
}

/** Pure 2D drawing (exported for tests / previews). */
export function drawDoorSign(
  ctx: Ctx2D,
  W: number,
  H: number,
  d: DoorSignData,
): void {
  const F = screenFonts();
  const accent = STATUS_COLORS[d.status];
  const pad = Math.round(W * 0.06);

  // E-ink-ish dark panel with a faint top sheen.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#111827");
  bg.addColorStop(1, "#0A0F1A");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const sheen = ctx.createLinearGradient(0, 0, 0, H * 0.35);
  sheen.addColorStop(0, "rgba(255,255,255,0.06)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H * 0.35);
  // Accent edge.
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, Math.max(5, W * 0.012), H);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  // Header: label + status chip.
  const headH = Math.round(H * 0.17);
  const headY = pad * 0.6 + headH / 2;
  const chipFont = Math.round(headH * 0.4);
  ctx.font = `700 ${chipFont}px ${F.sans}`;
  const chipText = STATUS_TEXT[d.status];
  const chipW = ctx.measureText(chipText).width + chipFont * 1.4;
  const chipH = headH * 0.74;
  const chipX = W - pad - chipW;
  roundRect(ctx, chipX, headY - chipH / 2, chipW, chipH, chipH / 2);
  ctx.fillStyle = withAlpha(accent, 0.2);
  ctx.fill();
  ctx.strokeStyle = withAlpha(accent, 0.8);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.textAlign = "center";
  ctx.fillText(chipText, chipX + chipW / 2, headY + 1);
  ctx.textAlign = "left";

  ctx.font = `700 ${Math.round(headH * 0.56)}px ${F.sans}`;
  ctx.fillStyle = "#F1F5F9";
  ctx.fillText(fitText(ctx, d.label || "-", chipX - pad * 1.5), pad, headY);

  // Divider.
  const divY = pad * 0.6 + headH + H * 0.015;
  ctx.fillStyle = "rgba(148,163,184,0.22)";
  ctx.fillRect(pad, divY, W - pad * 2, 2);

  // Objective: up to 2 lines.
  const objFont = Math.round(H * 0.125);
  ctx.font = `700 ${objFont}px ${F.sans}`;
  const textW = W - pad * 2;
  const objective = d.objective?.trim();
  const headline = objective || d.focus?.trim() || "";
  ctx.fillStyle = "#FFFFFF";
  const lines = headline ? wrapText(ctx, headline, textW, 2) : [];
  const objTop = divY + H * 0.05 + objFont / 2;
  lines.forEach((l, i) => ctx.fillText(l, pad, objTop + i * objFont * 1.18));

  // Focus: 1 line.
  const focusFont = Math.round(H * 0.092);
  const focusY = objTop + objFont * 1.18 + objFont * 0.85 + focusFont / 2;
  ctx.font = `500 ${focusFont}px ${F.sans}`;
  ctx.fillStyle = accent;
  ctx.fillText("▸", pad, focusY);
  const arrowW = ctx.measureText("▸ ").width;
  ctx.fillStyle = NEUTRAL_GREY;
  ctx.fillText(
    fitText(ctx, d.focus?.trim() || "Idle", textW - arrowW),
    pad + arrowW,
    focusY,
  );

  // Footer: progress bar + counts + branch.
  const barH = Math.max(6, Math.round(H * 0.03));
  const barY = H - pad * 0.8 - barH;
  const footFont = Math.round(H * 0.068);
  ctx.font = `600 ${footFont}px ${F.mono}`;
  const counts = d.todoTotal ? `${d.todoDone}/${d.todoTotal}` : "-";
  const countsW = ctx.measureText(counts).width;
  const branch = d.gitBranch?.trim();
  const textY = barY - footFont * 0.85;
  ctx.fillStyle = MUTED_GREY;
  ctx.fillText(counts, pad, textY);
  // Cost + tokens, right-aligned on the same line.
  const spend = [
    d.costUsd != null ? fmtUsd(d.costUsd) : null,
    d.tokens != null ? `${fmtTokens(d.tokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  let spendW = 0;
  if (spend) {
    spendW = ctx.measureText(spend).width;
    ctx.fillStyle = withAlpha(accent, 0.9);
    ctx.textAlign = "right";
    ctx.fillText(spend, W - pad, textY);
    ctx.textAlign = "left";
  }
  if (branch) {
    ctx.fillStyle = NEUTRAL_GREY;
    ctx.fillText(
      fitText(
        ctx,
        `⎇ ${branch}`,
        textW - countsW - spendW - pad * (spendW ? 1.2 : 0.6),
      ),
      pad + countsW + pad * 0.6,
      textY,
    );
  }
  roundRect(ctx, pad, barY, textW, barH, barH / 2);
  ctx.fillStyle = "rgba(148,163,184,0.2)";
  ctx.fill();
  if (d.todoTotal > 0 && d.todoDone > 0) {
    const frac = Math.min(1, d.todoDone / d.todoTotal);
    roundRect(ctx, pad, barY, Math.max(barH, textW * frac), barH, barH / 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
}
