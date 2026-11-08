/**
 * Shipping dock at the end of the factory main line (P3.3, static build).
 *
 * Merged code is packaged at the gantry, shelved as release boxes and leaves
 * on a branded truck. Local frame: origin = centre of the dock's front wall at
 * the APRON level, +z = out onto the apron (trucks), -z = into the plant (the
 * main line arrives along x = 0 from -z). Doors sit at x = -9, 0, 9.
 *
 * Draw budget: 7 dock draws (matte, metal, led, doors, board, boxes, labels)
 * + 2 truck draws. No GlowLayer. Every DynamicTexture is drawn on change only.
 */
import {
  Color3,
  CreateBox,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  TransformNode,
  VertexBuffer,
  VertexData,
  Vector3,
} from "@/engine/babylon";
import type { ColliderSink } from "@/engine/physics/Colliders";
import type {
  BrandingOptions,
  PipelineRun,
  ReleaseInfo,
} from "@/engine/contracts";
import { DEFAULT_BRANDING } from "@/engine/world/brandLayout";
import {
  flight,
  guardBox,
  rampBox,
  STAIR_RAIL_TOP,
  treads,
  type Flight,
} from "@/engine/world/stairs";
import {
  BOARD_TEX_H,
  BOARD_TEX_W,
  DOOR_TEX_H,
  DOOR_TEX_W,
  LABEL_CELL_H,
  LABEL_CELL_W,
  LABEL_COLS,
  LABEL_ROWS,
  accentOf,
  drawBoard,
  drawDoorAtlas,
  drawLabelAtlas,
  labelCell,
  makeDotMask,
} from "@/engine/world/factory/dockArt";
import {
  SHELF,
  boardLines,
  shade,
  slotReleases,
  type ShelfSlot,
} from "@/engine/world/factory/dockModel";
import { MeshSoup, hexColor, type RGBA } from "@/engine/world/factory/meshSoup";
import { Truck } from "@/engine/world/factory/Truck";
import { applyWorldUVs, Materials } from "@/engine/materials/Materials";

type Ctx2D = CanvasRenderingContext2D;

/** Geometry constants (m), dock-local. */
export const DOCK = {
  width: 32,
  depth: 14,
  wallH: 7,
  platformH: 1.2,
  doorXs: [-9, 0, 9] as const,
  doorW: 3.4,
  doorH: 3.6,
  canopyDepth: 5.2,
  canopyY: 5.6,
  bumperZ: 0.16,
  /** Door index the truck is parked at. */
  truckDoor: 1,
  /** Draws contributed by the dock itself (truck adds 2 more). */
  draws: 7,
} as const;

/**
 * Loading stair on the platform's plant-side (-z) face, dock-local. Top flush
 * with the platform edge (z = -depth), bottom flush with the plant floor.
 * Pitch = atan(1.2 / 2.4) = 26.6 deg, well under the 35 deg walk limit.
 */
export const DOCK_STAIR = {
  x: -6,
  width: 1.5,
  run: 2.4,
  steps: 7,
  railTop: STAIR_RAIL_TOP,
} as const;

/** Teleport landing on the platform in front of the truck's door (dock-local). */
export const DOCK_SPAWN = { x: 3, y: 0.05, z: -3.5 } as const;

/**
 * Static colliders in the dock-local frame: the platform slab, the door wall
 * above it, side walls, and the stair's hidden ramp (top face through the top
 * and bottom nosing, no lip) with vertical side guards over the flight only.
 */
export function addDockColliders(sink: ColliderSink, group: string): void {
  const pH = DOCK.platformH;
  const W = DOCK.width;
  const D = DOCK.depth;
  const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  sink.addBox(group, v(0, pH / 2, -D / 2), v(W, pH, D));
  sink.addBox(
    group,
    v(0, (pH + DOCK.wallH) / 2, -0.15),
    v(W, DOCK.wallH - pH, 0.3),
  );
  for (const sx of [-1, 1])
    sink.addBox(
      group,
      v(sx * (W / 2 - 0.15), (pH + DOCK.wallH) / 2, -D / 2),
      v(0.3, DOCK.wallH - pH, D),
    );
  const st = DOCK_STAIR;
  const f = dockStairFlight();
  const ramp = rampBox(f);
  sink.addBox(group, ramp.c, ramp.s, 0, { pitch: ramp.pitch });
  for (const sx of [-1, 1]) {
    const g = guardBox(f, st.x + (sx * (st.width - 0.05)) / 2, 0);
    sink.addBox(group, g.c, g.s);
  }
}

/** The loading stair as a `stairs.ts` flight (dock-local, top at the platform edge). */
export function dockStairFlight(): Flight {
  const st = DOCK_STAIR;
  const D = DOCK.depth;
  return flight(
    st.x - st.width / 2,
    st.x + st.width / 2,
    -D,
    -D - st.run,
    DOCK.platformH,
    0,
    DOCK.platformH / st.steps,
  );
}

/** Shelf bay centre z, rack face x (dock-local). */
const BAY_Z0 = -11.4;
const BAY_DZ = 3.1;
const RACK_FACE_X = 15.1;
const BOX = { x: 0.5, y: 0.42, z: 0.6 };
const COL_DZ = 0.7;
const BEAM_TOPS = [0.25, 1.05, 1.85];

export interface DockOptions {
  x?: number;
  y?: number;
  z?: number;
  /** Yaw (rad) about +y; the dock's +z (apron) rotates with it. */
  yaw?: number;
  parent?: TransformNode | null;
  branding?: BrandingOptions;
  /** Side walls (default true). */
  walls?: boolean;
  /** Include the parked truck (default true). */
  truck?: boolean;
}

type Range = [number, number];

export class Dock {
  readonly root: TransformNode;
  readonly truck: Truck | null;
  readonly meshes: Mesh[] = [];

  private readonly scene: Scene;
  private brand: BrandingOptions;
  private releases: ReleaseInfo[] = [];
  private deploys: PipelineRun[] = [];
  private nowMs = Date.now();

  private matte!: Mesh;
  private metal!: Mesh;
  private led!: Mesh;
  private metalAccent: Range[] = [];
  private ledAccent: Range[] = [];
  private matteAccent: Range[] = [];
  private lastAccent = "";

  private doorMesh!: Mesh;
  private readonly doorTex: DynamicTexture;
  private readonly doorOpen: number[] = [0, 0, 0];
  private doorDirty = false;

  private readonly boardTex: DynamicTexture;
  private dotMask: HTMLCanvasElement | null = null;

  private boxes!: Mesh;
  private boxStrap: Range[] = [];
  private labels!: Mesh;
  private readonly labelTex: DynamicTexture;
  private slots: ShelfSlot[] = [];

  private logoImg: HTMLImageElement | null = null;
  private logoSrc: string | null = null;
  private logoToken = 0;
  private disposed = false;

  // ---- Departure sequence stub state (see departTruck()).
  private seq: "idle" | "opening" | "driving" | "gone" = "idle";
  private seqT = 0;
  private truckZ: number = DOCK.bumperZ;

  constructor(scene: Scene, opts: DockOptions = {}) {
    this.scene = scene;
    this.brand = opts.branding ?? DEFAULT_BRANDING;
    this.root = new TransformNode("dock", scene);
    this.root.parent = opts.parent ?? null;
    this.root.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    this.root.rotation.y = opts.yaw ?? 0;

    this.buildStatic(opts.walls !== false);
    this.buildDoors();
    this.doorTex = this.makeTexture(
      "dock:doors",
      DOOR_TEX_W * DOCK.doorXs.length,
      DOOR_TEX_H,
      true,
    );
    // Painted steel roller doors (dielectric; the canvas carries the slats).
    const dm = new PBRMaterial("dock:doorMat", scene);
    dm.albedoTexture = this.doorTex;
    dm.metallic = 0;
    dm.roughness = 0.5;
    dm.environmentIntensity = 0.6;
    this.doorMesh.material = dm;
    dm.freeze();

    this.boardTex = this.makeTexture(
      "dock:board",
      BOARD_TEX_W,
      BOARD_TEX_H,
      true,
    );
    this.buildBoard();
    this.buildShelfBoxes();
    this.labelTex = this.makeTexture(
      "dock:labels",
      LABEL_CELL_W * LABEL_COLS,
      LABEL_CELL_H * LABEL_ROWS,
      true,
    );
    this.buildLabels();

    if (opts.truck !== false) {
      this.truck = new Truck(scene, this.root, this.brand);
      this.truck.root.position.set(
        DOCK.doorXs[DOCK.truckDoor],
        0,
        DOCK.bumperZ,
      );
    } else this.truck = null;

    for (const m of this.meshes) m.parent = this.root;
    this.applyBranding(true);
    this.redrawBoard();
    this.redrawLabels();
    this.setDoor(DOCK.truckDoor, 0);
    // Kick off the (async) logo load for doors + livery.
    if (this.brand.logo) {
      const b = this.brand;
      this.logoSrc = null;
      this.setBranding(b);
    }
  }

  // ------------------------------------------------------------------ API

  /** Name / tagline / logo / colour for door marks, board header, truck livery. */
  setBranding(b: BrandingOptions): void {
    this.brand = b;
    if (b.logo !== this.logoSrc) {
      this.logoSrc = b.logo;
      this.logoImg = null;
      const my = ++this.logoToken;
      if (b.logo) {
        const img = new Image();
        img.onload = () => {
          if (my !== this.logoToken || this.disposed) return;
          this.logoImg = img;
          this.redrawDoors();
        };
        img.src = b.logo;
      }
    }
    this.truck?.setBranding(b);
    this.applyBranding(false);
  }

  /** Recent releases (any order; newest are shelved first). */
  setReleases(list: readonly ReleaseInfo[]): void {
    this.releases = [...list];
    this.rebuildShelves();
    this.redrawBoard();
  }

  /** Pipeline runs; deploy and release kinds feed the departures board. */
  setDeploys(pipelines: readonly PipelineRun[]): void {
    this.deploys = [...pipelines];
    this.redrawBoard();
  }

  /** Reference time for board ages (default Date.now() at call time). */
  setNow(ms: number): void {
    this.nowMs = ms;
    this.redrawBoard();
    this.redrawLabels();
  }

  /** Current shelf slots (for tests / picking later). */
  get shelfSlots(): readonly ShelfSlot[] {
    return this.slots;
  }

  /** Rolled-up door state: 0 closed .. 1 fully open. */
  setDoor(index: number, open: number): void {
    if (index < 0 || index >= this.doorOpen.length) return;
    const v = Math.max(0, Math.min(1, open));
    if (
      Math.abs(v - this.doorOpen[index]) < 1e-4 &&
      this.doorMeshReady &&
      !this.doorDirty
    )
      return;
    this.doorOpen[index] = v;
    this.writeDoors();
  }

  /** Stub: start the truck departure (door opens, truck drives out +z). */
  departTruck(): void {
    if (!this.truck || this.seq === "opening" || this.seq === "driving") return;
    this.seq = "opening";
    this.seqT = 0;
  }

  /** Stub: bring a (new) truck back to the bay and close up. */
  resetTruck(): void {
    if (!this.truck) return;
    this.seq = "idle";
    this.truckZ = DOCK.bumperZ;
    this.truck.root.position.z = this.truckZ;
    this.truck.root.setEnabled(true);
    this.setDoor(DOCK.truckDoor, 0);
  }

  /** Per-frame hook: ONLY drives the departure stub; no texture work. */
  update(dt: number): void {
    if (this.seq === "idle" || this.seq === "gone" || !this.truck) return;
    this.seqT += dt;
    if (this.seq === "opening") {
      this.setDoor(DOCK.truckDoor, this.seqT / 1.6);
      if (this.seqT >= 1.6) {
        this.seq = "driving";
        this.seqT = 0;
      }
    } else if (this.seq === "driving") {
      // Ease from standstill to ~6 m/s along +z.
      const t = this.seqT;
      this.truckZ = DOCK.bumperZ + 1.5 * t * t;
      this.truck.root.position.z = this.truckZ;
      if (this.truckZ > 80) {
        this.truck.root.setEnabled(false);
        this.seq = "gone";
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.logoToken++;
    this.truck?.dispose();
    for (const t of [this.doorTex, this.boardTex, this.labelTex]) t.dispose();
    for (const m of this.meshes) {
      m.material?.dispose();
      m.dispose();
    }
    this.root.dispose();
  }

  // ------------------------------------------------------------- building

  private makeTexture(
    name: string,
    w: number,
    h: number,
    mips: boolean,
  ): DynamicTexture {
    const t = new DynamicTexture(
      name,
      { width: w, height: h },
      this.scene,
      mips,
    );
    t.wrapU = Texture.CLAMP_ADDRESSMODE;
    t.wrapV = Texture.CLAMP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 8;
    return t;
  }

  private track(m: Mesh, name: string): Mesh {
    m.name = name;
    m.isPickable = false;
    m.receiveShadows = false;
    this.meshes.push(m);
    return m;
  }

  private buildStatic(walls: boolean): void {
    const scene = this.scene;
    const matte = new MeshSoup();
    const metal = new MeshSoup();
    const led = new MeshSoup();
    const mark = (s: MeshSoup, store: Range[], fn: () => void): void => {
      const a = s.positions.length / 3;
      fn();
      store.push([a, s.positions.length / 3]);
    };
    const acc = hexColor(accentOf(this.brand));

    const concrete = hexColor("#c9cdd2");
    const concreteDark = hexColor("#8a9098");
    const floorC = hexColor("#b4b8bd");
    const joint = hexColor("#9a9fa5");
    const yellow = hexColor("#f2c500");
    const black = hexColor("#121316");
    const rubber = hexColor("#18191c");
    const satin = hexColor("#aeb4bc");
    const graphite = hexColor("#2b2f35");
    const pH = DOCK.platformH;
    const W2 = DOCK.width / 2;
    const D = DOCK.depth;

    // ---- Platform slab + expansion joints + safety lines.
    matte.span(-W2, 0, -D, W2, pH, 0, floorC);
    matte.span(-W2, 0, -0.02, W2, 0.35, 0.04, concreteDark); // plinth strip
    for (let z = -D + 3.5; z < 0; z += 3.5)
      matte.span(-W2, pH + 0.001, z - 0.02, W2, pH + 0.004, z + 0.02, joint);
    for (let x = -W2 + 4; x < W2; x += 4)
      matte.span(x - 0.02, pH + 0.001, -D, x + 0.02, pH + 0.004, 0, joint);
    for (const dx of DOCK.doorXs) {
      for (const sx of [-1, 1])
        matte.span(
          dx + sx * 2.45 - 0.07,
          pH + 0.005,
          -5.6,
          dx + sx * 2.45 + 0.07,
          pH + 0.008,
          0,
          yellow,
        );
      matte.span(
        dx - 2.45,
        pH + 0.005,
        -5.6 - 0.07,
        dx + 2.45,
        pH + 0.008,
        -5.6 + 0.07,
        yellow,
      );
    }
    // Main-line axis marking toward the gantry.
    matte.span(-0.04, pH + 0.005, -D, 0.04, pH + 0.008, -6.2, yellow);

    // ---- Loading stair: galvanised treads, yellow nosings, painted stringers,
    // black handrails + balusters on both sides (open middle = walking path).
    {
      const st = DOCK_STAIR;
      const f = dockStairFlight();
      const x0 = f.xa;
      const x1 = f.xb;
      // Treads from stairs.ts: each nosing (the -z edge) on the ramp line.
      for (const t of treads(f)) {
        const zFar = t.zNose + f.going; // uphill edge (toward the platform)
        metal.span(
          x0 + 0.05,
          t.yt - 0.04,
          t.zNose,
          x1 - 0.05,
          t.yt,
          zFar,
          satin,
        );
        matte.span(
          x0 + 0.06,
          t.yt,
          t.zNose,
          x1 - 0.06,
          t.yt + 0.006,
          t.zNose + 0.05,
          yellow,
        );
      }
      const slab = (
        zA: number,
        yA: number,
        zB: number,
        yB: number,
        t: number,
      ) =>
        [
          [zA, yA],
          [zB, yB],
          [zB, yB - t],
          [zA, yA - t],
        ] as [number, number][];
      for (const [xa, xb] of [
        [x0, x0 + 0.06],
        [x1 - 0.06, x1],
      ] as const) {
        metal.prismZY(slab(-D, pH, -D - st.run, 0, 0.26), xa, xb, graphite);
        const xr = (xa + xb) / 2;
        const rt = st.railTop;
        metal.prismZY(
          slab(-D, pH + rt + 0.025, -D - st.run, rt + 0.025, 0.05),
          xr - 0.025,
          xr + 0.025,
          black,
        );
        const nb = 8;
        for (let k = 0; k <= nb; k++) {
          const t = k / nb;
          const z = -D - t * st.run;
          const y = pH - t * pH;
          metal.span(
            xr - 0.012,
            y,
            z - 0.012,
            xr + 0.012,
            y + rt,
            z + 0.012,
            black,
          );
        }
        // Newel post on the platform where the rail returns to the edge.
        metal.span(
          xr - 0.03,
          pH,
          -D - 0.03,
          xr + 0.03,
          pH + rt + 0.05,
          -D + 0.03,
          black,
        );
      }
    }

    // ---- Front wall (piers + header), side walls, fascia.
    const wallT = 0.3;
    const wallTop = DOCK.wallH;
    const doorTop = pH + DOCK.doorH;
    const edges: number[] = [-W2];
    for (const dx of DOCK.doorXs)
      edges.push(dx - DOCK.doorW / 2, dx + DOCK.doorW / 2);
    edges.push(W2);
    for (let i = 0; i < edges.length; i += 2)
      matte.span(edges[i], pH, -wallT, edges[i + 1], wallTop, 0, concrete);
    matte.span(-W2, doorTop, -wallT, W2, wallTop, 0, concrete);
    if (walls)
      for (const sx of [-1, 1])
        matte.span(
          sx > 0 ? W2 - wallT : -W2,
          pH,
          -D,
          sx > 0 ? W2 : -W2 + wallT,
          wallTop,
          -wallT,
          concrete,
        );
    // Fascia (satin metal) with an accent stripe under it.
    metal.span(
      -W2 - 0.3,
      wallTop - 0.9,
      -wallT,
      W2 + 0.3,
      wallTop + 0.25,
      0.14,
      satin,
    );
    mark(led, this.ledAccent, () =>
      led.span(
        -W2 - 0.3,
        wallTop - 1.0,
        0.1,
        W2 + 0.3,
        wallTop - 0.94,
        0.16,
        acc,
      ),
    );

    // ---- Door frames, bumpers, levellers, traffic lights.
    for (const [i, dx] of DOCK.doorXs.entries()) {
      const hw = DOCK.doorW / 2;
      metal.span(
        dx - hw - 0.14,
        pH,
        -0.05,
        dx - hw,
        doorTop + 0.14,
        0.1,
        satin,
      );
      metal.span(
        dx + hw,
        pH,
        -0.05,
        dx + hw + 0.14,
        doorTop + 0.14,
        0.1,
        satin,
      );
      metal.span(
        dx - hw - 0.14,
        doorTop,
        -0.05,
        dx + hw + 0.14,
        doorTop + 0.14,
        0.1,
        satin,
      );
      // Rubber bumpers on the platform face.
      for (const sx of [-1, 1])
        matte.span(
          dx + sx * 1.55 - 0.15,
          pH - 0.5,
          0,
          dx + sx * 1.55 + 0.15,
          pH - 0.05,
          DOCK.bumperZ,
          rubber,
        );
      // Dock leveller: deck + lip, hazard-striped edges.
      metal.span(
        dx - 1.15,
        pH - 0.01,
        -2.0,
        dx + 1.15,
        pH + 0.012,
        0,
        graphite,
      );
      metal.span(
        dx - 1.15,
        pH - 0.012,
        0,
        dx + 1.15,
        pH + 0.012,
        0.42,
        graphite,
      );
      const seg = 0.21;
      const stripe = (
        x0: number,
        z0: number,
        x1: number,
        z1: number,
        n: number,
        alongX: boolean,
      ) => {
        for (let k = 0; k < n; k++) {
          const c = k % 2 === 0 ? yellow : black;
          if (alongX)
            matte.span(
              x0 + k * seg,
              pH + 0.012,
              z0,
              x0 + (k + 1) * seg,
              pH + 0.02,
              z1,
              c,
            );
          else
            matte.span(
              x0,
              pH + 0.012,
              z0 + k * seg,
              x1,
              pH + 0.02,
              z0 + (k + 1) * seg,
              c,
            );
        }
      };
      for (const sx of [-1, 1]) {
        const xa = dx + sx * 1.15 - (sx > 0 ? 0.07 : 0);
        stripe(xa, -2.0, xa + 0.07, 0, 9, false);
        stripe(xa, 0, xa + 0.07, 0.42, 2, false);
      }
      stripe(dx - 1.15, 0.35, dx + 1.15, 0.42, 11, true);
      // Traffic light: red where a truck is docked, green elsewhere.
      const tl =
        i === DOCK.truckDoor ? hexColor("#ff3b30") : hexColor("#35e08a");
      metal.span(
        dx + 2.0 - 0.1,
        pH + 1.9,
        0.02,
        dx + 2.0 + 0.1,
        pH + 2.6,
        0.12,
        graphite,
      );
      led.span(
        dx + 2.0 - 0.06,
        pH + 2.2,
        0.12,
        dx + 2.0 + 0.06,
        pH + 2.5,
        0.15,
        tl,
      );
    }

    // ---- Canopy (apron side) with LED edge + downlights, slim columns.
    const cy = DOCK.canopyY;
    const cd = DOCK.canopyDepth;
    metal.span(-W2 - 0.6, cy, 0.14, W2 + 0.6, cy + 0.28, cd - 0.08, satin);
    metal.span(
      -W2 - 0.6,
      cy - 0.04,
      cd - 0.08,
      W2 + 0.6,
      cy + 0.32,
      cd,
      graphite,
    );
    mark(led, this.ledAccent, () =>
      led.span(
        -W2 - 0.6,
        cy - 0.06,
        cd - 0.02,
        W2 + 0.6,
        cy - 0.01,
        cd + 0.03,
        acc,
      ),
    );
    for (let x = -W2 + 2; x < W2; x += 3) {
      led.span(
        x - 0.5,
        cy - 0.015,
        1.2,
        x + 0.5,
        cy,
        1.34,
        hexColor("#f4f8ff"),
      );
      led.span(
        x - 0.5,
        cy - 0.015,
        3.4,
        x + 0.5,
        cy,
        3.54,
        hexColor("#f4f8ff"),
      );
    }
    for (const x of [-13.5, -4.5, 4.5, 13.5])
      metal.span(x - 0.14, 0, cd - 0.3, x + 0.14, cy, cd - 0.02, satin);
    // Light bars on the wall under the canopy (above the doors).
    for (const dx of DOCK.doorXs)
      led.span(
        dx - 1.4,
        doorTop + 0.3,
        0.14,
        dx + 1.4,
        doorTop + 0.34,
        0.18,
        hexColor("#f4f8ff"),
      );

    // ---- Departures board frame (east pier).
    const bx = 13.35;
    const by = 3.95;
    metal.span(bx - 2.42, by - 1.22, 0.0, bx + 2.42, by + 1.22, 0.1, graphite);
    metal.span(bx - 2.46, by - 1.26, 0.0, bx + 2.46, by - 1.22, 0.12, satin);
    metal.span(bx - 2.46, by + 1.22, 0.0, bx + 2.46, by + 1.26, 0.12, satin);
    mark(led, this.ledAccent, () =>
      led.span(bx - 2.3, by - 1.32, 0.1, bx + 2.3, by - 1.28, 0.14, acc),
    );

    // ---- Packaging station: end of the main line.
    const bz0 = -D;
    const beltTop = pH + 0.9;
    const beltEnd = -6.3;
    metal.span(-0.62, pH, bz0, -0.52, beltTop - 0.06, beltEnd, satin); // side rails
    metal.span(0.52, pH, bz0, 0.62, beltTop - 0.06, beltEnd, satin);
    matte.span(
      -0.52,
      beltTop - 0.1,
      bz0,
      0.52,
      beltTop,
      beltEnd,
      hexColor("#25282d"),
    );
    for (let z = bz0 + 1; z < beltEnd; z += 1.4) {
      metal.span(-0.58, pH, z - 0.05, -0.5, beltTop - 0.1, z + 0.05, graphite); // legs
      metal.span(0.5, pH, z - 0.05, 0.58, beltTop - 0.1, z + 0.05, graphite);
    }
    for (let z = bz0 + 0.3; z < beltEnd; z += 0.5)
      led.span(
        -0.5,
        beltTop + 0.001,
        z,
        0.5,
        beltTop + 0.006,
        z + 0.02,
        hexColor("#3b4048"),
      );
    // Portal gantry over the line.
    const gz = -9.6;
    for (const sx of [-1, 1]) {
      metal.span(
        sx * 1.55 - 0.11,
        pH,
        gz - 0.11,
        sx * 1.55 + 0.11,
        pH + 3.4,
        gz + 0.11,
        satin,
      );
      metal.span(
        sx * 1.55 - 0.2,
        pH,
        gz - 0.2,
        sx * 1.55 + 0.2,
        pH + 0.12,
        gz + 0.2,
        graphite,
      );
    }
    metal.span(-1.75, pH + 3.2, gz - 0.2, 1.75, pH + 3.5, gz + 0.2, satin);
    mark(led, this.ledAccent, () =>
      led.span(-1.7, pH + 3.17, gz - 0.12, 1.7, pH + 3.2, gz + 0.12, acc),
    );
    // Gripper head on pistons + the carton being boxed.
    for (const sx of [-0.45, 0.45])
      metal.cyl("y", sx, pH + 2.85, gz, 0.04, 0.6, graphite, 8);
    metal.span(-0.62, pH + 2.2, gz - 0.35, 0.62, pH + 2.5, gz + 0.35, graphite);
    matte.span(
      -0.42,
      beltTop,
      gz - 0.38,
      0.42,
      beltTop + 0.55,
      gz + 0.38,
      hexColor("#dde1e6"),
    );
    mark(led, this.ledAccent, () =>
      led.span(
        -0.43,
        beltTop + 0.2,
        gz - 0.39,
        0.43,
        beltTop + 0.3,
        gz + 0.39,
        acc,
      ),
    );
    // Wrap ring (rectangular frame) just downstream, with an inner LED.
    const rz = -8.1;
    const ry0 = beltTop + 0.05;
    const rh = 1.5;
    for (const sx of [-1, 1])
      metal.span(
        sx * 0.82 - 0.05,
        ry0,
        rz - 0.12,
        sx * 0.82 + 0.05,
        ry0 + rh,
        rz + 0.12,
        satin,
      );
    metal.span(
      -0.87,
      ry0 + rh,
      rz - 0.12,
      0.87,
      ry0 + rh + 0.1,
      rz + 0.12,
      satin,
    );
    metal.span(
      -0.87,
      ry0 - 0.05,
      rz - 0.12,
      0.87,
      ry0 + 0.03,
      rz + 0.12,
      satin,
    );
    mark(led, this.ledAccent, () => {
      led.span(-0.77, ry0 + 0.03, rz - 0.02, -0.74, ry0 + rh, rz + 0.02, acc);
      led.span(0.74, ry0 + 0.03, rz - 0.02, 0.77, ry0 + rh, rz + 0.02, acc);
      led.span(
        -0.74,
        ry0 + rh - 0.03,
        rz - 0.02,
        0.74,
        ry0 + rh,
        rz + 0.02,
        acc,
      );
    });
    // Controller cabinet beside the gantry.
    metal.span(1.9, pH, gz - 0.4, 2.5, pH + 1.6, gz + 0.4, graphite);
    led.span(
      1.88,
      pH + 1.1,
      gz - 0.2,
      1.9,
      pH + 1.4,
      gz + 0.2,
      hexColor("#35e08a"),
    );
    // Wrapped pallet at the staging spot (end of the line).
    const px = 0;
    const pz = -4.4;
    matte.span(
      px - 0.6,
      pH,
      pz - 0.5,
      px + 0.6,
      pH + 0.14,
      pz + 0.5,
      hexColor("#8a6b47"),
    );
    for (let ly = 0; ly < 2; ly++)
      for (const ox of [-0.29, 0.29])
        for (const oz of [-0.24, 0.24]) {
          matte.span(
            px + ox - 0.27,
            pH + 0.14 + ly * 0.4,
            pz + oz - 0.22,
            px + ox + 0.27,
            pH + 0.14 + ly * 0.4 + 0.38,
            pz + oz + 0.22,
            hexColor("#e3e6ea"),
          );
        }
    mark(led, this.ledAccent, () => {
      for (let ly = 0; ly < 2; ly++)
        led.span(
          px - 0.57,
          pH + 0.14 + ly * 0.4 + 0.15,
          pz - 0.47,
          px + 0.57,
          pH + 0.14 + ly * 0.4 + 0.2,
          pz + 0.47,
          acc,
        );
    });

    // ---- Release shelving (east wall).
    const rackBack = RACK_FACE_X + 0.7;
    for (let b = 0; b < SHELF.bays; b++) {
      const zc = BAY_Z0 + b * BAY_DZ;
      for (const sz of [-1, 1])
        metal.span(
          RACK_FACE_X - 0.04,
          pH,
          zc + sz * 1.52 - 0.04,
          rackBack,
          pH + 2.55,
          zc + sz * 1.52 + 0.04,
          graphite,
        );
      for (const top of BEAM_TOPS) {
        const y = pH + top;
        matte.span(
          RACK_FACE_X,
          y - 0.03,
          zc - 1.5,
          rackBack,
          y,
          zc + 1.5,
          hexColor("#d6d9de"),
        );
        mark(metal, this.metalAccent, () =>
          metal.span(
            RACK_FACE_X - 0.05,
            y - 0.1,
            zc - 1.52,
            RACK_FACE_X,
            y,
            zc + 1.52,
            acc,
          ),
        );
        metal.span(
          rackBack - 0.05,
          y - 0.1,
          zc - 1.52,
          rackBack,
          y,
          zc + 1.52,
          graphite,
        );
      }
      metal.span(
        RACK_FACE_X,
        pH + 2.5,
        zc - 1.52,
        rackBack,
        pH + 2.55,
        zc + 1.52,
        graphite,
      );
    }
    // Rack-end LED strip (reads as signage under the canopy of the hall).
    led.span(
      RACK_FACE_X - 0.02,
      pH + 2.6,
      BAY_Z0 - 1.5,
      RACK_FACE_X,
      pH + 2.64,
      BAY_Z0 + 2 * BAY_DZ + 1.5,
      hexColor("#f4f8ff"),
    );

    // (No interior wall cove: the single 4 cm strip on the west wall read as
    // a stray black member along the wall head (G11); cove light belongs to
    // the dock lighting pass.)

    const mm = matte.build("dock:matte", scene);
    const me = metal.build("dock:metal", scene);
    const ld = led.build("dock:led", scene);
    if (!mm || !me || !ld) throw new Error("dock: empty static geometry");
    this.matte = this.track(mm, "dock:matte");
    this.metal = this.track(me, "dock:metal");
    this.led = this.track(ld, "dock:led");

    const mk = (name: string, rough: number, env: number) => {
      const m = new PBRMaterial(name, scene);
      m.albedoColor = Color3.White();
      m.metallic = 0;
      m.roughness = rough;
      m.environmentIntensity = env;
      return m;
    };
    // Precast concrete shell and painted steel: the shared textured surfaces
    // (normal + ORM at world scale + grime) under the vertex colours, with
    // the albedo pulled down to real concrete / paint (was white × colour:
    // the washed-out beige of the review shots). Flat fallbacks headless.
    const mats = Materials.of(scene);
    applyWorldUVs(this.matte);
    applyWorldUVs(this.metal);
    this.matte.material =
      mats?.forVertexColors("concreteSoffit", {
        albedo: 0.82,
        grime: true,
        env: 0.45,
        // Constant 0.9 roughness, soft relief: ORM roughness variation let
        // SSR smear the bright door openings into radial streaks.
        roughFactor: 0.9,
        flatRough: true,
        bumpLevel: 0.3,
      }) ?? mk("dock:matteMat", 0.88, 0.45);
    this.metal.material =
      mats?.forVertexColors("steelPainted", { albedo: 0.9, env: 0.7 }) ??
      mk("dock:metalMat", 0.45, 0.7);
    // LED diffusers: unlit, output = vertex colour (an unlit StandardMaterial
    // with black emissive rendered them black).
    const lm = new PBRMaterial("dock:ledMat", scene);
    lm.unlit = true;
    lm.albedoColor = Color3.White();
    this.led.material = lm;
    lm.freeze();
    for (const m of [this.matte, this.metal, this.led]) m.freezeWorldMatrix();
  }

  private doorMeshReady = false;
  private doorBase: Float32Array = new Float32Array(0);

  private buildDoors(): void {
    const m = new Mesh("dock:doors", this.scene);
    const n = DOCK.doorXs.length;
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const dx = DOCK.doorXs[i];
      const hw = DOCK.doorW / 2;
      const y0 = DOCK.platformH;
      const y1 = y0 + DOCK.doorH;
      const z = -0.12;
      const u0 = i / n;
      const u1 = (i + 1) / n;
      const b = pos.length / 3;
      // Face looks toward +z (the apron); u runs with +x.
      pos.push(dx - hw, y0, z, dx + hw, y0, z, dx + hw, y1, z, dx - hw, y1, z);
      for (let k = 0; k < 4; k++) nor.push(0, 0, 1);
      // Viewed from the apron (looking -z) the right-hand side is -x.
      uv.push(u1, 0, u0, 0, u0, 1, u1, 1);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.normals = nor;
    vd.uvs = uv;
    vd.indices = idx;
    vd.applyToMesh(m, true);
    this.doorBase = new Float32Array(pos);
    this.doorMesh = this.track(m, "dock:doors");
    this.doorMeshReady = true;
  }

  /** Roll a door's curtain up: the bottom edge (and its UVs) rise. */
  private writeDoors(): void {
    const pos = new Float32Array(this.doorBase);
    const uvs = this.doorMesh.getVerticesData(VertexBuffer.UVKind);
    const n = DOCK.doorXs.length;
    for (let i = 0; i < n; i++) {
      const o = this.doorOpen[i];
      // Keep a 0.25 m rolled coil at the top; hide the door fully when open.
      const rise = Math.min(o, 0.999) * (DOCK.doorH - 0.01);
      for (const v of [0, 1]) {
        pos[(i * 4 + v) * 3 + 1] = DOCK.platformH + rise;
        if (uvs) uvs[(i * 4 + v) * 2 + 1] = rise / DOCK.doorH;
      }
    }
    this.doorMesh.updateVerticesData(VertexBuffer.PositionKind, pos);
    if (uvs) this.doorMesh.updateVerticesData(VertexBuffer.UVKind, uvs);
    this.doorMesh.refreshBoundingInfo();
    this.doorDirty = false;
  }

  private buildBoard(): void {
    const bx = 13.35;
    const by = 3.95;
    const w = 4.6;
    const h = (w * BOARD_TEX_H) / BOARD_TEX_W;
    const m = new Mesh("dock:board", this.scene);
    const vd = new VertexData();
    vd.positions = [
      bx - w / 2,
      by - h / 2,
      0.105,
      bx + w / 2,
      by - h / 2,
      0.105,
      bx + w / 2,
      by + h / 2,
      0.105,
      bx - w / 2,
      by + h / 2,
      0.105,
    ];
    vd.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    vd.uvs = [1, 0, 0, 0, 0, 1, 1, 1];
    vd.indices = [0, 2, 1, 0, 3, 2];
    vd.applyToMesh(m);
    const mat = new PBRMaterial("dock:boardMat", this.scene);
    mat.albedoColor = Color3.Black();
    mat.emissiveTexture = this.boardTex;
    mat.emissiveColor = Color3.White();
    mat.emissiveIntensity = 1.15;
    mat.disableLighting = true;
    mat.environmentIntensity = 0;
    m.material = mat;
    this.track(m, "dock:board").freezeWorldMatrix();
  }

  private buildShelfBoxes(): void {
    // Unit box: white body + brand strap (accent vertices, recoloured live).
    const s = new MeshSoup();
    s.box(0, 0, 0, 1, 1, 1, hexColor("#f0f2f5"));
    const a = s.positions.length / 3;
    s.box(0, 0.28, 0, 1.03, 0.2, 1.03, hexColor(accentOf(this.brand)));
    this.boxStrap = [[a, s.positions.length / 3]];
    const m = s.build("dock:boxes", this.scene);
    if (!m) throw new Error("dock: empty box");
    const mat = new PBRMaterial("dock:boxMat", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.62;
    mat.environmentIntensity = 0.6;
    m.material = mat;
    m.alwaysSelectAsActiveMesh = true;
    m.setEnabled(false);
    this.boxes = this.track(m, "dock:boxes");
    void CreateBox;
  }

  private slotPos(s: ShelfSlot): { y: number; z: number } {
    const zc = BAY_Z0 + s.bay * BAY_DZ;
    return {
      z: zc + (s.col - (SHELF.cols - 1) / 2) * COL_DZ,
      y: DOCK.platformH + BEAM_TOPS[s.level] + BOX.y / 2,
    };
  }

  private buildLabels(): void {
    const cap = SHELF.bays * SHELF.cols * SHELF.levels;
    const m = new Mesh("dock:labels", this.scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(cap * 12);
    vd.normals = new Float32Array(cap * 12);
    vd.uvs = new Float32Array(cap * 8);
    const idx: number[] = [];
    for (let i = 0; i < cap; i++) {
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      for (let k = 0; k < 4; k++) vd.normals[i * 12 + k * 3] = -1;
    }
    vd.indices = idx;
    vd.applyToMesh(m, true);
    const mat = new PBRMaterial("dock:labelMat", this.scene);
    mat.albedoColor = Color3.Black();
    mat.emissiveTexture = this.labelTex;
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.environmentIntensity = 0;
    m.material = mat;
    m.alwaysSelectAsActiveMesh = true;
    m.setEnabled(false);
    this.labels = this.track(m, "dock:labels");
  }

  // -------------------------------------------------------------- updates

  private rebuildShelves(): void {
    this.slots = slotReleases(this.releases);
    const n = this.slots.length;
    const mats = new Float32Array(n * 16);
    const cols = new Float32Array(n * 4);
    const pos = new Float32Array(SHELF.bays * SHELF.cols * SHELF.levels * 12);
    const uvs = new Float32Array(SHELF.bays * SHELF.cols * SHELF.levels * 8);
    const faceX = RACK_FACE_X + 0.04 + BOX.x / 2 - BOX.x / 2; // box front plane
    this.slots.forEach((s, i) => {
      const { y, z } = this.slotPos(s);
      const cx = faceX + BOX.x / 2;
      // Row-major scale + translation (column-vector layout, Babylon is row).
      const o = i * 16;
      mats[o] = BOX.x;
      mats[o + 5] = BOX.y;
      mats[o + 10] = BOX.z;
      mats[o + 15] = 1;
      mats[o + 12] = cx;
      mats[o + 13] = y;
      mats[o + 14] = z;
      const t = s.prerelease ? [1, 0.88, 0.64] : [1, 1, 1];
      cols[i * 4] = t[0];
      cols[i * 4 + 1] = t[1];
      cols[i * 4 + 2] = t[2];
      cols[i * 4 + 3] = 1;
      // Label quad on the box front (faces -x).
      const lx = faceX - 0.003;
      const lw = BOX.z * 0.86;
      const lh = lw * (LABEL_CELL_H / LABEL_CELL_W);
      const ly = y - 0.075;
      const p = i * 12;
      pos.set(
        [
          lx,
          ly - lh / 2,
          z + lw / 2,
          lx,
          ly - lh / 2,
          z - lw / 2,
          lx,
          ly + lh / 2,
          z - lw / 2,
          lx,
          ly + lh / 2,
          z + lw / 2,
        ],
        p,
      );
      const c = labelCell(i);
      const u0 = c.x / (LABEL_CELL_W * LABEL_COLS);
      const u1 = (c.x + LABEL_CELL_W) / (LABEL_CELL_W * LABEL_COLS);
      const v1 = 1 - c.y / (LABEL_CELL_H * LABEL_ROWS);
      const v0 = 1 - (c.y + LABEL_CELL_H) / (LABEL_CELL_H * LABEL_ROWS);
      uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
    });
    this.boxes.thinInstanceSetBuffer("matrix", mats, 16, true);
    this.boxes.thinInstanceSetBuffer("color", cols, 4, true);
    this.boxes.thinInstanceCount = n;
    this.boxes.thinInstanceRefreshBoundingInfo(true);
    this.boxes.setEnabled(n > 0);
    this.labels.updateVerticesData(VertexBuffer.PositionKind, pos);
    this.labels.updateVerticesData(VertexBuffer.UVKind, uvs);
    this.labels.refreshBoundingInfo();
    this.labels.setEnabled(n > 0);
    this.redrawLabels();
  }

  private paintRanges(
    mesh: Mesh,
    ranges: Range[],
    col: RGBA,
    mix?: number,
  ): void {
    const data = mesh.getVerticesData(VertexBuffer.ColorKind);
    if (!data) return;
    for (const [a, b] of ranges)
      for (let v = a; v < b; v++) {
        data[v * 4] = col[0] * (mix ?? 1);
        data[v * 4 + 1] = col[1] * (mix ?? 1);
        data[v * 4 + 2] = col[2] * (mix ?? 1);
      }
    mesh.updateVerticesData(VertexBuffer.ColorKind, data);
  }

  private applyBranding(first: boolean): void {
    const acc = accentOf(this.brand);
    if (acc !== this.lastAccent) {
      this.lastAccent = acc;
      const c = hexColor(acc);
      const d = hexColor(shade(acc, -0.2));
      if (!first) {
        this.paintRanges(this.led, this.ledAccent, c);
        this.paintRanges(this.metal, this.metalAccent, d);
      }
      this.paintRanges(this.boxes, this.boxStrap, d);
    }
    this.redrawDoors();
    this.redrawBoard();
    this.redrawLabels();
  }

  private redrawDoors(): void {
    const ctx = this.doorTex.getContext() as unknown as Ctx2D;
    drawDoorAtlas(ctx, DOCK.doorXs.length, this.brand, this.logoImg);
    this.doorTex.update(true);
  }

  private redrawBoard(): void {
    if (!this.boardTex) return;
    if (!this.dotMask && typeof document !== "undefined")
      this.dotMask = makeDotMask(BOARD_TEX_W, BOARD_TEX_H, 8);
    const ctx = this.boardTex.getContext() as unknown as Ctx2D;
    const lines = boardLines(this.releases, this.deploys, this.nowMs);
    drawBoard(ctx, lines, this.brand.name, accentOf(this.brand), this.dotMask);
    this.boardTex.update(true);
  }

  private redrawLabels(): void {
    if (!this.labelTex) return;
    const ctx = this.labelTex.getContext() as unknown as Ctx2D;
    drawLabelAtlas(ctx, this.slots, accentOf(this.brand));
    this.labelTex.update(true);
  }
}
