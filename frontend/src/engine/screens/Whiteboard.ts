/**
 * Wall whiteboard: glossy white board in a brushed-aluminium frame with a
 * marker tray, showing the session todos as a 3-column kanban of sticky notes.
 */

import {
  Color3,
  Color4,
  CreateBox,
  CreateCylinder,
  CreatePlane,
  Mesh,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  type DynamicTexture,
} from "../babylon";
import type { Vec3 } from "../contracts";
import type { TodoItem } from "@/types";
import type { Lod } from "../characters/types";
import { ScreenHub, type HubScreen } from "./ScreenHub";
import {
  createScreenTexture,
  fitText,
  roundRect,
  screenFonts,
  sharedScreenMaterial,
  thawed,
  whenFontsReady,
  wrapText,
  type Ctx2D,
} from "./canvasKit";
import { bucketTodos, noteTilt, type KanbanColumnId } from "./screenModels";

export interface WhiteboardOptions {
  position: Vec3;
  yaw: number;
  width: number;
  height: number;
  sessionId: string;
  roomLabel: string;
}

const NOTE: Record<
  KanbanColumnId,
  { fill: string; edge: string; ink: string; head: string }
> = {
  pending: {
    fill: "#FFE98A",
    edge: "#F2D25C",
    ink: "#3D3420",
    head: "#64748B",
  },
  in_progress: {
    fill: "#9FD3FF",
    edge: "#73B9F2",
    ink: "#1E3A5F",
    head: "#2563EB",
  },
  completed: {
    fill: "#B5EBB0",
    edge: "#8FD889",
    ink: "#1F4A1C",
    head: "#16A34A",
  },
};

export class WhiteboardScreen implements HubScreen {
  readonly mesh: Mesh;
  readonly sessionId: string;
  readonly worldPos: Vector3;
  private readonly hub: ScreenHub;
  private readonly scene: Scene;
  private readonly pivot: TransformNode;
  private readonly frame: Mesh;
  private readonly mat: StandardMaterial;
  private readonly texW: number;
  private readonly texH: number;
  private tex: DynamicTexture | null = null;
  private todos: TodoItem[] = [];
  private key = "\u0000";
  private dirty = true;
  private lod: Lod = "near";
  private disposed = false;

  constructor(
    scene: Scene,
    private readonly opts: WhiteboardOptions,
  ) {
    this.scene = scene;
    this.sessionId = opts.sessionId;
    this.worldPos = new Vector3(
      opts.position.x,
      opts.position.y,
      opts.position.z,
    );
    this.hub = ScreenHub.get(scene);
    const id = `board_${opts.sessionId}`;
    this.pivot = new TransformNode(id, scene);
    this.pivot.position.set(opts.position.x, opts.position.y, opts.position.z);
    this.pivot.rotation.y = opts.yaw;
    const { width: w, height: h } = opts;

    this.mesh = CreatePlane(`${id}_surface`, { width: w, height: h }, scene);
    this.mesh.parent = this.pivot;
    this.mesh.rotation.y = Math.PI;
    this.mesh.position.z = 0.012;
    this.mesh.metadata = {
      interact: {
        kind: "whiteboard",
        sessionId: opts.sessionId,
        roomLabel: opts.roomLabel,
      },
    };
    this.mesh.receiveShadows = true;

    this.mat = new StandardMaterial(`${id}_mat`, scene);
    // Half lit, half self-lit: reads in any room lighting, still catches light.
    this.mat.diffuseColor = new Color3(0.45, 0.45, 0.45);
    this.mat.specularColor = new Color3(0.25, 0.25, 0.27);
    this.mat.specularPower = 90;
    this.mat.emissiveColor = Color3.Black();
    this.mesh.material = this.mat;
    this.mat.freeze(); // texture swaps thaw and re-freeze

    this.frame = buildBoardFrame(id, scene, w, h);
    this.frame.parent = this.pivot;
    this.frame.metadata = this.mesh.metadata;

    this.hub.add(this);
    this.texW = 1024;
    this.texH = Math.max(256, Math.round((1024 * h) / w / 8) * 8);
    this.render(true);
    whenFontsReady(() => {
      this.dirty = true;
      this.render(false);
    });
  }

  setTodos(todos: TodoItem[]): void {
    const key = todos
      .map((t) => `${t.status}|${t.active_form ?? ""}|${t.content}`)
      .join("\n");
    if (key === this.key) return;
    this.key = key;
    this.todos = todos.slice();
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

  getMeshes(): Mesh[] {
    return [this.frame, this.mesh];
  }

  /** ScreenHub: hide the board while its room is culled or it is too far to read. */
  applyHub(show: boolean, dist: number): void {
    const on = show && dist < (this.mesh.isEnabled(false) ? 20 : 17);
    if (this.mesh.isEnabled(false) === on) return;
    this.mesh.setEnabled(on);
    this.frame.setEnabled(on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.remove(this);
    this.release();
    this.mat.dispose();
    this.pivot.dispose(false, false);
  }

  private release(): void {
    if (!this.tex) return;
    thawed(this.mat, () => {
      this.mat.diffuseTexture = null;
      this.mat.emissiveTexture = null;
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
        `${this.mesh.name}_tex`,
        this.scene,
        this.texW,
        this.texH,
      );
      this.tex.level = 0.78;
      const tex = this.tex;
      thawed(this.mat, () => {
        this.mat.diffuseTexture = tex;
        this.mat.emissiveTexture = tex;
      });
    }
    const ctx = this.tex.getContext() as unknown as Ctx2D;
    ctx.save();
    drawKanban(ctx, this.texW, this.texH, this.todos, this.opts.roomLabel);
    ctx.restore();
    this.tex.update(true);
    this.dirty = false;
  }
}

function buildBoardFrame(id: string, scene: Scene, w: number, h: number): Mesh {
  const t = 0.028; // frame bar thickness
  const d = 0.03;
  const parts: Mesh[] = [];
  const bar = (name: string, bw: number, bh: number, x: number, y: number) => {
    const b = CreateBox(
      `${id}_${name}`,
      { width: bw, height: bh, depth: d },
      scene,
    );
    b.position.set(x, y, 0);
    parts.push(b);
  };
  bar("top", w + 2 * t, t, 0, h / 2 + t / 2);
  bar("bottom", w + 2 * t, t, 0, -h / 2 - t / 2);
  bar("left", t, h, -w / 2 - t / 2, 0);
  bar("right", t, h, w / 2 + t / 2, 0);
  const back = CreateBox(
    `${id}_back`,
    { width: w, height: h, depth: 0.01 },
    scene,
  );
  back.position.z = -0.002;
  parts.push(back);
  // Marker tray.
  const tray = CreateBox(
    `${id}_tray`,
    { width: w * 0.42, height: 0.018, depth: 0.075 },
    scene,
  );
  tray.position.set(w * 0.22, -h / 2 - t - 0.005, 0.04);
  parts.push(tray);
  const lip = CreateBox(
    `${id}_lip`,
    { width: w * 0.42, height: 0.03, depth: 0.006 },
    scene,
  );
  lip.position.set(w * 0.22, -h / 2 - t + 0.004, 0.077);
  parts.push(lip);
  const white = new Color4(0.86, 0.87, 0.89, 1);
  for (const p of parts) colorize(p, white);
  const markers: [string, number][] = [
    ["#1F2937", 0.02],
    ["#2563EB", 0.11],
    ["#DC2626", 0.2],
    ["#16A34A", 0.3],
  ];
  for (const [hex, x] of markers) {
    const m = CreateCylinder(
      `${id}_marker`,
      { height: 0.12, diameter: 0.018, tessellation: 10 },
      scene,
    );
    m.rotation.z = Math.PI / 2;
    m.rotation.y = 0.08;
    m.position.set(w * 0.06 + x * w * 0.4, -h / 2 - t + 0.013, 0.045);
    const c = Color3.FromHexString(hex).toLinearSpace();
    colorize(m, new Color4(c.r, c.g, c.b, 1));
    parts.push(m);
  }
  const merged = Mesh.MergeMeshes(parts, true, true) as Mesh;
  merged.name = `${id}_frame`;
  merged.material = sharedScreenMaterial(scene, "frame");
  merged.useVertexColors = true;
  merged.isPickable = true;
  merged.receiveShadows = true;
  return merged;
}

function colorize(m: Mesh, c: Color4): void {
  const n = m.getTotalVertices();
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = c.r;
    arr[i * 4 + 1] = c.g;
    arr[i * 4 + 2] = c.b;
    arr[i * 4 + 3] = 1;
  }
  m.setVerticesData(VertexBuffer.ColorKind, arr);
}

export function drawKanban(
  ctx: Ctx2D,
  W: number,
  H: number,
  todos: TodoItem[],
  label: string,
): void {
  const F = screenFonts();
  // Glossy white board with a soft reflection streak.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#FBFCFD");
  bg.addColorStop(1, "#ECEFF3");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const streak = ctx.createLinearGradient(W * 0.15, 0, W * 0.55, H);
  streak.addColorStop(0, "rgba(255,255,255,0)");
  streak.addColorStop(0.5, "rgba(255,255,255,0.55)");
  streak.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = streak;
  ctx.fillRect(0, 0, W, H);
  // Faint ghost of erased marker.
  ctx.strokeStyle = "rgba(100,116,139,0.06)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(W * 0.62, H * 0.18);
  ctx.bezierCurveTo(W * 0.7, H * 0.08, W * 0.8, H * 0.3, W * 0.9, H * 0.14);
  ctx.stroke();

  const pad = Math.round(W * 0.03);
  const titleH = Math.round(H * 0.13);
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(titleH * 0.5)}px ${F.hand}`;
  ctx.fillStyle = "#1E293B";
  const done = todos.filter((t) => t.status === "completed").length;
  ctx.fillText(
    fitText(ctx, label || "Sprint board", W * 0.6),
    pad,
    pad + titleH / 2,
  );
  ctx.font = `600 ${Math.round(titleH * 0.34)}px ${F.sans}`;
  ctx.fillStyle = "#64748B";
  const prog = todos.length ? `${done}/${todos.length} done` : "no tasks yet";
  const pw = ctx.measureText(prog).width;
  ctx.fillText(prog, W - pad - pw, pad + titleH / 2);
  // Underline stroke like a marker.
  ctx.strokeStyle = "#D97757";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pad, pad + titleH - 4);
  ctx.quadraticCurveTo(
    pad + W * 0.15,
    pad + titleH,
    pad + W * 0.3,
    pad + titleH - 6,
  );
  ctx.stroke();

  const top = pad + titleH + Math.round(H * 0.04);
  const colW = (W - pad * 2) / 3;
  const noteGap = Math.round(H * 0.025);
  const headH = Math.round(H * 0.08);
  const availH = H - top - headH - pad;
  const noteH = Math.round(
    Math.max(H * 0.13, Math.min(H * 0.17, availH / 4 - noteGap)),
  );
  const maxNotes = Math.max(
    1,
    Math.floor((availH + noteGap) / (noteH + noteGap)),
  );
  const cols = bucketTodos(todos, maxNotes);

  cols.forEach((col, ci) => {
    const x0 = pad + ci * colW;
    const style = NOTE[col.id];
    // Column divider (hand-drawn-ish line).
    if (ci > 0) {
      ctx.strokeStyle = "rgba(51,65,85,0.25)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, top + 4);
      ctx.lineTo(x0 + 2, H - pad);
      ctx.stroke();
    }
    ctx.font = `700 ${Math.round(headH * 0.5)}px ${F.hand}`;
    ctx.fillStyle = style.head;
    ctx.textBaseline = "middle";
    ctx.fillText(col.title, x0 + 16, top + headH / 2);
    const tw = ctx.measureText(col.title).width;
    // Count badge.
    const badge = String(col.total);
    ctx.font = `700 ${Math.round(headH * 0.36)}px ${F.sans}`;
    const bw = Math.max(headH * 0.6, ctx.measureText(badge).width + 16);
    roundRect(
      ctx,
      x0 + 26 + tw,
      top + headH * 0.2,
      bw,
      headH * 0.6,
      headH * 0.3,
    );
    ctx.fillStyle = style.head;
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.fillText(badge, x0 + 26 + tw + bw / 2, top + headH / 2 + 1);
    ctx.textAlign = "left";

    const nw = colW - 32;
    col.items.forEach((item, i) => {
      const nx = x0 + 16;
      const ny = top + headH + i * (noteH + noteGap);
      ctx.save();
      ctx.translate(nx + nw / 2, ny + noteH / 2);
      ctx.rotate(noteTilt(item.index + ci * 7));
      ctx.shadowColor = "rgba(15,23,42,0.22)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = style.fill;
      ctx.fillRect(-nw / 2, -noteH / 2, nw, noteH);
      ctx.shadowColor = "transparent";
      ctx.fillStyle = style.edge;
      ctx.fillRect(-nw / 2, -noteH / 2, nw, Math.max(5, noteH * 0.09));
      ctx.fillStyle = style.ink;
      const fs = Math.round(noteH * 0.27);
      ctx.font = `600 ${fs}px ${F.hand}`;
      ctx.textBaseline = "middle";
      const lines = wrapText(ctx, item.text, nw - 28, 2);
      const lh = fs * 1.18;
      const y0 = -((lines.length - 1) * lh) / 2 + noteH * 0.04;
      lines.forEach((l, li) => {
        ctx.fillText(l, -nw / 2 + 14, y0 + li * lh);
        if (col.id === "completed") {
          const lw = ctx.measureText(l).width;
          ctx.strokeStyle = "rgba(31,74,28,0.55)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-nw / 2 + 12, y0 + li * lh + 1);
          ctx.lineTo(-nw / 2 + 16 + lw, y0 + li * lh - 1);
          ctx.stroke();
        }
      });
      ctx.restore();
    });
    if (col.overflow > 0) {
      const ny = top + headH + col.items.length * (noteH + noteGap);
      ctx.font = `700 ${Math.round(noteH * 0.3)}px ${F.hand}`;
      ctx.fillStyle = "#475569";
      ctx.textBaseline = "middle";
      ctx.fillText(`+${col.overflow} more`, x0 + 22, ny + noteH * 0.35);
    }
  });
}
