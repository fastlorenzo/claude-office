/**
 * Factory — the software-factory level under the offices, as one unit the
 * World talks to. Owns the static shell (`FactoryHall`) and fans the World's
 * seams out to the machine pools other modules build (Conveyors, Stations,
 * Workpieces, Dock, Cells…), which plug in through `attach(part)`:
 *
 *   setLayout(fl, building)  layout changed → shell rebuilds only when the
 *                            set of rooms changes; parts get `setLayout`
 *   sync(model)              FactoryModel from logic/factoryModel.ts (P2.5)
 *   update(dt, eye, zone3)   per frame
 *   applyVisibility(v, now)  computeCellVisibility result (~5 Hz), with the
 *                            rooms' hide grace period, → part.setVisibility
 */
import type { Vector3 } from "@/engine/babylon";
import type { BuildingLayout } from "@/engine/contracts";
import type { FixturePoint } from "@/engine/fx/Lighting";
import type { FactoryLayout, Zone3 } from "@/engine/layout/factoryLayout";
import type { FactoryModel } from "@/engine/logic/factoryModel";
import { HIDE_GRACE_MS } from "@/engine/world/Visibility";
import type {
  CellDetail,
  FactoryVisibility,
} from "@/engine/world/factoryVisibility";
import {
  FactoryHall,
  type FactoryHallContext,
} from "@/engine/world/factory/FactoryHall";

/** A factory subsystem (pool) plugged into the World's seams. Every hook is optional. */
export interface FactoryPart {
  /** The factory layout changed (cells added / moved / removed). */
  setLayout?(layout: FactoryLayout, building: BuildingLayout): void;
  /** New factory model (lanes, stations, workpieces, dock). */
  sync?(model: FactoryModel): void;
  /** Per frame: animation, LOD against the eye, zone-dependent behaviour. */
  update?(dt: number, eye: Vector3, zone: Zone3): void;
  /** Detail per cell / main line / dock (already grace-filtered). */
  setVisibility?(v: FactoryVisibility): void;
  /** Extra clustered fixtures (hood lights, beacons). */
  getFixtures?(): FixturePoint[];
  dispose(): void;
}

export type FactoryContext = FactoryHallContext;

export class Factory {
  readonly hall: FactoryHall;
  private readonly parts = new Set<FactoryPart>();
  private layout: FactoryLayout | null = null;
  private building: BuildingLayout | null = null;
  private model: FactoryModel | null = null;
  private readonly applied = new Map<string, CellDetail>();
  private readonly lastSeen = new Map<string, number>();

  constructor(ctx: FactoryContext) {
    this.hall = new FactoryHall(ctx);
  }

  /**
   * Plug a pool in; it immediately receives the current layout / model.
   * Returns a detach function (does not dispose the part).
   */
  attach(part: FactoryPart): () => void {
    this.parts.add(part);
    if (this.layout && this.building)
      part.setLayout?.(this.layout, this.building);
    if (this.model) part.sync?.(this.model);
    return () => void this.parts.delete(part);
  }

  /** Current factory layout (null before the first `setLayout`). */
  get currentLayout(): FactoryLayout | null {
    return this.layout;
  }

  /** Returns true when the shell was rebuilt (fixtures / probes changed). */
  setLayout(layout: FactoryLayout, building: BuildingLayout): boolean {
    this.layout = layout;
    this.building = building;
    const rebuilt = this.hall.build(layout, building);
    for (const p of this.parts) p.setLayout?.(layout, building);
    return rebuilt;
  }

  sync(model: FactoryModel): void {
    this.model = model;
    for (const p of this.parts) p.sync?.(model);
  }

  update(dt: number, eye: Vector3, zone: Zone3): void {
    for (const p of this.parts) p.update?.(dt, eye, zone);
  }

  /** Apply a `computeCellVisibility` result with the rooms' hide grace. */
  applyVisibility(v: FactoryVisibility, nowMs: number): void {
    const want = new Map<string, CellDetail>();
    for (const [id, d] of v.cells) want.set(`cell:${id}`, d);
    want.set("main", v.mainLine);
    want.set("dock", v.dock);
    let changed = false;
    for (const id of [...this.applied.keys()])
      if (!want.has(id)) {
        this.applied.delete(id);
        this.lastSeen.delete(id);
        changed = true;
      }
    for (const [id, raw] of want) {
      let d = raw;
      if (d !== "hidden") this.lastSeen.set(id, nowMs);
      else if (nowMs - (this.lastSeen.get(id) ?? -Infinity) < HIDE_GRACE_MS)
        d = this.applied.get(id) ?? "full";
      if (this.applied.get(id) !== d) {
        this.applied.set(id, d);
        changed = true;
      }
    }
    if (!changed) return;
    const cells = new Map<string, CellDetail>();
    for (const [id, d] of this.applied)
      if (id.startsWith("cell:")) cells.set(id.slice(5), d);
    const out: FactoryVisibility = {
      cells,
      mainLine: this.applied.get("main") ?? "full",
      dock: this.applied.get("dock") ?? "full",
    };
    for (const p of this.parts) p.setVisibility?.(out);
  }

  /** Detail currently applied (debug / tests): `cell:<id>`, `main`, `dock`. */
  detailOf(key: string): CellDetail {
    return this.applied.get(key) ?? "full";
  }

  get fixtures(): FixturePoint[] {
    const out = [...this.hall.fixtures];
    for (const p of this.parts) out.push(...(p.getFixtures?.() ?? []));
    return out;
  }

  dispose(): void {
    for (const p of this.parts) p.dispose();
    this.parts.clear();
    this.hall.dispose();
  }
}
