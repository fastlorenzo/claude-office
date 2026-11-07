/**
 * Control-room video wall: a cols×rows grid of thin-bezel screens, each
 * showing one session room's live camera feed (FeedScheduler RTT) with a
 * security-cam style overlay (● LIVE + clock, project name, status chip,
 * vignette). needs_you rooms get a pulsing amber frame; empty cells show an
 * idle "NO SIGNAL" pattern. Capped at LAYOUT.MAX_FEEDS (last cell → "+N").
 */

import {
  Color3,
  CreateBox,
  CreatePlane,
  Mesh,
  Scene,
  StandardMaterial,
  TransformNode,
  type DynamicTexture,
  type Observer,
} from "../babylon";
import {
  LAYOUT,
  STATUS_COLORS,
  type BuildingLayout,
  type RoomStatus,
} from "../contracts";
import {
  createEmissiveMaterial,
  createScreenTexture,
  fitText,
  roundRect,
  screenFonts,
  sharedScreenMaterial,
  whenFontsReady,
  withAlpha,
  type Ctx2D,
} from "./canvasKit";
import type { FeedScheduler } from "./FeedScheduler";
import { wallCells, type WallCell } from "./wallModel";

export interface WallSession {
  sessionId: string;
  label: string;
  status: RoomStatus;
}

interface CellMeshes {
  screen: Mesh;
  mat: StandardMaterial;
  rim: Mesh;
  x: number;
  y: number;
}

const GAP = 0.06;
const STATUS_LABEL: Record<RoomStatus, string> = {
  needs_you: "NEEDS YOU",
  working: "WORKING",
  done: "DONE",
  ended: "ENDED",
};

export class ControlRoomWall {
  private readonly scene: Scene;
  private readonly feeds: FeedScheduler;
  private readonly pivot: TransformNode;
  private readonly body: Mesh;
  private readonly cells: CellMeshes[] = [];
  private readonly overlay: Mesh;
  private readonly overlayMat: StandardMaterial;
  private readonly overlayTex: DynamicTexture;
  private readonly rimMats = new Map<RoomStatus | "none", StandardMaterial>();
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly ow: number;
  private readonly oh: number;
  private model: WallCell<WallSession>[] = [];
  private sessions: WallSession[] = [];
  private readonly observer: Observer<Scene> | null;
  private readonly feedObserver: ReturnType<FeedScheduler["onChanged"]["add"]>;
  private clockAcc = 0;
  private pulseT = 0;
  private lastClock = "";
  private disposed = false;

  constructor(
    scene: Scene,
    control: BuildingLayout["controlRoom"],
    feeds: FeedScheduler,
  ) {
    this.scene = scene;
    this.feeds = feeds;
    const sw = control.screenWall;
    const cap = LAYOUT.MAX_FEEDS;
    this.cols = Math.max(1, sw.cols);
    this.rows = Math.max(1, Math.min(sw.rows, Math.ceil(cap / this.cols)));
    this.cellW = sw.cellW;
    this.cellH = sw.cellH;
    this.pivot = new TransformNode("controlWall", scene);
    this.pivot.position.set(sw.origin.x, sw.origin.y, sw.origin.z);
    this.pivot.rotation.y = sw.yaw;

    const totalW = this.cols * this.cellW;
    const totalH = this.rows * this.cellH;
    const sWidth = this.cellW - GAP;
    const sHeight = this.cellH - GAP;

    const bezels: Mesh[] = [];
    const back = CreateBox(
      "wallBack",
      { width: totalW + 0.12, height: totalH + 0.12, depth: 0.05 },
      scene,
    );
    back.position.z = -0.045;
    bezels.push(back);
    const n = Math.min(this.cols * this.rows, cap);
    for (let i = 0; i < n; i++) {
      const c = i % this.cols;
      const r = Math.floor(i / this.cols);
      // Viewed from the front, local -X is the viewer's right: index 0 top-left.
      const x = ((this.cols - 1) / 2 - c) * this.cellW;
      const y = ((this.rows - 1) / 2 - r) * this.cellH;
      const bz = CreateBox(
        `wallBezel_${i}`,
        { width: sWidth + 0.016, height: sHeight + 0.016, depth: 0.02 },
        scene,
      );
      bz.position.set(x, y, -0.011);
      bezels.push(bz);

      const screen = CreatePlane(
        `wallScreen_${i}`,
        { width: sWidth, height: sHeight },
        scene,
      );
      screen.parent = this.pivot;
      screen.rotation.y = Math.PI;
      screen.position.set(x, y, 0.0005);
      const mat = createEmissiveMaterial(`wallScreenMat_${i}`, scene, null);
      screen.material = mat;

      const rim = buildRim(
        `wallRim_${i}`,
        scene,
        sWidth + 0.016,
        sHeight + 0.016,
      );
      rim.parent = this.pivot;
      rim.position.set(x, y, 0.001);
      rim.isVisible = false;
      this.cells.push({ screen, mat, rim, x, y });
    }
    this.body = Mesh.MergeMeshes(bezels, true, true) as Mesh;
    this.body.name = "controlWallBody";
    this.body.parent = this.pivot;
    this.body.material = sharedScreenMaterial(scene, "bezel");
    this.body.isPickable = false;

    // Overlay (labels, LIVE badges, vignettes, NO SIGNAL) for the whole wall.
    this.ow = 2048;
    this.oh = Math.max(256, Math.round((2048 * totalH) / totalW / 8) * 8);
    this.overlay = CreatePlane(
      "controlWallOverlay",
      { width: totalW, height: totalH },
      scene,
    );
    this.overlay.parent = this.pivot;
    this.overlay.rotation.y = Math.PI;
    this.overlay.position.z = 0.0025;
    this.overlay.isPickable = false;
    this.overlayTex = createScreenTexture(
      "controlWallOverlayTex",
      scene,
      this.ow,
      this.oh,
      true,
    );
    this.overlayMat = createEmissiveMaterial(
      "controlWallOverlayMat",
      scene,
      this.overlayTex,
    );
    this.overlayMat.opacityTexture = this.overlayTex;
    this.overlay.material = this.overlayMat;

    this.feedObserver = feeds.onChanged.add(() => this.bindTextures());
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
    this.setSessions([]);
    whenFontsReady(() => this.drawOverlay());
  }

  setSessions(list: WallSession[]): void {
    this.sessions = list.slice();
    this.model = wallCells(list, this.cells.length);
    this.bindTextures();
    this.cells.forEach((cell, i) => {
      const m = this.model[i];
      if (m.kind === "session") {
        cell.screen.metadata = {
          interact: {
            kind: "screen",
            sessionId: m.session.sessionId,
            roomLabel: m.session.label,
          },
        };
        cell.screen.isPickable = true;
        const st = m.session.status;
        cell.rim.material = this.rimMaterial(st);
        cell.rim.isVisible =
          st === "needs_you" || st === "working" || st === "done";
      } else {
        cell.screen.metadata = null;
        cell.screen.isPickable = false;
        cell.rim.isVisible = false;
      }
    });
    this.drawOverlay();
  }

  /** Screens + status rims (add to a GlowLayer). */
  getGlowMeshes(): Mesh[] {
    return [
      ...this.cells.map((c) => c.screen),
      ...this.cells.map((c) => c.rim),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer)
      this.scene.onBeforeRenderObservable.remove(this.observer);
    this.feeds.onChanged.remove(this.feedObserver);
    for (const c of this.cells) {
      c.mat.emissiveTexture = null;
      c.mat.dispose();
    }
    for (const m of this.rimMats.values()) m.dispose();
    this.overlayTex.dispose();
    this.overlayMat.dispose();
    this.pivot.dispose(false, false);
  }

  // -------------------------------------------------------------------------

  private bindTextures(): void {
    this.cells.forEach((cell, i) => {
      const m = this.model[i];
      const tex =
        m && m.kind === "session"
          ? this.feeds.getTexture(m.session.sessionId)
          : null;
      if (cell.mat.emissiveTexture !== tex) {
        cell.mat.emissiveTexture = tex;
        cell.mat.emissiveColor = tex
          ? Color3.Black()
          : new Color3(0.012, 0.014, 0.02);
      }
    });
  }

  private rimMaterial(st: RoomStatus): StandardMaterial {
    let m = this.rimMats.get(st);
    if (!m) {
      m = new StandardMaterial(`wallRim_${st}`, this.scene);
      m.disableLighting = true;
      const c = Color3.FromHexString(STATUS_COLORS[st]);
      m.emissiveColor = st === "needs_you" ? c : c.scale(0.55);
      m.diffuseColor = Color3.Black();
      m.specularColor = Color3.Black();
      this.rimMats.set(st, m);
    }
    return m;
  }

  private tick(): void {
    const dt = Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000);
    const needs = this.rimMats.get("needs_you");
    if (needs && this.sessions.some((s) => s.status === "needs_you")) {
      this.pulseT += dt;
      const k =
        0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.pulseT * Math.PI * 2 * 0.9));
      needs.emissiveColor = Color3.FromHexString(STATUS_COLORS.needs_you).scale(
        k,
      );
    }
    if (!this.feeds.isActive) return;
    this.clockAcc += dt;
    if (this.clockAcc < 1) return;
    this.clockAcc = 0;
    if (clockString() !== this.lastClock) this.drawOverlay();
  }

  private drawOverlay(): void {
    if (this.disposed) return;
    const ctx = this.overlayTex.getContext() as unknown as Ctx2D;
    const W = this.ow;
    const H = this.oh;
    const F = screenFonts();
    ctx.clearRect(0, 0, W, H);
    const sx = W / (this.cols * this.cellW);
    const sy = H / (this.rows * this.cellH);
    const clock = clockString();
    this.lastClock = clock;
    this.cells.forEach((cell, i) => {
      const m = this.model[i];
      const cw = (this.cellW - GAP) * sx;
      const ch = (this.cellH - GAP) * sy;
      // Front view: texture u grows toward local -X.
      const cx = ((this.cols * this.cellW) / 2 - cell.x) * sx - cw / 2;
      const cy = ((this.rows * this.cellH) / 2 - cell.y) * sy - ch / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();
      if (m.kind === "session")
        drawFeedOverlay(ctx, cx, cy, cw, ch, m.session, clock, F);
      else if (m.kind === "more") drawMore(ctx, cx, cy, cw, ch, m.count, F);
      else drawNoSignal(ctx, cx, cy, cw, ch, i, F);
      ctx.restore();
    });
    this.overlayTex.update(true);
  }
}

function clockString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildRim(name: string, scene: Scene, w: number, h: number): Mesh {
  const t = 0.008;
  const parts = [
    [w + t * 2, t, 0, h / 2 + t / 2],
    [w + t * 2, t, 0, -h / 2 - t / 2],
    [t, h, -w / 2 - t / 2, 0],
    [t, h, w / 2 + t / 2, 0],
  ].map(([bw, bh, x, y], i) => {
    const b = CreateBox(
      `${name}_${i}`,
      { width: bw, height: bh, depth: 0.006 },
      scene,
    );
    b.position.set(x, y, 0);
    return b;
  });
  const m = Mesh.MergeMeshes(parts, true, true) as Mesh;
  m.name = name;
  m.isPickable = false;
  return m;
}

type Fonts = ReturnType<typeof screenFonts>;

function drawFeedOverlay(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  s: WallSession,
  clock: string,
  F: Fonts,
): void {
  // Vignette.
  const v = ctx.createRadialGradient(
    x + w / 2,
    y + h / 2,
    h * 0.35,
    x + w / 2,
    y + h / 2,
    w * 0.62,
  );
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = v;
  ctx.fillRect(x, y, w, h);
  const u = h / 100; // overlay unit
  // ● LIVE badge.
  ctx.font = `700 ${Math.round(5.6 * u)}px ${F.sans}`;
  ctx.textBaseline = "middle";
  const liveW = ctx.measureText("LIVE").width + 7 * u;
  roundRect(ctx, x + 3 * u, y + 3 * u, liveW + 4 * u, 8 * u, 1.6 * u);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 7 * u, y + 7 * u, 1.6 * u, 0, Math.PI * 2);
  ctx.fillStyle = "#EF4444";
  ctx.shadowColor = "#EF4444";
  ctx.shadowBlur = 2 * u;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText("LIVE", x + 10 * u, y + 7.2 * u);
  // Clock + cam id (top right).
  ctx.font = `500 ${Math.round(5.2 * u)}px ${F.mono}`;
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 1.5 * u;
  ctx.fillText(clock, x + w - 3.5 * u, y + 7.2 * u);
  ctx.textAlign = "left";
  ctx.shadowBlur = 0;
  // Bottom label strip.
  const sh = 15 * u;
  const g = ctx.createLinearGradient(0, y + h - sh * 1.6, 0, y + h);
  g.addColorStop(0, "rgba(5,7,10,0)");
  g.addColorStop(1, "rgba(5,7,10,0.85)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y + h - sh * 1.6, w, sh * 1.6);
  const color = STATUS_COLORS[s.status];
  // Status chip (right).
  ctx.font = `700 ${Math.round(5 * u)}px ${F.sans}`;
  const chip = STATUS_LABEL[s.status];
  const chipW = ctx.measureText(chip).width + 10 * u;
  const chipX = x + w - chipW - 3.5 * u;
  const chipY = y + h - sh + 2 * u;
  roundRect(ctx, chipX, chipY, chipW, 9 * u, 4.5 * u);
  ctx.fillStyle = withAlpha(color, 0.28);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5 * u;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(chipX + 4 * u, chipY + 4.5 * u, 1.4 * u, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(chip, chipX + 6.8 * u, chipY + 4.8 * u);
  // Project name (left).
  ctx.font = `600 ${Math.round(7 * u)}px ${F.sans}`;
  ctx.fillStyle = "#F8FAFC";
  ctx.fillText(
    fitText(ctx, s.label, chipX - x - 8 * u),
    x + 4 * u,
    chipY + 4.8 * u,
  );
}

function drawNoSignal(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  i: number,
  F: Fonts,
): void {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "#10141B");
  g.addColorStop(1, "#0A0D12");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(148,163,184,0.05)";
  ctx.lineWidth = h * 0.02;
  for (let k = -h; k < w; k += h * 0.09) {
    ctx.beginPath();
    ctx.moveTo(x + k, y + h);
    ctx.lineTo(x + k + h, y);
    ctx.stroke();
  }
  const u = h / 100;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(9 * u)}px ${F.sans}`;
  ctx.fillStyle = "rgba(148,163,184,0.55)";
  ctx.fillText("NO SIGNAL", x + w / 2, y + h / 2 - 2 * u);
  ctx.font = `500 ${Math.round(5 * u)}px ${F.mono}`;
  ctx.fillStyle = "rgba(148,163,184,0.35)";
  ctx.fillText(
    `CAM ${String(i + 1).padStart(2, "0")} · standby`,
    x + w / 2,
    y + h / 2 + 9 * u,
  );
  ctx.textAlign = "left";
}

function drawMore(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  F: Fonts,
): void {
  ctx.fillStyle = "#0E1218";
  ctx.fillRect(x, y, w, h);
  const u = h / 100;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(18 * u)}px ${F.sans}`;
  ctx.fillStyle = "#E2E8F0";
  ctx.fillText(`+${count}`, x + w / 2, y + h / 2 - 4 * u);
  ctx.font = `500 ${Math.round(6 * u)}px ${F.sans}`;
  ctx.fillStyle = "rgba(148,163,184,0.7)";
  ctx.fillText("more sessions", x + w / 2, y + h / 2 + 12 * u);
  ctx.textAlign = "left";
}
