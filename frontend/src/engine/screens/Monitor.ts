/**
 * Desk monitors with live canvas-rendered screens.
 *
 * BossMonitor — dark terminal dashboard (1024×576): header with traffic-light
 * dots + "claude@<label>", status chip, current task, activity log with the
 * newest line highlighted, todo + context progress bars.
 * AgentMonitor — compact code-editor look (512×288) with the agent colour accent.
 *
 * Screens re-render only when content changes. LOD: near = live, mid = frozen
 * on the last frame (updates are queued), far = texture released and a static
 * dark emissive material shown.
 */

import {
  CreatePlane,
  Mesh,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  type DynamicTexture,
} from "../babylon";
import { STATUS_COLORS, type Vec3 } from "../contracts";
import type { Lod } from "../characters/types";
import {
  createEmissiveMaterial,
  createScreenTexture,
  fitText,
  roundRect,
  screenFonts,
  setScreenTexture,
  sharedScreenMaterial,
  whenFontsReady,
  withAlpha,
  wrapText,
  type Ctx2D,
} from "./canvasKit";
import { parseMonitorLines, type MonitorModel } from "./screenModels";
import { MonitorBatch } from "./MonitorBatch";
import { nextLive, ScreenHub, type HubScreen } from "./ScreenHub";

export interface MonitorOptions {
  parent?: TransformNode;
  position: Vec3;
  yaw: number;
  width: number;
  height: number;
  sessionId: string;
  roomLabel: string;
}

const DESK_TOP_Y = 0.755;

/** Shared hardware + texture lifecycle for both monitor kinds. */
abstract class ScreenBase implements HubScreen {
  readonly screenMesh: Mesh;
  protected readonly scene: Scene;
  protected readonly pivot: TransformNode;
  readonly sessionId: string;
  readonly worldPos: Vector3;
  protected readonly liveMat: PBRMaterial;
  protected tex: DynamicTexture | null = null;
  protected lod: Lod = "near";
  protected dirty = true;
  protected key = "";
  /** Own textured plane in use (close to the camera); else a shared static. */
  protected live = false;
  private readonly batch: MonitorBatch;
  private readonly batchId: number;
  protected readonly hub: ScreenHub;
  private disposed = false;

  protected constructor(
    scene: Scene,
    protected readonly opts: MonitorOptions,
    private readonly texW: number,
    private readonly texH: number,
    kind: string,
  ) {
    this.scene = scene;
    const id = `${kind}_${opts.sessionId}_${Math.round(opts.position.x * 100)}_${Math.round(opts.position.z * 100)}`;
    this.pivot = new TransformNode(id, scene);
    if (opts.parent) this.pivot.parent = opts.parent;
    this.pivot.position.set(opts.position.x, opts.position.y, opts.position.z);
    this.pivot.rotation.y = opts.yaw;

    const drop = Math.max(0, opts.position.y - opts.height / 2 - DESK_TOP_Y);
    this.sessionId = opts.sessionId;
    this.worldPos = new Vector3(
      opts.position.x,
      opts.position.y,
      opts.position.z,
    );
    // Hardware (bezel / back / stand) lives in the shared thin-instance batch.
    this.batch = MonitorBatch.get(scene);
    this.batchId = this.batch.register({
      position: opts.position,
      yaw: opts.yaw,
      width: opts.width,
      height: opts.height,
      drop,
    });
    this.hub = ScreenHub.get(scene);

    this.screenMesh = CreatePlane(
      `${id}_screen`,
      { width: opts.width, height: opts.height },
      scene,
    );
    this.screenMesh.parent = this.pivot;
    this.screenMesh.rotation.y = Math.PI; // plane front (-Z) → +Z
    this.screenMesh.position.z = 0.0006;
    this.screenMesh.metadata = {
      interact: {
        kind: "monitor",
        sessionId: opts.sessionId,
        roomLabel: opts.roomLabel,
      },
    };
    this.screenMesh.setEnabled(false); // the hub enables it while live
    this.liveMat = createEmissiveMaterial(`${id}_mat`, scene, null);
    this.liveMat.freeze(); // picture swaps go through setScreenTexture
    this.screenMesh.material = this.liveMat;
    this.hub.add(this);
    whenFontsReady(() => {
      this.dirty = true;
      this.refresh();
    });
  }

  /** Live screen mesh (for feed render lists). */
  getMeshes(): Mesh[] {
    return [this.screenMesh];
  }

  /** Called by the ScreenHub (~5 Hz): live plane vs shared static screen. */
  applyHub(
    show: boolean,
    dist: number,
    feedMode: boolean,
    liveScale: number,
  ): void {
    if (this.disposed) return;
    const showNow = show && this.pivot.isEnabled(true);
    const wantLive =
      showNow &&
      !feedMode &&
      this.isLive() &&
      nextLive(this.live, dist, liveScale);
    if (wantLive !== this.live) {
      this.live = wantLive;
      this.screenMesh.setEnabled(wantLive);
      if (wantLive) {
        this.screenMesh.material = this.liveMat;
        this.refresh(true);
      }
    }
    this.batch.showBody(this.batchId, showNow);
    this.batch.showStatic(
      this.batchId,
      !showNow || wantLive ? null : this.isLive() ? "idle" : "off",
    );
  }

  /** Meshes to add to a GlowLayer (emissive screen). */
  getGlowMeshes(): Mesh[] {
    return [this.screenMesh];
  }

  setLod(lod: Lod): void {
    if (lod === this.lod) return;
    this.lod = lod;
    this.hub.touch();
    if (lod === "far") {
      this.releaseTexture();
      this.screenMesh.material = this.offMaterial();
      return;
    }
    if (this.isLive()) this.screenMesh.material = this.liveMat;
    if (!this.tex) this.dirty = true;
    // mid: render once if we have nothing to show, else stay frozen.
    if (lod === "near" || !this.tex) this.refresh(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.remove(this);
    this.batch.unregister(this.batchId);
    this.releaseTexture();
    this.liveMat.dispose();
    this.pivot.dispose(false, false);
  }

  protected abstract draw(ctx: Ctx2D, w: number, h: number): void;
  protected abstract offMaterial(): PBRMaterial;
  protected isLive(): boolean {
    return true;
  }

  protected setKey(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.dirty = true;
    this.refresh();
  }

  protected refresh(force = false): void {
    if (this.disposed || !this.dirty || !this.isLive() || !this.live) return;
    if (this.lod === "far") return;
    if (this.lod === "mid" && !force) return;
    if (!this.tex) {
      this.tex = createScreenTexture(
        `${this.screenMesh.name}_tex`,
        this.scene,
        this.texW,
        this.texH,
      );
      setScreenTexture(this.liveMat, this.tex);
    }
    const ctx = this.tex.getContext() as unknown as Ctx2D;
    ctx.save();
    this.draw(ctx, this.texW, this.texH);
    ctx.restore();
    this.tex.update(true);
    this.dirty = false;
  }

  private releaseTexture(): void {
    if (!this.tex) return;
    setScreenTexture(this.liveMat, null);
    this.tex.dispose();
    this.tex = null;
    this.dirty = true;
  }
}

// ---------------------------------------------------------------------------
// Boss terminal
// ---------------------------------------------------------------------------

export class BossMonitor extends ScreenBase {
  private model: MonitorModel = parseMonitorLines([]);

  constructor(scene: Scene, opts: MonitorOptions) {
    super(scene, opts, 1024, 576, "bossMon");
    this.refresh();
  }

  setLines(lines: string[]): void {
    const key = lines.join("\n");
    if (key === this.key) return;
    this.model = parseMonitorLines(lines);
    this.setKey(key);
  }

  protected offMaterial(): PBRMaterial {
    return sharedScreenMaterial(this.scene, "screenIdle");
  }

  protected draw(ctx: Ctx2D, W: number, H: number): void {
    drawBossTerminal(ctx, W, H, this.model, this.opts.roomLabel);
  }
}

export function drawBossTerminal(
  ctx: Ctx2D,
  W: number,
  H: number,
  m: MonitorModel,
  roomLabel: string,
): void {
  const F = screenFonts();
  const accent = "#D97757";
  // Background.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0E131B");
  bg.addColorStop(1, "#090C11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(
    W * 0.85,
    -40,
    10,
    W * 0.85,
    -40,
    W * 0.7,
  );
  glow.addColorStop(0, withAlpha(accent, 0.1));
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header bar.
  const HB = 58;
  ctx.fillStyle = "#151B24";
  ctx.fillRect(0, 0, W, HB);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, HB - 1, W, 1);
  ["#FF5F57", "#FEBC2E", "#28C840"].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(30 + i * 26, HB / 2, 8, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  const label = m.structured ? m.label : roomLabel;
  ctx.font = `500 23px ${F.mono}`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = accent;
  ctx.fillText("claude", 118, HB / 2 + 1);
  const cw = ctx.measureText("claude").width;
  ctx.fillStyle = "#6E7681";
  ctx.fillText("@", 118 + cw, HB / 2 + 1);
  const aw = ctx.measureText("@").width;
  ctx.fillStyle = "#C9D1D9";
  ctx.fillText(fitText(ctx, label, 520), 118 + cw + aw, HB / 2 + 1);

  // Status chip.
  const statusColor = STATUS_COLORS[m.status];
  const chipText = (m.state || "IDLE").replace(/_/g, " ");
  ctx.font = `700 19px ${F.sans}`;
  const tw = ctx.measureText(chipText).width;
  const chipW = tw + 52;
  const chipX = W - chipW - 22;
  roundRect(ctx, chipX, 12, chipW, HB - 24, (HB - 24) / 2);
  ctx.fillStyle = withAlpha(statusColor, 0.18);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = withAlpha(statusColor, 0.75);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(chipX + 20, HB / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.shadowColor = statusColor;
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#F0F6FC";
  ctx.fillText(chipText, chipX + 34, HB / 2 + 1);

  if (!m.structured) {
    drawPlainLines(ctx, m.raw, 28, HB + 24, W - 56, F.mono);
    return;
  }

  // Task.
  const PX = 30;
  let y = HB + 26;
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 14px ${F.sans}`;
  ctx.fillStyle = "#7D8590";
  ctx.fillText("CURRENT TASK", PX, y + 8);
  y += 22;
  ctx.font = `600 27px ${F.sans}`;
  ctx.fillStyle = m.task.length ? "#F0F6FC" : "#6E7681";
  const taskText = m.task.length
    ? m.task.join(" ")
    : "Waiting for instructions…";
  const taskLines = wrapText(ctx, taskText, W - PX * 2, 2);
  for (const l of taskLines) {
    y += 32;
    ctx.fillText(l, PX, y);
  }
  if (taskLines.length < 2) y += 32;

  // Activity log panel.
  y += 22;
  const logTop = y;
  const logH = 8 * 34 + 16;
  roundRect(ctx, PX - 12, logTop, W - (PX - 12) * 2, logH, 14);
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.stroke();
  const acts = m.activity.slice(-8);
  const rowH = 34;
  let ry = logTop + 8;
  acts.forEach((a, i) => {
    const newest = i === acts.length - 1;
    if (newest) {
      roundRect(ctx, PX - 6, ry + 1, W - (PX - 6) * 2, rowH - 2, 8);
      ctx.fillStyle = withAlpha(accent, 0.14);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillRect(PX - 6, ry + 6, 3, rowH - 12);
    }
    const age = acts.length - 1 - i;
    const fade = newest ? 1 : Math.max(0.42, 0.92 - age * 0.08);
    ctx.font = `400 19px ${F.mono}`;
    ctx.fillStyle = newest ? "#E3B4A3" : `rgba(125,133,144,${fade})`;
    ctx.textBaseline = "middle";
    ctx.fillText(a.time || "  ·  ", PX + 8, ry + rowH / 2 + 1);
    const tx = PX + 90;
    ctx.font = `${newest ? 500 : 400} 20px ${F.mono}`;
    ctx.fillStyle = newest ? "#FFFFFF" : `rgba(201,209,217,${fade})`;
    const t = fitText(ctx, a.text, W - tx - PX - 30);
    ctx.fillText(t, tx, ry + rowH / 2 + 1);
    if (newest) {
      const cx = tx + ctx.measureText(t).width + 8;
      ctx.fillStyle = accent;
      ctx.fillRect(cx, ry + 9, 11, rowH - 18);
    }
    ry += rowH;
  });
  if (acts.length === 0) {
    ctx.font = `400 20px ${F.mono}`;
    ctx.fillStyle = "#6E7681";
    ctx.textBaseline = "middle";
    ctx.fillText("$ no activity yet", PX + 8, logTop + 26);
  }

  // Progress bars.
  const by = logTop + logH + 20;
  const bw = (W - PX * 2 - 30) / 2;
  const todoFrac = m.todoTotal ? m.todoDone / m.todoTotal : 0;
  drawBar(
    ctx,
    PX,
    by,
    bw,
    "TODOS",
    `${m.todoDone}/${m.todoTotal}`,
    todoFrac,
    "#22C55E",
    F.sans,
    F.mono,
  );
  const ctxFrac = m.ctxPct / 100;
  const ctxColor =
    ctxFrac > 0.85 ? "#EF4444" : ctxFrac > 0.65 ? "#F59E0B" : "#3B82F6";
  drawBar(
    ctx,
    PX + bw + 30,
    by,
    bw,
    "CONTEXT",
    `${m.ctxPct}%`,
    ctxFrac,
    ctxColor,
    F.sans,
    F.mono,
  );
}

function drawBar(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  frac: number,
  color: string,
  sans: string,
  mono: string,
): void {
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 14px ${sans}`;
  ctx.fillStyle = "#7D8590";
  ctx.fillText(label, x, y + 12);
  ctx.font = `500 17px ${mono}`;
  ctx.fillStyle = "#C9D1D9";
  const vw = ctx.measureText(value).width;
  ctx.fillText(value, x + w - vw, y + 13);
  const ty = y + 22;
  roundRect(ctx, x, ty, w, 12, 6);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0) {
    roundRect(ctx, x, ty, Math.max(12, w * f), 12, 6);
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, withAlpha(color, 0.75));
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawPlainLines(
  ctx: Ctx2D,
  lines: string[],
  x: number,
  y: number,
  w: number,
  mono: string,
): void {
  ctx.font = `400 22px ${mono}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#C9D1D9";
  lines
    .slice(0, 14)
    .forEach((l, i) => ctx.fillText(fitText(ctx, l, w), x, y + i * 33));
}

// ---------------------------------------------------------------------------
// Agent editor screen
// ---------------------------------------------------------------------------

export class AgentMonitor extends ScreenBase {
  private lines: string[] = [];
  private color = "#3B82F6";
  private active = true;

  constructor(scene: Scene, opts: MonitorOptions) {
    super(scene, opts, 512, 288, "agentMon");
    this.applyActive();
  }

  setText(lines: string[], color: string): void {
    this.lines = lines.slice();
    this.color = color;
    this.setKey(`${color}\n${lines.join("\n")}`);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.applyActive();
    this.hub.touch();
  }

  protected isLive(): boolean {
    return this.active;
  }

  protected offMaterial(): PBRMaterial {
    return sharedScreenMaterial(this.scene, "screenOff");
  }

  private applyActive(): void {
    if (!this.active || this.lod === "far") {
      this.screenMesh.material = this.offMaterial();
      return;
    }
    this.screenMesh.material = this.liveMat;
    this.dirty = true;
    this.refresh(true);
  }

  protected draw(ctx: Ctx2D, W: number, H: number): void {
    drawAgentEditor(ctx, W, H, this.lines, this.color);
  }
}

const KEYWORDS = [
  "const",
  "await",
  "return",
  "if",
  "export",
  "import",
  "function",
  "async",
];

export function drawAgentEditor(
  ctx: Ctx2D,
  W: number,
  H: number,
  lines: string[],
  color: string,
): void {
  const F = screenFonts();
  const [name = "agent", state = "", ...task] = lines;
  ctx.fillStyle = "#0F131A";
  ctx.fillRect(0, 0, W, H);
  // Tab bar.
  ctx.fillStyle = "#161B23";
  ctx.fillRect(0, 0, W, 34);
  const file = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent"
  }.ts`;
  ctx.font = `500 14px ${F.sans}`;
  const tabW = Math.min(W - 120, ctx.measureText(file).width + 44);
  ctx.fillStyle = "#0F131A";
  ctx.fillRect(10, 4, tabW, 30);
  ctx.fillStyle = color;
  ctx.fillRect(10, 4, tabW, 2.5);
  ctx.beginPath();
  ctx.arc(26, 19, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#E6EDF3";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, file, tabW - 40), 38, 20);

  // Gutter + code.
  const top = 46;
  const lh = 21;
  ctx.font = `400 14px ${F.mono}`;
  type Row = { text: string; kind: "comment" | "task" | "code" };
  const code = (text: string): Row => ({ text, kind: "code" });
  const body: Row[] = [
    { text: `// ${name} · ${state}`, kind: "comment" } as Row,
    ...task.map((t): Row => ({ text: t, kind: "task" })),
    code(""),
    code("export async function run(ctx) {"),
    code("  const plan = await ctx.plan();"),
    code("  for (const step of plan) {"),
    code("    await step.apply();"),
    code("  }"),
    code("  return ctx.report();"),
    code("}"),
  ].slice(0, 10);
  body.forEach((row, i) => {
    const y = top + i * lh + lh / 2;
    ctx.fillStyle = "#3D4450";
    ctx.textAlign = "right";
    ctx.fillText(String(i + 1), 30, y);
    ctx.textAlign = "left";
    if (row.kind === "comment") {
      ctx.fillStyle = "#6A9955";
      ctx.fillText(fitText(ctx, row.text, W - 60), 44, y);
    } else if (row.kind === "task") {
      ctx.fillStyle = withAlpha(color, 0.16);
      ctx.fillRect(38, y - lh / 2, W - 48, lh);
      ctx.fillStyle = "#F0F6FC";
      ctx.font = `500 14px ${F.mono}`;
      ctx.fillText(fitText(ctx, row.text, W - 60), 44, y);
      ctx.font = `400 14px ${F.mono}`;
    } else {
      let x = 44;
      for (const tok of row.text.split(/(\s+|[(){}.;,])/)) {
        if (!tok) continue;
        ctx.fillStyle = KEYWORDS.includes(tok)
          ? "#C586C0"
          : /^[A-Za-z_]+$/.test(tok)
            ? "#9CDCFE"
            : "#D4D4D4";
        ctx.fillText(tok, x, y);
        x += ctx.measureText(tok).width;
      }
    }
  });
  // Status bar.
  ctx.fillStyle = color;
  ctx.fillRect(0, H - 26, W, 26);
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.font = `600 13px ${F.sans}`;
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, `● ${state || "idle"}`, W / 2), 12, H - 12);
  ctx.textAlign = "right";
  ctx.fillText("TypeScript  UTF-8", W - 12, H - 12);
  ctx.textAlign = "left";
}
