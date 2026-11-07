/**
 * Stations — thin-instanced pool of CI inspection stations ("checks as
 * inspectors on the line"). 7 draw calls for any number of stations:
 *
 *   housing  gantry + sensor box + hood bezel + beacon base + arm pedestal
 *            (vertex-coloured satin paint, static)
 *   hood     inspection light under the sensor box (unlit, instance colour)
 *   arm1-3   3-segment robot arm (shoulder/upper arm, elbow/forearm,
 *            wrist/sensor head); static poses per state, `setArmPose` is the
 *            Phase 3 motion hook
 *   beacon   lens, instance colour = `stateColor` (CHECK_COLORS) in HDR so
 *            the pipeline bloom picks it up; running breathes, failure strobes
 *   glyph    per-CheckKind "kind drum" on both faces of the sensor box
 *            (one atlas, face chosen by the instance rotation)
 *
 * `setStations()` is a no-op (zero buffer writes) when the station key is
 * unchanged; `update(dt)` re-uploads only the contiguous prefix of animated
 * beacons (running / failure), and nothing at all when there are none.
 * Planning / colours / kinematics live in `stationPlan.ts` (pure, tested).
 */
import {
  Color3,
  CreateBoxVertexData,
  CreateCylinderVertexData,
  DynamicTexture,
  Matrix,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  VertexData,
} from "@/engine/babylon";
import { roundedBoxData } from "@/engine/art/geometry";
import {
  GLYPH_KINDS,
  GLYPH_LABELS,
  STATION,
  armMatrices,
  armPoseFor,
  drumApothem,
  glyphColor,
  glyphMatrices,
  hoodColor,
  housingMatrix,
  orderStations,
  stationKey,
  writeBeaconColors,
  type ArmPose,
  type StationInstance,
} from "./stationPlan";
import { hexToLinear, rotZ, transformPoint, type Mat4 } from "./poolMath";
import type { CheckKind } from "@/engine/contracts";

export type { StationInstance, ArmPose } from "./stationPlan";

export interface StationStats {
  draws: number;
  stations: number;
  animated: number;
  /** Full buffer (re)uploads since creation. */
  bufferWrites: number;
  /** Partial beacon-prefix uploads since creation. */
  partialWrites: number;
  rebuilds: number;
}

type Part = "housing" | "hood" | "arm1" | "arm2" | "arm3" | "beacon" | "glyph";
const PARTS: Part[] = [
  "housing",
  "hood",
  "arm1",
  "arm2",
  "arm3",
  "beacon",
  "glyph",
];

const C = {
  white: hexToLinear("#E6E8EB"),
  graphite: hexToLinear("#2A2D31"),
  dark: hexToLinear("#17191C"),
  steel: hexToLinear("#8E959C"),
  alu: hexToLinear("#B4BAC0"),
  cap: hexToLinear("#6E757C"),
  yellow: hexToLinear("#F2BE00"),
};

class Pool {
  mats = new Float32Array(0);
  cols: Float32Array | null = null;
  count = 0;

  constructor(
    readonly mesh: Mesh,
    readonly colored: boolean,
  ) {
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
  }

  reserve(n: number): void {
    if (n * 16 <= this.mats.length) return;
    const cap = Math.max(32, Math.ceil(n * 1.25));
    this.mats = new Float32Array(cap * 16);
    if (this.colored) this.cols = new Float32Array(cap * 4);
  }

  /** Upload matrices (+ colours) for `n` instances; returns buffer writes. */
  upload(n: number, withColors = true): number {
    let w = 0;
    this.mesh.thinInstanceSetBuffer("matrix", this.mats, 16, false);
    w++;
    if (this.cols && withColors) {
      this.mesh.thinInstanceSetBuffer("color", this.cols, 4, false);
      w++;
    }
    this.mesh.thinInstanceCount = n;
    this.count = n;
    this.mesh.setEnabled(n > 0);
    return w;
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}

export class Stations {
  private readonly pools = {} as Record<Part, Pool>;
  private readonly materials: PBRMaterial[] = [];
  private readonly atlas: DynamicTexture;
  private key: string | null = null;
  private order: StationInstance[] = [];
  private animated = 0;
  private time = 0;
  private bufferWrites = 0;
  private partialWrites = 0;
  private rebuilds = 0;
  private readonly poses = new Map<string, ArmPose>();
  private armsDirty = false;

  constructor(private readonly scene: Scene) {
    // Satin painted steel (housing) and glossy robot paint (arm).
    const paint = this.pbr("stationPaint", 0.18, 0.36);
    const robot = this.pbr("stationArmPaint", 0.08, 0.28);
    robot.clearCoat.isEnabled = true;
    robot.clearCoat.intensity = 0.5;
    robot.clearCoat.roughness = 0.12;

    this.pools.housing = new Pool(
      this.mesh("stationHousing", housingData(), paint),
      false,
    );
    this.pools.arm1 = new Pool(
      this.mesh("stationArm1", arm1Data(), robot),
      false,
    );
    this.pools.arm2 = new Pool(
      this.mesh("stationArm2", arm2Data(), robot),
      false,
    );
    this.pools.arm3 = new Pool(
      this.mesh("stationArm3", arm3Data(), robot),
      false,
    );
    for (const p of ["housing", "arm1", "arm2", "arm3"] as const)
      this.pools[p].mesh.receiveShadows = true;

    const hoodMat = this.unlit("stationHoodMat");
    this.pools.hood = new Pool(
      this.mesh("stationHood", hoodData(), hoodMat),
      true,
    );
    const beaconMat = this.unlit("stationBeaconMat");
    this.pools.beacon = new Pool(
      this.mesh("stationBeacon", beaconData(), beaconMat),
      true,
    );

    this.atlas = glyphAtlas(scene);
    const glyphMat = this.unlit("stationGlyphMat");
    glyphMat.albedoTexture = this.atlas;
    glyphMat.backFaceCulling = false;
    this.pools.glyph = new Pool(
      this.mesh("stationGlyph", drumData(), glyphMat),
      true,
    );
  }

  private pbr(name: string, metallic: number, roughness: number): PBRMaterial {
    const m = new PBRMaterial(name, this.scene);
    m.albedoColor = Color3.White();
    m.metallic = metallic;
    m.roughness = roughness;
    this.materials.push(m);
    return m;
  }

  /** Unlit: output = albedo × instance colour (HDR-capable, blooms > 1). */
  private unlit(name: string): PBRMaterial {
    const m = new PBRMaterial(name, this.scene);
    m.unlit = true;
    m.albedoColor = Color3.White();
    m.metallic = 0;
    m.roughness = 1;
    this.materials.push(m);
    return m;
  }

  private mesh(name: string, vd: VertexData, mat: PBRMaterial): Mesh {
    const m = new Mesh(name, this.scene);
    vd.applyToMesh(m, false);
    m.material = mat;
    return m;
  }

  /** Replace the station set. No-op (zero buffer writes) when unchanged. */
  setStations(list: readonly StationInstance[]): boolean {
    const key = stationKey(list);
    if (key === this.key) return false;
    this.key = key;
    const { order, animated } = orderStations(list);
    this.order = order;
    this.animated = animated;
    const live = new Set(order.map((s) => s.id));
    for (const id of [...this.poses.keys()])
      if (!live.has(id)) this.poses.delete(id);
    this.writeAll();
    this.rebuilds++;
    return true;
  }

  /**
   * Phase 3 hook: override one station's arm pose (null → state default).
   * Arm matrices are re-uploaded on the next `update()`.
   */
  setArmPose(id: string, pose: ArmPose | null): void {
    if (pose) this.poses.set(id, pose);
    else this.poses.delete(id);
    this.armsDirty = true;
  }

  /** Beacon pulse / strobe; zero buffer writes when nothing animates. */
  update(dt: number): void {
    this.time += dt;
    if (this.armsDirty) {
      this.armsDirty = false;
      this.writeArms();
    }
    if (this.animated === 0) return;
    const beacon = this.pools.beacon;
    if (!beacon.cols || beacon.count === 0) return;
    writeBeaconColors(this.order, this.animated, this.time, beacon.cols);
    beacon.mesh.thinInstancePartialBufferUpdate("color", this.animated, 0);
    this.partialWrites++;
  }

  private writeAll(): void {
    const n = this.order.length;
    for (const p of PARTS) this.pools[p].reserve(p === "glyph" ? n * 2 : n);
    const P = this.pools;
    for (let i = 0; i < n; i++) {
      const st = this.order[i];
      const hm = housingMatrix(st);
      P.housing.mats.set(hm, i * 16);
      P.hood.mats.set(hm, i * 16);
      P.beacon.mats.set(hm, i * 16);
      setRgb(P.hood.cols!, i, hoodColor(st.state));
      const g = glyphColor(st.state);
      const [gf, gb] = glyphMatrices(st);
      P.glyph.mats.set(gf, i * 32);
      P.glyph.mats.set(gb, i * 32 + 16);
      setRgb(P.glyph.cols!, i * 2, g);
      setRgb(P.glyph.cols!, i * 2 + 1, g);
    }
    writeBeaconColors(this.order, n, this.time, P.beacon.cols!);
    this.fillArms();
    for (const p of PARTS)
      this.bufferWrites += P[p].upload(p === "glyph" ? n * 2 : n);
  }

  private fillArms(): void {
    const P = this.pools;
    for (let i = 0; i < this.order.length; i++) {
      const st = this.order[i];
      const pose = this.poses.get(st.id) ?? armPoseFor(st.state);
      const [a, b, c] = armMatrices(st, pose);
      P.arm1.mats.set(a, i * 16);
      P.arm2.mats.set(b, i * 16);
      P.arm3.mats.set(c, i * 16);
    }
  }

  private writeArms(): void {
    if (this.order.length === 0) return;
    this.fillArms();
    for (const p of ["arm1", "arm2", "arm3"] as const)
      this.bufferWrites += this.pools[p].upload(this.order.length);
  }

  meshes(): Mesh[] {
    return PARTS.map((p) => this.pools[p].mesh);
  }

  /** Meshes that should cast shadows (lit, solid parts). */
  casterMeshes(): Mesh[] {
    return (["housing", "arm1", "arm2", "arm3"] as const).map(
      (p) => this.pools[p].mesh,
    );
  }

  setVisible(on: boolean): void {
    for (const p of PARTS)
      this.pools[p].mesh.setEnabled(on && this.pools[p].count > 0);
  }

  stats(): StationStats {
    return {
      draws: PARTS.filter((p) => this.pools[p].count > 0).length,
      stations: this.order.length,
      animated: this.animated,
      bufferWrites: this.bufferWrites,
      partialWrites: this.partialWrites,
      rebuilds: this.rebuilds,
    };
  }

  dispose(): void {
    for (const p of PARTS) this.pools[p].dispose();
    for (const m of this.materials) m.dispose();
    this.atlas.dispose();
  }
}

function setRgb(out: Float32Array, i: number, c: [number, number, number]) {
  out[i * 4] = c[0];
  out[i * 4 + 1] = c[1];
  out[i * 4 + 2] = c[2];
  out[i * 4 + 3] = 1;
}

// ---------------------------------------------------------------------------
// Geometry (station local frame, 0.9 m belt; see stationPlan.STATION)
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function colored(vd: VertexData, m: Matrix, c: Rgb): VertexData {
  vd.transform(m);
  const n = vd.positions!.length / 3;
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) col.set([c[0], c[1], c[2], 1], i * 4);
  vd.colors = col;
  return vd;
}

/** Rounded box from min/max corners. */
function rbox(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  c: Rgb,
  r = 0.012,
): VertexData {
  return colored(
    roundedBoxData(x1 - x0, y1 - y0, z1 - z0, r, 1),
    Matrix.Translation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    c,
  );
}

function box(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  c: Rgb,
): VertexData {
  return colored(
    CreateBoxVertexData({ width: x1 - x0, height: y1 - y0, depth: z1 - z0 }),
    Matrix.Translation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    c,
  );
}

/** Vertical cylinder (axis Y) from y0 to y1. */
function cyl(
  x: number,
  z: number,
  y0: number,
  y1: number,
  r: number,
  c: Rgb,
  tess = 20,
): VertexData {
  return colored(
    CreateCylinderVertexData({
      height: y1 - y0,
      diameter: 2 * r,
      tessellation: tess,
    }),
    Matrix.Translation(x, (y0 + y1) / 2, z),
    c,
  );
}

/** Cylinder along Z (joint axis), centred at (x, y, 0). */
function joint(y: number, r: number, len: number, c: Rgb): VertexData {
  return colored(
    CreateCylinderVertexData({
      height: len,
      diameter: 2 * r,
      tessellation: 20,
    }),
    Matrix.RotationX(Math.PI / 2).multiply(Matrix.Translation(0, y, 0)),
    c,
  );
}

function merge(parts: VertexData[]): VertexData {
  const [first, ...rest] = parts;
  first.merge(rest, true);
  return first;
}

function housingData(): VertexData {
  const S = STATION;
  const parts: VertexData[] = [];
  // Uprights (satin aluminium) with a dark foot plate.
  for (const sz of [1, -1]) {
    const z = sz * S.uprightZ;
    parts.push(
      rbox(-0.06, 0.02, z - 0.05, 0.06, S.boxY0 + 0.01, z + 0.05, C.alu, 0.012),
    );
    parts.push(box(-0.12, 0, z - 0.1, 0.12, 0.02, z + 0.1, C.dark));
  }
  // Sensor box (satin white) with grey end caps.
  parts.push(
    rbox(
      -S.boxX,
      S.boxY0,
      -S.boxZ + 0.04,
      S.boxX,
      S.boxY1,
      S.boxZ - 0.04,
      C.white,
      0.025,
    ),
  );
  for (const sz of [1, -1])
    parts.push(
      rbox(
        -S.boxX + 0.01,
        S.boxY0 + 0.005,
        sz > 0 ? S.boxZ - 0.05 : -S.boxZ,
        S.boxX - 0.01,
        S.boxY1 - 0.005,
        sz > 0 ? S.boxZ : -S.boxZ + 0.05,
        C.cap,
        0.02,
      ),
    );
  // Hood bezel (dark, recessed frame around the light panel).
  parts.push(box(-0.27, S.boxY0 - 0.016, -0.49, 0.27, S.boxY0, 0.49, C.dark));
  // Beacon base + cap (graphite).
  const B = S.beacon;
  parts.push(cyl(B.x, B.z, S.boxY1, B.y0, 0.06, C.graphite));
  parts.push(cyl(B.x, B.z, B.y1, B.y1 + 0.016, 0.058, C.graphite));
  // Arm pedestal: plate, column (white), thin yellow band, turret.
  const P = S.pedestal;
  parts.push(
    rbox(
      P.x - 0.17,
      0,
      P.z - 0.17,
      P.x + 0.17,
      0.025,
      P.z + 0.17,
      C.dark,
      0.008,
    ),
  );
  parts.push(cyl(P.x, P.z, 0.025, P.h, 0.085, C.white));
  parts.push(cyl(P.x, P.z, 0.1, 0.135, 0.087, C.yellow));
  parts.push(cyl(P.x, P.z, P.h, P.h + P.turret, 0.11, C.graphite));
  // Cable duct from pedestal to the near upright (low, along the floor).
  parts.push(
    box(
      P.x - 0.04,
      0.025,
      -S.uprightZ - 0.05,
      P.x + 0.04,
      0.06,
      P.z,
      C.graphite,
    ),
  );
  return merge(parts);
}

function hoodData(): VertexData {
  return box(
    -0.25,
    STATION.hoodY - 0.004,
    -0.46,
    0.25,
    STATION.hoodY,
    0.46,
    [1, 1, 1],
  );
}

function beaconData(): VertexData {
  const B = STATION.beacon;
  return cyl(B.x, B.z, B.y0, B.y1, B.r, [1, 1, 1], 24);
}

function arm1Data(): VertexData {
  const L = STATION.arm.l1;
  return merge([
    joint(0, 0.075, 0.2, C.graphite),
    rbox(-0.055, 0.02, -0.05, 0.055, L, 0.05, C.white, 0.035),
  ]);
}

function arm2Data(): VertexData {
  const L = STATION.arm.l2;
  return merge([
    joint(0, 0.065, 0.17, C.graphite),
    rbox(-0.045, 0.02, -0.042, 0.045, L, 0.042, C.white, 0.03),
  ]);
}

function arm3Data(): VertexData {
  const T = STATION.arm.tool;
  return merge([
    joint(0, 0.05, 0.13, C.graphite),
    rbox(-0.05, 0.03, -0.055, 0.05, T - 0.02, 0.055, C.graphite, 0.015),
    cyl(0, 0, T - 0.02, T, 0.03, C.dark, 16),
    cyl(0, 0, T - 0.005, T + 0.001, 0.018, C.steel, 16),
  ]);
}

/** 7-face prism around local Z; face k (atlas row k) faces +X after rotZ(k·step). */
function drumData(): VertexData {
  const { w, h, faces } = STATION.glyph;
  const a = drumApothem();
  const step = (2 * Math.PI) / faces;
  const rows = ATLAS_ROWS;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const inset = 0.004;
  for (let k = 0; k < faces; k++) {
    const m: Mat4 = rotZ(-k * step);
    const vTop = 1 - k / rows - inset / rows;
    const vBot = 1 - (k + 1) / rows + inset / rows;
    const corners: [number, number, number, number][] = [
      // y, z, u, v
      [-h / 2, -w / 2, 0, vBot],
      [-h / 2, w / 2, 1, vBot],
      [h / 2, w / 2, 1, vTop],
      [h / 2, -w / 2, 0, vTop],
    ];
    const base = positions.length / 3;
    const nrm = transformPoint(m, 1, 0, 0);
    const o = transformPoint(m, 0, 0, 0);
    for (const [y, z, u, v] of corners) {
      positions.push(...transformPoint(m, a, y, z));
      normals.push(nrm[0] - o[0], nrm[1] - o[1], nrm[2] - o[2]);
      uvs.push(u, v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  return vd;
}

// ---------------------------------------------------------------------------
// Glyph atlas (one row per CheckKind, GLYPH_KINDS order)
// ---------------------------------------------------------------------------

const ATLAS_ROWS = 8;
const CELL_W = 1024;
const CELL_H = 256;

function glyphAtlas(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture(
    "stationGlyphAtlas",
    { width: CELL_W, height: CELL_H * ATLAS_ROWS },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  tex.hasAlpha = false;
  tex.anisotropicFilteringLevel = 8;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#121417";
  ctx.fillRect(0, 0, CELL_W, CELL_H * ATLAS_ROWS);
  GLYPH_KINDS.forEach((kind, row) => {
    const y0 = row * CELL_H;
    // Panel: dark glass with a thin light border.
    ctx.fillStyle = "#16191D";
    ctx.fillRect(6, y0 + 6, CELL_W - 12, CELL_H - 12);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 4;
    ctx.strokeRect(10, y0 + 10, CELL_W - 20, CELL_H - 20);
    // Icon tile.
    ctx.save();
    ctx.translate(128, y0 + CELL_H / 2);
    drawIcon(ctx, kind);
    ctx.restore();
    // Label.
    ctx.fillStyle = "#F4F6F8";
    ctx.font = `700 118px Inter, "Segoe UI", system-ui, "DejaVu Sans", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const label = GLYPH_LABELS[kind];
    const maxW = CELL_W - 290;
    const mw = ctx.measureText(label).width;
    const sx = mw > maxW ? maxW / mw : 1;
    ctx.save();
    ctx.translate(250, y0 + CELL_H / 2 + 6);
    ctx.scale(sx, 1);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
  tex.update(true);
  return tex;
}

/** White line pictograms, ~180 px, centred on the origin. */
function drawIcon(ctx: CanvasRenderingContext2D, kind: CheckKind): void {
  ctx.strokeStyle = "#F4F6F8";
  ctx.fillStyle = "#F4F6F8";
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (kind) {
    case "lint": // three lines + check
      for (let i = 0; i < 3; i++) {
        ctx.moveTo(-70, -50 + i * 40);
        ctx.lineTo(i === 2 ? -10 : 40, -50 + i * 40);
      }
      ctx.moveTo(10, 40);
      ctx.lineTo(35, 65);
      ctx.lineTo(80, 10);
      ctx.stroke();
      break;
    case "build": // hex nut
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const x = Math.cos(a) * 72;
        const y = Math.sin(a) * 72;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 28, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "test": // flask
      ctx.moveTo(-25, -75);
      ctx.lineTo(-25, -15);
      ctx.lineTo(-68, 65);
      ctx.lineTo(68, 65);
      ctx.lineTo(25, -15);
      ctx.lineTo(25, -75);
      ctx.moveTo(-40, -75);
      ctx.lineTo(40, -75);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-50, 35);
      ctx.lineTo(50, 35);
      ctx.stroke();
      break;
    case "security": // shield + check
      ctx.moveTo(0, -80);
      ctx.lineTo(65, -55);
      ctx.quadraticCurveTo(62, 40, 0, 80);
      ctx.quadraticCurveTo(-62, 40, -65, -55);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-28, 2);
      ctx.lineTo(-6, 25);
      ctx.lineTo(32, -20);
      ctx.stroke();
      break;
    case "deploy": // up arrow out of a tray
      ctx.moveTo(0, 30);
      ctx.lineTo(0, -75);
      ctx.moveTo(-40, -35);
      ctx.lineTo(0, -75);
      ctx.lineTo(40, -35);
      ctx.moveTo(-70, 20);
      ctx.lineTo(-70, 70);
      ctx.lineTo(70, 70);
      ctx.lineTo(70, 20);
      ctx.stroke();
      break;
    case "release": // box (package)
      ctx.moveTo(0, -75);
      ctx.lineTo(70, -40);
      ctx.lineTo(70, 40);
      ctx.lineTo(0, 75);
      ctx.lineTo(-70, 40);
      ctx.lineTo(-70, -40);
      ctx.closePath();
      ctx.moveTo(-70, -40);
      ctx.lineTo(0, -5);
      ctx.lineTo(70, -40);
      ctx.moveTo(0, -5);
      ctx.lineTo(0, 75);
      ctx.stroke();
      break;
    default: // ring + dot
      ctx.arc(0, 0, 66, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
  }
}
