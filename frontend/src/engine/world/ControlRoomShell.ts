/**
 * Control-room drum: the exterior of the round ops room, seen from the
 * factory floor and the hall end (ControlRoom builds the interior lining on
 * the same plan, Building the floor).
 *
 *   - light composite cladding skin (the office's plaster tone) with slim
 *     black panel joints, floor-to-head ribbon windows on both flanks (black
 *     frames, mullions on `DRUM.pane`), a black datum band continuing the
 *     window head round the solid arcs;
 *   - flat roof disc behind an aluminium fascia with a recessed LED reveal;
 *   - round concrete slab with a black edge band (a steel edge beam under
 *     the ribbons, where a glazed floor strip lets you look straight down),
 *     a soffit LED ring and RAL 7016 columns down to the factory floor;
 *   - the neck: straight side walls + soffit joining the hall end (the hall
 *     ceiling continues over it), so the square spine meets the round drum
 *     without overlapping boxes.
 *
 * One ArtBatcher, lit by the factory (not part of the zone-isolated
 * interior): cladding, black metal, glass, aluminium, concrete, painted
 * steel, paint, LED = 8 draws.
 */

import { Mesh, Vector3, VertexData, type Scene } from "@/engine/babylon";
import { FLOOR_Y } from "@/engine/layout/factoryLayout";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { ArtBatcher, paintOf } from "@/engine/art/geometry";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  DRUM,
  drumOutline,
  onArc,
  type ControlPlan,
  type DrumPlan,
} from "./controlRoomPlan";

const COLUMN = 0.3;
const YELLOW = "#E3B417";

type P2 = { x: number; z: number };

/** Push a triangle with Babylon's winding (cross(b-a, c-a) opposes `n`). */
function tri(
  pos: number[],
  idx: number[],
  a: number,
  b: number,
  c: number,
  n: [number, number, number],
): void {
  const g = (i: number, k: number) => pos[i * 3 + k];
  const e1 = [g(b, 0) - g(a, 0), g(b, 1) - g(a, 1), g(b, 2) - g(a, 2)];
  const e2 = [g(c, 0) - g(a, 0), g(c, 1) - g(a, 1), g(c, 2) - g(a, 2)];
  const cx = e1[1] * e2[2] - e1[2] * e2[1];
  const cy = e1[2] * e2[0] - e1[0] * e2[2];
  const cz = e1[0] * e2[1] - e1[1] * e2[0];
  if (cx * n[0] + cy * n[1] + cz * n[2] > 0) idx.push(a, c, b);
  else idx.push(a, b, c);
}

/**
 * Vertical prism over a star-shaped plan outline (fan from `c`): top,
 * bottom and flat-shaded sides. World coordinates.
 */
export function prismData(
  outline: P2[],
  c: P2,
  y0: number,
  y1: number,
): VertexData {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const add = (
    x: number,
    y: number,
    z: number,
    n: [number, number, number],
  ) => {
    pos.push(x, y, z);
    nor.push(n[0], n[1], n[2]);
    return pos.length / 3 - 1;
  };
  const N = outline.length;
  for (const [y, ny] of [
    [y1, 1],
    [y0, -1],
  ] as const) {
    const n: [number, number, number] = [0, ny, 0];
    const ci = add(c.x, y, c.z, n);
    const base = pos.length / 3;
    for (const q of outline) add(q.x, y, q.z, n);
    for (let i = 0; i < N; i++)
      tri(pos, idx, ci, base + i, base + ((i + 1) % N), n);
  }
  sides(outline, y0, y1, pos, nor, idx);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = new Array((pos.length / 3) * 2).fill(0);
  vd.indices = idx;
  return vd;
}

/**
 * Prism between two paired polylines (`a[i]` ↔ `b[i]`, same direction):
 * a quad strip top + bottom and the closing sides. World coordinates.
 */
export function stripData(
  a: P2[],
  bb: P2[],
  y0: number,
  y1: number,
): VertexData {
  const outline = [...a, ...[...bb].reverse()];
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const add = (q: P2, y: number, n: [number, number, number]) => {
    pos.push(q.x, y, q.z);
    nor.push(n[0], n[1], n[2]);
    return pos.length / 3 - 1;
  };
  for (const [y, ny] of [
    [y1, 1],
    [y0, -1],
  ] as const) {
    const n: [number, number, number] = [0, ny, 0];
    for (let i = 0; i < a.length - 1; i++) {
      const q = add(a[i], y, n);
      add(a[i + 1], y, n);
      add(bb[i + 1], y, n);
      add(bb[i], y, n);
      tri(pos, idx, q, q + 1, q + 2, n);
      tri(pos, idx, q, q + 2, q + 3, n);
    }
  }
  sides(outline, y0, y1, pos, nor, idx);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = new Array((pos.length / 3) * 2).fill(0);
  vd.indices = idx;
  return vd;
}

/** Flat-shaded vertical sides of a closed outline (normals point out). */
function sides(
  outline: P2[],
  y0: number,
  y1: number,
  pos: number[],
  nor: number[],
  idx: number[],
): void {
  const N = outline.length;
  let area = 0;
  for (let i = 0; i < N; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % N];
    area += a.x * b.z - b.x * a.z;
  }
  const s = area > 0 ? 1 : -1;
  for (let i = 0; i < N; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % N];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const n: [number, number, number] = [(s * dz) / len, 0, (-s * dx) / len];
    const q = pos.length / 3;
    for (const [x, y, z] of [
      [a.x, y0, a.z],
      [b.x, y0, b.z],
      [b.x, y1, b.z],
      [a.x, y1, a.z],
    ]) {
      pos.push(x, y, z);
      nor.push(n[0], n[1], n[2]);
    }
    tri(pos, idx, q, q + 1, q + 2, n);
    tri(pos, idx, q, q + 2, q + 3, n);
  }
}

/** Room floor (y −0.1 → 0): circle to under the plaster + the neck. */
export function floorOutline(p: ControlPlan, d: DrumPlan): P2[] {
  return drumOutline(p, d, d.rWall, d.rGlassFloor, p.neckHW);
}

export interface ControlShellContext {
  scene: Scene;
  materials: Materials;
  colliders: Colliders;
}

/** Build the drum exterior; returns the merged meshes (8 draws). */
export function buildControlShell(
  ctx: ControlShellContext,
  p: ControlPlan,
  d: DrumPlan,
  group: string,
): Mesh[] {
  const { scene, materials, colliders } = ctx;
  const b = new ArtBatcher(scene, materials, "controlDrum", 23);
  b.jitter = 0.01;
  const { cx, cz, H } = p;
  const C = v3(cx, 0, cz);
  const deg = Math.PI / 180;
  const clad = "wall";
  const led = materials.emissive("controlReveal", "#EAF2FF", 1.4);
  const { rIn, rWall, rOut, rGlass, aNeckOut } = d;
  const top = H + 0.05; // skin top (LED reveal above, fascia over it)
  const soffit = DRUM.soffit;
  const head = DRUM.head;
  const nk = p.neckHW;
  const segs = (a0: number, a1: number) =>
    Math.max(2, Math.ceil(Math.abs(a1 - a0) / (1.5 * deg)));
  const arc = (
    m: Parameters<ArtBatcher["arc"]>[0],
    r0: number,
    r1: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
  ) => b.arc(m, C, r0, r1, a0, a1, y0, y1, segs(a0, a1));

  // Solid arcs (no windows): north wall arc, the piers by the neck.
  const solids: Array<[number, number]> = [];
  const wins = [...d.windows].sort((a, b2) => a.a0 - b2.a0);
  if (wins.length === 2) {
    solids.push([-aNeckOut, wins[0].a0]);
    solids.push([wins[0].a1, wins[1].a0]);
    solids.push([wins[1].a1, aNeckOut]);
  } else solids.push([-aNeckOut, aNeckOut]);

  // ---- Skin: solid arcs full height, over the windows from the head up,
  // over the neck (the lintel) from the neck ceiling up.
  for (const [a0, a1] of solids) arc(clad, rWall, rOut, a0, a1, -0.1, top);
  for (const w of wins) arc(clad, rWall, rOut, w.a0, w.a1, head, top);
  arc(
    clad,
    rWall,
    rOut,
    aNeckOut,
    2 * Math.PI - aNeckOut,
    DRUM.neckH + 0.1,
    top,
  );

  // Panel joints on the solid skin (slim black reveals ~1.2 m apart) and a
  // datum band continuing the window head line round the drum.
  for (const [a0, a1] of solids) {
    const n = Math.max(1, Math.round(((a1 - a0) * rOut) / 1.2));
    for (let i = 1; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const q = onArc(cx, cz, rOut + 0.004, a);
      b.box(
        "blackMetal",
        v3(q.x, (top - 0.1) / 2, q.z),
        v3(0.018, top + 0.1, 0.012),
        {
          yaw: a,
        },
      );
    }
    arc("blackMetal", rOut, rOut + 0.012, a0, a1, head, head + 0.05);
  }
  arc(
    "blackMetal",
    rOut,
    rOut + 0.012,
    aNeckOut,
    2 * Math.PI - aNeckOut,
    head,
    head + 0.05,
  );

  // ---- Ribbon windows: glass from the floor to the head, black sill /
  // head rails and mullions on the glass line.
  for (const w of wins) {
    arc("glass", rGlass - 0.01, rGlass + 0.01, w.a0, w.a1, 0.06, head - 0.06);
    arc("blackMetal", rIn + 0.04, rOut + 0.03, w.a0, w.a1, -0.04, 0.06);
    arc("blackMetal", rIn + 0.04, rIn + 0.16, w.a0, w.a1, head - 0.06, head);
  }
  for (const a of d.mullions) {
    const q = onArc(cx, cz, rGlass, a);
    b.box("blackMetal", v3(q.x, head / 2, q.z), v3(0.06, head - 0.04, 0.14), {
      yaw: a,
      bevel: 0.004,
    });
  }

  // ---- Glazed floor strip inside the ribbons (on a steel edge beam), and
  // the slab edge band under the solid arcs: one black band all round.
  for (const w of wins) {
    arc("glass", d.rGlassFloor, rIn + 0.1, w.a0, w.a1, -0.04, 0);
    arc("blackMetal", rIn, rOut + 0.03, w.a0, w.a1, soffit, -0.04);
    // Inner support angle + radial bearers under the glass.
    arc(
      "blackMetal",
      d.rGlassFloor - 0.04,
      d.rGlassFloor,
      w.a0,
      w.a1,
      -0.14,
      -0.04,
    );
    const n = Math.max(1, Math.round(((w.a1 - w.a0) * rIn) / 1.2));
    for (let i = 1; i < n; i++) {
      const a = w.a0 + ((w.a1 - w.a0) * i) / n;
      const q = onArc(cx, cz, (d.rGlassFloor + rIn) / 2, a);
      b.box(
        "blackMetal",
        v3(q.x, -0.08, q.z),
        v3(0.04, 0.08, rIn - d.rGlassFloor),
        {
          yaw: a,
        },
      );
    }
  }
  const band0 = rOut - 0.2;
  for (const [a0, a1] of solids)
    arc("blackMetal", band0, rOut + 0.03, a0, a1, soffit, -0.1);

  // ---- Slab (concrete, soffit at DRUM.soffit): circle inside the edge
  // band (inside the glazed strip across the ribbons) + the neck.
  b.add(
    "concreteSoffit",
    meshOf(
      scene,
      prismData(
        drumOutline(p, d, band0, d.rGlassFloor, nk),
        { x: cx, z: cz },
        soffit,
        -0.1,
      ),
    ),
  );
  // Soffit LED ring (lights the drum's underside / the columns).
  arc(
    led,
    rOut - 1.05,
    rOut - 1.0,
    -aNeckOut + 4 * deg,
    aNeckOut - 4 * deg,
    soffit - 0.006,
    soffit,
  );

  // ---- Neck: side walls (skin outside, plaster lining is ControlRoom's)
  // with the edge band under them, and the hall ceiling slab carried on
  // over it up to the drum's inner face (the lintel sits on it).
  const xSkin = nk + DRUM.wallT + DRUM.cladT / 2;
  const zSkin = p.cz - Math.sqrt((rWall + DRUM.cladT / 2) ** 2 - xSkin ** 2);
  const zBand = p.cz - Math.sqrt((band0 + 0.12) ** 2 - (nk + 0.14) ** 2);
  for (const s of [-1, 1]) {
    const zl = zSkin - p.z0;
    b.box(
      clad,
      v3(cx + s * xSkin, (DRUM.neckH + 0.1 - 0.1) / 2, p.z0 + zl / 2),
      v3(DRUM.cladT, DRUM.neckH + 0.2, zl),
    );
    const zb = zBand - p.z0;
    b.box(
      "blackMetal",
      v3(cx + s * (nk + 0.14), (soffit - 0.1) / 2, p.z0 + zb / 2),
      v3(0.28, -0.1 - soffit, zb),
    );
  }
  const slabHW = nk + DRUM.wallT;
  const south: P2[] = [];
  const north: P2[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = cx - slabHW + (2 * slabHW * i) / 24;
    south.push({ x, z: p.z0 });
    north.push({ x, z: p.cz - Math.sqrt(rIn * rIn - (x - cx) ** 2) });
  }
  b.add(
    clad,
    meshOf(scene, stripData(south, north, DRUM.neckH, DRUM.neckH + 0.1)),
  );

  // ---- Roof: flat deck behind an aluminium fascia, LED reveal under it.
  arc(led, rOut - 0.06, rOut - 0.02, 0, 2 * Math.PI, top, H + 0.1);
  b.arc(
    "aluminium",
    C,
    rOut - 0.12,
    rOut + 0.05,
    0,
    2 * Math.PI,
    H + 0.1,
    H + 0.5,
    240,
  );
  b.arc(
    "concreteSoffit",
    C,
    0,
    rOut - 0.12,
    0,
    2 * Math.PI,
    H + 0.1,
    H + 0.32,
    120,
  );

  // ---- Columns (factory floor → soffit), same detailing as the hall's.
  const fy = FLOOR_Y;
  for (const { x, z } of d.columns) {
    b.box(
      "steelPainted",
      v3(x, (fy + soffit) / 2, z),
      v3(COLUMN, soffit - fy, COLUMN),
      { bevel: 0.006 },
    );
    b.box("steelPainted", v3(x, fy + 0.015, z), v3(0.55, 0.03, 0.55), {
      bevel: 0.005,
    });
    b.box("steelPainted", v3(x, soffit - 0.015, z), v3(0.45, 0.03, 0.45), {
      bevel: 0.005,
    });
    b.paint = paintOf(YELLOW);
    b.box("paint", v3(x, fy + 0.5, z), v3(COLUMN + 0.03, 0.9, COLUMN + 0.03), {
      bevel: 0.005,
    });
    b.paint = null;
    colliders.addBox(
      group,
      new Vector3(x, (fy + soffit) / 2, z),
      new Vector3(COLUMN + 0.04, soffit - fy, COLUMN + 0.04),
    );
  }

  const meshes = b.build({ receiveShadows: true });
  for (const m of meshes) {
    m.isPickable = false;
    if (m.material?.needAlphaBlending()) m.alphaIndex = 0;
  }
  return meshes;
}

function meshOf(scene: Scene, vd: VertexData): Mesh {
  const m = new Mesh("controlDrum:prism", scene);
  vd.applyToMesh(m);
  return m;
}
