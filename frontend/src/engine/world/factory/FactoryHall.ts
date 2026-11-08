/**
 * FactoryHall — the plant shell under the elevated office (P1.2).
 *
 * The envelope is a big hall that encloses the office block (spine + rooms)
 * and the control room, south wall at `fl.bounds.min.z` where the entrance
 * building (ground lobby + reception gallery, not ours) adjoins it:
 *  - satin grey epoxy floor at y = FLOOR_Y with painted lane markings,
 *    walkways, station pads, stair-foot hatching and daylit "RESERVED"
 *    stencils on empty cells;
 *  - outer walls (concrete plinth + cladding, perimeter steel columns; the
 *    south wall leaves the entrance opening, the north wall the dock
 *    opening), roof trusses, purlins and a profiled roof deck (y 9, above
 *    every office roof) with rooflight strips over the outer 20 m of each
 *    cell (+ over empty slots);
 *  - the undersides of the y = 0 level (the office draws none): room soffits
 *    with downstand beams, cable trays, spiral ducts and slab-edge LED
 *    strips; the glass-floor strip's steel grillage; balcony undersides; the
 *    spine soffit around its glass strip / tower bay / stair wells; the
 *    control-room soffit;
 *  - RAL 7016 columns from the floor up to the soffits at
 *    `ProjectRoomLayout.columns` (+ the spine and control grids);
 *  - steel stairs with hidden ramp colliders: the spine-node stairs and one
 *    switchback stair per cell from the balcony (balustrade gap, see
 *    `cellStairGap`) down to the cell's entry bay. Slim black handrails at
 *    0.95 m with balusters below; nothing crosses a flight;
 *  - a box-projected "factory" reflection probe on the epoxy and clustered
 *    fixtures (slab-edge strips, tray battens, high-bay pendants) so the zone
 *    under the rooms is lit by the slab edges and not from nowhere.
 *
 * Everything merges per material through one ArtBatcher: floor, paint
 * (vertex coloured), concrete, galvanised, painted steel, black steel, LED,
 * glass, stencil = 9 draws for the whole shell, at any project count.
 * Rebuilt only when the set of rooms (or the envelope) changes — `keyOf`.
 */
import {
  CreatePlane,
  DynamicTexture,
  PBRMaterial,
  Texture,
  Vector3,
  type Mesh,
  type Scene,
} from "@/engine/babylon";
import { LAYOUT, type BuildingLayout } from "@/engine/contracts";
import { ArtBatcher, paintOf } from "@/engine/art/geometry";
import {
  fixture,
  type FixturePoint,
  type Lighting,
} from "@/engine/fx/Lighting";
import type { Materials, SurfaceKey } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  CELL_STAIR,
  cellStairFoot,
  cellStairGap,
  CROSSOVER,
  FACTORY,
  SPINE_GLASS_W,
  SPINE_STAIR,
  TOWER_BAY_D,
  type CellLayout,
  type CrossoverLayout,
  type FactoryLayout,
  type Rect,
  type StairLayout,
} from "@/engine/layout/factoryLayout";
import { rectMinusHoles } from "@/engine/world/architecture";
import {
  buildSignMesh,
  hallSigns,
  signHardware,
} from "@/engine/world/wayfinding";
import {
  flight,
  type Flight,
  NOSING_YELLOW,
  steelFlight,
  steelLanding,
  steelPost,
  steelRail,
} from "@/engine/world/stairs";

export interface FactoryHallContext {
  scene: Scene;
  materials: Materials;
  colliders: Colliders;
  lighting: Lighting;
}

/** Shell dimensions (m). */
export const HALL = {
  ROOF_Y: FACTORY.ROOF_Y,
  /** Underside band of every y = 0 slab (the office slabs are 0.1 thick). */
  SOFFIT_TOP: -0.1,
  SOFFIT_BOT: -0.45,
  COLUMN: 0.3,
  WALL_T: 0.3,
  PLINTH_H: 1.2,
  TRUSS_D: 1.6,
  /**
   * South-wall opening the entrance building fills (|x| ≤ halfW, floor → h):
   * the entrance block's outer side-wall faces (half width + its 0.2 wall)
   * and the reception ceiling's top (6 + 0.1) — no slit, no slot (G10).
   */
  ENTRANCE_OPENING: {
    halfW: (LAYOUT.HALL_W + 2 * LAYOUT.ROOM_D) / 2 + 0.2,
    h: LAYOUT.LOBBY_H + 0.1,
  },
  /** Opening in the north wall the dock fills (half width, height). */
  DOCK_OPENING: { halfW: 16, h: 7 },
  /** Rooflight strips (|x| ranges) over the outer part of every cell. */
  SKYLIGHT_X: [
    [18, 20.4],
    [26, 28.4],
  ] as const,
  /** High-bay pendants (|x|) over the cells, one pair per bay. */
  HIGHBAY_X: [18, 27] as const,
  HIGHBAY_Y: 0.5,
} as const;

/** Spine flight run for the 6 m drop (continues under the slab past the well). */
export const SPINE_RUN = SPINE_STAIR.RUN;

// The cell stair's numbers live with the layout (one source for the built
// stair, its plan rect and its foot); re-exported for the shells.
export { CELL_STAIR, cellStairFoot, cellStairGap };

const G = "factoryHall";
/** Entry-bay walkway |x| runs: trunk → stair, stair foot → loading aisle. */
const WALKWAY_X = [
  [9.2, 14.0],
  [17.8, FACTORY.AISLE_X[1]],
] as const;

const PAINT = {
  yellow: NOSING_YELLOW,
  white: "#E4E5E1",
  green: "#3F7D5A",
  cladding: "#CED2D4",
  joint: "#A3A8AB",
  liftPanel: "#8F969B",
  black: "#1C1D1F",
} as const;

type Hex = (typeof PAINT)[keyof typeof PAINT];

/** The spine-stair flight of a well: 35° from its top edge, under the slab (pure). */
export function spineFlight(st: StairLayout, fy: number): Flight {
  const r = st.rect;
  return flight(r.x0, r.x1, r.z0, r.z0 + SPINE_RUN, 0, fy);
}

/**
 * A cell's switchback (balcony → entry bay), top flight first: three 2 m
 * flights side by side, the top landing at the balcony door's end (offsets
 * mirror in z). Pure.
 */
export function cellStairFlights(c: CellLayout, fy: number): Flight[] {
  const S = CELL_STAIR;
  const s = c.side === "east" ? 1 : -1;
  const W = LAYOUT.ROOM_W;
  const m = c.stair.top.z - c.z0 > W / 2;
  const Z = (o: number) => (m ? c.z0 + W - o : c.z0 + o);
  const levels = [0, -2, -4, fy];
  return S.flights.map((f, k) => {
    const down = k % 2 === 0; // flights 1, 3 run near → far
    return flight(
      Math.min(s * f.x0, s * f.x1),
      Math.max(s * f.x0, s * f.x1),
      Z(down ? S.zNear : S.zFar),
      Z(down ? S.zFar : S.zNear),
      levels[k],
      levels[k + 1],
    );
  });
}

/** A crossover's two flights (south, north), each from the deck edge down (pure). */
export function crossoverFlights(x: CrossoverLayout, fy: number): Flight[] {
  const C = CROSSOVER;
  const xa = x.x - C.W / 2;
  const xb = x.x + C.W / 2;
  const d0 = x.z - C.DECK_HALF;
  const d1 = x.z + C.DECK_HALF;
  return [
    flight(xa, xb, d0, d0 - C.RUN, x.deckY, fy),
    flight(xa, xb, d1, d1 + C.RUN, x.deckY, fy),
  ];
}

/** Signed x range → ordered rect. */
const xr = (s: number, a: number, b: number, z0: number, z1: number): Rect => ({
  x0: Math.min(s * a, s * b),
  x1: Math.max(s * a, s * b),
  z0,
  z1,
});

export class FactoryHall {
  private meshes: Mesh[] = [];
  private textures: DynamicTexture[] = [];
  private stencil: PBRMaterial | null = null;
  /** Wayfinding signs (one merged unlit mesh, one draw; not a caster). */
  private signs: Mesh | null = null;
  private fixtureList: FixturePoint[] = [];
  private key = "";
  private layout: FactoryLayout | null = null;
  /** South wall z (fl.bounds.min.z; the entrance building adjoins it outside). */
  private zSouth = 0;

  constructor(private readonly ctx: FactoryHallContext) {}

  /** Rebuild key: the set of rooms / empty slots and the hall extents. */
  static keyOf(fl: FactoryLayout, b: BuildingLayout): string {
    const cells = fl.cells
      .map((c) => `${c.projectId}:${c.side}:${c.z0}:${c.z1}`)
      .sort()
      .join("|");
    const empty = fl.emptyCells
      .map((e) => `${e.side}:${e.z0}:${e.z1}`)
      .join("|");
    const c = b.controlRoom;
    return `${cells}#${empty}#${b.hall.length}:${fl.bounds.min.z}:${c.size.x}:${c.size.z}:${fl.bounds.max.z}`;
  }

  /** Build for this layout; no-op (false) when the set of rooms is unchanged. */
  build(fl: FactoryLayout, building: BuildingLayout): boolean {
    const key = FactoryHall.keyOf(fl, building);
    if (key === this.key) return false;
    this.clear();
    this.key = key;
    this.layout = fl;
    this.zSouth = fl.bounds.min.z;
    const { scene, materials } = this.ctx;
    const b = new ArtBatcher(scene, materials, "factory", 11);
    b.jitter = 0.025;
    this.buildFloor(b, fl);
    this.buildWallsAndRoof(b, fl, building);
    this.buildSoffits(b, fl, building);
    this.buildColumns(b, fl, building);
    this.buildStairs(b, fl);
    this.buildCrossovers(b, fl);
    this.buildMainLineEnd(b, fl);
    this.buildHighBays(b, fl);
    const signs = hallSigns(fl, LAYOUT.WALL_H);
    signHardware(b, signs);
    const meshes = b.build({ receiveShadows: true });
    const sm = buildSignMesh(scene, "factory", signs);
    if (sm) {
      this.signs = sm.mesh;
      this.textures.push(sm.texture);
    }
    for (const m of meshes)
      m.metadata = { ...(m.metadata ?? {}), probe: true, factory: true };
    this.meshes = meshes;
    this.ctx.lighting.addStaticCasters(
      meshes.filter(
        (m) =>
          !m.material?.needAlphaBlending() &&
          !/lightPanel|stencil/.test(m.name),
      ),
    );
    this.registerProbe(fl);
    return true;
  }

  /** Clustered fixture points (slab-edge strips, battens, high bays). */
  get fixtures(): FixturePoint[] {
    return this.fixtureList;
  }

  /** The merged shell meshes (≤ 9). */
  get staticMeshes(): Mesh[] {
    return this.meshes.filter((m) => !m.isDisposed());
  }

  dispose(): void {
    this.clear();
  }

  // -------------------------------------------------------------------------

  private clear(): void {
    this.ctx.colliders.disposeGroup(G);
    for (const m of this.meshes) m.dispose(false, false);
    this.meshes = [];
    for (const t of this.textures) t.dispose();
    this.textures = [];
    this.stencil?.dispose(false, false);
    this.stencil = null;
    this.signs?.material?.dispose(false, false);
    this.signs?.dispose(false, false);
    this.signs = null;
    this.fixtureList = [];
    this.key = "";
  }

  private col(c: Vector3, s: Vector3, opts?: { pitch?: number }): void {
    this.ctx.colliders.addBox(G, c, s, 0, opts);
  }

  private registerProbe(fl: FactoryLayout): void {
    const { lighting, materials, scene } = this.ctx;
    const b = fl.bounds;
    const z0 = this.zSouth;
    // The probe camera sits at the box centre's y (capped at 1.6 by
    // Lighting): centre it 1.6 m above the floor and let the box reach the
    // roof (its bottom face only skews downward rays, which the floor eats).
    const cy = fl.floorY + 1.6;
    const top = b.max.y;
    lighting.registerProbe(
      "factory",
      new Vector3(0, cy, (z0 + b.max.z) / 2),
      new Vector3(b.max.x - b.min.x, 2 * (top - cy), b.max.z - z0),
      [materials.get("floorEpoxy")],
      () =>
        scene.meshes.filter(
          (m) =>
            m.isEnabled() &&
            !m.name.includes("floorEpoxy") &&
            (m.metadata as { probe?: boolean } | null)?.probe === true,
        ),
    );
  }

  // -------------------------------------------------------------------------
  // Floor + markings
  // -------------------------------------------------------------------------

  private paint(b: ArtBatcher, hex: Hex, fn: () => void): void {
    const prev = b.paint;
    b.paint = paintOf(hex);
    fn();
    b.paint = prev;
  }

  /** Painted floor marking (5 mm film). */
  private mark(b: ArtBatcher, fy: number, r: Rect): void {
    if (r.x1 - r.x0 < 1e-3 || r.z1 - r.z0 < 1e-3) return;
    b.box(
      "paint",
      v3((r.x0 + r.x1) / 2, fy + 0.0025, (r.z0 + r.z1) / 2),
      v3(r.x1 - r.x0, 0.005, r.z1 - r.z0),
    );
  }

  /** Line along z at x (width w). */
  private lineZ(
    b: ArtBatcher,
    fy: number,
    x: number,
    z0: number,
    z1: number,
    w = 0.1,
  ): void {
    this.mark(b, fy, { x0: x - w / 2, x1: x + w / 2, z0, z1 });
  }

  /** Line along x at z (width w). */
  private lineX(
    b: ArtBatcher,
    fy: number,
    z: number,
    x0: number,
    x1: number,
    w = 0.1,
  ): void {
    this.mark(b, fy, {
      x0: Math.min(x0, x1),
      x1: Math.max(x0, x1),
      z0: z - w / 2,
      z1: z + w / 2,
    });
  }

  private outline(b: ArtBatcher, fy: number, r: Rect, w = 0.08): void {
    this.lineX(b, fy, r.z0 + w / 2, r.x0, r.x1, w);
    this.lineX(b, fy, r.z1 - w / 2, r.x0, r.x1, w);
    this.lineZ(b, fy, r.x0 + w / 2, r.z0 + w, r.z1 - w, w);
    this.lineZ(b, fy, r.x1 - w / 2, r.z0 + w, r.z1 - w, w);
  }

  /** Yellow safety hatching (bars across z) over a rect. */
  private hatch(b: ArtBatcher, fy: number, r: Rect): void {
    this.outline(b, fy, r, 0.08);
    for (let z = r.z0 + 0.25; z < r.z1 - 0.15; z += 0.4)
      this.lineX(b, fy, z, r.x0 + 0.1, r.x1 - 0.1, 0.16);
  }

  private buildFloor(b: ArtBatcher, fl: FactoryLayout): void {
    const fy = fl.floorY;
    const zS = this.zSouth;
    const { max } = fl.bounds;
    const OX = max.x;
    b.box(
      "floorEpoxy",
      v3(0, fy - 0.15, (zS + max.z) / 2),
      v3(OX * 2, 0.3, max.z - zS),
    );
    this.col(
      new Vector3(0, fy - 0.25, (zS + max.z) / 2),
      new Vector3(OX * 2 + 2, 0.5, max.z - zS + 2),
    );

    const hallEnd = fl.mainLine.z1;
    this.paint(b, PAINT.yellow, () => {
      // Main-line keep-out + spine aisle edges.
      for (const s of [-1, 1]) {
        this.lineZ(b, fy, s * 1.1, zS + 0.3, hallEnd, 0.1);
        this.lineZ(b, fy, s * 3.25, zS + 0.3, hallEnd, 0.1);
      }
      // Cell borders + the entry-bay walkway edges.
      for (const c of fl.cells) {
        const s = c.side === "east" ? 1 : -1;
        const xIn = s * 3.8;
        const xOut = s * (OX - 0.5);
        this.lineX(b, fy, c.z0 + 0.12, xIn, xOut, 0.08);
        this.lineX(b, fy, c.z1 - 0.12, xIn, xOut, 0.08);
        this.lineZ(b, fy, xOut, c.z0 + 0.12, c.z1 - 0.12, 0.08);
        const wz = c.z0 + LAYOUT.ROOM_W / 2;
        for (const [a, bb] of WALKWAY_X) {
          this.lineX(b, fy, wz - 0.7, s * a, s * bb, 0.08);
          this.lineX(b, fy, wz + 0.7, s * a, s * bb, 0.08);
        }
        // Loading aisle edges along the outer wall.
        for (const ax of FACTORY.AISLE_X)
          this.lineZ(b, fy, s * ax, c.z0 + 0.2, c.z1 - 0.2, 0.08);
        // Station pads (QA desk and merge gate included).
        for (const lane of c.lanes) {
          for (const x of [...lane.stationX, lane.qaX, lane.gateX]) {
            const h = 0.7;
            this.outline(
              b,
              fy,
              { x0: x - h, x1: x + h, z0: lane.z - h, z1: lane.z + h },
              0.06,
            );
          }
        }
        // Stair foot.
        const mz = c.stair.top.z - c.z0 > LAYOUT.ROOM_W / 2;
        // Flight 3 lands at the far end (offsets 4.02 → 4.72), x 16.4 → 17.4.
        const fz0 = mz ? c.z0 + LAYOUT.ROOM_W - 4.72 : c.z0 + 4.02;
        const foot = xr(s, 16.45, 18.6, fz0, fz0 + 0.7);
        this.hatch(b, fy, foot);
      }
      for (const st of fl.spineStairs)
        this.hatch(b, fy, {
          x0: st.rect.x0,
          x1: st.rect.x1,
          z0: st.rect.z0 + SPINE_RUN + 0.05,
          z1: st.rect.z0 + SPINE_RUN + 1.25,
        });
      // Crossover feet.
      for (const x of fl.crossovers)
        for (const [z0, z1] of [
          [x.rect.z0 - 1.2, x.rect.z0 - 0.05],
          [x.rect.z1 + 0.05, x.rect.z1 + 1.2],
        ])
          this.hatch(b, fy, { x0: x.rect.x0, x1: x.rect.x1, z0, z1 });
      // Empty cells: double border with diagonal ticks.
      for (const e of fl.emptyCells) {
        const s = e.side === "east" ? 1 : -1;
        const r = xr(s, 4.2, OX - 0.6, e.z0 + 0.4, e.z1 - 0.4);
        this.outline(b, fy, r, 0.1);
        const inner = {
          x0: r.x0 + 0.7,
          x1: r.x1 - 0.7,
          z0: r.z0 + 0.7,
          z1: r.z1 - 0.7,
        };
        this.outline(b, fy, inner, 0.1);
        const tick = (x: number, z: number) =>
          b.box("paint", v3(x, fy + 0.0025, z), v3(0.14, 0.005, 0.8), {
            yaw: Math.PI / 4,
          });
        for (let x = r.x0 + 0.9; x < r.x1 - 0.5; x += 0.9) {
          tick(x, r.z0 + 0.35);
          tick(x, r.z1 - 0.35);
        }
        for (let z = r.z0 + 1.2; z < r.z1 - 0.8; z += 0.9) {
          tick(r.x0 + 0.35, z);
          tick(r.x1 - 0.35, z);
        }
      }
    });

    this.paint(b, PAINT.white, () => {
      // Lane edge lines from the merge gate out to the intake.
      for (const c of fl.cells)
        for (const lane of c.lanes) {
          const a = lane.gateX - Math.sign(lane.gateX) * 0.9;
          const e = lane.intakeX + Math.sign(lane.intakeX) * 1.1;
          for (const dz of [-1.0, 1.0])
            this.lineX(b, fy, lane.z + dz, a, e, 0.05);
        }
    });

    this.paint(b, PAINT.green, () => {
      // Safety walkway across each cell's entry bay (no lanes there; the
      // feeder runs inboard of the trunk, the crossover steps over it) and
      // the loading aisle along the outer wall joining every bay.
      for (const c of fl.cells) {
        const s = c.side === "east" ? 1 : -1;
        const wz = c.z0 + LAYOUT.ROOM_W / 2;
        for (const [a, bb] of WALKWAY_X)
          this.mark(b, fy - 0.001, xr(s, a, bb, wz - 0.66, wz + 0.66));
        const [a0, a1] = FACTORY.AISLE_X;
        this.mark(b, fy - 0.001, xr(s, a0 + 0.04, a1 - 0.04, c.z0, c.z1));
      }
      // Walkway in from the entrance building's factory door (x = 0).
      this.mark(b, fy - 0.001, {
        x0: -1.2,
        x1: 1.2,
        z0: zS + 0.2,
        z1: zS + 2.0,
      });
    });

    // Daylit RESERVED stencils on empty cells.
    if (fl.emptyCells.length) {
      const mat = this.stencilMaterial();
      for (const e of fl.emptyCells) {
        const s = e.side === "east" ? 1 : -1;
        const len = e.z1 - e.z0;
        const w = Math.min(10, len - 3);
        if (w < 3) continue;
        const q = CreatePlane(
          `factory:stencil`,
          { width: w, height: w / 4 },
          this.ctx.scene,
        );
        q.position.set(s * 19, fy + 0.006, (e.z0 + e.z1) / 2);
        // Lie flat, text "up" pointing outward (read from the spine).
        q.rotation.set(Math.PI / 2, (s * Math.PI) / 2, 0);
        b.addRaw(mat, q);
      }
    }
  }

  private stencilMaterial(): PBRMaterial {
    if (this.stencil) return this.stencil;
    const { scene } = this.ctx;
    const tex = new DynamicTexture(
      "factory:stencilTex",
      { width: 1024, height: 256 },
      scene,
      true,
    );
    tex.hasAlpha = true;
    const g = tex.getContext() as unknown as CanvasRenderingContext2D;
    g.clearRect(0, 0, 1024, 256);
    g.fillStyle = PAINT.yellow;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "900 150px 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
    g.fillText("RESERVED", 512, 104);
    g.font = "700 46px 'Helvetica Neue', Arial, sans-serif";
    g.fillText("FUTURE PRODUCTION CELL", 512, 214);
    tex.update(true);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.textures.push(tex);
    const mat = new PBRMaterial("factory:stencil", scene);
    mat.albedoTexture = tex;
    mat.useAlphaFromAlbedoTexture = true;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    mat.alphaCutOff = 0.45;
    mat.metallic = 0;
    mat.roughness = 0.7;
    mat.environmentIntensity = 0.6;
    mat.freeze();
    this.stencil = mat;
    return mat;
  }

  // -------------------------------------------------------------------------
  // Walls, roof, trusses, rooflights
  // -------------------------------------------------------------------------

  /** Wall slab along `axis` at `fixed` (centre line), [a0,a1] × [y0,y1]. */
  private wall(
    b: ArtBatcher,
    axis: "x" | "z",
    fixed: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
    fy: number,
  ): void {
    if (a1 - a0 < 0.01 || y1 - y0 < 0.01) return;
    const T = HALL.WALL_T;
    const put = (mat: SurfaceKey, ya: number, yb: number) => {
      if (yb - ya < 0.01) return;
      const c = (a0 + a1) / 2;
      const len = a1 - a0;
      if (axis === "z")
        b.box(mat, v3(fixed, (ya + yb) / 2, c), v3(T, yb - ya, len));
      else b.box(mat, v3(c, (ya + yb) / 2, fixed), v3(len, yb - ya, T));
    };
    const plinthTop = fy + HALL.PLINTH_H;
    put("concreteSoffit", y0, Math.min(y1, plinthTop));
    // Profiled sandwich-panel cladding (WS5 R15) above the concrete plinth.
    this.paint(b, PAINT.cladding, () =>
      put("cladding", Math.max(y0, plinthTop), y1),
    );
    const c = (a0 + a1) / 2;
    const len = a1 - a0;
    this.col(
      axis === "z"
        ? new Vector3(fixed, (y0 + y1) / 2, c)
        : new Vector3(c, (y0 + y1) / 2, fixed),
      axis === "z"
        ? new Vector3(T, y1 - y0, len)
        : new Vector3(len, y1 - y0, T),
    );
  }

  private buildWallsAndRoof(
    b: ArtBatcher,
    fl: FactoryLayout,
    building: BuildingLayout,
  ): void {
    const fy = fl.floorY;
    const { max } = fl.bounds;
    const OX = max.x;
    const RY = HALL.ROOF_Y;
    const T = HALL.WALL_T;
    const zA = this.zSouth;
    const zB = max.z;
    // Side walls (inner face at |x| = OX); they stop at the north wall's
    // outer face (zB).
    for (const s of [-1, 1])
      this.wall(b, "z", s * (OX + T / 2), zA - T, zB, fy, RY + 0.15, fy);
    // South wall: the entrance building (ground lobby + reception gallery)
    // draws the shared wall in |x| ≤ 13.35 up to 6.25 (factory door,
    // reception glazing); the shell closes the rest.
    const eo = HALL.ENTRANCE_OPENING;
    const zs = zA - T / 2;
    this.wall(b, "x", zs, -OX, -eo.halfW, fy, RY + 0.15, fy);
    this.wall(b, "x", zs, eo.halfW, OX, fy, RY + 0.15, fy);
    this.wall(b, "x", zs, -eo.halfW, eo.halfW, eo.h, RY + 0.15, fy);
    // North wall: the dock's door wall fills the central opening. Both
    // share the plane zB − T … zB (the dock draws its wall at local
    // −0.3 … 0 from zB), so the inner faces line up (G11).
    const d = HALL.DOCK_OPENING;
    const zn = zB - T / 2;
    this.wall(b, "x", zn, -OX, -d.halfW, fy, RY + 0.15, fy);
    this.wall(b, "x", zn, d.halfW, OX, fy, RY + 0.15, fy);
    this.wall(b, "x", zn, -d.halfW, d.halfW, fy + d.h, RY + 0.15, fy);

    // Cladding joints (inner faces, every 1.2 m) on the long walls.
    this.paint(b, PAINT.joint, () => {
      for (const s of [-1, 1])
        for (let y = fy + HALL.PLINTH_H; y < RY; y += 1.2)
          b.box(
            "paint",
            v3(s * (OX - 0.006), y, (zA + zB) / 2),
            v3(0.012, 0.025, zB - zA),
          );
    });

    // Trusses on the bay grid (+ perimeter columns carrying them).
    const trussZ: number[] = [];
    const W = LAYOUT.ROOM_W;
    for (let k = Math.ceil((zA + 1) / W); k * W < zB - 1; k++)
      trussZ.push(k * W);
    const n = 28;
    const dx = (2 * OX) / n;
    const yTop = RY - 0.12;
    const yBot = RY - HALL.TRUSS_D;
    for (const z of trussZ) {
      b.box("steelPainted", v3(0, yTop, z), v3(2 * OX, 0.2, 0.16));
      b.box("steelPainted", v3(0, yBot, z), v3(2 * OX, 0.16, 0.14));
      for (let i = 0; i <= n; i++) {
        const x = -OX + i * dx;
        b.box(
          "steelPainted",
          v3(x, (yTop + yBot) / 2, z),
          v3(0.09, yTop - yBot, 0.09),
        );
        if (i === n) continue;
        // Pratt pattern: diagonals fall toward the centre.
        const leftHalf = i < n / 2;
        const xa = x;
        const xb = x + dx;
        const ya = leftHalf ? yTop : yBot;
        const yb = leftHalf ? yBot : yTop;
        const len = Math.hypot(xb - xa, yb - ya);
        b.box(
          "steelPainted",
          v3((xa + xb) / 2, (ya + yb) / 2, z),
          v3(len, 0.07, 0.07),
          { roll: Math.atan2(yb - ya, xb - xa) },
        );
      }
      for (const s of [-1, 1]) {
        b.box(
          "steelPainted",
          v3(s * (OX - 0.2), (fy + RY) / 2, z),
          v3(0.4, RY - fy, 0.3),
        );
        this.col(
          new Vector3(s * (OX - 0.2), (fy + RY) / 2, z),
          new Vector3(0.42, RY - fy, 0.32),
        );
      }
    }

    // Rooflights: strips over the outer 20 m of each side + empty slots.
    const L = building.hall.length;
    const sky: Rect[] = [];
    if (L > 2)
      for (const s of [-1, 1])
        for (const [a, bb] of HALL.SKYLIGHT_X)
          sky.push(xr(s, a, bb, 0.6, L - 0.6));
    for (const e of fl.emptyCells) {
      const s = e.side === "east" ? 1 : -1;
      sky.push(xr(s, 5.2, 12.4, e.z0 + 0.7, e.z1 - 0.7));
    }
    // Purlins along z (skipped under rooflights).
    for (let x = -OX + 1.2; x < OX - 1; x += 2.4) {
      if (sky.some((r) => x > r.x0 - 0.2 && x < r.x1 + 0.2 && r.z1 - r.z0 > 20))
        continue;
      b.box(
        "steelPainted",
        v3(x, RY - 0.12, (zA + zB) / 2),
        v3(0.08, 0.18, zB - zA),
      );
    }
    // Profiled deck (galvanised underside) with the rooflight holes.
    const roof = rectMinusHoles(
      { x0: -OX - T, x1: OX + T, z0: zA - T, z1: zB },
      sky,
    );
    for (const r of roof)
      b.box(
        "galvanised",
        v3((r.x0 + r.x1) / 2, RY + 0.08, (r.z0 + r.z1) / 2),
        v3(r.x1 - r.x0, 0.16, r.z1 - r.z0),
      );
    // Deck ribs (trapezoidal profile read from below) every 1.2 m.
    for (const r of roof) {
      if (r.x1 - r.x0 < 1.2) continue;
      for (let z = Math.ceil(r.z0 / 1.2) * 1.2; z < r.z1; z += 1.2)
        b.box(
          "galvanised",
          v3((r.x0 + r.x1) / 2, RY - 0.03, z),
          v3(r.x1 - r.x0, 0.06, 0.12),
        );
    }
    for (const r of sky) {
      const h = 0.6;
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      // Kerb upstands.
      b.box(
        "galvanised",
        v3(r.x0 - 0.05, RY + h / 2, cz),
        v3(0.1, h, r.z1 - r.z0 + 0.2),
      );
      b.box(
        "galvanised",
        v3(r.x1 + 0.05, RY + h / 2, cz),
        v3(0.1, h, r.z1 - r.z0 + 0.2),
      );
      b.box(
        "galvanised",
        v3(cx, RY + h / 2, r.z0 - 0.05),
        v3(r.x1 - r.x0, h, 0.1),
      );
      b.box(
        "galvanised",
        v3(cx, RY + h / 2, r.z1 + 0.05),
        v3(r.x1 - r.x0, h, 0.1),
      );
      // Glazing + bars (bars cast the stripes in the sun patches).
      b.box("glass", v3(cx, RY + h, cz), v3(r.x1 - r.x0, 0.02, r.z1 - r.z0));
      for (let z = r.z0 + 1.2; z < r.z1 - 0.3; z += 1.2)
        b.box(
          "steelPainted",
          v3(cx, RY + h - 0.04, z),
          v3(r.x1 - r.x0, 0.06, 0.05),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Undersides of the y = 0 level
  // -------------------------------------------------------------------------

  private soffit(b: ArtBatcher, r: Rect): void {
    const { SOFFIT_TOP: t, SOFFIT_BOT: u } = HALL;
    b.box(
      "concreteSoffit",
      v3((r.x0 + r.x1) / 2, (t + u) / 2, (r.z0 + r.z1) / 2),
      v3(r.x1 - r.x0, t - u, r.z1 - r.z0),
    );
  }

  /** LED strip (aluminium channel + diffuser) along z, with fixtures. */
  private ledZ(
    b: ArtBatcher,
    x: number,
    y: number,
    z0: number,
    z1: number,
    every = 2.4,
    intensity = 0.8,
  ): void {
    if (z1 - z0 < 0.3) return;
    b.box(
      "galvanised",
      v3(x, y + 0.02, (z0 + z1) / 2),
      v3(0.08, 0.04, z1 - z0),
    );
    b.box(
      "lightPanel",
      v3(x, y - 0.005, (z0 + z1) / 2),
      v3(0.06, 0.012, z1 - z0 - 0.02),
    );
    const n = Math.max(1, Math.round((z1 - z0) / every));
    for (let i = 0; i < n; i++)
      this.fixtureList.push(
        fixture(x, y - 0.05, z0 + ((i + 0.5) * (z1 - z0)) / n, {
          kind: "down",
          color: "#FFF3E4",
          intensity,
          range: 7.6,
        }),
      );
  }

  /** LED batten along x (lobby / control soffits). */
  private ledX(
    b: ArtBatcher,
    z: number,
    y: number,
    x0: number,
    x1: number,
    every = 4,
    intensity = 0.8,
  ): void {
    if (x1 - x0 < 0.3) return;
    b.box(
      "galvanised",
      v3((x0 + x1) / 2, y + 0.02, z),
      v3(x1 - x0, 0.04, 0.08),
    );
    b.box(
      "lightPanel",
      v3((x0 + x1) / 2, y - 0.005, z),
      v3(x1 - x0 - 0.02, 0.012, 0.06),
    );
    const n = Math.max(1, Math.round((x1 - x0) / every));
    for (let i = 0; i < n; i++)
      this.fixtureList.push(
        fixture(x0 + ((i + 0.5) * (x1 - x0)) / n, y - 0.05, z, {
          kind: "down",
          color: "#FFF3E4",
          intensity,
          range: 7.6,
        }),
      );
  }

  /** Cable tray along z (bottom plate + side rails + hanger pairs). */
  private trayZ(
    b: ArtBatcher,
    x: number,
    y: number,
    z0: number,
    z1: number,
  ): void {
    const len = z1 - z0;
    if (len < 0.5) return;
    const cz = (z0 + z1) / 2;
    b.box("galvanised", v3(x, y, cz), v3(0.45, 0.012, len));
    for (const s of [-1, 1])
      b.box(
        "galvanised",
        v3(x + s * 0.22, y + 0.045, cz),
        v3(0.012, 0.09, len),
      );
    for (let z = z0 + 1.2; z < z1 - 0.3; z += 2.4)
      for (const s of [-1, 1])
        b.box(
          "galvanised",
          v3(x + s * 0.25, (y + HALL.SOFFIT_BOT) / 2, z),
          v3(0.016, HALL.SOFFIT_BOT - y, 0.016),
        );
  }

  private buildSoffits(
    b: ArtBatcher,
    fl: FactoryLayout,
    building: BuildingLayout,
  ): void {
    const U = HALL.SOFFIT_BOT;
    const W = LAYOUT.ROOM_W;
    const front = LAYOUT.HALL_W / 2;
    const stripY = U - 0.03;

    // ---- Project rooms.
    for (const p of building.projects) {
      const s = p.slot.side === "east" ? 1 : -1;
      const { z0, z1 } = p.footprint;
      const xg = Math.abs(p.glassFloor.x0); // inner edge of the glass strip
      const xo = Math.abs(p.outer.x);
      this.soffit(b, xr(s, front, xg, z0, z1));
      // Downstand beams on the internal bay lines (stop short of the strips).
      for (let k = 1; k < p.span; k++) {
        const z = z0 + k * W;
        b.box(
          "concreteSoffit",
          v3(s * ((front + 0.7 + xg - 0.6) / 2), U - 0.15, z),
          v3(xg - 0.6 - front - 0.7, 0.3, 0.3),
        );
      }
      // Glass-strip grillage: edge beams + ribs (no slab: see-through).
      for (const x of [xg + 0.1, xo - 0.1])
        b.box(
          "steelPainted",
          v3(s * x, (U + HALL.SOFFIT_TOP) / 2 - 0.02, (z0 + z1) / 2),
          v3(0.2, HALL.SOFFIT_TOP - U - 0.04, z1 - z0),
        );
      for (let z = z0 + 1.2; z < z1 - 0.1; z += 1.2)
        b.box(
          "steelPainted",
          v3(s * ((xg + xo) / 2), -0.24, z),
          v3(xo - xg - 0.4, 0.22, 0.08),
        );
      // Balcony underside: galvanised deck plate, edge channel, brackets.
      const bx0 = Math.abs(p.balcony.x0);
      const bx1 = Math.abs(p.balcony.x1);
      b.box(
        "galvanised",
        v3(s * ((bx0 + bx1) / 2), -0.15, (z0 + z1) / 2),
        v3(bx1 - bx0, 0.1, z1 - z0),
      );
      b.box(
        "steelPainted",
        v3(s * (bx1 - 0.05), -0.25, (z0 + z1) / 2),
        v3(0.1, 0.3, z1 - z0),
      );
      for (let k = 0; k <= p.span; k++)
        b.box(
          "steelPainted",
          v3(
            s * ((bx0 + bx1) / 2),
            -0.32,
            Math.min(z1 - 0.06, Math.max(z0 + 0.06, z0 + k * W)),
          ),
          v3(bx1 - bx0, 0.22, 0.1),
        );
      // Services: two cable trays + a spiral duct, battens under the trays.
      for (const x of [6.2, 9.6])
        this.trayZ(b, s * x, -0.95, z0 + 0.3, z1 - 0.3);
      b.cylinder(
        "galvanised",
        v3(s * 7.9, -1.2, (z0 + z1) / 2),
        z1 - z0 - 0.6,
        0.5,
        0.5,
        16,
        {
          pitch: Math.PI / 2,
        },
      );
      for (let z = z0 + W / 2; z < z1 - 0.3; z += W)
        b.box(
          "galvanised",
          v3(s * 7.9, (U + -1.2) / 2, z),
          v3(0.02, -1.2 - U, 0.02),
        );
      // Slab-edge LED strips (front + glass-strip edge), tray battens.
      this.ledZ(b, s * (front + 0.45), stripY, z0 + 0.2, z1 - 0.2, 2.4, 0.85);
      this.ledZ(b, s * (xg - 0.3), stripY, z0 + 0.2, z1 - 0.2, 2.4, 0.85);
      for (let k = 0; k < p.span; k++) {
        const zc = z0 + (k + 0.5) * W;
        for (const x of [6.2, 9.6])
          this.ledZ(b, s * x, -1.02, zc - 0.8, zc + 0.8, 1.6, 1.0);
      }
    }

    // ---- Spine (hall) soffit around the glass strip, tower bay, stair wells.
    const L = building.hall.length;
    const gw = SPINE_GLASS_W / 2;
    const bayZ = Math.max(0, L - TOWER_BAY_D);
    const holes: Rect[] = [
      { x0: -gw, x1: gw, z0: 0, z1: bayZ },
      { x0: -front, x1: front, z0: bayZ, z1: L },
      ...fl.spineStairs.map((st) => st.rect),
    ];
    for (const r of rectMinusHoles(
      { x0: -front, x1: front, z0: 0, z1: L },
      holes,
    ))
      this.soffit(b, r);
    // Spine edge beams (finished fascia on both hall edges, over the front
    // column line): closes the slab edge at empty bays, sits under the room
    // soffits elsewhere. Stops short of the control-room footprint.
    for (const s of [-1, 1])
      b.box(
        "concreteSoffit",
        v3(s * (front + 0.15), (HALL.SOFFIT_TOP + U - 0.3) / 2, (L - 0.2) / 2),
        v3(0.3, HALL.SOFFIT_TOP - U + 0.3, L - 0.2),
      );
    // Glass strip edge beams (inside the strip's opening, their bottoms
    // 2 cm below the soffit: no coplanar faces) + ribs; tower-bay grillage.
    for (const s of [-1, 1])
      b.box(
        "steelPainted",
        v3(s * (gw - 0.08), (-0.12 + HALL.SOFFIT_BOT - 0.02) / 2, bayZ / 2),
        v3(0.16, -0.12 - HALL.SOFFIT_BOT + 0.02, bayZ),
      );
    for (let z = 1.2; z < bayZ - 0.1; z += 1.2)
      b.box("steelPainted", v3(0, -0.22, z), v3(gw * 2 - 0.32, 0.2, 0.08));
    if (L - bayZ > 0.5) {
      for (let z = bayZ; z <= L + 1e-6; z += 1.0)
        b.box(
          "steelPainted",
          v3(0, -0.26, Math.min(z, L - 0.08)),
          v3(front * 2, 0.28, 0.12),
        );
      for (const x of [-front + 0.1, -1.2, 1.2, front - 0.1])
        b.box(
          "steelPainted",
          v3(x, -0.26, (bayZ + L) / 2),
          v3(0.12, 0.28, L - bayZ),
        );
    }
    // Stair-well trimmers.
    for (const st of fl.spineStairs) {
      const r = st.rect;
      const inner = Math.abs(r.x0) < Math.abs(r.x1) ? r.x0 : r.x1;
      b.box(
        "steelPainted",
        v3(inner, -0.28, (r.z0 + r.z1) / 2),
        v3(0.16, 0.32, r.z1 - r.z0),
      );
      for (const z of [r.z0, r.z1])
        b.box(
          "steelPainted",
          v3((r.x0 + r.x1) / 2, -0.28, z),
          v3(r.x1 - r.x0, 0.32, 0.16),
        );
    }
    // Main-line lighting off the glass-strip edges; spine trays.
    for (const s of [-1, 1]) {
      this.ledZ(b, s * (gw + 0.3), stripY, 0.3, bayZ - 0.3, 3.2, 0.9);
      this.trayZ(b, s * 1.7, -0.9, 0.3, L - 0.3);
    }

    // The control room draws its own round underside (no soffit, trays,
    // LEDs or columns of ours inside its footprint).
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  private buildColumns(
    b: ArtBatcher,
    fl: FactoryLayout,
    building: BuildingLayout,
  ): void {
    const fy = fl.floorY;
    const topC = HALL.SOFFIT_BOT;
    const W = LAYOUT.ROOM_W;
    const front = LAYOUT.HALL_W / 2;
    const outer = front + LAYOUT.ROOM_D;
    const pts = new Map<string, { x: number; z: number }>();
    const add = (x: number, z: number) =>
      pts.set(`${x.toFixed(2)},${z.toFixed(2)}`, { x, z });
    // Room columns, nudged under the slab (clear of the spine-stair wells
    // on the front line and centred under the glass-strip edge beam).
    const nudge = (x: number) => {
      const a = Math.abs(x);
      const s = Math.sign(x) || 1;
      if (Math.abs(a - front) < 0.3) return s * (front + 0.15);
      if (Math.abs(a - outer) < 0.3) return s * (outer - 0.15);
      return x;
    };
    const zEnd = building.hall.length - 0.2; // clear of the control room
    for (const c of fl.cells)
      for (const p of c.columns) add(nudge(p.x), Math.min(p.z, zEnd));
    // Spine edge grid (rooms or not).
    // (the last one stops short of the control-room footprint).
    for (let k = 0; k <= building.bays; k++)
      for (const s of [-1, 1]) add(s * (front + 0.15), Math.min(k * W, zEnd));
    const C = HALL.COLUMN;
    for (const { x, z } of pts.values()) {
      // Front-line columns carry the spine edge beam (0.3 m deeper).
      const top =
        Math.abs(Math.abs(x) - (front + 0.15)) < 0.01 ? topC - 0.3 : topC;
      b.box("steelPainted", v3(x, (fy + top) / 2, z), v3(C, top - fy, C));
      b.box("steelPainted", v3(x, fy + 0.015, z), v3(0.55, 0.03, 0.55));
      b.box("steelPainted", v3(x, top - 0.015, z), v3(0.45, 0.03, 0.45));
      this.paint(b, PAINT.yellow, () =>
        b.box("paint", v3(x, fy + 0.5, z), v3(C + 0.03, 0.9, C + 0.03)),
      );
      this.col(
        new Vector3(x, (fy + top) / 2, z),
        new Vector3(C + 0.04, top - fy, C + 0.04),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Stairs (visual steel + hidden ramp colliders)
  // -------------------------------------------------------------------------

  private buildStairs(b: ArtBatcher, fl: FactoryLayout): void {
    const fy = fl.floorY;
    // Spine-node stairs: one 35° flight from the well's top edge, carrying on
    // under the hall slab past the well (≥ 4 m headroom there).
    for (const st of fl.spineStairs) {
      steelFlight(b, this.ctx.colliders, G, spineFlight(st, fy), {
        guardFloor: fy,
      });
    }
    // Per-cell switchback stairs (balcony → entry bay): three 2 m flights.
    // The top landing sits at the balcony door's end (offsets mirror in z).
    const S = CELL_STAIR;
    for (const c of fl.cells) {
      const s = c.side === "east" ? 1 : -1;
      const W = LAYOUT.ROOM_W;
      const m = c.stair.top.z - c.z0 > W / 2;
      const Z = (o: number) => (m ? c.z0 + W - o : c.z0 + o);
      const X = (a: number) => s * a;
      const R = (x0: number, x1: number, o0: number, o1: number): Rect => ({
        x0: Math.min(X(x0), X(x1)),
        x1: Math.max(X(x0), X(x1)),
        z0: Math.min(Z(o0), Z(o1)),
        z1: Math.max(Z(o0), Z(o1)),
      });
      const flights = cellStairFlights(c, fy);
      steelLanding(
        b,
        this.ctx.colliders,
        G,
        R(S.top.x0, S.top.x1, S.top.z0, S.top.z1),
        0,
      );
      // Dividers: f1|f2 share the far landing (y −2), f2|f3 the near one
      // (y −4); their guards stop 0.7 m short of that end.
      const div = [S.flights[0].x1, S.flights[1].x1];
      const TRIM = 0.7;
      flights.forEach((f, k) => {
        const band = { x0: f.xa, x1: f.xb };
        const trims: { x: number; end: "top" | "bottom"; len: number }[] = [];
        if (k === 0) trims.push({ x: X(div[0]), end: "bottom", len: TRIM });
        if (k === 1) {
          trims.push({ x: X(div[0]), end: "top", len: TRIM });
          trims.push({ x: X(div[1]), end: "bottom", len: TRIM });
        }
        if (k === 2) trims.push({ x: X(div[1]), end: "top", len: TRIM });
        // Guards sit 0.025 inside the band edge.
        for (const t of trims) t.x += band.x0 < t.x - 0.5 ? -0.025 : 0.025;
        steelFlight(b, this.ctx.colliders, G, f, { guardFloor: fy, trims });
      });
      steelLanding(
        b,
        this.ctx.colliders,
        G,
        R(S.far.x0, S.far.x1, S.far.z0, S.far.z1),
        -2,
      );
      steelLanding(
        b,
        this.ctx.colliders,
        G,
        R(S.near.x0, S.near.x1, S.near.z0, S.near.z1),
        -4,
      );
      // Landing guards on the open edges (never across a flight entry).
      const g = 0.03;
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "x",
        Z(S.far.z1 - g),
        X(S.far.x0),
        X(S.far.x1),
        -2,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "z",
        X(S.far.x0 + g),
        Z(S.far.z0),
        Z(S.far.z1),
        -2,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "z",
        X(S.far.x1 - g),
        Z(S.far.z0),
        Z(S.far.z1),
        -2,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "x",
        Z(S.near.z0 + g),
        X(S.near.x0),
        X(S.near.x1),
        -4,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "z",
        X(S.near.x0 + g),
        Z(S.near.z0),
        Z(S.near.z1),
        -4,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "z",
        X(S.near.x1 - g),
        Z(S.near.z0),
        Z(S.near.z1),
        -4,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "x",
        Z(S.top.z0 + g),
        X(S.top.x0),
        X(S.top.x1),
        0,
      );
      steelRail(
        b,
        this.ctx.colliders,
        G,
        "z",
        X(S.top.x1 - g),
        Z(S.top.z0),
        Z(S.top.z1),
        0,
      );
      // Supports under the landings.
      for (const [x, o, y] of [
        [S.far.x0 + 0.06, S.far.z1 - 0.06, -2],
        [S.far.x1 - 0.06, S.far.z1 - 0.06, -2],
        [S.near.x1 - 0.06, S.near.z0 + 0.06, -4],
        [S.near.x0 + 0.06, S.near.z0 + 0.06, -4],
        [S.top.x1 - 0.06, S.top.z0 + 0.06, 0],
      ])
        steelPost(b, this.ctx.colliders, G, X(x), Z(o), fy, y - 0.19);
    }
  }

  /**
   * The main line's tail (R14): a drive / tail-pulley housing with a yellow
   * end-stop where the belt starts (one metre before the first feeder
   * joins), instead of the belt ending in open air.
   */
  private buildMainLineEnd(b: ArtBatcher, fl: FactoryLayout): void {
    if (!fl.cells.length) return;
    const fy = fl.floorY;
    const z0 = Math.min(...fl.cells.map((c) => c.trunk.feederZ)) - 1;
    const h = 1.0;
    const d = 0.55;
    const zc = z0 - 0.06 - d / 2;
    b.box("steelPainted", v3(0, fy + h / 2, zc), v3(1.3, h, d));
    b.box("galvanised", v3(0, fy + h - 0.02, zc), v3(1.34, 0.04, d + 0.04));
    for (const s of [-1, 1])
      b.box("blackMetal", v3(s * 0.69, fy + 0.62, zc), v3(0.06, 0.3, 0.3));
    this.paint(b, PAINT.yellow, () =>
      // End-stop band on the housing's south face.
      b.box("paint", v3(0, fy + 0.55, zc - d / 2 - 0.01), v3(1.3, 0.25, 0.02)),
    );
    this.col(new Vector3(0, fy + h / 2, zc), new Vector3(1.4, h, d + 0.05));
  }

  /**
   * Step-over crossovers on the feeders (`fl.crossovers`): a 33.7° steel
   * flight up each side onto a grating deck 2 m above the floor (over the
   * tallest workpiece), handrails continuous along the flights and the deck,
   * legs outside the belt. Colliders: both ramps (flush with the floor and
   * the deck), the deck plate, side guards over the flights, deck rails.
   */
  private buildCrossovers(b: ArtBatcher, fl: FactoryLayout): void {
    const fy = fl.floorY;
    const C = CROSSOVER;
    const cols = this.ctx.colliders;
    for (const x of fl.crossovers) {
      const xa = x.x - C.W / 2;
      const xb = x.x + C.W / 2;
      const d0 = x.z - C.DECK_HALF;
      const d1 = x.z + C.DECK_HALF;
      for (const f of crossoverFlights(x, fy))
        steelFlight(b, cols, G, f, { guardFloor: fy });
      steelLanding(b, cols, G, { x0: xa, x1: xb, z0: d0, z1: d1 }, x.deckY);
      for (const gx of [xa + 0.025, xb - 0.025]) {
        steelRail(b, cols, G, "z", gx, d0, d1, x.deckY);
        // Toe board along the deck edge.
        b.box(
          "steelPainted",
          v3(gx, x.deckY + 0.05, x.z),
          v3(0.01, 0.1, d1 - d0),
        );
      }
      for (const px of [xa + 0.06, xb - 0.06])
        for (const pz of [d0 + 0.06, d1 - 0.06])
          steelPost(b, cols, G, px, pz, fy, x.deckY - 0.19);
    }
  }

  // -------------------------------------------------------------------------
  // Goods lift (teleport pad) + high bays
  // -------------------------------------------------------------------------

  private buildHighBays(b: ArtBatcher, fl: FactoryLayout): void {
    const ry = HALL.ROOF_Y;
    const y = HALL.HIGHBAY_Y;
    const W = LAYOUT.ROOM_W;
    for (const c of fl.cells) {
      const s = c.side === "east" ? 1 : -1;
      for (let z = c.z0 + W / 2; z < c.z1; z += W)
        for (const ax of HALL.HIGHBAY_X) {
          const x = s * ax;
          b.box(
            "galvanised",
            v3(x, (ry + y + 0.2) / 2, z),
            v3(0.02, ry - y - 0.2, 0.02),
          );
          b.cylinder("steelPainted", v3(x, y + 0.12, z), 0.24, 0.3, 0.55, 16);
          b.cylinder("lightPanel", v3(x, y - 0.005, z), 0.01, 0.5, 0.5, 16);
          // 1.0 (was 1.35): the bays no longer clip through the drum glazing.
          this.fixtureList.push(
            fixture(x, y - 0.05, z, {
              kind: "down",
              color: "#F2F5FF",
              intensity: 1.0,
              range: 7.8,
            }),
          );
        }
    }
  }
}
