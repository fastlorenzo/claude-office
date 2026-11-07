/**
 * Digital door sign beside each room door (hall side): a slim black-framed
 * e-paper style panel that says what the session is doing, not just its id.
 *
 *   ROOM 02 · CONTINUUM                      ← eyebrow (room number · project)
 *   Add SSO login to the admin               ← summary, ≤ 2 lines
 *   dashboard
 *   [CONT-839]  ● Waiting for your approval  ← ref chip + phase (colour by kind)
 *
 * Title fallback: summary → objective → room label (sessionSummary already
 * strips refs from objectives). Redraws only when one of the strings changes.
 *
 * Built from the screens/DoorSign.ts idea, but owned by the world layer so the
 * art direction (layout, materials, placement on the pier) lives with Room.
 */
import {
  Color3,
  CreatePlane,
  DynamicTexture,
  Mesh,
  Scene,
  StandardMaterial,
  TransformNode,
  type AbstractMesh,
} from "@/engine/babylon";
import {
  type CampusSession,
  type RoomStatus,
  type SessionPhaseKind,
} from "@/engine/contracts";
import type { Lod } from "@/engine/characters/types";
import {
  sessionPhase,
  sessionRefs,
  sessionSummary,
} from "@/engine/logic/sessionInfo";
import {
  fitText,
  roundRect,
  screenFonts,
  whenFontsReady,
  wrapText,
} from "@/engine/screens/canvasKit";

export const PHASE_COLORS: Record<SessionPhaseKind, string> = {
  needs_approval: "#F59E0B",
  waiting_user: "#F5B547",
  planning: "#60A5FA",
  researching: "#38BDF8",
  exploring: "#7DD3FC",
  coding: "#22C55E",
  testing: "#A78BFA",
  building: "#818CF8",
  running: "#3B82F6",
  git: "#F472B6",
  delegating: "#2DD4BF",
  compacting: "#94A3B8",
  idle: "#94A3B8",
  ended: "#64748B",
};

export interface RoomSignData {
  room: number;
  project: string | null;
  title: string;
  ref: string | null;
  phaseKind: SessionPhaseKind;
  phase: string;
  status: RoomStatus;
}

/** Pure: campus session → sign strings (with the documented fallbacks). */
export function roomSignData(
  cs: CampusSession | null,
  label: string,
  room: number,
  status: RoomStatus,
): RoomSignData {
  if (!cs)
    return {
      room,
      project: null,
      title: label,
      ref: null,
      phaseKind: "idle",
      phase: "Idle",
      status,
    };
  const phase = sessionPhase(cs);
  return {
    room,
    project: cs.project?.trim() || null,
    title: sessionSummary(cs) ?? label,
    ref: sessionRefs(cs, 1)[0] ?? null,
    phaseKind: phase.kind,
    phase: phase.label,
    status,
  };
}

const TEX_W = 1024;
const TEX_H = 576;

export class RoomSign {
  readonly root: TransformNode;
  private readonly face: Mesh;
  private readonly mat: StandardMaterial;
  private tex: DynamicTexture | null = null;
  private data: RoomSignData;
  private key = "";
  private lod: Lod = "near";
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    opts: {
      parent: TransformNode;
      /** Face centre (parent frame). */
      x: number;
      y: number;
      z: number;
      /** Yaw in the parent frame (the face looks along local -Z after yaw). */
      yaw: number;
      width: number;
      height: number;
      name: string;
      interact: unknown;
    },
    initial: RoomSignData,
  ) {
    this.data = initial;
    this.root = new TransformNode(`${opts.name}:sign`, scene);
    this.root.parent = opts.parent;
    this.root.position.set(opts.x, opts.y, opts.z);
    this.root.rotation.y = opts.yaw;

    this.face = CreatePlane(
      `${opts.name}:signFace`,
      { width: opts.width, height: opts.height },
      scene,
    );
    this.face.parent = this.root;
    this.face.metadata = { interact: opts.interact };
    this.mat = new StandardMaterial(`${opts.name}:signMat`, scene);
    this.mat.disableLighting = true;
    this.mat.diffuseColor = Color3.Black();
    this.mat.specularColor = Color3.Black();
    // StandardMaterial adds emissiveColor to the texture: keep it black.
    this.mat.emissiveColor = Color3.Black();
    this.face.material = this.mat;

    for (const m of [this.face]) {
      m.isPickable = true;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    this.redraw(true);
    whenFontsReady(() => this.redraw(true));
  }

  /** The status LED moved to the door's status bar (one draw less per room). */
  get glowMeshes(): AbstractMesh[] {
    return [];
  }

  get meshes(): AbstractMesh[] {
    return [this.face];
  }

  update(data: RoomSignData): void {
    this.data = data;
    this.redraw(false);
  }

  setLod(lod: Lod): void {
    if (lod === this.lod) return;
    this.lod = lod;
    if (lod === "far") {
      this.mat.emissiveTexture = null;
      this.tex?.dispose();
      this.tex = null;
      this.key = "";
      return;
    }
    this.redraw(false);
  }

  private redraw(force: boolean): void {
    if (this.disposed || this.lod === "far") return;
    const d = this.data;
    const key = [
      d.room,
      d.project,
      d.title,
      d.ref,
      d.phaseKind,
      d.phase,
      d.status,
    ].join("\u0001");
    if (!force && key === this.key && this.tex) return;
    this.key = key;
    if (!this.tex) {
      this.tex = new DynamicTexture(
        "roomSign",
        { width: TEX_W, height: TEX_H },
        this.scene,
        true,
      );
      this.tex.anisotropicFilteringLevel = 8;
      this.mat.emissiveTexture = this.tex;
    }
    const ctx = this.tex.getContext() as unknown as CanvasRenderingContext2D;
    drawRoomSign(ctx, TEX_W, TEX_H, d);
    this.tex.update(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tex?.dispose();
    this.mat.dispose();
    this.root.dispose(false, false);
  }
}

/** Draw the sign (dark e-ink look: graphite ground, warm white type). */
export function drawRoomSign(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  d: RoomSignData,
): void {
  const { sans, mono } = screenFonts();
  ctx.fillStyle = "#121315";
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.06;
  const tw = w - pad * 2;
  // Eyebrow
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8D8981";
  ctx.font = `600 ${Math.round(h * 0.068)}px ${sans}`;
  const eyebrow = `ROOM ${String(d.room).padStart(2, "0")}${d.project ? ` · ${d.project.toUpperCase()}` : ""}`;
  ctx.fillText(fitText(ctx, eyebrow, tw), pad, pad + h * 0.06);
  // Title (≤ 2 lines, shrink a step if one line overflows badly)
  ctx.fillStyle = "#F4F1EC";
  let size = Math.round(h * 0.135);
  ctx.font = `600 ${size}px ${sans}`;
  let lines = wrapText(ctx, d.title, tw, 2);
  if (lines.length === 2 && ctx.measureText(lines[1]).width > tw * 0.98) {
    size = Math.round(h * 0.118);
    ctx.font = `600 ${size}px ${sans}`;
    lines = wrapText(ctx, d.title, tw, 2);
  }
  const titleY = pad + h * 0.24;
  lines.forEach((l, i) => ctx.fillText(l, pad, titleY + i * size * 1.12));
  // Ref chip + phase
  const rowY = h - pad - h * 0.05;
  let x = pad;
  if (d.ref) {
    ctx.font = `600 ${Math.round(h * 0.062)}px ${mono}`;
    const cw = ctx.measureText(d.ref).width + h * 0.06;
    const ch = h * 0.1;
    ctx.fillStyle = "#26282C";
    roundRect(ctx, x, rowY - ch * 0.72, cw, ch, ch * 0.24);
    ctx.fill();
    ctx.fillStyle = "#C9C5BE";
    ctx.fillText(d.ref, x + h * 0.03, rowY);
    x += cw + h * 0.05;
  }
  const col = PHASE_COLORS[d.phaseKind] ?? "#94A3B8";
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x + h * 0.022, rowY - h * 0.022, h * 0.022, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 ${Math.round(h * 0.07)}px ${sans}`;
  ctx.fillText(
    fitText(ctx, d.phase, w - pad - x - h * 0.06),
    x + h * 0.065,
    rowY,
  );
  // Hairline divider above the row
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(pad, rowY - h * 0.14, tw, 2);
}
