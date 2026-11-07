/**
 * Cells — per-project production-cell dressing for the software factory.
 *
 *   furniture  ONE thin-instanced pool shared by every cell: QA desks, merge
 *              gates (barrier arm coloured by mergeable / review state), rework
 *              loop markers, intake + holding racks, scrap bins, the technician
 *              workbench, floor-mounted lane number plates and safety bollards.
 *              4 draws in total (box / cyl / glow / plate), see `cellPlan.ts`.
 *   board      one `LedPanel` per cell on its board pose showing
 *              `LineModel.header` + lanes in use / max + queue; redrawn only
 *              when the text changes; tagged as a `lineBoard` target.
 *
 * API: `setCells(cells, models)` (rebuilds only when a key changes),
 * `update(dt)`, `setVisibility(projectId, "full" | "impostor" | "hidden")`,
 * `dispose()`. Lane plates are `lanePlate` targets through a thin resolver.
 * Budget: pool <= 4 draws + 1 per cell (the board).
 */
import {
  Color3,
  CreateBoxVertexData,
  CreateCylinderVertexData,
  Mesh,
  PBRMaterial,
  Scene,
  VertexData,
} from "@/engine/babylon";
import type { CellLayout } from "@/engine/layout/factoryLayout";
import type { LineModel } from "@/engine/logic/factoryModel";
import {
  factoryTarget,
  registerThinResolver,
  tagFactoryMesh,
  unregisterThinResolver,
} from "@/engine/interaction/factoryTargets";
import { LedPanel } from "@/engine/world/LedPanel";
import {
  BOARD,
  FURNITURE_PARTS,
  boardLine,
  cellFurnitureKey,
  gateArmItem,
  gateColor,
  packPart,
  planCell,
  writeItem,
  type CellDetail,
  type CellPlan,
  type FurniturePart,
  type GateRef,
  type Item,
} from "./cellPlan";
import { hexToLinear } from "./poolMath";
import type { InteractionTarget } from "@/engine/contracts";

export type { CellDetail } from "./cellPlan";

export interface CellStats {
  /** Furniture draws (enabled pool meshes) + enabled boards. */
  draws: number;
  furnitureDraws: number;
  boards: number;
  cells: number;
  instances: number;
  rebuilds: number;
  bufferWrites: number;
  boardDraws: number;
}

const ARM_SPEED = 2.4; // rad/s

class Pool {
  mats: Float32Array = new Float32Array(0);
  cols: Float32Array = new Float32Array(0);
  count = 0;
  constructor(readonly mesh: Mesh) {
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
  }
}

interface Board {
  panel: LedPanel;
  key: string;
}

export class Cells {
  private readonly pools = {} as Record<FurniturePart, Pool>;
  private readonly materials: PBRMaterial[] = [];
  private readonly boards = new Map<string, Board>();
  private readonly detail = new Map<string, CellDetail>();
  private readonly armAngle = new Map<string, number>();
  private readonly gates = new Map<string, GateRef & { owner: string }>();
  /** Glow-pool instance index of each gate arm. */
  private readonly armIndex = new Map<string, number>();
  private plateTargets: (InteractionTarget | null)[] = [];
  private cells: CellLayout[] = [];
  private models = new Map<string, LineModel>();
  private furnitureKey: string | null = null;
  private armsMoving = false;
  private visible = true;
  private rebuilds = 0;
  private bufferWrites = 0;
  private boardDraws = 0;
  private disposed = false;

  constructor(private readonly scene: Scene) {
    const metal = this.pbr("cellMetal", 0.45, 0.4);
    metal.environmentIntensity = 0.9;
    this.pools.box = new Pool(this.mesh("cellBox", boxData(), metal));
    this.pools.cyl = new Pool(this.mesh("cellCyl", cylData(), metal));
    const plateMat = this.pbr("cellPlateMat", 0.35, 0.35);
    this.pools.plate = new Pool(this.mesh("cellPlate", boxData(), plateMat));
    const glow = new PBRMaterial("cellGlowMat", scene);
    glow.unlit = true;
    glow.albedoColor = Color3.White();
    this.materials.push(glow);
    this.pools.glow = new Pool(this.mesh("cellGlow", boxData(), glow));
    for (const p of ["box", "cyl", "plate"] as const)
      this.pools[p].mesh.receiveShadows = true;

    registerThinResolver(this.pools.plate.mesh, (_m, i) => {
      return this.plateTargets[i] ?? null;
    });
  }

  private pbr(name: string, metallic: number, roughness: number): PBRMaterial {
    const m = new PBRMaterial(name, this.scene);
    m.albedoColor = Color3.White();
    m.metallic = metallic;
    m.roughness = roughness;
    this.materials.push(m);
    return m;
  }

  private mesh(name: string, vd: VertexData, mat: PBRMaterial): Mesh {
    const m = new Mesh(name, this.scene);
    vd.applyToMesh(m, false);
    m.material = mat;
    return m;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /**
   * Replace the cell set. Furniture buffers are rewritten only when a cell's
   * furniture key changes; a board is redrawn only when its text changes.
   * Returns true when the furniture was rebuilt.
   */
  setCells(
    cells: readonly CellLayout[],
    models: ReadonlyMap<string, LineModel>,
  ): boolean {
    this.cells = [...cells];
    this.models = new Map(models);
    this.syncBoards();
    return this.rebuildFurniture();
  }

  setVisibility(projectId: string, detail: CellDetail): void {
    if (this.detail.get(projectId) === detail) return;
    this.detail.set(projectId, detail);
    const b = this.boards.get(projectId);
    if (b) b.panel.setLod(detail === "hidden" ? "far" : "near");
    this.rebuildFurniture();
  }

  /** Whole-pool toggle (floor <-> offices); boards follow. */
  setVisible(on: boolean): void {
    this.visible = on;
    for (const p of FURNITURE_PARTS)
      this.pools[p].mesh.setEnabled(on && this.pools[p].count > 0);
    for (const [id, b] of this.boards)
      b.panel.setLod(on && this.detailOf(id) !== "hidden" ? "near" : "far");
  }

  update(dt: number): void {
    if (this.disposed) return;
    for (const b of this.boards.values()) b.panel.update(dt);
    if (!this.armsMoving) return;
    let moving = false;
    const glow = this.pools.glow;
    for (const [key, g] of this.gates) {
      const cur = this.armAngle.get(key) ?? g.target;
      if (cur === g.target) continue;
      const d = g.target - cur;
      const step = ARM_SPEED * dt;
      const next = Math.abs(d) <= step ? g.target : cur + Math.sign(d) * step;
      this.armAngle.set(key, next);
      const idx = this.armIndex.get(key);
      if (idx !== undefined) {
        writeItem(glow.mats, idx * 16, this.armItemOf(g, next));
      }
      if (next !== g.target) moving = true;
    }
    this.armsMoving = moving;
    glow.mesh.thinInstanceBufferUpdated("matrix");
    this.bufferWrites++;
  }

  stats(): CellStats {
    const furnitureDraws = FURNITURE_PARTS.filter(
      (p) => this.pools[p].mesh.isEnabled() && this.pools[p].count > 0,
    ).length;
    let boards = 0;
    for (const [id, b] of this.boards)
      if (b.panel.mesh.isEnabled() && this.detailOf(id) !== "hidden") boards++;
    return {
      draws: furnitureDraws + boards,
      furnitureDraws,
      boards,
      cells: this.cells.length,
      instances: FURNITURE_PARTS.reduce((n, p) => n + this.pools[p].count, 0),
      rebuilds: this.rebuilds,
      bufferWrites: this.bufferWrites,
      boardDraws: this.boardDraws,
    };
  }

  meshes(): Mesh[] {
    return FURNITURE_PARTS.map((p) => this.pools[p].mesh);
  }

  /** Solid, lit parts (shadow casters). */
  casterMeshes(): Mesh[] {
    return (["box", "cyl", "plate"] as const).map((p) => this.pools[p].mesh);
  }

  dispose(): void {
    this.disposed = true;
    unregisterThinResolver(this.pools.plate.mesh);
    for (const b of this.boards.values()) b.panel.dispose();
    this.boards.clear();
    for (const p of FURNITURE_PARTS) this.pools[p].mesh.dispose(false, false);
    for (const m of this.materials) m.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private detailOf(id: string): CellDetail {
    return this.detail.get(id) ?? "full";
  }

  private armItemOf(g: GateRef & { owner: string }, angle: number): Item {
    const [r, gg, b] = hexToLinear(gateColor(g.state));
    const k = g.state === "idle" ? 0.5 : 1.35;
    return gateArmItem(g, g.owner, angle, [r * k, gg * k, b * k, 1]);
  }

  private syncBoards(): void {
    const live = new Set(this.cells.map((c) => c.projectId));
    for (const [id, b] of [...this.boards]) {
      if (live.has(id)) continue;
      b.panel.dispose();
      this.boards.delete(id);
    }
    for (const cell of this.cells) {
      const model = this.models.get(cell.projectId);
      let b = this.boards.get(cell.projectId);
      const pose = `${cell.board.position.x},${cell.board.position.y},${cell.board.position.z},${cell.board.yaw}`;
      if (b && !b.key.startsWith(pose + "#")) {
        b.panel.dispose();
        this.boards.delete(cell.projectId);
        b = undefined;
      }
      if (!b) {
        const panel = new LedPanel(this.scene, {
          name: `cellBoard:${cell.projectId}`,
          x: cell.board.position.x,
          y: cell.board.position.y,
          z: cell.board.position.z,
          yaw: cell.board.yaw + Math.PI,
          width: BOARD.w,
          height: BOARD.h,
          rows: 1,
        });
        tagFactoryMesh(
          panel.mesh,
          factoryTarget("lineBoard", {
            projectId: cell.projectId,
            label: model?.name ?? cell.projectId,
          }),
          { range: 18 },
        );
        b = { panel, key: pose + "#" };
        this.boards.set(cell.projectId, b);
        panel.setLod(
          this.visible && this.detailOf(cell.projectId) !== "hidden"
            ? "near"
            : "far",
        );
      }
      if (!model) continue;
      const line = boardLine(model);
      const key = `${pose}#${line.text}|${line.dot}`;
      if (key === b.key) continue;
      b.key = key;
      b.panel.set({ line: line.segments, ticker: null, dot: line.dot });
      this.boardDraws++;
    }
  }

  private rebuildFurniture(): boolean {
    const key = this.cells
      .map((c) =>
        cellFurnitureKey(
          c,
          this.models.get(c.projectId),
          this.detailOf(c.projectId),
        ),
      )
      .join("\n");
    if (key === this.furnitureKey) return false;
    this.furnitureKey = key;

    const plans: CellPlan[] = this.cells.map((c) =>
      planCell(
        c,
        this.models.get(c.projectId),
        this.detailOf(c.projectId),
        this.armAngle,
      ),
    );
    const items = plans.flatMap((p) => p.items);

    // gates: keep the mid-swing angle of surviving gates, forget the rest
    this.gates.clear();
    for (const p of plans)
      for (const g of p.gates)
        this.gates.set(g.key, { ...g, owner: p.projectId });
    for (const k of [...this.armAngle.keys()])
      if (!this.gates.has(k)) this.armAngle.delete(k);
    for (const [k, g] of this.gates)
      if (!this.armAngle.has(k)) this.armAngle.set(k, g.target);

    // lane plate targets, in plate-pool order
    this.plateTargets = items
      .filter((i) => i.part === "plate")
      .map((i) => {
        const model = this.models.get(i.owner);
        const lane = i.lane ?? 0;
        const w = model?.workpieces.find((p) => p.lane === lane);
        return factoryTarget("lanePlate", {
          projectId: i.owner,
          label: `Lane ${lane + 1}`,
          lane,
          prNumber: w?.prNumber,
          sessionId: w?.sessionId ?? null,
          url: w?.url ?? null,
        });
      });

    for (const part of FURNITURE_PARTS) {
      const pool = this.pools[part];
      const pk = packPart(items, part);
      pool.mats = pk.mats;
      pool.cols = pk.cols;
      pool.count = pk.count;
      this.upload(pool, true);
    }
    this.armIndex.clear();
    let gi = 0;
    for (const it of items) {
      if (it.part !== "glow") continue;
      if (it.kind === "gateArm" && it.key) this.armIndex.set(it.key, gi);
      gi++;
    }
    this.armsMoving = [...this.gates].some(
      ([k, g]) => (this.armAngle.get(k) ?? g.target) !== g.target,
    );
    this.rebuilds++;
    return true;
  }

  private upload(pool: Pool, withColors: boolean): void {
    const m = pool.mesh;
    if (pool.count === 0) {
      m.thinInstanceCount = 0;
      m.setEnabled(false);
      return;
    }
    m.thinInstanceSetBuffer("matrix", pool.mats, 16, false);
    this.bufferWrites++;
    if (withColors) {
      m.thinInstanceSetBuffer("color", pool.cols, 4, true);
      this.bufferWrites++;
    }
    m.thinInstanceCount = pool.count;
    m.setEnabled(this.visible);
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function boxData(): VertexData {
  return CreateBoxVertexData({ size: 1 });
}

function cylData(): VertexData {
  return CreateCylinderVertexData({ height: 1, diameter: 1, tessellation: 18 });
}
