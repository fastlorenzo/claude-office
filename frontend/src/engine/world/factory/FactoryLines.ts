/**
 * FactoryLines — the production lines of the software factory (P2.5 + P3.1
 * hookup): campus projects → `FactoryModel` → the machine pools.
 *
 *   feed(projects, campus)  World.sync seam: builds the model (FactorySync,
 *                           `prev` for lane stability) and pushes it through
 *                           `Factory.sync` only when `factoryKey` changed
 *   sync(model)             stations / cells / belt speeds / dock data / the
 *                           per-line FactoryMotion targets
 *   update(dt, eye)         only while some part of the factory is visible:
 *                           FactoryMotion.step → workpiece poses (written only
 *                           when a piece moved), belts, arms, beacons, gates,
 *                           truck
 *   setVisibility(v)        culling: whole pools off when nothing is visible;
 *                           per-cell detail to the cell dressing + arm LOD
 *
 * Pools are created lazily, the first time any part of the factory becomes
 * visible, so a player who stays upstairs never pays for them. Interaction:
 * F on a workpiece / station / lane belt / trunk / main line / dock resolves
 * through thin-instance resolvers (lane plates + boards come from `Cells`).
 */
import { BoundingInfo, Vector3, type Scene } from "@/engine/babylon";
import { framedSink, type Colliders } from "@/engine/physics/Colliders";
import type {
  BrandingOptions,
  BuildingLayout,
  CampusProject,
  CampusSession,
  InteractionTarget,
  PipelineRun,
  ReleaseInfo,
} from "@/engine/contracts";
import type { Lighting } from "@/engine/fx/Lighting";
import {
  factoryTarget,
  registerThinResolver,
  tagFactoryMesh,
} from "@/engine/interaction/factoryTargets";
import type { FactoryLayout } from "@/engine/layout/factoryLayout";
import { FactoryMotion, type MotionPhase } from "@/engine/logic/factoryMotion";
import type {
  FactoryModel,
  LineModel,
  Workpiece,
} from "@/engine/logic/factoryModel";
import type { FactoryVisibility } from "@/engine/world/factoryVisibility";
import { Cells } from "./Cell";
import { Conveyors } from "./Conveyors";
import { DOCK, Dock, addDockColliders } from "./Dock";
import type { Factory, FactoryPart } from "./Factory";
import { FactorySync, type FactorySyncStats } from "./factorySync";
import {
  conveyorPaths,
  laneOccupant,
  LINE,
  lineCtx,
  MAIN_PATH_ID,
  lanePathId,
  pieceLook,
  placeMotion,
  stationRows,
  trunkPathId,
  waitSlots,
  type LineCtx,
  type StationMeta,
} from "./lineAdapter";
import { orderStations, type StationInstance } from "./stationPlan";
import { Stations } from "./Stations";
import { Workpieces } from "./Workpieces";
import type { PieceInstance } from "./workpiecePlacement";

export interface FactoryLinesContext {
  scene: Scene;
  lighting: Lighting;
  /** Static collider registry (absent in headless tests). */
  colliders?: Colliders;
}

export interface FactoryLinesOptions {
  /** Demo data instead of the feed (world-debug `?demoFactory=1`). */
  demo?: boolean;
  branding?: BrandingOptions | null;
}

export interface FactoryLinesStats {
  built: boolean;
  visible: boolean;
  sync: FactorySyncStats;
  /** Pieces currently tracked by the motion layer. */
  pieces: number;
  /** Workpiece pool updates (frames where a piece moved). */
  pieceUpdates: number;
  /** Animation CPU (motion + pools), EMA in ms per visible frame. */
  animMs: number;
  /** Draw calls of the factory machine pools (+ dock + truck). */
  draws: number;
  bufferWrites: {
    conveyors: number;
    stations: number;
    workpieces: number;
    cells: number;
  };
  truck: string;
}

/** Truck back at the bay this long after a departure (s). */
const TRUCK_TURNAROUND_S = 30;
const PHASES: readonly MotionPhase[] = [
  "rack",
  "queued",
  "holding",
  "entering",
  "lane",
  "rework",
  "rework-wait",
  "returning",
  "gate",
  "trunk",
  "main",
  "qc",
  "dock",
  "shipped",
  "scrapping",
  "scrapped",
];
const PHASE_ID = new Map(PHASES.map((p, i) => [p, i]));

const DOCK_GROUP = "factoryDock";

export class FactoryLines implements FactoryPart {
  readonly feedSync = new FactorySync();
  private conveyors: Conveyors | null = null;
  private stations: Stations | null = null;
  private workpieces: Workpieces | null = null;
  private cells: Cells | null = null;
  private dock: Dock | null = null;

  private layout: FactoryLayout | null = null;
  private model: FactoryModel | null = null;
  private models = new Map<string, LineModel>();
  private ctxs = new Map<string, LineCtx>();
  private readonly motions = new Map<string, FactoryMotion>();
  /** Last known workpiece per id (pieces playing out a merge keep their look). */
  private readonly looks = new Map<string, { w: Workpiece; line: string }>();
  private stationOrder: StationInstance[] = [];
  private stationMeta = new Map<string, StationMeta>();
  private vis: FactoryVisibility | null = null;
  private visible = false;
  private piecesDirty = true;
  private frameSig = NaN;
  private pieceUpdates = 0;
  private animMs = 0;
  private projects: readonly CampusProject[] = [];
  private dockKey = "";
  private dockProject: string | null = null;
  private newestRelease: string | null = null;
  private truckT = -1;
  private branding: BrandingOptions | null;
  private disposed = false;
  private readonly detach: () => void;

  constructor(
    private readonly factory: Factory,
    private readonly ctx: FactoryLinesContext,
    private readonly opts: FactoryLinesOptions = {},
  ) {
    this.branding = opts.branding ?? null;
    this.detach = factory.attach(this);
  }

  // -------------------------------------------------------------------------
  // World seam
  // -------------------------------------------------------------------------

  /**
   * Build the model from the feed (or demo data) and push it to the pools
   * when anything visible changed. Returns true when a model was pushed.
   */
  feed(
    projects: readonly CampusProject[] | null | undefined,
    campus: readonly CampusSession[],
    nowMs = Date.now(),
  ): boolean {
    const layout = this.layout ?? this.factory.currentLayout;
    const cells = layout?.cells ?? [];
    const lanes = new Map(cells.map((c) => [c.projectId, c.lanes.length]));
    const res = this.feedSync.update({
      projects,
      campus,
      nowMs,
      lanesFor: (id) => lanes.get(id) ?? 0,
      cellIds: cells.map((c) => c.projectId),
      demo: this.opts.demo,
    });
    this.projects = res.projects;
    if (!res.model) return false;
    this.factory.sync(res.model);
    return true;
  }

  setBranding(b: BrandingOptions): void {
    this.branding = b;
    this.dock?.setBranding(b);
  }

  stats(): FactoryLinesStats {
    const c = this.conveyors?.stats();
    const s = this.stations?.stats();
    const w = this.workpieces?.stats();
    const k = this.cells?.stats();
    const dockOn = !!this.dock?.root.isEnabled();
    let pieces = 0;
    for (const m of this.motions.values()) pieces += m.size;
    return {
      built: !!this.conveyors,
      visible: this.visible,
      sync: { ...this.feedSync.stats },
      pieces,
      pieceUpdates: this.pieceUpdates,
      animMs: Math.round(this.animMs * 1000) / 1000,
      draws: this.visible
        ? (c?.draws ?? 0) +
          (s?.draws ?? 0) +
          (w?.draws ?? 0) +
          (k?.draws ?? 0) +
          (dockOn ? DOCK.draws + 2 : 0)
        : 0,
      bufferWrites: {
        conveyors: c?.bufferWrites ?? 0,
        stations: s?.bufferWrites ?? 0,
        workpieces: w?.bufferWrites ?? 0,
        cells: k?.bufferWrites ?? 0,
      },
      truck: this.truckT < 0 ? "parked" : `away ${Math.round(this.truckT)}s`,
    };
  }

  // -------------------------------------------------------------------------
  // FactoryPart
  // -------------------------------------------------------------------------

  setLayout(layout: FactoryLayout, _building: BuildingLayout): void {
    void _building;
    this.layout = layout;
    this.rebuildContexts();
    if (!this.conveyors) return;
    this.conveyors.setPaths(conveyorPaths(layout));
    this.placeDock();
    this.applyPickBounds();
    this.applyModel();
  }

  sync(model: FactoryModel): void {
    this.model = model;
    this.models = new Map(model.lines.map((l) => [l.projectId, l]));
    const now = Date.now();
    for (const l of model.lines) {
      let m = this.motions.get(l.projectId);
      if (!m) {
        m = new FactoryMotion();
        this.motions.set(l.projectId, m);
      }
      m.setModel(l, now);
      for (const w of l.workpieces)
        this.looks.set(w.id, { w, line: l.projectId });
    }
    for (const id of [...this.motions.keys()])
      if (!this.models.has(id)) this.motions.delete(id);
    this.rebuildContexts();
    this.piecesDirty = true;
    if (this.conveyors) this.applyModel();
  }

  setVisibility(v: FactoryVisibility): void {
    this.vis = v;
    let any = v.mainLine !== "hidden" || v.dock !== "hidden";
    for (const d of v.cells.values()) if (d !== "hidden") any = true;
    if (any && !this.conveyors) this.build();
    this.visible = any;
    if (!this.conveyors) return;
    this.conveyors.setVisible(any);
    this.stations?.setVisible(any);
    this.cells?.setVisible(any);
    for (const [id, d] of v.cells) this.cells?.setVisibility(id, d);
    this.dock?.root.setEnabled(v.dock !== "hidden");
    // Arms in `full` cells always animate; others only within the LOD radius.
    const full = new Set<string>();
    for (const s of this.stationOrder) {
      const meta = this.stationMeta.get(s.id);
      if (meta && v.cells.get(meta.projectId) === "full") full.add(s.id);
    }
    this.stations?.setFullStations(full);
    this.setPiecesVisible(any);
  }

  update(dt: number, eye: Vector3): void {
    if (!this.visible || !this.conveyors || this.disposed) return;
    const t0 = performance.now();
    this.stepPieces(dt);
    this.stations?.setViewer(eye.x, eye.y, eye.z);
    this.stations?.update(dt);
    this.conveyors.update(dt);
    this.cells?.update(dt);
    this.updateTruck(dt);
    const ms = performance.now() - t0;
    this.animMs = this.animMs ? this.animMs * 0.95 + ms * 0.05 : ms;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.workpieces?.setPicker(null);
    this.conveyors?.dispose();
    this.stations?.dispose();
    this.workpieces?.dispose();
    this.cells?.dispose();
    this.dock?.dispose();
    this.ctx.colliders?.disposeGroup(DOCK_GROUP);
    this.motions.clear();
  }

  // -------------------------------------------------------------------------
  // Build (lazy)
  // -------------------------------------------------------------------------

  private build(): void {
    const scene = this.ctx.scene;
    this.conveyors = new Conveyors(scene);
    this.conveyors.setSpeed(0);
    this.stations = new Stations(scene);
    this.workpieces = new Workpieces(scene);
    this.cells = new Cells(scene);
    const belt = this.conveyors.meshes()[0];
    registerThinResolver(belt, (_m, i) => this.beltTarget(i), { range: 4 });
    this.stations.meshes().forEach((mesh, p) => {
      const glyph = p === this.stations!.meshes().length - 1;
      registerThinResolver(mesh, (_m, i) =>
        this.stationTarget(glyph ? i >> 1 : i),
      );
    });
    if (this.layout) {
      this.conveyors.setPaths(conveyorPaths(this.layout));
      this.placeDock();
    }
    this.applyPickBounds();
    this.applyModel();
    // Daylight (static) shadows only: the belts, station housings and cell
    // furniture never move; no cascade casters (draw budget).
    this.ctx.lighting.addStaticCasters([
      ...this.conveyors.meshes(),
      this.stations.casterMeshes()[0],
      ...this.cells.casterMeshes(),
    ]);
  }

  /**
   * The pools keep their base geometry's bounds (no per-frame sync) and
   * Babylon tests the mesh bounds before any thin instance: give every
   * pickable pool the factory floor's box so F reaches its instances.
   */
  private applyPickBounds(): void {
    const fl = this.layout;
    if (!fl || !this.workpieces) return;
    const min = new Vector3(fl.bounds.min.x, fl.floorY - 1, fl.bounds.min.z);
    const max = new Vector3(fl.bounds.max.x, fl.floorY + 9, fl.bounds.max.z);
    this.workpieces.setPicker((id) => this.pieceTarget(id), { min, max });
    const meshes = [
      this.conveyors?.meshes()[0],
      ...(this.stations?.meshes() ?? []),
      ...(this.cells?.meshes() ?? []),
    ];
    for (const m of meshes) m?.setBoundingInfo(new BoundingInfo(min, max));
  }

  private placeDock(): void {
    const fl = this.layout;
    if (!fl) return;
    const want = { x: 0, y: fl.floorY, z: fl.dock.z1 };
    if (!this.dock) {
      this.dock = new Dock(this.ctx.scene, {
        ...want,
        yaw: 0,
        ...(this.branding ? { branding: this.branding } : {}),
      });
      this.tagDock();
      this.dockKey = "";
      this.applyDock();
    } else this.dock.root.position.set(want.x, want.y, want.z);
    this.placeDockColliders(want);
  }

  /** Platform slab, door wall, side walls and the stair ramp (static). */
  private placeDockColliders(at: { x: number; y: number; z: number }): void {
    const cols = this.ctx.colliders;
    if (!cols) return;
    cols.disposeGroup(DOCK_GROUP);
    addDockColliders(
      framedSink(cols, new Vector3(at.x, at.y, at.z), 0),
      DOCK_GROUP,
    );
  }

  private rebuildContexts(): void {
    this.ctxs.clear();
    if (!this.layout) return;
    for (const c of this.layout.cells)
      this.ctxs.set(
        c.projectId,
        lineCtx(this.layout, c, this.models.get(c.projectId) ?? null),
      );
  }

  // -------------------------------------------------------------------------
  // Model → static pools
  // -------------------------------------------------------------------------

  private applyModel(): void {
    const fl = this.layout;
    if (!fl || !this.stations || !this.cells || !this.conveyors) return;
    const { list, meta } = stationRows(fl, this.models);
    this.stationMeta = meta;
    this.stations.setStations(list);
    this.stationOrder = orderStations(list).order;
    this.cells.setCells(fl.cells, this.models);
    if (this.vis) this.setVisibility(this.vis);
    // Belts run while their lane's checks run; trunk / main while merging.
    let mainBusy = false;
    for (const c of fl.cells) {
      const m = this.models.get(c.projectId);
      c.lanes.forEach((l) =>
        this.conveyors!.setLaneSpeed(
          lanePathId(c.projectId, l.index),
          m?.laneBusy[l.index] ? LINE.LANE_MPS : 0,
        ),
      );
      const trunk = !!m?.trunk.running;
      mainBusy ||= trunk;
      this.conveyors.setLaneSpeed(
        trunkPathId(c.projectId),
        trunk ? LINE.TRUNK_MPS : 0,
      );
    }
    this.conveyors.setLaneSpeed(MAIN_PATH_ID, mainBusy ? LINE.TRUNK_MPS : 0);
    this.applyDock();
  }

  private applyDock(): void {
    const dock = this.dock;
    if (!dock) return;
    const releases: ReleaseInfo[] = [];
    const pipes: PipelineRun[] = [];
    let best: { id: string; at: number } | null = null;
    for (const p of this.projects) {
      for (const r of p.releases ?? []) {
        releases.push(r);
        const at = Date.parse(r.publishedAt ?? "") || 0;
        if (!best || at > best.at) best = { id: p.id, at };
      }
      for (const run of p.pipelines ?? [])
        if (run.kind === "deploy" || run.kind === "release") pipes.push(run);
    }
    const key = JSON.stringify([
      releases.map((r) => [r.tag, r.publishedAt]),
      pipes.map((r) => [r.id, r.state]),
    ]);
    this.dockProject = best?.id ?? this.projects[0]?.id ?? null;
    if (key === this.dockKey) return;
    this.dockKey = key;
    dock.setReleases(releases);
    dock.setDeploys(pipes);
    dock.setNow(Date.now());
    // A new newest release ships: the truck leaves (not on the first load).
    const newest = [...releases].sort(
      (a, b) =>
        (Date.parse(b.publishedAt ?? "") || 0) -
        (Date.parse(a.publishedAt ?? "") || 0),
    )[0]?.tag;
    if (newest && this.newestRelease && newest !== this.newestRelease)
      this.departTruck();
    if (newest) this.newestRelease = newest;
  }

  private departTruck(): void {
    if (!this.dock || this.truckT >= 0) return;
    this.dock.departTruck();
    this.truckT = 0;
  }

  private updateTruck(dt: number): void {
    this.dock?.update(dt);
    if (this.truckT < 0) return;
    this.truckT += dt;
    if (this.truckT >= TRUCK_TURNAROUND_S) {
      this.truckT = -1;
      this.dock?.resetTruck();
    }
  }

  // -------------------------------------------------------------------------
  // Motion → workpieces
  // -------------------------------------------------------------------------

  private setPiecesVisible(on: boolean): void {
    if (!this.workpieces) return;
    if (!on) {
      this.workpieces.set([]);
      this.frameSig = NaN;
    } else this.piecesDirty = true;
  }

  private stepPieces(dt: number): void {
    const wp = this.workpieces;
    if (!wp) return;
    const dtMs = dt * 1000;
    const frames: [string, ReturnType<FactoryMotion["step"]>][] = [];
    let sig = 0;
    let n = 0;
    for (const [id, m] of this.motions) {
      const f = m.step(dtMs);
      frames.push([id, f]);
      for (const e of f.events) if (e.type === "shipped") this.departTruck();
      for (const p of f.pieces) {
        n++;
        sig +=
          n *
          (Math.round(p.t * 2000) +
            Math.round((p.queueSlot ?? 0) * 100) * 7 +
            (PHASE_ID.get(p.phase) ?? 0) * 131 +
            (p.laneIndex ?? 0) * 17);
      }
    }
    sig = sig * 31 + n;
    if (!this.piecesDirty && sig === this.frameSig) return;
    this.piecesDirty = false;
    this.frameSig = sig;
    const out: PieceInstance[] = [];
    for (const [lineId, f] of frames) {
      const ctx = this.ctxs.get(lineId);
      if (!ctx) continue;
      const slots = waitSlots(f.pieces);
      for (const pm of f.pieces) {
        const look = this.looks.get(pm.id);
        if (!look) continue;
        const placed = placeMotion(ctx, pm, slots);
        if (!placed) continue;
        out.push({
          id: pm.id,
          t: 0,
          lanePath: () => placed,
          ...pieceLook(look.w),
        });
      }
    }
    // Forget looks of pieces that left both the model and the motion.
    if (this.looks.size > out.length * 2 + 64) {
      const live = new Set(out.map((p) => p.id));
      for (const id of [...this.looks.keys()])
        if (!live.has(id)) this.looks.delete(id);
    }
    wp.set(out);
    this.pieceUpdates++;
  }

  // -------------------------------------------------------------------------
  // Interaction targets
  // -------------------------------------------------------------------------

  private pieceTarget(id: string): InteractionTarget | null {
    const look = this.looks.get(id);
    if (!look) return null;
    const w = look.w;
    return factoryTarget("workpiece", {
      projectId: look.line,
      label: w.tag,
      ...(w.prNumber !== undefined ? { prNumber: w.prNumber } : {}),
      ...(w.lane !== null ? { lane: w.lane } : {}),
      sessionId: w.sessionId,
      url: w.url,
    });
  }

  private stationTarget(i: number): InteractionTarget | null {
    const st = this.stationOrder[i];
    const meta = st ? this.stationMeta.get(st.id) : undefined;
    if (!meta) return null;
    const p = meta.piece;
    return factoryTarget("station", {
      projectId: meta.projectId,
      label: meta.checkName,
      checkName: meta.checkName,
      lane: meta.lane,
      ...(p?.prNumber !== undefined ? { prNumber: p.prNumber } : {}),
      sessionId: p?.sessionId ?? null,
      url: p?.url ?? null,
    });
  }

  private beltTarget(i: number): InteractionTarget | null {
    const seg = this.conveyors?.segments;
    const r = seg?.beltRanges.find((b) => i >= b.start && i < b.end);
    if (!r) return null;
    if (r.id === MAIN_PATH_ID) {
      const pid = this.dockProject ?? this.model?.lines[0]?.projectId;
      return pid
        ? factoryTarget("mainLine", { projectId: pid, label: "Main line" })
        : null;
    }
    const m = /^(.*):(lane(\d+)|trunk)$/.exec(r.id);
    if (!m) return null;
    const projectId = m[1];
    const line = this.models.get(projectId);
    const name = line?.name ?? projectId;
    if (m[2] === "trunk")
      return factoryTarget("trunk", { projectId, label: `${name} · trunk` });
    const lane = Number(m[3]);
    const p = line ? laneOccupant(line, lane) : null;
    return factoryTarget("lanePlate", {
      projectId,
      label: p ? p.tag : `${name} · lane ${lane + 1}`,
      lane,
      ...(p?.prNumber !== undefined ? { prNumber: p.prNumber } : {}),
      sessionId: p?.sessionId ?? null,
      url: p?.url ?? null,
    });
  }

  /** Dock meshes open the Deploy panel of the project that shipped last. */
  private tagDock(): void {
    const dock = this.dock;
    if (!dock) return;
    const target = (): InteractionTarget => {
      const pid = this.dockProject ?? this.model?.lines[0]?.projectId ?? "";
      const name = this.models.get(pid)?.name ?? pid;
      return factoryTarget("dock", {
        projectId: pid,
        label: name ? `Dock · ${name}` : "Dock",
      });
    };
    // A live getter so the tag follows the project without re-tagging.
    const meshes = [
      ...dock.meshes,
      ...(dock.truck?.root.getChildMeshes() ?? []),
    ];
    for (const mesh of meshes) {
      tagFactoryMesh(mesh, target(), { range: 8, noFocusFrame: true });
      const md = mesh.metadata as { interact?: InteractionTarget };
      Object.defineProperty(md, "interact", {
        get: target,
        configurable: true,
        enumerable: true,
      });
    }
  }
}
