/**
 * European articulated lorry at real proportions, procedural: a 4x2 high-roof
 * cab-over tractor (3.6 m wheelbase) on a 13.6 x 2.55 x 4.0 m tri-axle box
 * semi-trailer, 16.5 m overall, floor at 1.2 m for the dock leveller; rear
 * doors swung back along the flanks. Local frame: origin = trailer rear
 * centre on the ground, +z toward the cab, +x to the driver's right.
 * Three draws: vertex-coloured body, livery quads, thin-instanced wheels
 * (12, rolled from the root's z travel while the truck departs).
 */
import {
  Axis,
  Color3,
  DynamicTexture,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type Observer,
} from "@/engine/babylon";
import type { BrandingOptions } from "@/engine/contracts";
import { DEFAULT_BRANDING } from "@/engine/world/brandLayout";
import { MeshSoup, hexColor, type RGBA } from "@/engine/world/factory/meshSoup";
import {
  accentOf,
  drawLivery,
  LIVERY_H,
  LIVERY_W,
} from "@/engine/world/factory/dockArt";
import { shade } from "@/engine/world/factory/dockModel";

type Ctx2D = CanvasRenderingContext2D;

export const TRUCK = {
  trailerW: 2.55,
  trailerL: 13.6,
  floorY: 1.2,
  roofY: 4.0,
  length: 16.5,
} as const;

/** Livery panel on each trailer side (m). */
const PANEL_L = 13.0;
const PANEL_H = 2.54;
const PANEL_Y0 = 1.36;
const PANEL_Z0 = 0.3;

export class Truck {
  readonly root: TransformNode;
  readonly body: Mesh;
  readonly livery: Mesh;
  /** 12 wheels, one thin-instanced draw. */
  readonly wheels: Mesh;
  readonly meshes: Mesh[];
  readonly texture: DynamicTexture;
  private opts: BrandingOptions;
  private logoImg: HTMLImageElement | null = null;
  private logoSrc: string | null = null;
  private token = 0;
  private accentRange: [number, number][] = [];
  private lastAccent = "";
  private readonly wheelBuf: Float32Array;
  private readonly rollObs: Observer<Scene>;
  private lastZ = 0;
  private travel = 0;

  constructor(
    scene: Scene,
    parent: TransformNode | null,
    opts?: BrandingOptions,
  ) {
    this.opts = opts ?? DEFAULT_BRANDING;
    this.root = new TransformNode("truck", scene);
    this.root.parent = parent;

    const soup = new MeshSoup();
    this.accentRange = buildTruck(soup, accentOf(this.opts));
    const body = soup.build("truck:body", scene);
    if (!body) throw new Error("truck: empty body");
    const bm = new PBRMaterial("truck:bodyMat", scene);
    // Painted body (dielectric) under an automotive clear coat.
    bm.albedoColor = Color3.White();
    bm.metallic = 0;
    bm.roughness = 0.5;
    bm.environmentIntensity = 0.7;
    bm.clearCoat.isEnabled = true;
    bm.clearCoat.intensity = 0.8;
    bm.clearCoat.roughness = 0.08;
    body.material = bm;
    body.parent = this.root;
    this.body = body;

    this.texture = new DynamicTexture(
      "truck:livery",
      { width: LIVERY_W, height: LIVERY_H },
      scene,
      true,
    );
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.texture.anisotropicFilteringLevel = 8;
    const lm = new PBRMaterial("truck:liveryMat", scene);
    lm.albedoTexture = this.texture;
    lm.metallic = 0;
    lm.roughness = 0.42;
    lm.environmentIntensity = 0.55;
    // Glossy vinyl livery on the trailer side (same clear coat as the body).
    lm.clearCoat.isEnabled = true;
    lm.clearCoat.intensity = 0.8;
    lm.clearCoat.roughness = 0.08;
    this.livery = buildLiveryMesh(scene);
    this.livery.material = lm;
    // Livery redraws update the texture in place: both stay frozen.
    bm.freeze();
    lm.freeze();
    this.livery.parent = this.root;
    this.meshes = [this.body, this.livery];
    this.redraw();

    const wheels = buildWheels(scene);
    this.wheels = wheels.mesh;
    this.wheelBuf = wheels.buf;
    // Tyres and rims (WS5): matte dielectric rubber, no clear coat; the
    // vertex colours separate black tyre from grey rim (steel rims are
    // painted, so dielectric too).
    const wm = new PBRMaterial("truck:wheelMat", scene);
    wm.albedoColor = Color3.White();
    wm.metallic = 0;
    wm.roughness = 0.85;
    wm.environmentIntensity = 0.5;
    wm.freeze();
    this.wheels.material = wm;
    this.wheels.parent = this.root;
    this.meshes.push(this.wheels);
    this.lastZ = this.root.position.z;
    this.rollObs = scene.onBeforeRenderObservable.add(() => this.roll());
  }

  /** Spin the wheels by the distance the root moved along +z (departure). */
  private roll(): void {
    const z = this.root.position.z;
    const dz = z - this.lastZ;
    if (dz === 0) return;
    this.lastZ = z;
    // A jump (reset back to the bay) is a teleport, not a roll.
    if (Math.abs(dz) > 2) return;
    this.travel += dz;
    writeWheelMatrices(this.wheelBuf, this.travel);
    this.wheels.thinInstanceBufferUpdated("matrix");
  }

  setBranding(b: BrandingOptions): void {
    this.opts = b;
    if (b.logo !== this.logoSrc) {
      this.logoSrc = b.logo;
      this.logoImg = null;
      const my = ++this.token;
      if (b.logo) {
        const img = new Image();
        img.onload = () => {
          if (my !== this.token) return;
          this.logoImg = img;
          this.redraw();
        };
        img.src = b.logo;
      }
    }
    this.recolor();
    this.redraw();
  }

  /** Re-tint the cab (accent vertices) without rebuilding geometry. */
  private recolor(): void {
    const acc = accentOf(this.opts);
    if (acc === this.lastAccent) return;
    this.lastAccent = acc;
    const col = hexColor(shade(acc, -0.12));
    const data = this.body.getVerticesData(VertexBuffer.ColorKind);
    if (!data) return;
    for (const [a, b] of this.accentRange)
      for (let v = a; v < b; v++) {
        data[v * 4] = col[0];
        data[v * 4 + 1] = col[1];
        data[v * 4 + 2] = col[2];
      }
    this.body.updateVerticesData(VertexBuffer.ColorKind, data);
  }

  private redraw(): void {
    const ctx = this.texture.getContext() as unknown as Ctx2D;
    drawLivery(ctx, LIVERY_W, LIVERY_H, this.opts, this.logoImg);
    this.texture.update(true);
  }

  dispose(): void {
    this.token++;
    this.root.getScene().onBeforeRenderObservable.remove(this.rollObs);
    this.texture.dispose();
    for (const m of this.meshes) {
      m.material?.dispose();
      m.dispose();
    }
    this.root.dispose();
  }
}

/** Two livery quads (both flanks) sharing one texture; text reads L->R. */
function buildLiveryMesh(scene: Scene): Mesh {
  const m = new Mesh("truck:livery", scene);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const xs = TRUCK.trailerW / 2 + 0.004;
  const y0 = PANEL_Y0;
  const y1 = PANEL_Y0 + PANEL_H;
  const zr = PANEL_Z0;
  const zf = PANEL_Z0 + PANEL_L;
  // Right flank (+x): viewer's right = +z (toward the cab).
  // Left flank (-x): viewer's right = -z.
  const sides: [number, number, number][] = [
    [xs, zr, zf],
    [-xs, zf, zr],
  ];
  for (const [x, zL, zR] of sides) {
    const base = pos.length / 3;
    const nx = Math.sign(x);
    pos.push(x, y0, zL, x, y0, zR, x, y1, zR, x, y1, zL);
    for (let i = 0; i < 4; i++) nor.push(nx, 0, 0);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    // Front face = cross(p1-p0, p2-p0) along the normal.
    const dz = zR - zL;
    const cx = -(dz * (y1 - y0)); // x component of the cross for this winding
    if (cx * nx < 0)
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = uv;
  vd.indices = idx;
  vd.applyToMesh(m);
  m.isPickable = false;
  return m;
}

const C = {
  white: hexColor("#e9ecf0"),
  roof: hexColor("#cfd4da"),
  floor: hexColor("#8a7458"),
  lining: hexColor("#b49a74"),
  wood: hexColor("#a08260"),
  graphite: hexColor("#24272c"),
  chassis: hexColor("#30343a"),
  rubber: hexColor("#16171a"),
  rim: hexColor("#b8bec6"),
  glass: hexColor("#0c1218"),
  mirror: hexColor("#8e9aa6"),
  red: hexColor("#d6332b"),
  lamp: hexColor("#fff3d2"),
  amber: hexColor("#f2a81a"),
  yellow: hexColor("#f0c419"),
  steel: hexColor("#9aa1ab"),
  chrome: hexColor("#c9ced6"),
  plate: hexColor("#eceee9"),
  adblue: hexColor("#dde3ea"),
  blue: hexColor("#2a5fb0"),
  carton: hexColor("#d8dce1"),
};

type V3 = readonly [number, number, number];

/**
 * Box from `a` to `b` with a `w` x `h` cross-section (`w` along `side`, which
 * defaults to the horizontal perpendicular of the segment).
 */
function bar(
  s: MeshSoup,
  a: V3,
  b: V3,
  w: number,
  h: number,
  col: RGBA,
  side?: V3,
): void {
  const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const hint: V3 = side ?? (Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]);
  let sd: V3;
  if (side) {
    const k = dot(hint, d);
    sd = norm([hint[0] - d[0] * k, hint[1] - d[1] * k, hint[2] - d[2] * k]);
  } else sd = norm(cross(d, hint));
  const up = cross(sd, d);
  const P = (e: V3, i: number, j: number): [number, number, number] => [
    e[0] + (sd[0] * i * w + up[0] * j * h) / 2,
    e[1] + (sd[1] * i * w + up[1] * j * h) / 2,
    e[2] + (sd[2] * i * w + up[2] * j * h) / 2,
  ];
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  s.quadAuto([P(a, 1, -1), P(b, 1, -1), P(b, 1, 1), P(a, 1, 1)], sd, col);
  s.quadAuto(
    [P(a, -1, -1), P(b, -1, -1), P(b, -1, 1), P(a, -1, 1)],
    neg(sd),
    col,
  );
  s.quadAuto([P(a, -1, 1), P(b, -1, 1), P(b, 1, 1), P(a, 1, 1)], up, col);
  s.quadAuto(
    [P(a, -1, -1), P(b, -1, -1), P(b, 1, -1), P(a, 1, -1)],
    neg(up),
    col,
  );
  s.quadAuto([P(a, -1, -1), P(a, 1, -1), P(a, 1, 1), P(a, -1, 1)], neg(d), col);
  s.quadAuto([P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1)], d, col);
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Wheel-arch fender: `n` flat plates on an arc about the axle at (cy, cz). */
function fender(
  s: MeshSoup,
  cy: number,
  cz: number,
  r: number,
  x0: number,
  x1: number,
  col: RGBA,
  a0 = 0.25,
  a1 = Math.PI - 0.25,
  n = 6,
): void {
  const xm = (x0 + x1) / 2;
  const pt = (a: number): V3 => [
    xm,
    cy + r * Math.sin(a),
    cz + r * Math.cos(a),
  ];
  for (let i = 0; i < n; i++) {
    const ta = a0 + ((a1 - a0) * i) / n - 0.02;
    const tb = a0 + ((a1 - a0) * (i + 1)) / n + 0.02;
    bar(s, pt(ta), pt(tb), Math.abs(x1 - x0), 0.025, col, [1, 0, 0]);
  }
}

/** Quad on a cab flank (x = const), corners as (z, y). */
function flankQuad(
  s: MeshSoup,
  x: number,
  zy: readonly (readonly [number, number])[],
  col: RGBA,
): void {
  s.quadAuto(
    zy.map(([z, y]) => [x, y, z] as [number, number, number]),
    [Math.sign(x), 0, 0],
    col,
  );
}

// Axle stations (local z, m). EU 16.5 m artic: kingpin 12.0 m from the
// trailer rear, tri-axle bogie centre 7.7 m behind it at 1.31 m pitch; 4x2
// tractor with a 3.6 m wheelbase and the fifth wheel 0.45 m ahead of the drive.
const KINGPIN_Z = 12.0;
const TRAILER_AXLES = [3.0, 4.31, 5.62] as const;
const DRIVE_Z = 11.55;
const STEER_Z = 15.15;
const LEGS_Z = 10.35;

/** Builds the truck into `s`; returns vertex ranges that take the accent. */
function buildTruck(s: MeshSoup, accentHex: string): [number, number][] {
  const accent: [number, number][] = [];
  const mark = (fn: () => void): void => {
    const a = s.positions.length / 3;
    fn();
    accent.push([a, s.positions.length / 3]);
  };
  const cab = hexColor(shade(accentHex, -0.12));
  const W = TRUCK.trailerW;
  const L = TRUCK.trailerL;
  const hw = W / 2;
  const fy = TRUCK.floorY;
  const zBody = (0.12 + 13.5) / 2;
  const lBody = 13.5 - 0.12;
  const sides = [-1, 1] as const;

  // =================================================== semi-trailer box
  // Floor (top flush with a 1.2 m dock leveller), cross-member band.
  s.box(0, fy - 0.03, zBody, W - 0.1, 0.06, lBody, C.floor);
  s.box(0, 1.095, zBody, 2.44, 0.09, lBody, C.chassis);
  for (const sx of sides) {
    // Composite side wall (outer face exactly at the livery plane - 4 mm).
    s.box(sx * (hw - 0.025), 2.56, zBody, 0.05, 2.72, lBody, C.white);
    // Plywood lining + a logistics rail inside (reads through the doors).
    s.box(sx * (hw - 0.055), 2.56, zBody, 0.01, 2.72, lBody, C.lining);
    s.box(sx * (hw - 0.064), 2.1, zBody, 0.008, 0.12, lBody, C.steel);
    // Aluminium bottom + top rails, contour tape, side marker lamps.
    s.box(sx * (hw - 0.025), 1.1, zBody, 0.07, 0.24, lBody, C.steel);
    s.box(sx * (hw - 0.026), 3.95, zBody, 0.068, 0.1, lBody, C.steel);
    s.box(sx * (hw + 0.0115), 1.15, L / 2, 0.003, 0.05, 12.8, C.yellow);
    for (const z of [1.4, 4.2, 7.0, 9.8, 12.6])
      s.box(sx * (hw + 0.02), 1.04, z, 0.03, 0.05, 0.09, C.amber);
  }
  s.box(0, 3.965, zBody, W - 0.1, 0.05, lBody, C.roof);
  // Front wall + front frame, marker lamps, coupling heads.
  s.box(0, 2.525, 13.55, W, 2.95, 0.1, C.white);
  for (const sx of sides) {
    s.box(sx * (hw - 0.039), 2.49, 13.553, 0.09, 3.0, 0.126, C.steel);
    s.box(sx * 1.18, 3.93, 13.625, 0.08, 0.05, 0.03, C.lamp);
  }
  s.box(0, 3.95, 13.553, W + 0.012, 0.1, 0.126, C.steel);
  s.box(0, 1.1, 13.553, W + 0.012, 0.24, 0.126, C.steel);
  s.box(-0.12, 1.42, 13.63, 0.5, 0.12, 0.03, C.graphite);

  // ---- Rear frame: posts, header, sill, red contour tape.
  for (const sx of sides) {
    s.box(sx * (hw - 0.039), 2.49, 0.057, 0.09, 3.0, 0.126, C.steel);
    s.box(sx * (hw - 0.035), 2.5, -0.0075, 0.05, 2.4, 0.003, C.red);
  }
  s.box(0, 3.892, 0.057, W + 0.012, 0.224, 0.126, C.steel);
  s.box(0, 1.09, 0.057, W + 0.012, 0.22, 0.126, C.steel);
  s.box(0, 3.86, -0.0075, W - 0.12, 0.05, 0.003, C.red);
  s.box(0, 1.07, -0.0075, 2.2, 0.05, 0.003, C.red);
  // ---- Twin rear doors, swung 270 deg and hooked back along the flanks.
  const leaf = (W - 0.168) / 2 + 0.01;
  for (const sx of sides) {
    s.box(sx * (hw + 0.045), 2.5, 0.022 + leaf / 2, 0.04, 2.76, leaf, C.white);
    s.box(
      sx * (hw + 0.067),
      2.5,
      0.022 + leaf - 0.03,
      0.004,
      2.6,
      0.03,
      C.graphite,
    );
    for (const y of [1.45, 2.2, 2.95, 3.65])
      s.box(sx * (hw + 0.03), y, 0.02, 0.08, 0.1, 0.06, C.steel);
    s.box(
      sx * (hw + 0.02),
      2.0,
      0.022 + leaf + 0.03,
      0.05,
      0.06,
      0.06,
      C.steel,
    );
  }
  // ---- Rear lamps, number plate, ICC under-run bar (<= 0.55 m high).
  for (const sx of sides) {
    s.box(sx * 1.02, 0.9, 0.04, 0.42, 0.15, 0.08, C.graphite);
    s.box(sx * 1.17, 0.9, -0.002, 0.09, 0.1, 0.006, C.amber);
    s.box(sx * 1.03, 0.9, -0.002, 0.17, 0.1, 0.006, C.red);
    s.box(sx * 0.89, 0.9, -0.002, 0.07, 0.1, 0.006, C.lamp);
    s.box(sx * 0.5, 0.66, 0.1, 0.1, 0.25, 0.1, C.graphite);
    bar(
      s,
      [sx * 0.5, 0.54, 0.14],
      [sx * 0.5, 0.79, 0.75],
      0.08,
      0.06,
      C.graphite,
    );
    s.box(sx * 0.85, 0.48, 0.037, 0.14, 0.07, 0.006, C.red);
  }
  s.box(0, 0.9, 0.05, 0.56, 0.14, 0.06, C.graphite);
  s.box(0, 0.9, 0.017, 0.52, 0.11, 0.006, C.plate);
  s.box(0, 0.48, 0.1, 2.36, 0.12, 0.12, C.graphite);

  // ---- Cargo on pallets just inside the doors (reads through the dock door).
  mark(() => {
    for (const [x, z, h] of [
      [-0.62, 1.0, 1.1],
      [0.42, 1.05, 1.5],
      [-0.62, 2.3, 0.9],
    ] as const)
      s.box(
        x,
        fy + 0.144 + h / 2,
        z,
        0.76,
        h,
        1.14,
        hexColor(shade(accentHex, -0.1)),
      );
  });
  for (const [x, z] of [
    [-0.62, 1.0],
    [0.42, 1.05],
    [-0.62, 2.3],
    [0.42, 2.45],
  ] as const)
    s.box(x, fy + 0.072, z, 0.8, 0.144, 1.2, C.wood);
  s.box(0.42, fy + 0.144 + 0.4, 2.45, 0.76, 0.8, 1.14, C.carton);

  // ---- Chassis: main beams, kingpin, bogie, side guards, landing legs.
  for (const sx of sides)
    s.box(sx * 0.5, 0.915, 6.785, 0.12, 0.27, 13.33, C.chassis);
  s.cyl("y", 0, 1.0, KINGPIN_Z, 0.045, 0.1, C.steel, 10);
  for (const z of TRAILER_AXLES) {
    s.cyl("x", 0, 0.52, z, 0.065, 1.66, C.chassis, 10);
    for (const sx of sides) {
      s.box(sx * 0.5, 0.72, z + 0.55, 0.12, 0.14, 0.16, C.graphite);
      bar(
        s,
        [sx * 0.5, 0.66, z + 0.55],
        [sx * 0.5, 0.5, z - 0.42],
        0.1,
        0.08,
        C.graphite,
      );
      s.cyl("y", sx * 0.5, 0.67, z - 0.38, 0.14, 0.22, C.rubber, 12);
    }
  }
  for (const sx of sides) {
    // Spray-suppression valance over the bogie, mudflap behind the last axle.
    s.box(sx * (hw - 0.005), 0.92, 4.3, 0.02, 0.12, 4.0, C.rubber);
    s.box(sx * 1.025, 0.57, 2.36, 0.42, 0.82, 0.012, C.rubber);
    s.box(sx * 1.03, 1.0, 2.36, 0.46, 0.04, 0.04, C.steel);
    // Lateral protection between the bogie and the landing legs.
    for (const y of [0.5, 0.84])
      s.box(sx * (hw - 0.035), y, 8.275, 0.04, 0.1, 3.65, C.graphite);
    for (const z of [6.55, 8.3, 10.0])
      s.box(sx * (hw - 0.08), 0.775, z, 0.05, 0.55, 0.05, C.graphite);
    // Landing leg (cranked up, foot clear of the apron) + brace.
    s.box(sx * 0.93, 0.8, LEGS_Z, 0.12, 0.5, 0.12, C.graphite);
    s.box(sx * 0.93, 0.38, LEGS_Z, 0.09, 0.4, 0.09, C.graphite);
    s.box(sx * 0.93, 0.16, LEGS_Z, 0.26, 0.04, 0.26, C.graphite);
    s.box(sx * 0.74, 0.95, LEGS_Z, 0.38, 0.2, 0.04, C.graphite);
    bar(
      s,
      [sx * 0.9, 0.62, LEGS_Z - 0.04],
      [sx * 0.6, 1.02, LEGS_Z - 0.75],
      0.05,
      0.05,
      C.graphite,
    );
  }
  s.box(0, 0.64, LEGS_Z, 1.86, 0.05, 0.05, C.graphite);
  s.cyl("x", 0, 0.92, LEGS_Z, 0.025, 1.86, C.steel, 8);
  s.box(-1.04, 0.9, LEGS_Z, 0.1, 0.16, 0.16, C.graphite); // gearbox
  bar(
    s,
    [-1.09, 0.9, LEGS_Z],
    [-1.12, 0.6, LEGS_Z + 0.16],
    0.025,
    0.025,
    C.steel,
  );

  // =================================================== 4x2 tractor
  // ---- Frame, fifth wheel, catwalk, driveline, axles.
  for (const sx of sides)
    s.box(sx * 0.43, 0.76, 13.425, 0.09, 0.28, 5.35, C.chassis);
  s.box(0, 0.76, 10.8, 0.95, 0.2, 0.1, C.chassis);
  s.box(0, 0.94, KINGPIN_Z, 0.98, 0.08, 0.9, C.graphite);
  s.cyl("y", 0, 1.01, KINGPIN_Z, 0.46, 0.06, C.graphite, 20);
  s.box(0, 0.97, 13.55, 0.95, 0.03, 1.2, C.steel);
  s.box(0, 0.78, 15.0, 0.76, 0.56, 1.9, C.graphite); // engine
  s.box(0, 0.7, 13.6, 0.5, 0.36, 0.9, C.graphite); // gearbox
  s.cyl("z", 0, 0.58, 12.45, 0.05, 1.4, C.steel, 8); // prop shaft
  s.cyl("x", 0, 0.49, DRIVE_Z, 0.085, 1.2, C.chassis, 12);
  s.box(0, 0.47, DRIVE_Z + 0.05, 0.42, 0.38, 0.42, C.chassis); // diff
  s.box(0, 0.47, STEER_Z, 1.8, 0.1, 0.12, C.chassis);
  for (const sx of sides) {
    s.box(sx * 0.43, 0.58, STEER_Z, 0.08, 0.08, 1.3, C.graphite); // leaf
    s.cyl("y", sx * 0.43, 0.52, 10.95, 0.12, 0.2, C.rubber, 12); // air bag
    bar(
      s,
      [sx * 0.43, 0.55, 12.25],
      [sx * 0.43, 0.42, 10.95],
      0.08,
      0.08,
      C.graphite,
    );
    // Drive-axle mudguards + mudflaps, front wheel arches.
    fender(s, 0.49, DRIVE_Z, 0.565, sx * 0.575, sx * 1.245, C.graphite);
    s.box(sx * 0.91, 0.46, 10.93, 0.66, 0.56, 0.012, C.rubber);
    s.box(sx * 0.86, 0.76, 10.93, 0.8, 0.04, 0.04, C.steel);
    fender(
      s,
      0.49,
      STEER_Z,
      0.555,
      sx * 0.86,
      sx * 1.245,
      C.graphite,
      0.21,
      Math.PI - 0.21,
    );
  }
  // ---- Tanks: diesel (driver's side, -x), battery box + AdBlue (+x).
  s.cyl("z", -0.83, 0.66, 13.2, 0.31, 1.5, C.steel, 18);
  for (const z of [12.75, 13.65])
    s.cyl("z", -0.83, 0.66, z, 0.317, 0.045, C.graphite, 18);
  s.cyl("y", -0.95, 0.98, 13.75, 0.05, 0.03, C.graphite, 8);
  s.box(0.83, 0.68, 12.85, 0.6, 0.48, 0.8, C.graphite);
  s.cyl("z", 0.83, 0.66, 13.65, 0.24, 0.55, C.adblue, 14);
  s.cyl("y", 0.9, 0.92, 13.7, 0.04, 0.03, C.blue, 8);
  // ---- Air + electric lines ("suzies") from the cab back to the trailer.
  for (const [x, col] of [
    [-0.3, C.red],
    [-0.16, C.yellow],
    [0.04, C.graphite],
  ] as const) {
    bar(s, [x, 1.75, 14.18], [x, 1.33, 13.9], 0.025, 0.025, col);
    bar(s, [x, 1.33, 13.9], [x, 1.42, 13.62], 0.025, 0.025, col);
  }

  // ---- Cab: high-roof cab-over, 2.49 m wide, 2.22 m deep.
  const cabX = 1.245;
  const rake = (y: number): number => 16.42 - (0.2 * (y - 2.12)) / 1.1;
  mark(() => {
    s.prismZY(
      [
        [14.2, 1.05],
        [16.42, 1.05],
        [16.42, 2.12],
        [16.22, 3.22],
        [16.02, 3.62],
        [15.65, 3.86],
        [14.2, 3.88],
      ],
      -cabX,
      cabX,
      cab,
    );
    // Headlamp band, step wells, rear side extenders.
    s.box(0, 0.895, 16.075, 2.49, 0.31, 0.71, cab);
    for (const sx of sides) {
      s.box(sx * 1.1875, 0.725, 14.41, 0.115, 0.65, 0.42, cab);
      s.box(sx * 1.23, 2.65, 14.09, 0.03, 2.3, 0.22, cab);
    }
  });
  // Windscreen (raked 10 deg) in a black surround, wipers, sun visor.
  const nWs: V3 = [0, 0.179, 0.984];
  const ws = (x: number, y: number, off: number): [number, number, number] => [
    x,
    y + nWs[1] * off,
    rake(y) + nWs[2] * off,
  ];
  s.quadAuto(
    [
      ws(-1.17, 2.16, 0.004),
      ws(1.17, 2.16, 0.004),
      ws(1.17, 3.18, 0.004),
      ws(-1.17, 3.18, 0.004),
    ],
    nWs,
    C.graphite,
  );
  s.quadAuto(
    [
      ws(-1.1, 2.21, 0.008),
      ws(1.1, 2.21, 0.008),
      ws(1.1, 3.13, 0.008),
      ws(-1.1, 3.13, 0.008),
    ],
    nWs,
    C.glass,
  );
  bar(s, ws(-1.0, 2.25, 0.02), ws(-0.12, 2.36, 0.02), 0.025, 0.02, C.graphite);
  bar(s, ws(0.05, 2.25, 0.02), ws(0.93, 2.36, 0.02), 0.025, 0.02, C.graphite);
  s.box(0, 3.245, 16.27, 2.3, 0.06, 0.18, C.graphite);
  for (const x of [-0.6, -0.3, 0, 0.3, 0.6])
    s.box(x, 3.29, 16.3, 0.12, 0.04, 0.06, C.amber);
  // Grille: black panel, slats, badge.
  s.box(0, 1.585, 16.427, 1.8, 0.93, 0.014, C.graphite);
  for (let k = 0; k < 6; k++)
    s.box(
      0,
      1.2 + k * 0.15,
      16.44,
      1.72,
      0.045,
      0.012,
      k === 5 ? C.chrome : C.steel,
    );
  s.box(0, 1.95, 16.449, 0.3, 0.06, 0.01, C.chrome);
  // Headlamps + indicators, bumper, fog lamps, plate.
  for (const sx of sides) {
    s.box(sx * 0.9, 0.89, 16.433, 0.6, 0.24, 0.015, C.graphite);
    s.box(sx * 0.88, 0.89, 16.446, 0.44, 0.18, 0.012, C.lamp);
    s.box(sx * 1.14, 0.89, 16.446, 0.08, 0.18, 0.012, C.amber);
    s.box(sx * 0.95, 0.55, 16.485, 0.16, 0.1, 0.01, C.lamp);
  }
  s.box(0, 0.55, 16.1, 2.48, 0.38, 0.76, C.graphite);
  s.box(0, 0.54, 16.483, 0.52, 0.11, 0.008, C.plate);
  // Flank glazing, door seams, handles, grab rails, mirrors.
  for (const sx of sides) {
    const x = sx * cabX;
    flankQuad(
      s,
      x + sx * 0.003,
      [
        [14.46, 2.08],
        [15.66, 2.08],
        [15.66, 3.06],
        [14.46, 3.06],
      ],
      C.graphite,
    );
    flankQuad(
      s,
      x + sx * 0.006,
      [
        [14.5, 2.12],
        [15.62, 2.12],
        [15.62, 3.02],
        [14.5, 3.02],
      ],
      C.glass,
    );
    flankQuad(
      s,
      x + sx * 0.003,
      [
        [15.69, 2.11],
        [rake(2.11) - 0.07, 2.11],
        [rake(2.99) - 0.07, 2.99],
        [15.69, 2.99],
      ],
      C.graphite,
    );
    flankQuad(
      s,
      x + sx * 0.006,
      [
        [15.73, 2.15],
        [rake(2.15) - 0.11, 2.15],
        [rake(2.95) - 0.11, 2.95],
        [15.73, 2.95],
      ],
      C.glass,
    );
    for (const z of [14.38, 15.68])
      s.box(x + sx * 0.0025, 2.16, z, 0.006, 2.08, 0.014, C.graphite);
    s.box(x + sx * 0.008, 1.85, 14.6, 0.015, 0.05, 0.22, C.chrome);
    bar(
      s,
      [x + sx * 0.035, 1.35, 14.3],
      [x + sx * 0.035, 2.6, 14.3],
      0.035,
      0.035,
      C.chrome,
    );
    // Steps: treads in the step well behind the front wheel.
    for (const y of [0.47, 0.83])
      s.box(sx * 1.2, y, 14.41, 0.11, 0.05, 0.38, C.graphite);
    // Main + wide-angle mirror on arms off the A-pillar.
    bar(s, [x, 3.0, 16.15], [sx * 1.5, 3.02, 16.28], 0.04, 0.04, C.graphite);
    bar(s, [x, 2.2, 16.25], [sx * 1.5, 2.1, 16.28], 0.04, 0.04, C.graphite);
    bar(
      s,
      [sx * 1.5, 3.02, 16.28],
      [sx * 1.5, 2.1, 16.28],
      0.03,
      0.03,
      C.graphite,
    );
    s.box(sx * 1.53, 2.7, 16.28, 0.1, 0.5, 0.2, C.graphite);
    s.box(sx * 1.53, 2.7, 16.177, 0.08, 0.44, 0.006, C.mirror);
    s.box(sx * 1.53, 2.2, 16.28, 0.1, 0.22, 0.2, C.graphite);
    s.box(sx * 1.53, 2.2, 16.177, 0.08, 0.17, 0.006, C.mirror);
  }
  // Air intake tower behind the cab (+x).
  s.box(1.075, 2.55, 14.08, 0.25, 2.1, 0.2, C.graphite);
  s.box(1.075, 3.65, 14.08, 0.28, 0.1, 0.24, C.graphite);
  return accent;
}

// ---------------------------------------------------------------- wheels

/** Wheel stations: centre, width scale, radius scale (template 385/65 R22.5). */
interface WheelSpec {
  x: number;
  y: number;
  z: number;
  w: number;
  s: number;
}

const TYRE_R = 0.536;
const TYRE_HALF_W = 0.1925;

const WHEELS: readonly WheelSpec[] = [
  // Trailer: 385/65 R22.5 super singles on three axles.
  ...TRAILER_AXLES.flatMap((z) =>
    [-1, 1].map((sx) => ({ x: sx * 1.02, y: 0.52, z, w: 1, s: 1 })),
  ),
  // Tractor drive: 315/70 R22.5 twins.
  ...[-1, 1].flatMap((sx) =>
    [0.74, 1.075].map((o) => ({
      x: sx * o,
      y: 0.49,
      z: DRIVE_Z,
      w: 0.818,
      s: 0.944,
    })),
  ),
  // Tractor steer: singles.
  ...[-1, 1].map((sx) => ({
    x: sx * 1.05,
    y: 0.49,
    z: STEER_Z,
    w: 0.86,
    s: 0.944,
  })),
];

/**
 * Surface of revolution about the x axis. `prof` is a closed (radius, x)
 * outline traversed from the -x axis over the tread to the +x axis; each
 * edge is smooth around the axle and creased along the outline.
 */
function lathe(
  s: MeshSoup,
  prof: readonly (readonly [number, number])[],
  cols: readonly RGBA[],
  seg: number,
): void {
  for (let e = 0; e + 1 < prof.length; e++) {
    const [r0, x0] = prof[e];
    const [r1, x1] = prof[e + 1];
    const dr = r1 - r0;
    const dx = x1 - x0;
    const len = Math.hypot(dr, dx);
    if (len < 1e-6) continue;
    const nr = dx / len;
    const nx = -dr / len;
    const c = cols[e];
    const base = s.positions.length / 3;
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const cy = Math.cos(a);
      const sz = Math.sin(a);
      for (const [r, x] of [
        [r0, x0],
        [r1, x1],
      ] as const) {
        s.positions.push(x, r * cy, r * sz);
        s.normals.push(nx, nr * cy, nr * sz);
        s.colors.push(c[0], c[1], c[2], c[3]);
      }
    }
    for (let k = 0; k < seg; k++) {
      const a = base + 2 * k;
      const b = a + 1;
      const c2 = a + 2;
      const d = a + 3;
      s.indices.push(a, d, b, a, c2, d);
    }
  }
}

/** One symmetric wheel at the origin, axle along x: tyre, dished rim, hub, nuts. */
function buildWheelTemplate(s: MeshSoup): void {
  const half: [number, number, RGBA][] = [
    [0, -0.165, C.graphite],
    [0.062, -0.165, C.steel],
    [0.08, -0.15, C.steel],
    [0.085, -0.122, C.rim],
    [0.215, -0.122, C.rim],
    [0.25, -0.15, C.rim],
    [0.285, -0.175, C.rim],
    [0.305, -0.183, C.rubber],
    [0.4, -TYRE_HALF_W, C.rubber],
    [0.49, -0.19, C.rubber],
    [0.522, -0.17, C.rubber],
    [TYRE_R, -0.13, C.rubber],
  ];
  // Mirror the half-outline: the colour of an edge belongs to its start point.
  const prof: [number, number][] = half.map(([r, x]) => [r, x]);
  const cols: RGBA[] = half.map(([, , c]) => c);
  for (let i = half.length - 1; i >= 0; i--)
    prof.push([half[i][0], -half[i][1]]);
  for (let i = half.length - 2; i >= 0; i--) cols.push(half[i][2]);
  lathe(s, prof, cols, 32);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      s.cyl(
        "x",
        sx * 0.134,
        0.165 * Math.cos(a),
        0.165 * Math.sin(a),
        0.017,
        0.024,
        C.steel,
        6,
      );
    }
    for (let k = 0; k < 5; k++) {
      const a = ((k + 0.5) / 5) * Math.PI * 2;
      s.cyl(
        "x",
        sx * 0.1235,
        0.195 * Math.cos(a),
        0.195 * Math.sin(a),
        0.018,
        0.003,
        C.graphite,
        8,
      );
    }
  }
}

/** Writes each wheel's matrix for `travel` metres rolled along +z. */
function writeWheelMatrices(buf: Float32Array, travel: number): void {
  const sc = new Vector3();
  const tr = new Vector3();
  const q = new Quaternion();
  const m = new Matrix();
  WHEELS.forEach((w, i) => {
    sc.set(w.w, w.s, w.s);
    tr.set(w.x, w.y, w.z);
    Quaternion.RotationAxisToRef(Axis.X, travel / (TYRE_R * w.s), q);
    Matrix.ComposeToRef(sc, q, tr, m);
    m.copyToArray(buf, i * 16);
  });
}

function buildWheels(scene: Scene): { mesh: Mesh; buf: Float32Array } {
  const s = new MeshSoup();
  buildWheelTemplate(s);
  const mesh = s.build("truck:wheels", scene);
  if (!mesh) throw new Error("truck: empty wheels");
  const buf = new Float32Array(16 * WHEELS.length);
  writeWheelMatrices(buf, 0);
  mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
  mesh.thinInstanceRefreshBoundingInfo(false);
  return { mesh, buf };
}
