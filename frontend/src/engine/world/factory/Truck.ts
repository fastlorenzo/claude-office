/**
 * Articulated box truck (~16.5 m: tractor + 13.2 m trailer), procedural.
 * Local frame: origin = trailer rear centre on the ground, +z toward the cab,
 * +x to the driver's right. Two draws: vertex-coloured body + livery quads.
 */
import {
  Color3,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  Scene,
  Texture,
  TransformNode,
  VertexBuffer,
  VertexData,
} from "@/engine/babylon";
import type { BrandingOptions } from "@/engine/contracts";
import { DEFAULT_BRANDING } from "@/engine/world/brandLayout";
import { MeshSoup, hexColor } from "@/engine/world/factory/meshSoup";
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
  trailerL: 13.2,
  floorY: 1.2,
  roofY: 4.0,
  length: 16.7,
} as const;

/** Livery panel on each trailer side (m). */
const PANEL_L = 13.0;
const PANEL_H = 2.54;
const PANEL_Y0 = 1.36;
const PANEL_Z0 = 0.1;

export class Truck {
  readonly root: TransformNode;
  readonly body: Mesh;
  readonly livery: Mesh;
  readonly meshes: Mesh[];
  readonly texture: DynamicTexture;
  private opts: BrandingOptions;
  private logoImg: HTMLImageElement | null = null;
  private logoSrc: string | null = null;
  private token = 0;
  private accentRange: [number, number][] = [];
  private lastAccent = "";

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
  graphite: hexColor("#24272c"),
  chassis: hexColor("#30343a"),
  rubber: hexColor("#16171a"),
  rim: hexColor("#b8bec6"),
  glass: hexColor("#0c1218"),
  red: hexColor("#d6332b"),
  lamp: hexColor("#fff3d2"),
  amber: hexColor("#f2a81a"),
  steel: hexColor("#9aa1ab"),
  carton: hexColor("#d8dce1"),
};

/** Builds the truck into `s`; returns vertex ranges that take the accent. */
function buildTruck(s: MeshSoup, accentHex: string): [number, number][] {
  const accent: [number, number][] = [];
  const mark = (fn: () => void): void => {
    const a = s.positions.length / 3;
    fn();
    accent.push([a, s.positions.length / 3]);
  };
  const W = TRUCK.trailerW;
  const L = TRUCK.trailerL;
  const hw = W / 2;
  const wall = 0.06;

  // ---- Trailer shell (open at the rear so the cargo hold reads).
  s.box(0, 1.17, L / 2, W - 0.05, 0.06, L, C.floor); // floor
  for (const sx of [-1, 1]) {
    s.box(
      sx * (hw - wall / 2),
      (TRUCK.floorY + TRUCK.roofY) / 2,
      L / 2,
      wall,
      TRUCK.roofY - TRUCK.floorY,
      L,
      C.white,
    );
    s.box(sx * 0.58, 1.02, L / 2 - 0.2, 0.16, 0.2, L - 0.8, C.chassis); // main beams
  }
  s.box(0, TRUCK.roofY - 0.03, L / 2, W, 0.06, L, C.roof);
  s.box(
    0,
    (TRUCK.floorY + TRUCK.roofY) / 2,
    L - wall / 2,
    W,
    TRUCK.roofY - TRUCK.floorY,
    wall,
    C.white,
  );
  // Rear frame (door posts + header) and ICC bar.
  s.box(0, TRUCK.roofY - 0.14, 0.02, W, 0.16, 0.08, C.steel);
  s.box(0, 0.62, -0.1, 2.3, 0.14, 0.1, C.graphite);
  for (const sx of [-1, 1]) {
    s.box(sx * 1.0, 0.8, -0.06, 0.08, 0.35, 0.08, C.graphite);
    s.box(sx * (hw - 0.14), 3.0, -0.02, 0.1, 0.5, 0.05, C.red); // tail lamps
    s.box(sx * (hw - 0.14), 1.75, -0.02, 0.1, 0.12, 0.05, C.amber);
  }
  // Side under-run guards.
  for (const sx of [-1, 1])
    s.box(sx * (hw - 0.08), 0.82, 6.4, 0.05, 0.16, 4.4, C.graphite);
  // A few cartons inside the rear (read through the dock door).
  mark(() => {
    for (const [x, z, h] of [
      [-0.7, 1.2, 1.1],
      [0.1, 1.3, 1.5],
      [0.8, 1.15, 0.9],
    ] as const)
      s.box(x, 1.2 + h / 2, z, 0.62, h, 0.7, hexColor(shade(accentHex, -0.1)));
  });
  s.box(-0.4, 1.2 + 0.4, 2.4, 1.2, 0.8, 0.9, C.carton);

  // ---- Landing legs.
  for (const sx of [-1, 1]) {
    s.box(sx * 0.95, 0.65, 9.4, 0.1, 1.0, 0.1, C.graphite);
    s.box(sx * 0.95, 0.07, 9.4, 0.3, 0.06, 0.3, C.graphite);
  }

  // ---- Wheels (tandem trailer axles, tractor drive tandem + steer).
  const wheel = (x: number, z: number, outward: number): void => {
    s.cyl("x", x, 0.5, z, 0.5, 0.27, C.rubber, 18);
    s.cyl("x", x + outward * 0.02, 0.5, z, 0.3, 0.28, C.rim, 14);
  };
  for (const z of [2.3, 3.6])
    for (const sx of [-1, 1]) {
      wheel(sx * 0.9, z, sx);
      wheel(sx * 1.2, z, sx);
      s.cyl("x", 0, 0.5, z, 0.07, 1.9, C.graphite, 8);
    }
  for (const z of [11.2, 12.5])
    for (const sx of [-1, 1]) {
      wheel(sx * 0.92, z, sx);
      wheel(sx * 1.2, z, sx);
      s.cyl("x", 0, 0.5, z, 0.08, 1.9, C.graphite, 8);
    }
  for (const sx of [-1, 1]) wheel(sx * 1.05, 15.5, sx);
  s.cyl("x", 0, 0.5, 15.5, 0.08, 2.0, C.graphite, 8);

  // ---- Tractor chassis, fifth wheel.
  for (const sx of [-1, 1])
    s.box(sx * 0.45, 0.88, 13.2, 0.14, 0.22, 6.6, C.chassis);
  s.box(0, 1.06, 11.6, 1.5, 0.1, 1.2, C.graphite);
  s.box(0, 0.7, 14.3, 2.1, 0.16, 0.5, C.chassis);
  // Wheel-arch fenders over the drive tandem.
  for (const sx of [-1, 1])
    s.box(sx * 1.08, 0.98, 11.85, 0.62, 0.05, 2.0, C.graphite);

  // ---- Cab (accent-coloured prism: cab-over with a roof deflector).
  const cabProfile: [number, number][] = [
    [13.95, 1.15],
    [16.45, 1.15],
    [16.45, 2.3],
    [16.2, 3.15],
    [15.0, 3.15],
    [14.2, 3.95],
    [13.95, 3.95],
  ];
  mark(() =>
    s.prismZY(cabProfile, -1.25, 1.25, hexColor(shade(accentHex, -0.12))),
  );
  // Windscreen + side glass + grille + lamps + bumper.
  s.quadAuto(
    [
      [-1.12, 2.38, 16.452],
      [1.12, 2.38, 16.452],
      [1.12, 3.08, 16.23],
      [-1.12, 3.08, 16.23],
    ],
    [0, 0.3, 0.95],
    C.glass,
  );
  for (const sx of [-1, 1]) {
    s.box(sx * 1.255, 2.55, 15.55, 0.02, 0.8, 1.2, C.glass);
    s.box(sx * 1.3, 2.2, 16.0, 0.08, 0.3, 0.2, C.graphite); // mirror
    s.box(sx * 0.85, 1.7, 16.46, 0.42, 0.2, 0.04, C.lamp);
    s.box(sx * 1.28, 1.25, 15.2, 0.1, 0.05, 0.5, C.graphite); // step
  }
  s.box(0, 1.65, 16.46, 1.0, 0.4, 0.03, C.graphite); // grille
  s.box(0, 0.95, 16.58, 2.5, 0.3, 0.16, C.graphite); // bumper
  s.box(0, 3.2, 16.0, 0.9, 0.05, 0.12, C.amber); // marker bar
  // Exhaust stack.
  for (const sx of [-1])
    s.cyl("y", sx * 1.18, 2.3, 13.8, 0.06, 2.6, C.steel, 8);
  return accent;
}
