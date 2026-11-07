/**
 * Control-room interior: the building's ops centre. Built on top of the
 * shell Building makes (floor, ceiling, walls) and rebuilt with it.
 *
 *   ┌──────────┬──────────╲ ALERTS ──────────────────╱──────────┬──────────┐
 *   │  feeds   │  USAGE    │   SESSIONS BOARD        │ ACTIVITY  │  feeds   │
 *   │  west    │ (gauges)  │   (one row / session)   │ (charts)  │  east    │
 *   └──────────┴──────────╱ TICKER ──────────────────╲──────────┴──────────┘
 *                       curved console (4 operator monitors)
 *
 *  - Ops wall: five canvas panels (DynamicTexture, ~440 px/m so text holds
 *    ≥ 14 px from the console) drawn by screens/opsCanvas from ONE OpsModel
 *    (logic/opsModel, also used by the DOM Ops dashboard). Redrawn only when
 *    their content key changes, at most 2 Hz, and only while someone is near.
 *  - Feed banks: two 2×4 ControlRoomWall banks (west rooms left, east right)
 *    with the FeedScheduler round-robin RTTs.
 *  - Console: four monitors merged into ONE mesh on a 2×2 atlas; monitor 0
 *    shows the session that most needs you, the others rotate every 8 s.
 *  - Lighting: zone-isolated point lights (key on the console, wall wash,
 *    door fill), cool linear fixtures, soft LED accents; screens glow.
 */

import {
  Color3,
  CreatePlane,
  DynamicTexture,
  Mesh,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type PBRMaterial,
} from "@/engine/babylon";
import type {
  BuildingLayout,
  CampusSession,
  CampusStats,
} from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { ArtBatcher } from "@/engine/art/geometry";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  buildOpsModel,
  fmtClock,
  opsKey,
  type OpsModel,
  type OpsRow,
} from "@/engine/logic/opsModel";
import {
  createEmissiveMaterial,
  createScreenTexture,
  whenFontsReady,
  type Ctx2D,
} from "@/engine/screens/canvasKit";
import {
  ControlRoomWall,
  type FeedBankPlacement,
  type WallSession,
} from "@/engine/screens/ControlRoomWall";
import type { FeedScheduler } from "@/engine/screens/FeedScheduler";
import {
  drawActivityPanel,
  drawAlertStrip,
  drawSessionCard,
  drawSessionsBoard,
  drawTicker,
  drawUsagePanel,
  type CardExtras,
} from "@/engine/screens/opsCanvas";

export interface ControlRoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
  feeds: FeedScheduler;
}

/** Texture pixels per metre of wall (≥ 14 px text at the console). */
const PPM = 440;
const Y0 = 0.86; // bottom of the wall panels
const CENTER_W = 5.6;
const BOARD_H = 1.72;
const ALERT_H = 0.26;
const TICKER_H = 0.24;
const WING_W = 2.6;
const WING_H = BOARD_H + 0.04 + ALERT_H; // flush with the alert strip top
const WING_YAW = (24 * Math.PI) / 180;
const WING_GAP = 0.1;
const BANK_COLS = 2;
const BANK_ROWS = 4;
const CELL_H = WING_H / BANK_ROWS;
const CELL_W = CELL_H * (16 / 9);
/** The ops wall is readable (and F-able) from the console. */
const WALL_INTERACT_RANGE = 7.5;
const REDRAW_MS = 500;
const ROTATE_MS = 8000;
const GROUP = "controlRoom";

const MON_W = 0.64;
const MON_H = 0.32;
const MON_COUNT = 4;
const ATLAS_W = 2048;
const ATLAS_H = 1024;

interface Panel {
  mesh: Mesh;
  tex: DynamicTexture;
  mat: StandardMaterial;
  w: number;
  h: number;
  key: string;
}

export class ControlRoom {
  private readonly scene: Scene;
  private readonly statics: Mesh[] = [];
  private readonly panels: Record<
    "board" | "alerts" | "ticker" | "usage" | "activity",
    Panel
  >;
  private readonly banks: ControlRoomWall[] = [];
  /** Session → feed bank side + bay (from the layout). */
  private sides = new Map<string, { west: boolean; bay: number }>();
  private readonly monitor: Mesh;
  private readonly monTex: DynamicTexture;
  private readonly monMat: StandardMaterial;
  private readonly monProxies: Mesh[] = [];
  private readonly monKeys: string[] = new Array(MON_COUNT).fill("");
  private readonly pulseMat: PBRMaterial;
  private readonly glow: Mesh[] = [];

  private campus: CampusSession[] = [];
  private stats: CampusStats | null = null;
  private labels: ReadonlyMap<string, string> = new Map();
  private model: OpsModel | null = null;
  private dirty = true;
  private sinceBuild = 1e9;
  private sinceRotate = 0;
  private sinceClock = 0;
  private pulseColor = "";
  private rotate = 0;
  private pulseT = 0;
  private bankKey = "";
  private lastClock = "";
  private far = false;
  private disposed = false;

  constructor(
    private readonly ctx: ControlRoomContext,
    layout: BuildingLayout,
    shell: AbstractMesh[],
  ) {
    const { scene } = ctx;
    this.scene = scene;
    const L = layout.hall.length;
    const T = 0.2;
    const cz0 = L + T;
    const cz1 = layout.controlRoom.origin.z + layout.controlRoom.size.z / 2;
    const cH = layout.controlRoom.size.y;
    const cw = layout.controlRoom.size.x / 2;
    this.setLayout(layout);

    const b = new ArtBatcher(scene, ctx.materials, "controlInt", 11);
    const zs = cz1 - 0.085; // screen plane depth (wall face is cz1)

    // ---- Ops wall housings (gloss black) + hairline frame
    const midY = Y0 + (BOARD_H + 0.04 + ALERT_H) / 2;
    const topY = Y0 + WING_H;
    b.rbox(
      "nocGloss",
      v3(0, (Y0 - TICKER_H - 0.1 + topY + 0.06) / 2, cz1 - 0.04),
      v3(CENTER_W + 0.16, topY + 0.06 - (Y0 - TICKER_H - 0.1), 0.08),
      { r: 0.01 },
    );
    const wing = (side: -1 | 1) => {
      const yaw = side * WING_YAW;
      const dir = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // plane local +X
      const inner = new Vector3(side * (CENTER_W / 2 + WING_GAP), midY, zs);
      const c = inner.add(dir.scale((side * WING_W) / 2));
      const back = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)); // -normal
      b.rbox(
        "nocGloss",
        v3(c.x + back.x * 0.045, midY, c.z + back.z * 0.045),
        v3(WING_W + 0.12, WING_H + 0.12, 0.07),
        { r: 0.01, yaw },
      );
      return { c, yaw };
    };
    const wl = wing(-1);
    const wr = wing(1);

    // ---- Wall-wash cove over the ops wall + side LED skirting
    b.rbox(
      "blackMetal",
      v3(0, cH - 0.07, cz1 - 0.55),
      v3(CENTER_W + 7.6, 0.06, 0.5),
      {
        r: 0.006,
      },
    );
    b.box(
      "lightPanelDim",
      v3(0, cH - 0.102, cz1 - 0.36),
      v3(CENTER_W + 7.4, 0.004, 0.06),
      {
        keepUVs: true,
      },
    );
    for (const sx of [-1, 1])
      b.box(
        "ledBlue",
        v3(sx * (cw - 0.02), 0.05, (cz0 + cz1) / 2),
        v3(0.01, 0.01, cz1 - cz0 - 0.4),
        {
          keepUVs: true,
        },
      );

    // ---- Acoustic baffles (kept clear of the wall's sight lines)
    const bz0 = cz0 + 0.5;
    const bz1 = cz1 - 3.4;
    for (let x = -cw + 0.9; x < cw - 0.5; x += 0.45)
      b.rbox(
        "ceilingDark",
        v3(x, cH - 0.17, (bz0 + bz1) / 2),
        v3(0.05, 0.3, bz1 - bz0),
        {
          r: 0.01,
        },
      );
    // Linear fixtures: over the console and by the door.
    for (const z of [cz1 - 4.5, cz0 + 1.7]) {
      b.rbox("blackMetal", v3(0, cH - 0.34, z), v3(6.2, 0.035, 0.1), {
        r: 0.006,
      });
      b.box("lightPanel", v3(0, cH - 0.36, z), v3(6.1, 0.004, 0.06), {
        keepUVs: true,
      });
    }

    // ---- Navy felt acoustic panels on the side walls
    const felt = ctx.materials.felt("#1C2738");
    for (const sx of [-1, 1])
      for (let z = cz0 + 0.75; z < cz1 - 0.6; z += 1.3)
        b.rbox(felt, v3(sx * (cw - 0.035), 1.55, z), v3(0.04, 2.5, 1.2), {
          r: 0.012,
        });

    // ---- Curved console (operators on the convex side, facing the wall)
    const R = 4.6;
    const cc = v3(0, 0, cz1 + 0.7);
    const a0 = Math.PI - 0.6;
    const a1 = Math.PI + 0.6;
    b.arc("blackMetal", cc, R - 0.8, R - 0.1, a0, a1, 0.1, 0.72, 48);
    b.arc("oakDark", cc, R - 0.88, R, a0 - 0.01, a1 + 0.01, 0.72, 0.76, 48);
    b.arc("shadowGap", cc, R - 0.72, R - 0.18, a0, a1, 0, 0.1, 40);
    b.arc(
      "lightPanelDim",
      cc,
      R - 0.02,
      R - 0.006,
      a0 + 0.01,
      a1 - 0.01,
      0.698,
      0.71,
      48,
      {
        keepUVs: true,
      },
    );
    const monAngles = [-0.36, -0.12, 0.12, 0.36];
    const monPos = monAngles.map((da) => {
      const a = Math.PI + da;
      const r = R - 0.5;
      return { x: Math.sin(a) * r + cc.x, z: Math.cos(a) * r + cc.z, yaw: da };
    });
    const monY = 1.07;
    for (const s of monPos) {
      // Stand sits behind the screen (towards the wall).
      const bx = s.x + Math.sin(s.yaw) * 0.09;
      const bz = s.z + Math.cos(s.yaw) * 0.09;
      b.rbox("blackMetal", v3(bx, 0.76 + 0.12, bz), v3(0.05, 0.24, 0.04), {
        r: 0.006,
        yaw: s.yaw,
      });
      b.rbox("blackMetal", v3(bx, 0.766, bz), v3(0.26, 0.012, 0.16), {
        r: 0.004,
        yaw: s.yaw,
      });
      b.rbox(
        "blackMetal",
        v3((bx + s.x) / 2, monY - 0.02, (bz + s.z) / 2),
        v3(0.05, 0.05, 0.1),
        { r: 0.006, yaw: s.yaw },
      );
      b.rbox(
        "blackMetal",
        v3(s.x + Math.sin(s.yaw) * 0.016, monY, s.z + Math.cos(s.yaw) * 0.016),
        v3(MON_W + 0.026, MON_H + 0.026, 0.026),
        { r: 0.006, yaw: s.yaw },
      );
    }
    const dzFront = cc.z - R;
    const { colliders } = ctx;
    colliders.addBox(
      GROUP,
      new Vector3(0, 0.4, dzFront + 0.42),
      new Vector3(3.4, 0.8, 0.85),
    );
    for (const sx of [-1, 1])
      colliders.addBox(
        GROUP,
        new Vector3(sx * 2.25, 0.4, dzFront + 0.78),
        new Vector3(1.9, 0.8, 0.85),
        sx * 0.42,
      );

    const built = b.build({ receiveShadows: true });
    for (const m of built) {
      m.metadata = { ...(m.metadata ?? {}), probe: true };
      m.isPickable = false;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
      const mat = m.material as { name?: string } | null;
      if (mat?.name && /led|lightPanel/i.test(mat.name)) ctx.fx?.addGlow(m);
    }
    this.statics.push(...built);

    // ---- Wall panels
    const wallMeta = {
      interact: { kind: "ops", sessionId: "", roomLabel: "Ops dashboard" },
      interactRange: WALL_INTERACT_RANGE,
    };
    const flat = (name: string, w: number, h: number, y: number) =>
      this.panel(name, w, h, new Vector3(0, y, zs), 0, wallMeta);
    this.panels = {
      board: flat("board", CENTER_W, BOARD_H, Y0 + BOARD_H / 2),
      alerts: flat(
        "alerts",
        CENTER_W,
        ALERT_H,
        Y0 + BOARD_H + 0.04 + ALERT_H / 2,
      ),
      ticker: flat("ticker", CENTER_W, TICKER_H, Y0 - 0.06 - TICKER_H / 2),
      usage: this.panel("usage", WING_W, WING_H, wl.c, wl.yaw, wallMeta),
      activity: this.panel("activity", WING_W, WING_H, wr.c, wr.yaw, wallMeta),
    };
    // Alert pulse line between the strip and the board.
    this.pulseMat = ctx.materials.emissive("opsPulse", "#475569", 1.2);
    const pulse = CreatePlane(
      "opsPulse",
      { width: CENTER_W, height: 0.012 },
      scene,
    );
    pulse.position.set(0, Y0 + BOARD_H + 0.02, zs - 0.001);
    pulse.material = this.pulseMat;
    pulse.isPickable = false;
    this.statics.push(pulse);
    this.glow.push(pulse);

    // ---- Feed banks (west rooms left, east rooms right)
    const bankX =
      CENTER_W / 2 +
      WING_GAP +
      WING_W * Math.cos(WING_YAW) +
      0.45 +
      (BANK_COLS * CELL_W) / 2;
    for (const side of [-1, 1] as const) {
      const placement: FeedBankPlacement = {
        origin: { x: side * bankX, y: Y0 + WING_H / 2, z: cz1 - 0.05 },
        yaw: Math.PI,
        cols: BANK_COLS,
        rows: BANK_ROWS,
        cellW: CELL_W,
        cellH: CELL_H,
      };
      const bank = new ControlRoomWall(
        scene,
        placement,
        ctx.feeds,
        side < 0 ? "W" : "E",
      );
      for (const m of bank.getGlowMeshes())
        if (/rim/i.test(m.name)) ctx.fx?.addGlow(m);
      this.banks.push(bank);
    }

    // ---- Console monitors: one merged mesh on a 2×2 atlas + pick proxies
    this.monTex = createScreenTexture("opsMonitors", scene, ATLAS_W, ATLAS_H);
    this.monMat = createEmissiveMaterial("opsMonitorsMat", scene, this.monTex);
    const parts: Mesh[] = [];
    monPos.forEach((s, i) => {
      const p = CreatePlane(
        `opsMon_${i}`,
        { width: MON_W, height: MON_H },
        scene,
      );
      const col = i % 2;
      const row = Math.floor(i / 2);
      const uv = p.getVerticesData(VertexBuffer.UVKind)!;
      for (let k = 0; k < uv.length; k += 2) {
        uv[k] = (col + uv[k]) / 2;
        uv[k + 1] = 1 - (row + 1 - uv[k + 1]) / 2;
      }
      p.setVerticesData(VertexBuffer.UVKind, uv);
      p.position.set(
        s.x - Math.sin(s.yaw) * 0.0005,
        monY,
        s.z - Math.cos(s.yaw) * 0.0005,
      );
      p.rotation.y = s.yaw;
      const proxy = CreatePlane(
        `opsMonPick_${i}`,
        { width: MON_W, height: MON_H },
        scene,
      );
      proxy.position.copyFrom(p.position);
      proxy.rotation.y = s.yaw;
      proxy.isVisible = false;
      proxy.isPickable = true;
      proxy.metadata = {
        interact: { kind: "ops", sessionId: "", roomLabel: "Operator console" },
      };
      this.monProxies.push(proxy);
      parts.push(p);
    });
    this.monitor = Mesh.MergeMeshes(parts, true, true) as Mesh;
    this.monitor.name = "opsMonitors";
    this.monitor.material = this.monMat;
    this.monitor.isPickable = false;
    this.glow.push(this.monitor);

    // ---- Props
    const { assets } = ctx;
    for (const da of [-0.33, 0, 0.33]) {
      const a = Math.PI + da;
      const r = R + 0.55;
      assets.instantiate(
        "taskChair",
        null,
        {
          position: {
            x: Math.sin(a) * r + cc.x,
            y: 0,
            z: Math.cos(a) * r + cc.z,
          },
          yaw: da,
        },
        { group: GROUP },
      );
    }
    for (const sx of [-1, 1])
      assets.instantiate(
        "plantTall",
        null,
        { position: { x: sx * (cw - 0.7), y: 0, z: cz0 + 0.75 }, yaw: sx },
        { group: GROUP },
      );
    assets.instantiate(
      "securityCamera",
      null,
      { position: { x: cw - 0.3, y: cH - 0.35, z: cz0 + 0.3 }, yaw: -2.3 },
      { group: GROUP },
    );

    for (const m of this.glow) ctx.fx?.addGlow(m);
    for (const p of Object.values(this.panels)) ctx.fx?.addGlow(p.mesh);

    // ---- Zone lighting: shell + interior only see these lights.
    ctx.lighting.isolateZone(
      [
        ...shell,
        ...this.statics,
        ...this.banks.flatMap((bk) => bk.getMeshes()),
      ],
      [
        {
          pos: new Vector3(0, 2.85, cc.z - R - 0.7),
          color: "#EEF2FF",
          intensity: 14,
          range: 9,
        },
        {
          pos: new Vector3(0, 2.75, cz1 - 1.3),
          color: "#AFC4FF",
          intensity: 7,
          range: 8,
        },
        {
          pos: new Vector3(0, 2.85, cz0 + 1.8),
          color: "#D9E2F5",
          intensity: 9,
          range: 9,
        },
      ],
    );

    // Draw now: a DynamicTexture is not "ready" until its first update(), and
    // scene.executeWhenReady (which starts the render loop) waits for it.
    this.redraw(true);
    whenFontsReady(() => this.redraw(true));
  }

  // -------------------------------------------------------------------------

  /** Room slots changed (feeds are grouped by side, ordered by bay). */
  setLayout(layout: BuildingLayout): void {
    this.sides = new Map(
      layout.rooms.map((r) => [
        r.sessionId,
        { west: r.slot.side === "west", bay: r.slot.bay },
      ]),
    );
    this.dirty = true;
  }

  /** Latest campus feed (cheap: just stored; drawn by update()). */
  setData(
    campus: CampusSession[],
    stats: CampusStats | null | undefined,
    labels: ReadonlyMap<string, string>,
  ): void {
    this.campus = campus;
    this.stats = stats ?? null;
    this.labels = labels;
    this.dirty = true;
  }

  /** Per frame. `near`: the player is in / approaching the room. */
  update(dt: number, near: boolean): void {
    if (this.disposed) return;
    this.pulse(dt);
    this.sinceBuild += dt * 1000;
    this.sinceRotate += dt * 1000;
    if (this.sinceRotate >= ROTATE_MS) {
      this.sinceRotate = 0;
      this.rotate += 1;
      this.dirty = true;
    }
    if (!near) return;
    this.sinceClock += dt * 1000;
    if (this.sinceClock >= 1000) {
      this.sinceClock = 0;
      if (fmtClock(new Date().toISOString()) !== this.lastClock)
        this.dirty = true;
    }
    // Elapsed times ("for 2m") drift without new data: rebuild every 15 s.
    if (this.sinceBuild >= 15_000) this.dirty = true;
    if (!this.dirty || this.sinceBuild < REDRAW_MS) return;
    this.redraw(false);
  }

  setFar(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    for (const bk of this.banks) bk.setFar(far);
    this.monitor.setEnabled(!far);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bk of this.banks) bk.dispose();
    for (const p of Object.values(this.panels)) {
      this.ctx.fx?.removeGlow?.(p.mesh);
      p.tex.dispose();
      p.mat.dispose();
      p.mesh.dispose();
    }
    for (const m of [...this.statics, this.monitor]) {
      this.ctx.fx?.removeGlow?.(m);
      m.dispose();
    }
    for (const p of this.monProxies) p.dispose();
    this.monTex.dispose();
    this.monMat.dispose();
    this.ctx.assets.disposeGroup(GROUP);
    this.ctx.colliders.disposeGroup(GROUP);
  }

  // -------------------------------------------------------------------------

  private panel(
    name: string,
    w: number,
    h: number,
    pos: Vector3,
    yaw: number,
    meta: object,
  ): Panel {
    const tw = Math.round((w * PPM) / 8) * 8;
    const th = Math.round((h * PPM) / 8) * 8;
    const tex = createScreenTexture(`ops_${name}`, this.scene, tw, th);
    const mat = createEmissiveMaterial(`ops_${name}Mat`, this.scene, tex);
    const mesh = CreatePlane(
      `wallScreen_ops_${name}`,
      { width: w, height: h },
      this.scene,
    );
    mesh.position.copyFrom(pos);
    mesh.rotation.y = yaw;
    mesh.material = mat;
    mesh.isPickable = true;
    mesh.metadata = { ...meta, probe: true };
    return { mesh, tex, mat, w: tw, h: th, key: "" };
  }

  private pulse(dt: number): void {
    const m = this.model;
    const high = !!m?.alerts.some((a) => a.severity === "high");
    const any = !!m && m.alerts.length > 0;
    this.pulseT += dt;
    const k = any
      ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.pulseT * Math.PI * 2 * 0.6))
      : 1;
    const base = any ? (high ? "#F59E0B" : "#FBBF24") : "#38BDF8";
    if (base !== this.pulseColor) {
      this.pulseColor = base;
      this.pulseMat.emissiveColor = Color3.FromHexString(base).toLinearSpace();
    }
    this.pulseMat.emissiveIntensity = any ? 2.4 * k : 0.6;
  }

  private redraw(force: boolean): void {
    if (this.disposed) return;
    this.dirty = false;
    this.sinceBuild = 0;
    const now = Date.now();
    const m = buildOpsModel(this.campus, this.stats, now, this.labels);
    this.model = m;
    const clock = fmtClock(new Date(now).toISOString());
    this.lastClock = clock;
    const u = PPM / 100;
    const P = this.panels;
    const draw = (p: Panel, key: string, fn: (ctx: Ctx2D) => void) => {
      if (!force && key === p.key) return;
      p.key = key;
      const ctx = p.tex.getContext() as unknown as Ctx2D;
      ctx.clearRect(0, 0, p.w, p.h);
      fn(ctx);
      p.tex.update(true);
    };
    const boardRows = m.rows.map(({ spark: _s, ...r }) => r);
    draw(P.board, opsKey([boardRows, m.counts]), (c) =>
      drawSessionsBoard(c, P.board.w, P.board.h, m, u),
    );
    draw(P.alerts, opsKey([m.alerts, clock]), (c) =>
      drawAlertStrip(c, P.alerts.w, P.alerts.h, m, clock),
    );
    draw(P.ticker, opsKey(m.ticker.map((t) => t.key)), (c) =>
      drawTicker(c, P.ticker.w, P.ticker.h, m),
    );
    const minute = (v: number | null | undefined) =>
      v == null ? null : Math.floor(v / 60_000);
    const usageKey = opsKey({
      ...m.usage,
      fiveHour: m.usage.fiveHour && {
        ...m.usage.fiveHour,
        resetsInMs: minute(m.usage.fiveHour.resetsInMs),
      },
      sevenDay: m.usage.sevenDay && {
        ...m.usage.sevenDay,
        resetsInMs: minute(m.usage.sevenDay.resetsInMs),
      },
    });
    draw(P.usage, usageKey, (c) =>
      drawUsagePanel(c, P.usage.w, P.usage.h, m, u),
    );
    draw(
      P.activity,
      opsKey([m.activity, m.rows.map((r) => [r.project, r.status, r.spark])]),
      (c) => drawActivityPanel(c, P.activity.w, P.activity.h, m, u),
    );
    this.drawMonitors(m, force);
    this.syncBanks(m);
  }

  /** Monitor 0: the session that most needs you; 1-3 rotate through the rest. */
  private drawMonitors(m: OpsModel, force: boolean): void {
    const live = m.rows.filter((r) => r.status !== "ended");
    const picks: Array<OpsRow | null> = [];
    picks.push(live[0] ?? null);
    const rest = live.slice(1);
    for (let i = 1; i < MON_COUNT; i++) {
      if (rest.length === 0) picks.push(null);
      else if (rest.length < MON_COUNT) picks.push(rest[i - 1] ?? null);
      else
        picks.push(rest[(this.rotate * (MON_COUNT - 1) + i - 1) % rest.length]);
    }
    const byId = new Map(this.campus.map((c) => [c.sessionId, c]));
    const ctx = this.monTex.getContext() as unknown as Ctx2D;
    const cw = ATLAS_W / 2;
    const ch = ATLAS_H / 2;
    let changed = false;
    picks.forEach((r, i) => {
      const cs = r ? byId.get(r.sessionId) : undefined;
      const extra: CardExtras | null = r
        ? {
            todos: (cs?.todos ?? [])
              .map((t) => ({
                text:
                  t.active_form && t.status === "in_progress"
                    ? t.active_form
                    : t.content,
                status: t.status,
              }))
              .sort((a, b) => rankTodo(a.status) - rankTodo(b.status)),
            activity: m.ticker
              .filter((t) => t.sessionId === r.sessionId)
              .slice(0, 4)
              .map((t) => ({ clock: t.clock, actor: t.actor, text: t.text })),
            index: live.indexOf(r),
            total: live.length,
          }
        : null;
      const { spark: _s, ...rk } = r ?? ({ spark: [] } as unknown as OpsRow);
      const key = opsKey([rk, extra]);
      const proxy = this.monProxies[i];
      proxy.metadata = {
        interact: {
          kind: "ops",
          sessionId: r?.sessionId ?? "",
          roomLabel: r?.project ?? "Operator console",
        },
      };
      if (!force && key === this.monKeys[i]) return;
      this.monKeys[i] = key;
      changed = true;
      drawSessionCard(
        ctx,
        (i % 2) * cw,
        Math.floor(i / 2) * ch,
        cw,
        ch,
        r,
        extra,
      );
    });
    if (changed) this.monTex.update(true);
  }

  private syncBanks(m: OpsModel): void {
    const west: WallSession[] = [];
    const east: WallSession[] = [];
    const bay = (id: string) => this.sides.get(id)?.bay ?? 99;
    const rows = [...m.rows].sort(
      (a, b) =>
        bay(a.sessionId) - bay(b.sessionId) ||
        a.sessionId.localeCompare(b.sessionId),
    );
    for (const r of rows) {
      const s: WallSession = {
        sessionId: r.sessionId,
        label: r.project,
        status: r.status,
        phase: r.phaseLabel,
      };
      (this.sides.get(r.sessionId)?.west ? west : east).push(s);
    }
    const key = opsKey([west, east]);
    if (key === this.bankKey) return;
    this.bankKey = key;
    this.banks[0].setSessions(west.slice(0, BANK_COLS * BANK_ROWS));
    this.banks[1].setSessions(east.slice(0, BANK_COLS * BANK_ROWS));
  }
}

function rankTodo(s: string): number {
  return s === "in_progress" ? 0 : s === "pending" ? 1 : 2;
}
