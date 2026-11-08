/**
 * Control-room interior: a ROUND ops centre at the far end of the hall,
 * laid out by the pure plan in ./controlRoomPlan (parametric in the
 * footprint `layout.controlRoom`). Building supplies the floor; everything
 * inside (plaster lining with the window reveals, neck, ceiling, cove,
 * wall, consoles) is here, and the drum exterior (cladding, ribbon windows,
 * roof, slab, columns) is ./ControlRoomShell, built alongside.
 *
 *   - Curved seamless video wall (±70°), two tiers on a vented plinth:
 *       upper:  project map · usage · SESSIONS BOARD · activity · projects
 *       lower:  room camera feeds ▢▢▢▢ · alerts + event log · ▢▢▢▢ feeds
 *     Five DynamicTextures (3 upper, 2 lower) mapped across curved strips,
 *     redrawn only when their content key changes, ≤ 2 Hz, only when near.
 *     Subagents on the project map are thin-instanced dots moving along the
 *     map lines every frame (no texture redraw).
 *   - Two tiered console arcs concentric with the wall (white solid-surface
 *     desks, low monitor arms so the lower tier stays in view) + a raised
 *     supervisor desk on a 30 cm platform with a rail.
 *   - All console screens: one merged mesh on one atlas (session cards on the
 *     centre monitors, wall minis on the side ones).
 *   - Bright: ring cove + downlights following the wall, a halo ring over
 *     the consoles, navy resin floor with carpet tiles, white consoles.
 */

import {
  Color3,
  CreateDisc,
  CreatePlane,
  DynamicTexture,
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type PBRMaterial,
} from "@/engine/babylon";
import type {
  BuildingLayout,
  CampusProject,
  CampusSession,
  CampusStats,
} from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { PLANTER_SOIL_Y } from "@/engine/assets/proceduralProps";
import type { Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { addDeckColliders } from "@/engine/world/controlRoomColliders";
import { ArtBatcher } from "@/engine/art/geometry";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  buildOpsModel,
  opsKey,
  type OpsModel,
  type OpsRow,
} from "@/engine/logic/opsModel";
import {
  dotPosition,
  layoutProjectMap,
  lineColor,
  mapKey,
  mapSessions,
  projectGroups,
  type MapGroup,
  type ProjectMapLayout,
} from "@/engine/logic/projectMap";
import {
  createEmissiveMaterial,
  createScreenTexture,
  whenFontsReady,
  type Ctx2D,
} from "@/engine/screens/canvasKit";
import type { FeedScheduler } from "@/engine/screens/FeedScheduler";
import {
  drawActivityPanel,
  drawAlertStrip,
  drawEventLog,
  drawFeedCaption,
  drawProjectMap,
  drawProjectsPanel,
  drawKpiTiles,
  drawSessionCard,
  drawSessionsBoard,
  drawWallBoard,
  drawTileSeams,
  drawUsagePanel,
  opsLocaleRev,
  setOpsLocale,
  type CardExtras,
  type ProjectsPanelRow,
} from "@/engine/screens/opsCanvas";
import {
  CONSOLE,
  DRUM,
  SURROUND_HALF,
  WALL_Y,
  controlPlan,
  drumPlan,
  feedCells,
  onArc,
  upperSpans,
  type ControlPlan,
  type DrumPlan,
  type FeedCell,
  type UpperPanel,
} from "./controlRoomPlan";
import { buildControlShell } from "./ControlRoomShell";
import { isLocale } from "@/i18n";
import { lowerTiles, lowerWallKey, wallClock } from "./controlRoomWall";

export interface ControlRoomContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
  feeds: FeedScheduler;
}

/** Upper-tier texture pixels per metre (text ≥ 14 px from the consoles). */
const PPM_UP = 400;
/** Lower tier (captions, alerts, log). */
const PPM_LOW = 300;
const GUTTER_CM = 1.2;
/** The wall is F-able from anywhere in the operator area. */
const WALL_INTERACT_RANGE = 12;
const REDRAW_MS = 500;
const ROTATE_MS = 8000;
const GROUP = "controlRoom";
/** LED tile pitch (m): seams line up across both tiers and every canvas. */
const TILE_M = 0.6;
/** Gutter / unlit LED colour behind the panels (one colour for both tiers). */
const WALL_BG = "#05080D";

const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;
const CELL_W = 768;
const CELL_H = 336;
const AUX = {
  board: 8,
  usage: 9,
  activity: 10,
  log: 11,
  map: 12,
  projects: 13,
} as const;
const AUX_CYCLE = [
  AUX.board,
  AUX.usage,
  AUX.activity,
  AUX.log,
  AUX.map,
  AUX.projects,
];

interface Canvas {
  name: string;
  mesh: Mesh;
  tex: DynamicTexture;
  mat: StandardMaterial;
  w: number;
  h: number;
  keys: Map<string, string>;
}

interface UpperLayout {
  canvas: "L" | "C" | "R";
  key: UpperPanel;
  /** Pixel rect inside its canvas. */
  x: number;
  w: number;
  a0: number;
  a1: number;
}

interface Monitor {
  cell: number;
  /** Seat index for session cards (-1 = aux). */
  seat: number;
  proxy: Mesh;
}

interface FeedSlot {
  cell: FeedCell;
  mesh: Mesh;
  mat: StandardMaterial;
  /** Project room shown (its feed texture is keyed by the room id). */
  room: FeedRoom | null;
  /** Session the feed enters / inspects (the room's most urgent one). */
  sessionId: string | null;
}

interface FeedRoom {
  id: string;
  name: string;
  west: boolean;
  bay: number;
  sessionIds: string[];
}

/** Ring-sector strip facing the centre (screens), uv u across the angle. */
function arcStrip(
  name: string,
  scene: Scene,
  r: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  segs: number,
): Mesh {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = a0 + (a1 - a0) * t;
    const s = Math.sin(a);
    const c = Math.cos(a);
    pos.push(s * r, y0, c * r, s * r, y1, c * r);
    nor.push(-s, 0, -c, -s, 0, -c);
    uvs.push(t, 0, t, 1);
    if (i < segs) {
      const q = i * 2;
      idx.push(q, q + 1, q + 3, q, q + 3, q + 2);
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = uvs;
  vd.indices = idx;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  return mesh;
}

export class ControlRoom {
  private readonly scene: Scene;
  private readonly plan: ControlPlan;
  private readonly drum: DrumPlan;
  private readonly statics: Mesh[] = [];
  /** Drum exterior (ControlRoomShell): lit by the factory, not isolated. */
  private readonly exterior: Mesh[];
  private readonly canvases: Record<"L" | "C" | "R" | "lowL" | "lowR", Canvas>;
  private readonly upper: UpperLayout[] = [];
  private readonly feedSlots: FeedSlot[] = [];
  private readonly feedObserver: ReturnType<FeedScheduler["onChanged"]["add"]>;
  private readonly lowerCenter: [number, number];
  private readonly monitor: Mesh;
  private readonly monTex: DynamicTexture;
  private readonly monMat: StandardMaterial;
  private readonly monitors: Monitor[] = [];
  private readonly cellKeys: string[] = new Array(ATLAS_COLS * ATLAS_ROWS).fill(
    "",
  );
  private readonly seatCount: number;
  private readonly dots: Mesh;
  private readonly dotMat: StandardMaterial;
  private readonly pulseMat: PBRMaterial;
  private dotBuf = new Float32Array(16 * 64);
  private dotCol = new Float32Array(4 * 64);
  private dotCap = 64;

  /** Project rooms (feeds are grouped by side, ordered by bay). */
  private rooms: FeedRoom[] = [];
  private campus: CampusSession[] = [];
  private stats: CampusStats | null = null;
  private projects: CampusProject[] | null = null;
  private labels: ReadonlyMap<string, string> = new Map();
  private model: OpsModel | null = null;
  private map: ProjectMapLayout | null = null;
  private dirty = true;
  private sinceBuild = 1e9;
  private sinceRotate = 0;
  private sinceClock = 0;
  private pulseT = 0;
  private pulseColor = "";
  private rotate = 0;
  private lastClock = "";
  private localeRev = -1;
  private feedKey = "";
  private far = false;
  private near = false;
  private disposed = false;

  constructor(
    private readonly ctx: ControlRoomContext,
    layout: BuildingLayout,
    shell: AbstractMesh[],
  ) {
    const { scene } = ctx;
    this.scene = scene;
    const p = controlPlan(layout);
    this.plan = p;
    this.drum = drumPlan(p);
    this.setLayout(layout);
    this.buildStatics();
    this.exterior = buildControlShell(ctx, p, this.drum, GROUP);

    // ---- Video wall canvases (upper: 3, lower: 2)
    const spans = upperSpans(p);
    const wallMeta = {
      interact: { kind: "ops", sessionId: "", roomLabel: "Ops dashboard" },
      interactRange: WALL_INTERACT_RANGE,
      noFocusFrame: true,
    };
    const upH = WALL_Y.upper1 - WALL_Y.upper0;
    const lowH = WALL_Y.lower1 - WALL_Y.lower0;
    const groups: Array<["L" | "C" | "R", UpperPanel[]]> = [
      ["L", ["map", "usage"]],
      ["C", ["board"]],
      ["R", ["activity", "projects"]],
    ];
    const made: Partial<Record<string, Canvas>> = {};
    for (const [name, keys] of groups) {
      const ss = spans.filter((s) => keys.includes(s.key));
      const a0 = ss[0].a0;
      const a1 = ss[ss.length - 1].a1;
      const wM = (a1 - a0) * p.R;
      const cv = this.canvas(
        name,
        a0,
        a1,
        WALL_Y.upper0,
        WALL_Y.upper1,
        wM,
        upH,
        PPM_UP,
        wallMeta,
      );
      made[name] = cv;
      for (const s of ss) {
        const x = ((s.a0 - a0) / (a1 - a0)) * cv.w;
        const w = ((s.a1 - s.a0) / (a1 - a0)) * cv.w;
        this.upper.push({ canvas: name, key: s.key, x, w, a0: s.a0, a1: s.a1 });
      }
    }
    const mid = (p.a0 + p.a1) / 2;
    made.lowL = this.canvas(
      "lowL",
      p.a0,
      mid,
      WALL_Y.lower0,
      WALL_Y.lower1,
      (mid - p.a0) * p.R,
      lowH,
      PPM_LOW,
      wallMeta,
    );
    made.lowR = this.canvas(
      "lowR",
      mid,
      p.a1,
      WALL_Y.lower0,
      WALL_Y.lower1,
      (p.a1 - mid) * p.R,
      lowH,
      PPM_LOW,
      wallMeta,
    );
    this.canvases = made as Record<"L" | "C" | "R" | "lowL" | "lowR", Canvas>;

    // ---- Lower-tier camera feeds (curved, flush with the strip)
    const fc = feedCells(p);
    this.lowerCenter = fc.center;
    for (const cell of fc.cells) {
      const mesh = arcStrip(
        `wallScreen_feed_${cell.side}_${cell.index}`,
        scene,
        p.R - 0.004,
        cell.a0,
        cell.a1,
        cell.y0,
        cell.y1,
        6,
      );
      mesh.position.set(p.cx, 0, p.cz);
      const mat = createEmissiveMaterial(
        `opsFeedMat_${cell.side}${cell.index}`,
        scene,
        null,
      );
      mat.backFaceCulling = false;
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      mesh.computeWorldMatrix(true);
      mesh.freezeWorldMatrix();
      this.feedSlots.push({ cell, mesh, mat, room: null, sessionId: null });
    }
    this.feedObserver = ctx.feeds.onChanged.add(() => this.bindFeeds());

    // ---- Alert pulse line between the tiers (under the board)
    this.pulseMat = ctx.materials.createEmissive("opsPulse", "#38BDF8", 0.6);
    const pulse = new Mesh("opsPulse", scene);
    pulse.position.set(p.cx, 0, p.cz);
    {
      const m = arcStrip(
        "opsPulseStrip",
        scene,
        p.R - 0.003,
        fc.center[0],
        fc.center[1],
        WALL_Y.lower1 + 0.008,
        WALL_Y.upper0 - 0.008,
        24,
      );
      m.parent = pulse;
      m.material = this.pulseMat;
      m.isPickable = false;
      this.statics.push(m);
    }
    this.statics.push(pulse);

    // ---- Project-map subagent dots (thin instances, 1 draw)
    this.dotMat = new StandardMaterial("opsDotMat", scene);
    this.dotMat.disableLighting = true;
    this.dotMat.diffuseColor = Color3.Black();
    this.dotMat.specularColor = Color3.Black();
    this.dotMat.emissiveColor = Color3.White();
    this.dotMat.backFaceCulling = false;
    this.dots = CreateDisc(
      "opsMapDots",
      { radius: 0.032, tessellation: 14 },
      scene,
    );
    this.dots.material = this.dotMat;
    this.dots.isPickable = false;
    this.dots.thinInstanceSetBuffer("matrix", this.dotBuf, 16, false);
    this.dots.thinInstanceSetBuffer("color", this.dotCol, 4, false);
    this.dots.thinInstanceCount = 0;
    this.dots.alwaysSelectAsActiveMesh = true;

    // ---- Console screens: one merged mesh on one atlas + pick proxies
    this.monTex = createScreenTexture(
      "opsMonitors",
      scene,
      ATLAS_COLS * CELL_W,
      ATLAS_ROWS * CELL_H,
    );
    this.monMat = createEmissiveMaterial("opsMonitorsMat", scene, this.monTex);
    const { mesh, seats } = this.buildMonitors();
    this.monitor = mesh;
    this.seatCount = seats;

    // No GlowLayer for anything here: bloom from the LED strips smeared blue
    // bands over the chairs / rail, and on screens it washes the text out.

    // ---- Zone lighting: only the shell + interior see these.
    const c = p;
    const sz = p.supervisor?.z ?? p.cz - 2;
    const r1 = p.rows[0]?.r ?? p.R * 0.6;
    const wash = (a: number) => {
      const q = onArc(c.cx, c.cz, p.R - 1.8, a);
      return new Vector3(q.x, 3.3, q.z);
    };
    ctx.lighting.isolateZone(
      [...shell, ...this.statics],
      [
        {
          // Low (3.4 m) so the key lands on the consoles, not the ceiling.
          pos: new Vector3(c.cx, 3.4, c.cz + r1 - 0.6),
          color: "#F3F6FF",
          intensity: 17,
          range: 10,
        },
        {
          pos: new Vector3(c.cx, 3.3, sz + 0.4),
          color: "#F5F3EE",
          intensity: 11,
          range: 9,
        },
        { pos: wash(-0.75), color: "#DCE6FF", intensity: 10, range: 7 },
        { pos: wash(0.75), color: "#DCE6FF", intensity: 10, range: 7 },
        {
          pos: new Vector3(c.cx, 2.9, p.z0 + 2.2),
          color: "#EEF1F6",
          intensity: 10,
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
  // Public API
  // -------------------------------------------------------------------------

  /** Room slots changed (feeds are grouped by side, ordered by bay). */
  setLayout(layout: BuildingLayout): void {
    this.rooms = (layout.projects ?? [])
      .map((pr) => ({
        id: pr.projectId,
        name: pr.name,
        west: pr.slot.side === "west",
        bay: pr.slot.bay,
        sessionIds: pr.pods.map((pod) => pod.sessionId),
      }))
      .sort((a, b) => a.bay - b.bay || a.id.localeCompare(b.id));
    this.feedKey = "";
    this.dirty = true;
  }

  /** Latest campus feed (cheap: just stored; drawn by update()). */
  setData(
    campus: CampusSession[],
    stats: CampusStats | null | undefined,
    labels: ReadonlyMap<string, string>,
    projects?: CampusProject[] | null,
    locale?: string,
  ): void {
    this.campus = campus;
    this.stats = stats ?? null;
    this.labels = labels;
    this.projects = projects ?? null;
    // Canvas text language; a change bumps opsLocaleRev (part of every key).
    if (locale && isLocale(locale)) setOpsLocale(locale);
    this.dirty = true;
  }

  /** Per frame. `near`: the player is in / approaching the room. */
  update(dt: number, near: boolean): void {
    if (this.disposed) return;
    this.near = near;
    this.pulse(dt);
    this.sinceBuild += dt * 1000;
    this.sinceRotate += dt * 1000;
    if (this.sinceRotate >= ROTATE_MS) {
      this.sinceRotate = 0;
      this.rotate += 1;
      this.dirty = true;
    }
    if (!near) return;
    this.moveDots();
    this.sinceClock += dt * 1000;
    if (this.sinceClock >= 1000) {
      this.sinceClock = 0;
      if (wallClock(Date.now()) !== this.lastClock) this.dirty = true;
    }
    // Elapsed times ("for 2m") drift without new data: rebuild every 15 s.
    if (this.sinceBuild >= 15_000) this.dirty = true;
    if (!this.dirty || this.sinceBuild < REDRAW_MS) return;
    this.redraw(false);
  }

  setFar(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    this.monitor.setEnabled(!far);
    this.dots.setEnabled(!far);
    for (const f of this.feedSlots) f.mesh.setEnabled(!far && !!f.room);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctx.feeds.onChanged.remove(this.feedObserver);
    for (const cv of Object.values(this.canvases)) {
      cv.tex.dispose();
      cv.mat.dispose();
      cv.mesh.dispose();
    }
    for (const f of this.feedSlots) {
      f.mat.emissiveTexture = null;
      f.mat.dispose();
      f.mesh.dispose();
    }
    for (const m of [
      ...this.statics,
      ...this.exterior,
      this.monitor,
      this.dots,
    ])
      m.dispose();
    for (const mo of this.monitors) mo.proxy.dispose();
    this.monTex.dispose();
    this.monMat.dispose();
    this.dotMat.dispose();
    this.pulseMat.dispose();
    this.ctx.assets.disposeGroup(GROUP);
    this.ctx.colliders.disposeGroup(GROUP);
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private buildStatics(): void {
    const { scene, materials, colliders, assets } = this.ctx;
    const p = this.plan;
    const { cx, cz, R, roomR, H } = p;
    const C = v3(cx, 0, cz);
    const b = new ArtBatcher(scene, materials, "controlInt", 11);
    b.jitter = 0.015;
    const plaster = materials.get("wall");
    // Toned-down ceiling (the dome read overexposed next to the wall).
    const ceiling = materials.tinted("ceiling", "#B9BEC6");
    const felt = materials.felt("#B9C4D2");
    const plinth = materials.color("#C9CFD7", 0.42, 0.35);
    const consoleBody = materials.color("#E4E8EC", 0.5);
    const consoleTop = materials.color("#F5F6F7", 0.3);
    const surround = materials.color("#1A1E25", 0.38, 0.2);
    const carpet = materials.tinted("floorRoom", "#2B3E66");
    const carpetDeck = materials.tinted("floorRoom", "#344A78");
    const deg = Math.PI / 180;
    const a0 = p.a0;
    const a1 = p.a1;
    const segs = (a: number, b2: number, per = 2 * deg) =>
      Math.max(4, Math.ceil(Math.abs(b2 - a) / per));

    // ---- Room lining: the drum's plaster (full circle) with the ribbon
    // window openings on the flanks (plaster reveals: sill-less, glass to
    // the floor), the neck to the hall door and the lintel over it. The
    // cladding, glass, roof and slab are ControlRoomShell's (lit by the
    // factory, not by the zone lights).
    const d = this.drum;
    const wallSeg = (a: number, b2: number) => segs(a, b2, 1.5 * deg);
    const wins = [...d.windows].sort((x, y) => x.a0 - y.a0);
    const solids: Array<[number, number]> =
      wins.length === 2
        ? [
            [-d.aNeck, wins[0].a0],
            [wins[0].a1, wins[1].a0],
            [wins[1].a1, d.aNeck],
          ]
        : [[-d.aNeck, d.aNeck]];
    for (const [s0, s1] of solids)
      b.arc(plaster, C, roomR, d.rWall, s0, s1, 0, H + 0.1, wallSeg(s0, s1));
    for (const w of wins)
      b.arc(
        plaster,
        C,
        roomR,
        d.rWall,
        w.a0,
        w.a1,
        DRUM.head,
        H + 0.1,
        wallSeg(w.a0, w.a1),
      );
    b.arc(
      plaster,
      C,
      roomR,
      d.rWall,
      d.aNeck,
      2 * Math.PI - d.aNeck,
      DRUM.neckH + 0.1,
      H + 0.1,
      wallSeg(d.aNeck, 2 * Math.PI - d.aNeck),
    );
    // Neck side walls (plaster, the skin is the shell's).
    const nk = p.neckHW;
    const zNeck = cz - Math.sqrt((roomR + 0.1) ** 2 - (nk + 0.1) ** 2);
    for (const sx of [-1, 1]) {
      const c0 = new Vector3(
        cx + sx * (nk + DRUM.wallT / 2),
        (DRUM.neckH - 0.1) / 2,
        (p.z0 + zNeck) / 2,
      );
      const sz0 = new Vector3(DRUM.wallT, DRUM.neckH + 0.1, zNeck - p.z0);
      b.box(plaster, c0, sz0);
      colliders.addBox(GROUP, c0, sz0);
    }
    // Colliders: 6° chords round the circle, except across the neck.
    const cr = roomR + DRUM.wallT / 2;
    for (let a = -d.aNeck; a < d.aNeck - 1e-3; a += 6 * deg) {
      const m = Math.min(d.aNeck, a + 6 * deg);
      const q = onArc(cx, cz, cr, (a + m) / 2);
      colliders.addBox(
        GROUP,
        new Vector3(q.x, H / 2, q.z),
        new Vector3(2 * cr * Math.sin((m - a) / 2) + 0.1, H, DRUM.wallT),
        (a + m) / 2,
      );
    }
    // Felt panels on the piers between the video wall and the windows.
    if (wins.length === 2)
      for (const sx of [-1, 1]) {
        const am = sx * (SURROUND_HALF + DRUM.pierWall / 2);
        const q = onArc(cx, cz, roomR - 0.02, am);
        b.rbox(
          felt,
          v3(q.x, 2.2, q.z),
          v3(roomR * DRUM.pierWall - 0.3, 3.2, 0.04),
          { r: 0.012, yaw: am },
        );
      }

    // ---- Ceiling + ring cove + downlights + halo ring over the consoles.
    b.arc(ceiling, C, 0, roomR + 0.02, 0, 2 * Math.PI, H, H + 0.1, 120);
    const soffit0 = R - 1.15;
    b.arc(ceiling, C, soffit0, roomR, 0, 2 * Math.PI, H - 0.42, H, 180);
    b.arc(
      "lightPanelDim",
      C,
      soffit0 - 0.012,
      soffit0,
      0,
      2 * Math.PI,
      H - 0.42,
      H - 0.34,
      180,
      { keepUVs: true },
    );
    b.arc(
      "lightPanelDim",
      C,
      R + 0.12,
      R + 0.22,
      a0 - 2 * deg,
      a1 + 2 * deg,
      H - 0.425,
      H - 0.42,
      70,
      { keepUVs: true },
    );
    for (let a = -176 * deg; a <= 176 * deg + 1e-3; a += 8 * deg) {
      const q = onArc(cx, cz, R - 0.55, a);
      b.cylinder("blackMetal", v3(q.x, H - 0.425, q.z), 0.012, 0.16, 0.16, 16);
      b.cylinder("lightPanel", v3(q.x, H - 0.432, q.z), 0.004, 0.12, 0.12, 16);
    }
    const haloR = (p.rows[0]?.r ?? R * 0.6) - 0.6;
    const hy = H - 1.15;
    b.arc(
      "aluminium",
      C,
      haloR - 0.16,
      haloR + 0.16,
      0,
      2 * Math.PI,
      hy,
      hy + 0.09,
      96,
    );
    b.arc(
      materials.emissive("opsHalo", "#F4F1EA", 1.05),
      C,
      haloR - 0.07,
      haloR + 0.07,
      0,
      2 * Math.PI,
      hy - 0.004,
      hy,
      96,
      { keepUVs: true },
    );
    for (let k = 0; k < 6; k++) {
      const q = onArc(cx, cz, haloR, (k / 6) * Math.PI * 2);
      b.cylinder(
        "blackMetal",
        v3(q.x, (hy + H) / 2, q.z),
        H - hy,
        0.008,
        0.008,
        6,
      );
    }

    // ---- Video wall: plinth with vent grilles, dark surround, top trim.
    const wa0 = a0 - 1.2 * deg;
    const wa1 = a1 + 1.2 * deg;
    b.arc(
      plinth,
      C,
      R - 0.07,
      R + 0.35,
      wa0,
      wa1,
      0.07,
      WALL_Y.plinth,
      segs(wa0, wa1, 1.5 * deg),
    );
    b.arc(
      "skirting",
      C,
      R - 0.02,
      R + 0.35,
      wa0,
      wa1,
      0,
      0.07,
      segs(wa0, wa1, 1.5 * deg),
    );
    b.arc(
      "ledBlue",
      C,
      R - 0.075,
      R - 0.07,
      wa0,
      wa1,
      WALL_Y.plinth - 0.03,
      WALL_Y.plinth - 0.02,
      segs(wa0, wa1),
      { keepUVs: true },
    );
    const modW = 1.05;
    const nMod = Math.floor(((wa1 - wa0) * R) / modW);
    for (let i = 0; i < nMod; i++) {
      const a = wa0 + ((i + 0.5) / nMod) * (wa1 - wa0);
      const q = onArc(cx, cz, R - 0.075, a);
      b.box("shadowGap", v3(q.x, 0.42, q.z), v3(modW - 0.22, 0.34, 0.012), {
        yaw: a,
      });
      for (let k = 0; k < 5; k++) {
        const qq = onArc(cx, cz, R - 0.085, a);
        b.box(
          plinth,
          v3(qq.x, 0.29 + k * 0.065, qq.z),
          v3(modW - 0.24, 0.022, 0.014),
          { yaw: a },
        );
      }
    }
    b.arc(
      surround,
      C,
      R + 0.006,
      R + 0.3,
      wa0,
      wa1,
      WALL_Y.plinth,
      WALL_Y.trim,
      segs(wa0, wa1, 1.5 * deg),
    );
    b.arc(
      surround,
      C,
      R - 0.05,
      roomR,
      wa0,
      wa1,
      WALL_Y.upper1 + 0.004,
      WALL_Y.trim + 0.08,
      segs(wa0, wa1, 1.5 * deg),
    );
    for (const a of [wa0, wa1]) {
      const q = onArc(cx, cz, (R - 0.05 + roomR) / 2, a);
      b.box(
        surround,
        v3(q.x, (WALL_Y.plinth + WALL_Y.trim) / 2, q.z),
        v3(0.1, WALL_Y.trim - WALL_Y.plinth + 0.16, roomR - R + 0.05),
        { yaw: a },
      );
    }
    for (let a = wa0; a < wa1 - 1e-3; a += 6 * deg) {
      const m = Math.min(wa1, a + 6 * deg);
      const q = onArc(cx, cz, R + 0.15, (a + m) / 2);
      colliders.addBox(
        GROUP,
        new Vector3(q.x, 0.6, q.z),
        new Vector3((m - a) * R + 0.1, 1.2, 0.5),
        (a + m) / 2,
      );
    }

    // ---- Floor: carpet-tile operator area with an LED ring (resin outside).
    const rugR = (p.rows[0]?.r ?? R * 0.6) + 1.1;
    b.arc(carpet, C, 0, rugR, 0, 2 * Math.PI, 0.001, 0.008, 96);
    b.arc("ledBlue", C, rugR, rugR + 0.018, 0, 2 * Math.PI, 0.001, 0.009, 96, {
      keepUVs: true,
    });

    // ---- Console rows.
    const chairs: Array<{ x: number; y: number; z: number; yaw: number }> = [];
    p.rows.forEach((row, ri) => {
      const span0 = Math.min(...row.halves.map((h) => h[0]));
      const span1 = Math.max(...row.halves.map((h) => h[1]));
      const ri0 = row.r - CONSOLE.depth / 2;
      const ro0 = row.r + CONSOLE.depth / 2;
      if (row.deck > 0) {
        const d0 = ri0 - 1.35;
        const d1 = ro0 + 0.15;
        const e0 = span0 - 0.18 / row.r;
        const e1 = span1 + 0.18 / row.r;
        b.arc(
          carpetDeck,
          C,
          d0,
          d1,
          e0,
          e1,
          0.008,
          row.deck,
          segs(e0, e1, 1.5 * deg),
        );
        b.arc(
          "ledBlue",
          C,
          d0 - 0.005,
          d0,
          e0,
          e1,
          row.deck - 0.03,
          row.deck - 0.02,
          segs(e0, e1),
          { keepUVs: true },
        );
        b.arc(
          "ledBlue",
          C,
          d1,
          d1 + 0.005,
          e0,
          e1,
          row.deck - 0.03,
          row.deck - 0.02,
          segs(e0, e1),
          { keepUVs: true },
        );
      }
      const y = row.deck;
      for (const [h0, h1] of row.halves) {
        const n = segs(h0, h1, 1.5 * deg);
        b.arc(
          consoleBody,
          C,
          ri0 + 0.1,
          ro0 - 0.04,
          h0,
          h1,
          y + 0.1,
          y + CONSOLE.deskH - 0.04,
          n,
        );
        b.arc("skirting", C, ri0 + 0.16, ro0 - 0.1, h0, h1, y, y + 0.1, n);
        b.arc(
          consoleTop,
          C,
          ri0 - 0.04,
          ro0,
          h0 - 0.004,
          h1 + 0.004,
          y + CONSOLE.deskH - 0.04,
          y + CONSOLE.deskH,
          n,
        );
        b.arc(
          "ledBlue",
          C,
          ri0 + 0.095,
          ri0 + 0.1,
          h0,
          h1,
          y + CONSOLE.deskH - 0.075,
          y + CONSOLE.deskH - 0.065,
          n,
          { keepUVs: true },
        );
        for (const e of [h0, h1]) {
          const q = onArc(cx, cz, row.r, e);
          b.rbox(
            consoleBody,
            v3(q.x, y + (CONSOLE.deskH - 0.04) / 2, q.z),
            v3(0.04, CONSOLE.deskH - 0.04, CONSOLE.depth - 0.06),
            { yaw: e, r: 0.01 },
          );
        }
        for (let a = h0; a < h1 - 1e-3; a += 0.9 / row.r) {
          const m = Math.min(h1, a + 0.9 / row.r);
          const q = onArc(cx, cz, row.r, (a + m) / 2);
          colliders.addBox(
            GROUP,
            new Vector3(q.x, y + 0.4, q.z),
            new Vector3((m - a) * row.r + 0.05, 0.8 + y, CONSOLE.depth),
            (a + m) / 2,
          );
        }
      }
      for (const s of row.seats) {
        const q = onArc(cx, cz, ri0 - 0.42, s.a);
        chairs.push({ x: q.x, y, z: q.z, yaw: s.a });
        this.monitorArm(b, cx, cz, row.r, y, s.a, s.monitors);
      }
      void ri;
    });

    // ---- Supervisor platform + desk + rail.
    const sv = p.supervisor;
    if (sv) {
      const pw = sv.phw;
      b.box(
        carpetDeck,
        v3(cx, sv.deck / 2, (sv.pz0 + sv.pz1) / 2),
        v3(pw * 2, sv.deck, sv.pz1 - sv.pz0),
      );
      b.box(
        "ledBlue",
        v3(cx, sv.deck - 0.025, sv.pz1 + 0.003),
        v3(pw * 2, 0.01, 0.006),
        { keepUVs: true },
      );
      b.box(
        plinth,
        v3(cx, sv.deck * 0.5, sv.pz1 + 0.2),
        v3(1.6, sv.deck * 0.5, 0.4),
      );
      // Rail along the back and sides (chrome posts + top tube).
      const railY = sv.deck + 0.9;
      const rail = (x0: number, z0: number, x1: number, z1: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const yaw = Math.atan2(x1 - x0, z1 - z0);
        b.box(
          "aluminium",
          v3((x0 + x1) / 2, railY, (z0 + z1) / 2),
          v3(0.05, 0.03, len),
          { yaw },
        );
        b.box(
          "aluminium",
          v3((x0 + x1) / 2, railY - 0.42, (z0 + z1) / 2),
          v3(0.02, 0.02, len),
          { yaw },
        );
        const n = Math.max(1, Math.round(len / 1.1));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          b.cylinder(
            "aluminium",
            v3(x0 + (x1 - x0) * t, sv.deck + 0.45, z0 + (z1 - z0) * t),
            0.9,
            0.028,
            0.028,
            10,
          );
        }
      };
      rail(cx - pw + 0.05, sv.pz0 + 0.05, cx + pw - 0.05, sv.pz0 + 0.05);
      for (const sx of [-1, 1])
        rail(
          cx + sx * (pw - 0.05),
          sv.pz0 + 0.05,
          cx + sx * (pw - 0.05),
          sv.pz0 + 0.95,
        );
      const SC = v3(cx, 0, sv.cz);
      const si = sv.r - CONSOLE.depth / 2;
      const so = sv.r + CONSOLE.depth / 2;
      const n = segs(sv.a0, sv.a1, 1.5 * deg);
      b.arc(
        consoleBody,
        SC,
        si + 0.1,
        so - 0.04,
        sv.a0,
        sv.a1,
        sv.deck + 0.1,
        sv.deck + CONSOLE.deskH - 0.04,
        n,
      );
      b.arc(
        "skirting",
        SC,
        si + 0.16,
        so - 0.1,
        sv.a0,
        sv.a1,
        sv.deck,
        sv.deck + 0.1,
        n,
      );
      b.arc(
        consoleTop,
        SC,
        si - 0.04,
        so,
        sv.a0,
        sv.a1,
        sv.deck + CONSOLE.deskH - 0.04,
        sv.deck + CONSOLE.deskH,
        n,
      );
      b.arc(
        "ledBlue",
        SC,
        si + 0.095,
        si + 0.1,
        sv.a0,
        sv.a1,
        sv.deck + CONSOLE.deskH - 0.075,
        sv.deck + CONSOLE.deskH - 0.065,
        n,
        { keepUVs: true },
      );
      for (const s of sv.seats) {
        const q = onArc(cx, sv.cz, si - 0.42, s.a);
        chairs.push({ x: q.x, y: sv.deck, z: q.z, yaw: s.a });
        this.monitorArm(b, cx, sv.cz, sv.r, sv.deck, s.a, s.monitors);
      }
      for (let a = sv.a0; a < sv.a1 - 1e-3; a += 0.25) {
        const m = Math.min(sv.a1, a + 0.25);
        const q = onArc(cx, sv.cz, sv.r, (a + m) / 2);
        colliders.addBox(
          GROUP,
          new Vector3(q.x, 0.5, q.z),
          new Vector3((m - a) * sv.r + 0.05, 1.0, CONSOLE.depth),
          (a + m) / 2,
        );
      }
      colliders.addBox(
        GROUP,
        new Vector3(cx, 0.6, sv.pz0 + 0.05),
        new Vector3(pw * 2, 1.2, 0.1),
      );
    }
    // Walkable decks: tier riser + supervisor platform (slabs and ramps).
    addDeckColliders(colliders, GROUP, p);

    const built = b.build({ receiveShadows: true });
    for (const m of built) {
      m.metadata = { ...(m.metadata ?? {}), probe: true };
      m.isPickable = false;
    }
    this.statics.push(...built);

    // ---- Props
    for (const ch of chairs)
      assets.instantiate(
        "taskChair",
        null,
        { position: { x: ch.x, y: ch.y, z: ch.z }, yaw: ch.yaw },
        { group: GROUP },
      );
    for (const sx of [-1, 1]) {
      // Foliage sits IN a planter (base at the soil line), never on the
      // floor: one on each pier by the video wall, one by the neck.
      const pw = SURROUND_HALF + DRUM.pierWall / 2;
      const pn = this.drum.aNeck - DRUM.pierNeck / 2;
      for (const [a, r, yaw] of [
        [sx * pw, roomR - 0.75, sx],
        [sx * pn, roomR - 0.75, -sx],
      ] as const) {
        const q = onArc(cx, cz, r, a);
        assets.instantiate(
          "planterTall",
          null,
          { position: { x: q.x, y: 0, z: q.z }, yaw: 0 },
          { group: GROUP },
        );
        assets.instantiate(
          "plantTall",
          null,
          { position: { x: q.x, y: PLANTER_SOIL_Y.planterTall, z: q.z }, yaw },
          { group: GROUP },
        );
      }
    }
    const camA = this.drum.aNeck - DRUM.pierNeck / 2;
    const cam = onArc(cx, cz, roomR - 0.3, camA);
    assets.instantiate(
      "securityCamera",
      null,
      {
        position: { x: cam.x, y: H - 0.6, z: cam.z },
        yaw: camA + Math.PI / 2,
      },
      { group: GROUP },
    );
  }

  /** Monitor arm (pole + bar + bezels) for one seat; screens come later. */
  private monitorArm(
    b: ArtBatcher,
    ccx: number,
    ccz: number,
    r: number,
    deck: number,
    a: number,
    count: number,
  ): void {
    const rm = r + CONSOLE.depth / 2 - 0.14;
    const da = (CONSOLE.monW + 0.03) / rm;
    const yC = deck + CONSOLE.monBottom + CONSOLE.monH / 2;
    const top = deck + CONSOLE.deskH;
    const pole = onArc(ccx, ccz, rm + 0.1, a);
    b.cylinder(
      "blackMetal",
      v3(pole.x, top + (yC - top) / 2, pole.z),
      yC - top,
      0.045,
      0.05,
      12,
    );
    b.rbox(
      "blackMetal",
      v3(pole.x, top + 0.006, pole.z),
      v3(0.16, 0.012, 0.1),
      { yaw: a, r: 0.004 },
    );
    const span = (count - 1) * da;
    if (count > 1) {
      b.arc(
        "blackMetal",
        v3(ccx, 0, ccz),
        rm + 0.075,
        rm + 0.1,
        a - span / 2,
        a + span / 2,
        yC - 0.018,
        yC + 0.018,
        8 * count,
      );
    }
    for (let i = 0; i < count; i++) {
      const ma = a + (i - (count - 1) / 2) * da;
      const q = onArc(ccx, ccz, rm + 0.018, ma);
      b.rbox(
        "blackMetal",
        v3(q.x, yC, q.z),
        v3(CONSOLE.monW + 0.018, CONSOLE.monH + 0.018, 0.03),
        { yaw: ma, r: 0.005 },
      );
      const k = onArc(ccx, ccz, rm + 0.06, ma);
      b.box("blackMetal", v3(k.x, yC, k.z), v3(0.08, 0.08, 0.05), { yaw: ma });
    }
  }

  private buildMonitors(): { mesh: Mesh; seats: number } {
    const p = this.plan;
    const parts: Mesh[] = [];
    let seat = 0;
    let aux = 0;
    const place = (
      ccx: number,
      ccz: number,
      r: number,
      deck: number,
      a: number,
      count: number,
      supervisor: boolean,
    ) => {
      const rm = r + CONSOLE.depth / 2 - 0.14;
      const da = (CONSOLE.monW + 0.03) / rm;
      const y = deck + CONSOLE.monBottom + CONSOLE.monH / 2;
      const cells: number[] = [];
      if (supervisor) {
        cells.push(
          ...(seat % 2 === 0
            ? [AUX.board, AUX.map]
            : [AUX.usage, AUX.projects]),
        );
        seat += 1;
      } else {
        const card = seat;
        seat += 1;
        if (count >= 3)
          cells.push(AUX_CYCLE[aux++ % 6], card, AUX_CYCLE[aux++ % 6]);
        else if (count === 2) cells.push(card, AUX_CYCLE[aux++ % 6]);
        else cells.push(card);
      }
      cells.forEach((cell, i) => {
        const ma = a + (i - (count - 1) / 2) * da;
        const q = onArc(ccx, ccz, rm - 0.0005, ma);
        const pl = CreatePlane(
          `opsMon_${parts.length}`,
          { width: CONSOLE.monW, height: CONSOLE.monH },
          this.scene,
        );
        const col = cell % ATLAS_COLS;
        const row = Math.floor(cell / ATLAS_COLS);
        const uv = pl.getVerticesData(VertexBuffer.UVKind)!;
        for (let k = 0; k < uv.length; k += 2) {
          uv[k] = (col + uv[k]) / ATLAS_COLS;
          uv[k + 1] = 1 - (row + 1 - uv[k + 1]) / ATLAS_ROWS;
        }
        pl.setVerticesData(VertexBuffer.UVKind, uv);
        pl.position.set(q.x, y, q.z);
        pl.rotation.y = ma;
        const proxy = CreatePlane(
          `opsMonPick_${parts.length}`,
          { width: CONSOLE.monW, height: CONSOLE.monH },
          this.scene,
        );
        proxy.position.copyFrom(pl.position);
        proxy.rotation.y = ma;
        proxy.isVisible = false;
        proxy.isPickable = true;
        proxy.metadata = {
          interact: {
            kind: "ops",
            sessionId: "",
            roomLabel: "Operator console",
          },
        };
        this.monitors.push({ cell, seat: cell < AUX.board ? cell : -1, proxy });
        parts.push(pl);
      });
    };
    for (const row of p.rows)
      for (const s of row.seats)
        place(p.cx, p.cz, row.r, row.deck, s.a, s.monitors, false);
    const operatorSeats = seat;
    if (p.supervisor) {
      seat = 0;
      for (const s of p.supervisor.seats)
        place(
          p.cx,
          p.supervisor.cz,
          p.supervisor.r,
          p.supervisor.deck,
          s.a,
          s.monitors,
          true,
        );
    }
    const mesh = Mesh.MergeMeshes(parts, true, true) as Mesh;
    mesh.name = "opsMonitors";
    mesh.material = this.monMat;
    mesh.isPickable = false;
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    return { mesh, seats: Math.min(operatorSeats, AUX.board) };
  }

  private canvas(
    name: string,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
    wM: number,
    hM: number,
    ppm: number,
    meta: object,
  ): Canvas {
    const p = this.plan;
    const w = Math.min(4096, Math.round((wM * ppm) / 8) * 8);
    const h = Math.round((hM * ppm) / 8) * 8;
    const tex = createScreenTexture(`ops_${name}`, this.scene, w, h);
    // LED wall: a touch brighter than desk monitors (reads against the room).
    tex.level = 1.3;
    const mat = createEmissiveMaterial(`ops_${name}Mat`, this.scene, tex);
    mat.backFaceCulling = false;
    const mesh = arcStrip(
      `wallScreen_ops_${name}`,
      this.scene,
      p.R,
      a0,
      a1,
      y0,
      y1,
      Math.max(8, Math.ceil((a1 - a0) / (Math.PI / 120))),
    );
    mesh.position.set(p.cx, 0, p.cz);
    mesh.material = mat;
    mesh.isPickable = true;
    mesh.metadata = { ...meta, probe: true };
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    return { name, mesh, tex, mat, w, h, keys: new Map() };
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

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
    this.pulseMat.emissiveIntensity = any ? 2.4 * k : 0.8;
  }

  private redraw(forceIn: boolean): void {
    if (this.disposed) return;
    // Language change (opsLocaleRev): every canvas key is stale.
    const rev = opsLocaleRev();
    const force = forceIn || rev !== this.localeRev;
    this.localeRev = rev;
    this.dirty = false;
    this.sinceBuild = 0;
    const now = Date.now();
    const m = buildOpsModel(this.campus, this.stats, now, this.labels);
    this.model = m;
    const clock = wallClock(now);
    this.lastClock = clock;
    const groups = projectGroups(this.campus, this.projects, this.labels);
    const sessions = mapSessions(this.campus);
    const u = PPM_UP / 100;

    // Upper tier: each canvas redraws when any of its panels' keys change.
    const panelKey: Record<UpperPanel, () => string> = {
      board: () => opsKey([m.rows.map(({ spark: _s, ...r }) => r), m.counts]),
      usage: () => {
        const minute = (v: number | null | undefined) =>
          v == null ? null : Math.floor(v / 60_000);
        return opsKey({
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
      },
      activity: () =>
        opsKey([m.activity, m.rows.map((r) => [r.project, r.status, r.spark])]),
      map: () => "",
      projects: () => opsKey(this.projectRows(groups, sessions)),
    };
    const H = this.canvases.C.h;
    const g = (GUTTER_CM * u) / 2;
    let mapLayout: ProjectMapLayout | null = null;
    const mapPanel = this.upper.find((x) => x.key === "map");
    if (mapPanel) {
      mapLayout = layoutProjectMap(
        groups,
        sessions,
        mapPanel.w - 2 * g,
        H - 2 * g,
      );
      this.map = mapLayout;
    }
    for (const name of ["L", "C", "R"] as const) {
      const cv = this.canvases[name];
      const panels = this.upper.filter((x) => x.canvas === name);
      const keys = panels.map((x) =>
        x.key === "map" ? mapKey(mapLayout!) : panelKey[x.key](),
      );
      const key = keys.join("|");
      if (!force && cv.keys.get("all") === key) continue;
      cv.keys.set("all", key);
      const c = cv.tex.getContext() as unknown as Ctx2D;
      c.fillStyle = WALL_BG;
      c.fillRect(0, 0, cv.w, cv.h);
      for (const pn of panels) {
        const x = pn.x + g;
        const w = pn.w - 2 * g;
        const h = cv.h - 2 * g;
        c.save();
        c.beginPath();
        c.rect(x, g, w, h);
        c.clip();
        c.translate(x, g);
        // Type scale per panel: the wall reads from 8-12 m (B = full detail).
        if (pn.key === "board") drawWallBoard(c, w, h, m, u);
        else if (pn.key === "usage") drawUsagePanel(c, w, h, m, u * 1.5);
        else if (pn.key === "activity") drawActivityPanel(c, w, h, m, u * 1.38);
        else if (pn.key === "map" && mapLayout)
          drawProjectMap(c, w, h, mapLayout, u * 1.5);
        else if (pn.key === "projects")
          drawProjectsPanel(
            c,
            w,
            h,
            this.projectRows(groups, sessions),
            !!this.projects?.some((pp) => pp.ciAvailable),
            u * 1.6,
          );
        c.restore();
      }
      const off =
        (this.upper.find((x) => x.canvas === name)!.a0 - this.plan.a0) *
        this.plan.R;
      drawTileSeams(
        c,
        cv.w,
        cv.h,
        TILE_M * PPM_UP,
        TILE_M * PPM_UP,
        off * PPM_UP,
      );
      cv.tex.update(true);
    }

    this.syncFeeds(m); // before drawLower: captions / KPI fill follow the rooms
    this.drawLower(m, clock, force);
    this.drawMonitors(m, groups, sessions, force);
  }

  private projectRows(
    groups: MapGroup[],
    sessions: ReturnType<typeof mapSessions>,
  ): ProjectsPanelRow[] {
    const byId = new Map((this.projects ?? []).map((pp) => [pp.id, pp]));
    return groups.map((gr) => {
      const pr = byId.get(gr.id);
      const pipe = pr?.pipelines?.[0];
      return {
        group: gr,
        color: lineColor(gr.id),
        statuses: gr.sessionIds
          .map((id) => sessions.get(id)?.status)
          .filter((s): s is NonNullable<typeof s> => !!s),
        pipeline: pipe ? { workflow: pipe.workflow, state: pipe.state } : null,
        prs: (pr?.pullRequests ?? [])
          .filter((x) => x.state === "open")
          .slice(0, 1)
          .map((x) => ({
            number: x.number,
            title: x.title,
            state: x.checks?.state ?? "none",
          })),
      };
    });
  }

  /**
   * Lower tier in one virtual strip (whole arc), split over two canvases:
   * centre = alerts + event log (under the board); each side = one camera
   * feed per project room (packed from the centre out), the rest KPI tiles.
   */
  private drawLower(m: OpsModel, clock: string, force: boolean): void {
    const p = this.plan;
    const L = this.canvases.lowL;
    const Rt = this.canvases.lowR;
    const total = L.w + Rt.w;
    const H = L.h;
    const u = PPM_LOW / 100;
    const ax = (a: number) => ((a - p.a0) / (p.a1 - p.a0)) * total;
    const ay = (y: number) =>
      ((WALL_Y.lower1 - y) / (WALL_Y.lower1 - WALL_Y.lower0)) * H;
    const feeds = this.feedSlots
      .filter((f) => f.room)
      .map((f) => {
        const row = f.sessionId
          ? m.rows.find((r) => r.sessionId === f.sessionId)
          : undefined;
        const n = m.rows.filter(
          (r) =>
            f.room!.sessionIds.includes(r.sessionId) && r.status !== "ended",
        ).length;
        return {
          f,
          s: {
            label: f.room!.name,
            status: row?.status ?? ("ended" as const),
            phase: row
              ? `${row.phaseLabel}${n > 1 ? ` · ${n} sessions` : ""}`
              : null,
          },
        };
      });
    const tiles = lowerTiles(m);
    const leftTiles = tiles.left;
    const rightTiles = tiles.right;
    const key = lowerWallKey(
      m,
      clock,
      feeds.map((x) => ({
        side: x.f.cell.side,
        index: x.f.cell.index,
        label: x.s.label,
        status: x.s.status,
        phase: x.s.phase,
      })),
      tiles,
    );
    const [c0, c1] = this.lowerCenter;
    const gap = 0.1 / p.R;
    const draw = (cv: Canvas, off: number) => {
      if (!force && cv.keys.get("all") === key) return;
      cv.keys.set("all", key);
      const c = cv.tex.getContext() as unknown as Ctx2D;
      c.save();
      c.fillStyle = WALL_BG;
      c.fillRect(0, 0, cv.w, cv.h);
      c.translate(-off, 0);
      const box = (xa: number, xb: number, fn: (w: number) => void) => {
        if (xb - xa < 8 * u) return;
        c.save();
        c.beginPath();
        c.rect(xa, 0, xb - xa, H);
        c.clip();
        c.translate(xa, 0);
        fn(xb - xa);
        c.restore();
      };
      // Centre: alert strip + event log.
      const x0 = ax(c0) + 0.6 * u;
      const x1 = ax(c1) - 0.6 * u;
      const alertH = 0.3 * PPM_LOW;
      c.save();
      c.translate(x0, 0.6 * u);
      drawAlertStrip(c, x1 - x0, alertH, m, clock);
      c.restore();
      c.save();
      c.beginPath();
      c.rect(x0, alertH + 1.4 * u, x1 - x0, H - alertH - 2 * u);
      c.clip();
      c.translate(x0, alertH + 1.4 * u);
      drawEventLog(c, x1 - x0, H - alertH - 2 * u, m, u * 1.45);
      c.restore();
      // Feeds: captions + frames (the feed meshes cover the image wells).
      let cam = 1;
      for (const { f, s } of feeds) {
        const fx = ax(f.cell.a0);
        const fw = ax(f.cell.a1) - fx;
        const iy = ay(f.cell.y1);
        const ih = ay(f.cell.y0) - iy;
        drawFeedCaption(c, fx, iy, fw, ih, H - (iy + ih), s, cam++, u * 1.3);
      }
      // KPI tiles fill whatever the feeds leave free on each side.
      const west = feeds.filter((x) => x.f.cell.side === "west");
      const east = feeds.filter((x) => x.f.cell.side === "east");
      const wEnd = west.length
        ? Math.min(...west.map((x) => x.f.cell.a0)) - gap
        : c0 - gap;
      const eStart = east.length
        ? Math.max(...east.map((x) => x.f.cell.a1)) + gap
        : c1 + gap;
      box(ax(p.a0) + 0.6 * u, ax(wEnd), (w) =>
        drawKpiTiles(c, w, H, leftTiles, u),
      );
      box(ax(eStart), ax(p.a1) - 0.6 * u, (w) =>
        drawKpiTiles(c, w, H, rightTiles, u),
      );
      c.restore();
      const offM = off / PPM_LOW;
      drawTileSeams(c, cv.w, cv.h, TILE_M * PPM_LOW, cv.h / 2, offM * PPM_LOW);
      cv.tex.update(true);
    };
    draw(L, 0);
    draw(Rt, L.w);
  }

  /** Centre monitors: one session per operator seat; side monitors: wall minis. */
  private drawMonitors(
    m: OpsModel,
    groups: MapGroup[],
    sessions: ReturnType<typeof mapSessions>,
    force: boolean,
  ): void {
    const live = m.rows.filter((r) => r.status !== "ended");
    const n = this.seatCount;
    const picks: Array<OpsRow | null> = [];
    for (let i = 0; i < n; i++) {
      if (live.length === 0) picks.push(null);
      else if (live.length <= n) picks.push(live[i] ?? null);
      else picks.push(live[(this.rotate * n + i) % live.length]);
    }
    for (const mo of this.monitors) {
      const r = mo.seat >= 0 ? picks[mo.seat] : null;
      mo.proxy.metadata = {
        interact: {
          kind: "ops",
          sessionId: r?.sessionId ?? "",
          roomLabel: r?.project ?? "Operator console",
        },
      };
    }
    const byId = new Map(this.campus.map((c) => [c.sessionId, c]));
    const ctx = this.monTex.getContext() as unknown as Ctx2D;
    let changed = false;
    const cell = (
      i: number,
      key: string,
      fn: (w: number, h: number) => void,
    ) => {
      if (!force && key === this.cellKeys[i]) return;
      this.cellKeys[i] = key;
      changed = true;
      const x = (i % ATLAS_COLS) * CELL_W;
      const y = Math.floor(i / ATLAS_COLS) * CELL_H;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, CELL_W, CELL_H);
      ctx.clip();
      ctx.translate(x, y);
      fn(CELL_W, CELL_H);
      ctx.restore();
    };
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
      // Empty seat: a null row (sparklines animate; they stay out of the key).
      const rk = r ? rowSansSpark(r) : null;
      cell(i, opsKey([rk, extra]), (w, h) =>
        drawSessionCard(ctx, 0, 0, w, h, r, extra),
      );
    });
    const boardKey = opsKey([m.rows.map(({ spark: _s, ...r }) => r), m.counts]);
    cell(AUX.board, boardKey, (w, h) =>
      drawSessionsBoard(ctx, w, h, m, h / 100),
    );
    cell(
      AUX.usage,
      opsKey([
        m.usage.fiveHour?.usedPct,
        m.usage.sevenDay?.usedPct,
        m.usage.costTodayUsd,
        m.usage.burnUsdPerHour,
        m.usage.costSeries.length,
      ]),
      (w, h) => drawUsagePanel(ctx, w, h, m, h / 112),
    );
    cell(
      AUX.activity,
      opsKey([m.activity.eventsPerMin, m.activity.toolMix]),
      (w, h) => {
        // Laid out at wall proportions, scaled into the cell.
        const s = h / 520;
        ctx.scale(s, s);
        drawActivityPanel(ctx, w / s, 520, m, 4);
      },
    );
    cell(AUX.log, opsKey(m.ticker.slice(0, 8).map((t) => t.key)), (w, h) =>
      drawEventLog(ctx, w, h, m, h / 62),
    );
    const mini = layoutProjectMap(groups, sessions, CELL_W, CELL_H, {
      maxLines: 5,
      maxNodes: 5,
    });
    cell(AUX.map, mapKey(mini), (w, h) =>
      drawProjectMap(ctx, w, h, mini, h / 70),
    );
    const rows = this.projectRows(groups, sessions);
    cell(AUX.projects, opsKey(rows), (w, h) =>
      drawProjectsPanel(
        ctx,
        w,
        h,
        rows,
        !!this.projects?.some((pp) => pp.ciAvailable),
        h / 95,
      ),
    );
    if (changed) this.monTex.update(true);
  }

  // -------------------------------------------------------------------------
  // Feeds + dots
  // -------------------------------------------------------------------------

  private syncFeeds(m: OpsModel): void {
    const rank = new Map(m.rows.map((r, i) => [r.sessionId, i]));
    // Rooms with live work first within a side would reshuffle cameras; keep
    // bay order (stable), each feed entering its most urgent session.
    const urgent = (room: FeedRoom) =>
      [...room.sessionIds]
        .filter((id) => rank.has(id))
        .sort((a, b) => rank.get(a)! - rank.get(b)!)[0] ?? null;
    const west = this.rooms.filter((r) => r.west);
    const east = this.rooms.filter((r) => !r.west);
    const key = opsKey([west, east, this.rooms.map(urgent)]);
    if (key === this.feedKey) return;
    this.feedKey = key;
    for (const f of this.feedSlots) {
      const list = f.cell.side === "west" ? west : east;
      f.room = list[f.cell.index] ?? null;
      f.sessionId = f.room ? urgent(f.room) : null;
      f.mesh.setEnabled(!this.far && !!f.room);
      f.mesh.isPickable = !!f.sessionId;
      f.mesh.metadata = f.sessionId
        ? {
            interact: {
              kind: "screen",
              sessionId: f.sessionId,
              roomLabel: f.room?.name ?? "",
            },
            interactRange: WALL_INTERACT_RANGE,
            // Curved strip: a frame fitted to its AABB would be a deep slab.
            noFocusFrame: true,
          }
        : null;
    }
    this.bindFeeds();
    this.dirty = true;
  }

  private bindFeeds(): void {
    for (const f of this.feedSlots) {
      const tex = f.room ? this.ctx.feeds.getTexture(f.room.id) : null;
      if (f.mat.emissiveTexture !== tex) {
        f.mat.emissiveTexture = tex;
        f.mat.emissiveColor = tex
          ? Color3.Black()
          : new Color3(0.012, 0.014, 0.02);
      }
    }
  }

  private moveDots(): void {
    const map = this.map;
    const panel = this.upper.find((x) => x.key === "map");
    if (!map || !panel || this.far || !this.near) {
      this.dots.thinInstanceCount = 0;
      return;
    }
    const p = this.plan;
    const cv = this.canvases[panel.canvas];
    const g = (GUTTER_CM * (PPM_UP / 100)) / 2;
    const n = map.dots.length;
    if (n > this.dotCap) {
      this.dotCap = n;
      this.dotBuf = new Float32Array(16 * n);
      this.dotCol = new Float32Array(4 * n);
      this.dots.thinInstanceSetBuffer("matrix", this.dotBuf, 16, false);
      this.dots.thinInstanceSetBuffer("color", this.dotCol, 4, false);
      this.dotColorsOf = null;
    }
    const t = performance.now() / 1000;
    const span = panel.a1 - panel.a0;
    const yTop = WALL_Y.upper1;
    const yH = WALL_Y.upper1 - WALL_Y.upper0;
    const tmp = this.dotTmp;
    const pos = this.dotPos;
    const q = this.dotQ;
    // Colours only change with the map layout (new object on redraw).
    const recolor = map !== this.dotColorsOf;
    this.dotColorsOf = map;
    for (let i = 0; i < n; i++) {
      const d = map.dots[i];
      const pt = dotPosition(d, t);
      const a = panel.a0 + ((pt.x + g) / panel.w) * span;
      const y = yTop - ((pt.y + g) / cv.h) * yH;
      const r = p.R - 0.012;
      pos.set(p.cx + Math.sin(a) * r, y, p.cz + Math.cos(a) * r);
      Quaternion.RotationYawPitchRollToRef(a, 0, 0, q);
      Matrix.ComposeToRef(this.dotScale, q, pos, tmp);
      tmp.copyToArray(this.dotBuf, i * 16);
      if (!recolor) continue;
      const col = Color3.FromHexString(d.color);
      this.dotCol[i * 4] = Math.min(1, col.r * 1.25 + 0.15);
      this.dotCol[i * 4 + 1] = Math.min(1, col.g * 1.25 + 0.15);
      this.dotCol[i * 4 + 2] = Math.min(1, col.b * 1.25 + 0.15);
      this.dotCol[i * 4 + 3] = 1;
    }
    this.dots.thinInstanceCount = n;
    this.dots.thinInstanceBufferUpdated("matrix");
    if (recolor) this.dots.thinInstanceBufferUpdated("color");
  }

  /** Scratch for moveDots (no per-frame allocation). */
  private readonly dotTmp = new Matrix();
  private readonly dotScale = new Vector3(1, 1, 1);
  private readonly dotPos = new Vector3();
  private readonly dotQ = new Quaternion();
  private dotColorsOf: ProjectMapLayout | null = null;
}

/** Row content without its sparkline (redraw-key ingredient). */
function rowSansSpark(r: OpsRow): Omit<OpsRow, "spark"> {
  const { spark: _s, ...rest } = r;
  return rest;
}

function rankTodo(s: string): number {
  return s === "in_progress" ? 0 : s === "pending" ? 1 : 2;
}
