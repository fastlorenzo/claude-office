/**
 * EntranceHall — the entrance building's ground floor (y = FLOOR_Y), its two
 * feature stairs up to the reception, the glass lift and the reception's
 * gallery underside inside the factory volume.
 *
 * The building projects south of the factory envelope under the reception
 * (factoryLayout `entrance`). Ground floor: a mostly empty, 5.6 m high lobby
 * with quartz floor, a graphite feature wall on the shared north wall with
 * the neon brand (a second BrandSign) above the sliding door into the
 * factory, a directory sign, benches and planters; glazed south façade with
 * automatic sliding doors under a cantilevered canopy, charcoal corner piers
 * and fins (reads as its own pavilion against the factory cladding).
 *
 * Stairs: U-shaped, against each side wall — lower flight along the wall up
 * to a landing behind the façade glass, upper flight inboard arriving north
 * at the reception. Oak treads on a folded black steel plate, glass
 * balustrades, hidden pitched ramp colliders (Colliders `pitch`).
 *
 * Lift: glass shaft beside the west stair; F on its doors (interaction kind
 * "lift") runs `LiftController`: doors, fade, move the rider, doors.
 *
 * Built in a ground-floor frame (local y 0 = FLOOR_Y): the batcher's merged
 * meshes are shifted by FLOOR_Y and colliders go through an offset sink.
 */
import {
  CreateBox,
  Mesh,
  TransformNode,
  Vector3,
  type DynamicTexture,
  type Scene,
} from "@/engine/babylon";
import type { BrandingOptions, InteractionTarget } from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import { PLANTER_SOIL_Y } from "@/engine/assets/proceduralProps";
import { ArtBatcher } from "@/engine/art/geometry";
import { fixture, type FixturePoint } from "@/engine/fx/Lighting";
import type { Materials } from "@/engine/materials/Materials";
import {
  framedSink,
  type ColliderSink,
  type Colliders,
} from "@/engine/physics/Colliders";
import { v3 } from "@/engine/util/MeshBatcher";
import {
  ENTRANCE,
  type EntranceLayout,
  type EntranceStair,
  type Rect,
} from "@/engine/layout/factoryLayout";
import { BrandSign } from "@/engine/world/BrandSign";
import {
  FONT_STACK,
  RAIL_H,
  downlight,
  drawSpark,
  glassPartition,
  makeTexture,
  recessedSlot,
  rectMinusHoles,
  roundRect,
  texturedPlane,
  wallWithOpenings,
} from "@/engine/world/architecture";
import { LiftController, type LiftLevel } from "@/engine/world/entranceLift";
import { onWorldLocale, worldT } from "@/engine/world/worldLocale";
import { forecourtBoxes } from "@/engine/world/forecourtColliders";
import {
  buildSignMesh,
  entranceSigns,
  signHardware,
} from "@/engine/world/wayfinding";
import {
  flight,
  guardBoxes,
  nookRail,
  rampBox,
  rampDepth,
  STAIR_RAIL_TOP,
  underBlockers,
  type Flight,
} from "@/engine/world/stairs";

export interface EntranceHallContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
}

const G = "entrance";
/** Ground clear height to the reception slab soffit (local). */
const CEIL = 5.6;
/** Reception floor level in the local frame. */
const UP = 6;
/** Reception box top (world 6) in the local frame. */
const TOP = 12;
const T = 0.2;
const DOOR_H = 2.6;
const LIFT_TOP = UP + 2.9;
const LIFT_DOOR_H = 2.2;
const RISE = 0.18;

/** Folded-steel depth of the flights / landings below the nosing line. */
const STAIR_D = 0.42;
const STRINGER_T = 0.02;
/** Handrail height above the nosing line / landing. */
const RAIL_TOP = STAIR_RAIL_TOP;

/** Sliding pair: two leaves that part along x. */
interface Slider {
  leaves: Mesh[];
  closedX: number[];
  dir: number[];
  travel: number;
  open: number;
}

export class EntranceHall {
  readonly meshes: Mesh[] = [];
  readonly textures: DynamicTexture[] = [];
  readonly fixtures: FixturePoint[] = [];
  private readonly brand: BrandSign;
  private readonly sink: ColliderSink;
  private readonly floorY: number;
  private readonly lift = new LiftController(0);
  private readonly liftCar: TransformNode;
  private readonly liftDoors: [Slider, Slider];
  private readonly entryDoors: Slider;
  private readonly factoryDoor: Slider;
  private fadeEl: HTMLDivElement | null = null;
  private readonly frame: TransformNode;

  constructor(
    private readonly ctx: EntranceHallContext,
    private readonly e: EntranceLayout,
    brandOpts: BrandingOptions,
  ) {
    const { scene, materials } = ctx;
    this.floorY = e.floorY;
    this.sink = framedSink(ctx.colliders, new Vector3(0, e.floorY, 0), 0);
    const b = new ArtBatcher(scene, materials, G, 7);
    this.buildShell(b);
    this.buildFacade(b);
    this.buildFeatureWall(b);
    for (const st of e.stairs) this.buildStair(b, st);
    this.buildOpeningRails(b);
    this.buildLiftShaft(b);
    this.buildGallery(b);
    this.buildBenches(b);
    this.buildForecourt(b);
    const signs = entranceSigns(e, UP, TOP);
    signHardware(b, signs);
    // Ground-floor frame: local y 0 = FLOOR_Y.
    this.frame = new TransformNode("entrance:frame", scene);
    this.frame.position.y = e.floorY;
    this.frame.computeWorldMatrix(true);
    const built = b.build({ receiveShadows: true, parent: this.frame });
    for (const m of built) {
      m.computeWorldMatrix(true);
      m.metadata = { ...(m.metadata ?? {}), probe: true };
      if (m.material?.needAlphaBlending()) m.alphaIndex = 0;
    }
    this.meshes.push(...built);
    for (const f of this.fixtures) f.y += e.floorY;

    // Moving parts (own meshes, world frame).
    this.entryDoors = this.slider(
      "entryDoor",
      e.doors.x,
      e.rect.z0 - 0.09,
      e.doors.width,
      DOOR_H,
      "glassExterior",
    );
    this.factoryDoor = this.slider(
      "factoryDoor",
      e.factoryDoor.x,
      e.factoryDoor.z - ENTR_WALL_T / 2,
      e.factoryDoor.width,
      e.factoryDoor.height,
      "aluminium",
    );
    const L = e.lift;
    this.liftDoors = [0, 1].map((lvl) =>
      this.slider(
        `liftDoor${lvl}`,
        L.door.x,
        L.door.z - 0.03,
        L.door.width,
        LIFT_DOOR_H,
        "aluminium",
        lvl * UP,
        (L.rect.x1 - L.rect.x0) / 2 - L.door.width / 2 - 0.06,
      ),
    ) as [Slider, Slider];
    this.liftCar = this.buildCar();
    this.buildLiftTargets();
    this.buildDirectory();
    const sm = buildSignMesh(
      scene,
      G,
      signs.map((s) => ({
        ...s,
        y: s.y + e.floorY,
        hangTo: s.hangTo === undefined ? undefined : s.hangTo + e.floorY,
      })),
    );
    if (sm) {
      this.meshes.push(sm.mesh);
      this.textures.push(sm.texture);
    }

    // Neon brand above the factory door, on the graphite feature wall.
    this.brand = new BrandSign(
      scene,
      { x: e.factoryDoor.x, y: e.floorY + 4.15, wallZ: e.factoryDoor.z - 0.34 },
      brandOpts,
    );
    this.meshes.push(...this.brand.meshes);
    this.textures.push(this.brand.texture);
    this.brand.set(brandOpts);

    this.placeProps();
    for (const m of this.meshes) {
      if (m.parent || this.isMoving(m)) continue;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
  }

  setBranding(opts: BrandingOptions): void {
    this.brand.set(opts);
  }

  /** F on a lift door: start a ride from that stop. */
  callLift(level: LiftLevel): void {
    this.lift.call(level);
  }

  /**
   * Per frame: sliding doors (proximity), the lift. Returns where to move the
   * player on the frame a lift ride swaps floors.
   */
  update(
    dt: number,
    feet: { x: number; y: number; z: number },
  ): { position: Vector3; yaw: number } | null {
    const e = this.e;
    const near = (x: number, z: number, y: number, r: number): boolean =>
      Math.abs(feet.y - y) < 1.2 && Math.hypot(feet.x - x, feet.z - z) < r;
    this.drive(this.entryDoors, near(e.doors.x, e.doors.z, e.floorY, 3.2), dt);
    this.drive(
      this.factoryDoor,
      near(e.factoryDoor.x, e.factoryDoor.z, e.floorY, 3.2),
      dt,
    );
    const f = this.lift.update(dt);
    this.liftCar.position.y = e.floorY + f.car * UP;
    this.liftDoors.forEach((s, i) => this.setSlider(s, f.doors[i]));
    this.setFade(f.fade);
    if (f.teleportTo === null) return null;
    const stop = e.lift.stops[f.teleportTo];
    return {
      position: new Vector3(stop.front.x, stop.front.y + 0.05, stop.front.z),
      yaw: stop.yaw,
    };
  }

  dispose(): void {
    this.ctx.assets.disposeGroup(G);
    this.ctx.colliders.disposeGroup(G);
    for (const m of this.meshes) {
      const mat = m.material;
      m.dispose(false, false);
      if (mat && mat.name.endsWith(":mat")) mat.dispose(false, false);
    }
    this.liftCar.dispose(false, false);
    this.frame.dispose(false, false);
    for (const t of this.textures) t.dispose();
    this.fadeEl?.remove();
    this.fadeEl = null;
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  private col(
    c: Vector3,
    s: Vector3,
    opts?: { pitch?: number; see?: boolean },
  ) {
    this.sink.addBox(G, c, s, 0, {
      pitch: opts?.pitch,
      seeThrough: opts?.see,
    });
  }

  private buildShell(b: ArtBatcher): void {
    const e = this.e;
    const { x0, x1, z0 } = e.rect;
    const zw = e.factoryDoor.z - ENTR_WALL_T; // lobby face of the shared wall
    const cz = (z0 + zw) / 2;
    const d = zw - z0;
    // Floor (quartz terrazzo) + collider.
    b.box("quartz", v3(0, -0.05, cz), v3(x1 - x0 + 0.4, 0.1, d + 0.2));
    // Threshold plate through the factory door (G6): from the lobby face of
    // the shared wall to just past its factory face, over the epoxy's edge
    // (no gap to the ground below; 2 mm proud, no lip for the feet).
    {
      const fd = e.factoryDoor;
      const za = zw - 0.02;
      const zb = fd.z + 0.04;
      b.box(
        "blackMetal",
        v3(fd.x, -0.049, (za + zb) / 2),
        v3(fd.width, 0.102, zb - za),
      );
    }
    this.col(new Vector3(0, -0.1, cz), new Vector3(x1 - x0, 0.2, d));
    // Entrance mat.
    b.rbox("charcoal", v3(e.doors.x, 0.006, z0 + 1.1), v3(3.8, 0.012, 1.7), {
      r: 0.004,
    });
    // Ceiling = reception slab soffit, cut at the stairs and the lift.
    const holes: Rect[] = [...e.stairs.map((s) => s.rect), e.lift.rect];
    for (const r of rectMinusHoles({ x0, x1, z0, z1: zw }, holes))
      b.box(
        "ceiling",
        v3((r.x0 + r.x1) / 2, (CEIL + UP - 0.1) / 2, (r.z0 + r.z1) / 2),
        v3(r.x1 - r.x0, UP - 0.1 - CEIL, r.z1 - r.z0),
      );
    // Linear LED slots along z between the stairs (clear of the lift).
    for (const x of [-6, -2, 2, 6])
      this.fixtures.push(
        ...recessedSlot(b, "z", x, z0 + 0.8, zw - 0.6, CEIL, 2.4, 0.06, 1.1),
      );
    // Side walls (exterior), full height of the entrance block's ground floor.
    for (const s of [-1, 1]) {
      const wx = s * (x1 + T / 2);
      wallWithOpenings(
        b,
        this.sink,
        G,
        "wall",
        "z",
        wx,
        T,
        z0,
        zw + ENTR_WALL_T,
        UP,
      );
      // Charcoal cladding outside: the ground floor on both sides, the full
      // block height on the west (the reception's east side is glazed).
      const cx = s * (x1 + T + 0.03);
      const ch = s < 0 ? TOP + 0.6 : UP + 0.05;
      b.box("charcoal", v3(cx, ch / 2 - 0.3, cz), v3(0.06, ch + 0.3, d + 0.3));
      for (let z = z0 + 1.2; z < zw; z += 1.2)
        b.box(
          "shadowGap",
          v3(cx + s * 0.031, ch / 2 - 0.3, z),
          v3(0.004, ch + 0.3, 0.02),
        );
      // 100 mm charcoal skirting (15 mm proud) with a shadow gap above (G14).
      b.box("charcoal", v3(s * (x1 - 0.0075), 0.05, cz), v3(0.015, 0.1, d), {
        bevel: 0.003,
      });
      b.box("shadowGap", v3(s * (x1 - 0.002), 0.106, cz), v3(0.004, 0.012, d));
    }
    // Shared north wall with the factory door (both faces finished).
    const fd = e.factoryDoor;
    const wz = fd.z - ENTR_WALL_T / 2;
    wallWithOpenings(
      b,
      null,
      G,
      "wall",
      "x",
      wz,
      ENTR_WALL_T,
      x0 - T,
      x1 + T,
      UP,
      [
        {
          a0: fd.x - fd.width / 2,
          a1: fd.x + fd.width / 2,
          y0: 0,
          y1: fd.height,
        },
      ],
      false,
    );
    const a = fd.x - fd.width / 2;
    const c = fd.x + fd.width / 2;
    this.col(
      new Vector3((x0 - T + a) / 2, UP / 2, wz),
      new Vector3(a - x0 + T, UP, ENTR_WALL_T),
    );
    this.col(
      new Vector3((c + x1 + T) / 2, UP / 2, wz),
      new Vector3(x1 + T - c, UP, ENTR_WALL_T),
    );
    this.col(
      new Vector3(fd.x, (fd.height + UP) / 2, wz),
      new Vector3(fd.width, UP - fd.height, ENTR_WALL_T),
    );
    // Door lining: black steel on the opening's jambs and head, flush with
    // the factory face and the lobby's slat face (no frame proud of either).
    const lz0 = fd.z; // factory face
    const lz1 = fd.z - ENTR_WALL_T - FEATURE_D; // lobby slat face
    const lzc = (lz0 + lz1) / 2;
    const ld = lz0 - lz1;
    for (const sx of [-1, 1])
      b.box(
        "blackMetal",
        v3(fd.x + sx * (fd.width / 2 - LINING_T / 2), fd.height / 2, lzc),
        v3(LINING_T, fd.height, ld),
        { bevel: 0.003 },
      );
    b.box(
      "blackMetal",
      v3(fd.x, fd.height - LINING_T / 2, lzc),
      v3(fd.width, LINING_T, ld),
      { bevel: 0.003 },
    );
    // Factory side: charcoal plinth band, stopping at the door jambs.
    for (const [p0, p1] of [
      [x0 - T, a],
      [c, x1 + T],
    ])
      b.box(
        "charcoal",
        v3((p0 + p1) / 2, 0.6, fd.z + 0.01),
        v3(p1 - p0, 1.2, 0.02),
      );
  }

  // -------------------------------------------------------------------------
  // Façade (south): curtain wall + doors, canopy, piers, fins
  // -------------------------------------------------------------------------

  private buildFacade(b: ArtBatcher): void {
    const e = this.e;
    const { x0, x1, z0 } = e.rect;
    const dw = e.doors.width;
    glassPartition(
      b,
      this.sink,
      G,
      "x",
      z0,
      x0,
      x1,
      CEIL,
      { a0: e.doors.x - dw / 2, a1: e.doors.x + dw / 2, h: DOOR_H },
      { pitch: 1.5, glass: "glassExterior", transom: "glass" },
    );
    // Slab-edge fascia between the floors (black band) + reception sill.
    b.rbox(
      "blackMetal",
      v3(0, (CEIL + UP) / 2, z0 - 0.02),
      v3(x1 - x0 + 0.5, UP - CEIL + 0.04, 0.16),
      { r: 0.006 },
    );
    // Charcoal corner piers framing the block, full height, + parapet band.
    for (const s of [-1, 1]) {
      b.box(
        "charcoal",
        v3(s * (x1 + T / 2 - 0.05), TOP / 2 + 0.3, z0 - 0.1),
        v3(T + 0.7, TOP + 0.6, 0.5),
      );
    }
    b.box(
      "charcoal",
      v3(0, TOP + 0.35, z0 - 0.1),
      v3(x1 - x0 + 2 * T + 0.6, 0.7, 0.5),
    );
    for (const s of [-1, 1]) {
      const sx = s * (x1 + T + 0.03);
      b.box(
        "charcoal",
        v3(sx, TOP + 0.35, (z0 + e.rect.z1) / 2),
        v3(0.08, 0.7, e.rect.z1 - z0),
      );
    }
    // Vertical fins outside the ground-floor mullions (skip the door bay).
    for (let x = x0 + 1.5; x < x1 - 0.5; x += 1.5) {
      if (Math.abs(x - e.doors.x) < dw / 2 + 2.4) continue;
      b.box("charcoal", v3(x, CEIL / 2, z0 - 0.22), v3(0.06, CEIL, 0.36));
    }
    // Canopy over the doors: cantilevered charcoal slab, downlights under.
    const cw = 9;
    const cd = 3.4;
    const cy = 3.55;
    b.box("charcoal", v3(e.doors.x, cy, z0 - cd / 2), v3(cw, 0.24, cd));
    b.box(
      "ceiling",
      v3(e.doors.x, cy - 0.125, z0 - cd / 2),
      v3(cw - 0.1, 0.01, cd - 0.1),
    );
    b.box(
      "blackMetal",
      v3(e.doors.x, cy + 0.17, z0 - cd + 0.04),
      v3(cw, 0.1, 0.08),
    );
    for (const dx of [-3, -1, 1, 3])
      this.fixtures.push(
        downlight(b, e.doors.x + dx, z0 - cd / 2, cy - 0.13, 0.8),
      );
    // Door surround: black portal.
    for (const s of [-1, 1])
      b.rbox(
        "blackMetal",
        v3(e.doors.x + s * (dw / 2 + 0.07), DOOR_H / 2, z0 - 0.06),
        v3(0.14, DOOR_H + 0.02, 0.2),
        { r: 0.006 },
      );
    // Daylight through the façade.
    for (const x of [-8, -3, 3, 8])
      this.fixtures.push(
        fixture(x, 2.6, z0 + 0.5, {
          kind: "window",
          dir: new Vector3(0, -0.4, 1),
          intensity: 1.2,
        }),
      );
  }

  // -------------------------------------------------------------------------
  // Feature wall: graphite slats on the lobby face of the shared wall
  // -------------------------------------------------------------------------

  private buildFeatureWall(b: ArtBatcher): void {
    const fd = this.e.factoryDoor;
    const face = fd.z - ENTR_WALL_T; // lobby face of the shared wall
    // Slats on a 1.2 m grid whose joints land on the door jambs: the two
    // slats over the door start at its head; nothing crosses the opening.
    const SW = fd.width / 2;
    const fx0 = fd.x - 5 * SW;
    const fx1 = fd.x + 5 * SW;
    const da = fd.x - fd.width / 2;
    const dc = fd.x + fd.width / 2;
    for (const [p0, p1, y0] of [
      [fx0, da, 0],
      [da, dc, fd.height],
      [dc, fx1, 0],
    ])
      b.box(
        "shadowGap",
        v3((p0 + p1) / 2, (y0 + CEIL) / 2, face - 0.004),
        v3(p1 - p0, CEIL - y0, 0.008),
      );
    for (let k = 0; k < 10; k++) {
      const x = fx0 + (k + 0.5) * SW;
      const overDoor = x > da && x < dc;
      const y0 = overDoor ? fd.height : 0;
      b.rbox(
        "wallFeature",
        v3(x, (y0 + CEIL) / 2, face - FEATURE_D / 2 - 0.005),
        v3(SW - 0.012, CEIL - y0 - 0.01, FEATURE_D),
        { r: 0.004 },
      );
    }
    // Wall-wash slot grazing the slats.
    for (const p of recessedSlot(
      b,
      "x",
      face - 0.35,
      fx0 + 0.3,
      fx1 - 0.3,
      CEIL,
      2.2,
      0.06,
      0.9,
    )) {
      p.spec = {
        kind: "accent",
        dir: new Vector3(0, -1, 0.35),
        intensity: 1.2,
      };
      this.fixtures.push(p);
    }
  }

  // -------------------------------------------------------------------------
  // Feature stairs
  // -------------------------------------------------------------------------

  /**
   * One straight flight along z between x ∈ [xa, xb] (local frame), built
   * as a closed folded-steel box: two side stringers whose top edge follows
   * the nosing line, oak treads spanning between them over black risers, a
   * soffit plate closing the underside, and a hidden ramp collider on the
   * nosing line. The last riser lands on the floor / landing flush.
   */
  private flight(b: ArtBatcher, f: Flight): Flight {
    const { n, rise, going, dir, xa, xb, zTop, yTop, yBot } = f;
    const xm = (xa + xb) / 2;
    const inner = xb - xa - 2 * STRINGER_T;
    for (let k = 1; k <= n; k++) {
      const zr = zTop + dir * (k - 1) * going;
      // Riser k (the first hangs from the landing / slab edge).
      b.box(
        "blackMetal",
        v3(xm, yTop - (k - 0.5) * rise, zr + dir * 0.012),
        v3(inner, rise, 0.02),
      );
      const yt = yTop - k * rise;
      // Tread k (the n-th is the bottom landing strip; on the floor: none).
      if (k === n && yBot <= 1e-6) continue;
      b.box(
        "oak",
        v3(xm, yt - 0.02, zr + dir * (going / 2 - 0.01)),
        v3(inner, 0.04, going + 0.02),
        { bevel: 0.005 },
      );
      // 30 mm dark anodised nosing on the tread's front edge (R13).
      b.box(
        "blackMetal",
        v3(xm, yt - 0.004, zr + dir * (going - 0.015)),
        v3(inner, 0.012, 0.031),
      );
    }
    // Side stringers: top 4 cm above the nosing line, STAIR_D below it.
    for (const x of [xa + STRINGER_T / 2, xb - STRINGER_T / 2])
      this.pitched(b, "blackMetal", f, x, 0.04, -STAIR_D, STRINGER_T);
    // Soffit plate closing the underside between the stringers.
    this.pitched(b, "blackMetal", f, xm, -STAIR_D + 0.03, -STAIR_D, inner);
    // Walkable ramp: top face through both nosings (flush, no lip at the
    // head), sinking under the lower floor past the foot.
    const ramp = rampBox(f);
    this.col(ramp.c, ramp.s, { pitch: ramp.pitch });
    // Open underneath (floating folded box): the lobby floor under it stays
    // walkable wherever the soffit is ≥ 2 m up; lower, the nook is closed.
    const depth = Math.max(STAIR_D, rampDepth(f));
    for (const k of underBlockers(f, 0, depth)) this.col(k.c, k.s);
    nookRail(b, "blackMetal", f, 0, depth);
    return f;
  }

  /**
   * A box following a flight's pitch at x, spanning vertically from
   * `vBot` to `vTop` relative to the nosing line (full flight length unless
   * `trim` shortens both ends along the slope).
   */
  private pitched(
    b: ArtBatcher,
    mat: "blackMetal" | "glass" | "oak" | "ledWarm",
    f: Flight,
    x: number,
    vTop: number,
    vBot: number,
    width: number,
    trim = 0,
  ): void {
    const c = Math.cos(f.th);
    b.box(
      mat,
      v3(x, f.ym + (vTop + vBot) / 2, f.zm),
      v3(width, (vTop - vBot) * c, f.len - 2 * trim),
      { pitch: f.pitch, keepUVs: mat === "ledWarm" },
    );
  }

  /** Glass infill on the stringer + oak handrail at 0.95 m along a flight edge. */
  private flightRail(
    b: ArtBatcher,
    x: number,
    f: Flight,
    collider = true,
  ): void {
    this.pitched(b, "glass", f, x, RAIL_TOP - 0.07, 0.06, 0.012, 0.12);
    this.pitched(b, "oak", f, x, RAIL_TOP + 0.025, RAIL_TOP - 0.025, 0.055);
    // Slim posts clamped to the stringer top, every ~1.2 m along the run.
    const run = Math.abs(f.zBot - f.zTop);
    const np = Math.max(2, Math.round(run / 1.2) + 1);
    for (let i = 0; i < np; i++) {
      const t = 0.06 + (0.88 * i) / (np - 1);
      const z = f.zTop + f.dir * t * run;
      const y = f.yTop - t * (f.yTop - f.yBot);
      b.box(
        "blackMetal",
        v3(x, y + (0.04 + RAIL_TOP) / 2, z),
        v3(0.025, RAIL_TOP - 0.04, 0.025),
        { bevel: 0.004 },
      );
    }
    // Newel post where the rail reaches the floor (bottom of the flight).
    if (f.yBot <= 1e-6)
      b.box(
        "blackMetal",
        v3(x, RAIL_TOP / 2, f.zBot),
        v3(0.04, RAIL_TOP, 0.04),
        { bevel: 0.005 },
      );
    if (!collider) return;
    const ny = Math.cos(f.th);
    const nz = f.dir * Math.sin(f.th);
    const k = (RAIL_TOP + 0.1) / 2;
    this.col(
      new Vector3(x, f.ym + k * ny, f.zm + k * nz),
      new Vector3(0.1, RAIL_TOP + 0.1, f.len),
      { pitch: f.pitch, see: true },
    );
  }

  /** Level glass rail with an oak handrail (landings, slab openings). */
  private levelRail(
    b: ArtBatcher,
    axis: "x" | "z",
    fixed: number,
    a0: number,
    a1: number,
    y0: number,
    h = RAIL_TOP,
    collider = true,
  ): void {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    const len = hi - lo;
    if (len < 0.02) return;
    const c = (lo + hi) / 2;
    const at = (y: number) =>
      axis === "z" ? v3(fixed, y, c) : v3(c, y, fixed);
    const sz = (t: number, hh: number, l = len) =>
      axis === "z" ? v3(t, hh, l) : v3(l, hh, t);
    b.box("blackMetal", at(y0 + 0.03), sz(0.05, 0.06), { bevel: 0.004 });
    b.box(
      "glass",
      at(y0 + (0.06 + h - 0.07) / 2),
      sz(0.012, h - 0.13, len - 0.04),
    );
    b.box("oak", at(y0 + h), sz(0.055, 0.05), { bevel: 0.01 });
    const np = Math.max(2, Math.round(len / 1.2) + 1);
    for (let i = 0; i < np; i++) {
      const t = lo + 0.02 + ((len - 0.04) * i) / (np - 1);
      b.box(
        "blackMetal",
        axis === "z" ? v3(fixed, y0 + h / 2, t) : v3(t, y0 + h / 2, fixed),
        v3(0.025, h - 0.04, 0.025),
        { bevel: 0.004 },
      );
    }
    if (collider) {
      const ctr = at(y0 + (h + 0.1) / 2);
      this.col(
        new Vector3(ctr.x, ctr.y, ctr.z),
        axis === "z"
          ? new Vector3(0.1, h + 0.1, len)
          : new Vector3(len, h + 0.1, 0.1),
        { see: true },
      );
    }
  }

  private buildStair(b: ArtBatcher, st: EntranceStair): void {
    const s = st.side === "east" ? 1 : -1;
    const ly = st.landingY - this.floorY; // local landing height (3)
    const lo = st.lower;
    const up = st.upper;
    // Lower flight: floor (north) up to the landing (south); upper flight:
    // landing up to the reception (north).
    const [fl, fu] = entranceFlights(st, this.floorY).map((f) =>
      this.flight(b, f),
    );
    // Landing: the same folded-steel body (STAIR_D deep) with an oak deck,
    // spanning both flights; the stringers die into its north face.
    const L = st.landing;
    const lcx = (L.x0 + L.x1) / 2;
    const lcz = (L.z0 + L.z1) / 2;
    const lw = L.x1 - L.x0;
    const ld = L.z1 - L.z0;
    b.box("oak", v3(lcx, ly - 0.02, lcz), v3(lw - 0.04, 0.04, ld - 0.04));
    b.box(
      "blackMetal",
      v3(lcx, ly - (STAIR_D + 0.04) / 2 + 0.02, lcz),
      v3(lw, STAIR_D + 0.04, ld),
    );
    this.col(new Vector3(lcx, ly - 0.1, lcz), new Vector3(lw, 0.2, ld));
    // Balustrades on every open edge, continuing around the landing.
    const xLoIn = s > 0 ? lo.x0 + 0.012 : lo.x1 - 0.012; // lower, divider side
    const xUpOut = s > 0 ? up.x1 - 0.012 : up.x0 + 0.012; // upper, divider side
    const xUpIn = s > 0 ? up.x0 + 0.012 : up.x1 - 0.012; // upper, lobby side
    const xWall = s > 0 ? lo.x1 - 0.07 : lo.x0 + 0.07;
    this.flightRail(b, xLoIn, fl, false);
    this.flightRail(b, xUpOut, fu, false);
    this.flightRail(b, xUpIn, fu);
    // Between the flights: a see-through guard band over each flight's own
    // treads (never down to the lobby floor under the upper flight).
    for (const g of guardBoxes(fl, xLoIn)) this.col(g.c, g.s, { see: true });
    for (const g of guardBoxes(fu, xUpOut)) this.col(g.c, g.s, { see: true });
    // Landing: lobby side and the façade side.
    const xLandIn = s > 0 ? L.x0 + 0.012 : L.x1 - 0.012;
    this.levelRail(b, "z", xLandIn, L.z0 + 0.02, L.z1, ly);
    this.levelRail(b, "x", L.z0 + 0.03, L.x0, L.x1, ly);
    // Wall string: charcoal skirting following the lower flight along the
    // side wall, and round the landing's wall side (G14).
    const xSk = s > 0 ? lo.x1 + 0.0425 : lo.x0 - 0.0425;
    this.pitched(b, "blackMetal", fl, xSk, 0.16, -0.06, 0.015);
    b.box(
      "charcoal",
      v3(xSk, ly + 0.05, (L.z0 + L.z1) / 2),
      v3(0.015, 0.1, L.z1 - L.z0),
      { bevel: 0.003 },
    );
    // Wall handrail over the lower flight's outer edge (oak on brackets).
    this.pitched(b, "oak", fl, xWall, RAIL_TOP + 0.025, RAIL_TOP - 0.025, 0.05);
    for (const t of [0.15, 0.5, 0.85]) {
      const z = fl.zTop + fl.dir * t * Math.abs(fl.zBot - fl.zTop);
      const y = fl.yTop - t * (fl.yTop - fl.yBot) + RAIL_TOP - 0.06;
      b.box("blackMetal", v3(xWall + s * 0.04, y, z), v3(0.07, 0.02, 0.02));
    }
    // Warm LED line along the upper flight's lobby-side stringer foot.
    this.pitched(
      b,
      "ledWarm",
      fu,
      xUpIn + s * 0.006,
      -STAIR_D + 0.035,
      -STAIR_D + 0.02,
      0.012,
      0.1,
    );
  }

  /** Slab-opening edges + balustrades at the reception (local y = UP). */
  private buildOpeningRails(b: ArtBatcher): void {
    for (const st of this.e.stairs) {
      const r = st.rect;
      const s = st.side === "east" ? 1 : -1;
      const up = st.upper;
      const xEdge = s > 0 ? r.x0 : r.x1; // opening edge on the room side
      // Clean slab edge: plaster fascia from the soffit to the floor.
      b.box(
        "ceiling",
        v3(xEdge + s * 0.006, (CEIL + UP) / 2, (r.z0 + r.z1) / 2),
        v3(0.012, UP - CEIL, r.z1 - r.z0),
      );
      const fa = s > 0 ? up.x1 : r.x0;
      const fb = s > 0 ? r.x1 : up.x0;
      b.box(
        "ceiling",
        v3((fa + fb) / 2, (CEIL + UP) / 2, r.z1 - 0.006),
        v3(Math.abs(fb - fa), UP - CEIL, 0.012),
      );
      // Balustrade on the room side and over the lower flight's head; open
      // over the upper flight (the arrival).
      this.levelRail(b, "z", xEdge - s * 0.05, r.z0, r.z1 + 0.05, UP, RAIL_H);
      this.levelRail(b, "x", r.z1 + 0.05, fa, fb, UP, RAIL_H);
    }
  }

  // -------------------------------------------------------------------------
  // Lift
  // -------------------------------------------------------------------------

  private buildLiftShaft(b: ArtBatcher): void {
    const L = this.e.lift;
    const r = L.rect;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const H = LIFT_TOP;
    // Corner posts.
    for (const x of [r.x0 + 0.04, r.x1 - 0.04])
      for (const z of [r.z0 + 0.04, r.z1 - 0.04])
        b.box("blackMetal", v3(x, H / 2, z), v3(0.08, H, 0.08), {
          bevel: 0.006,
        });
    // Glass on three sides; the south face holds a door at each stop.
    for (const x of [r.x0 + 0.04, r.x1 - 0.04])
      b.box("glass", v3(x, H / 2, cz), v3(0.012, H - 0.05, d - 0.08));
    b.box("glass", v3(cx, H / 2, r.z1 - 0.04), v3(w - 0.08, H - 0.05, 0.012));
    const dw = L.door.width;
    for (const y0 of [0, UP]) {
      const yTop = y0 === 0 ? UP - 0.4 : H;
      const h = yTop - y0 - LIFT_DOOR_H;
      // Transom glass over the door, side glass beside it.
      b.box(
        "glass",
        v3(cx, y0 + LIFT_DOOR_H + h / 2, r.z0 + 0.04),
        v3(w - 0.08, h, 0.012),
      );
      for (const s of [-1, 1]) {
        const sw = (w - dw) / 2 - 0.08;
        b.box(
          "glass",
          v3(
            cx + s * (dw / 2 + sw / 2 + 0.02),
            y0 + LIFT_DOOR_H / 2,
            r.z0 + 0.04,
          ),
          v3(sw, LIFT_DOOR_H, 0.012),
        );
      }
      // Door frame + head band.
      for (const s of [-1, 1])
        b.box(
          "blackMetal",
          v3(cx + s * (dw / 2 + 0.03), y0 + LIFT_DOOR_H / 2, r.z0 + 0.03),
          v3(0.06, LIFT_DOOR_H, 0.08),
          { bevel: 0.006 },
        );
      b.box(
        "blackMetal",
        v3(cx, y0 + LIFT_DOOR_H + 0.05, r.z0 + 0.03),
        v3(dw + 0.12, 0.1, 0.08),
        { bevel: 0.006 },
      );
      // Call panel beside the door (warm LED).
      const px = cx + dw / 2 + 0.22;
      b.rbox(
        "blackMetal",
        v3(px, y0 + 1.15, r.z0 - 0.01),
        v3(0.1, 0.22, 0.02),
        { r: 0.006 },
      );
      b.cylinder(
        "ledWarm",
        v3(px, y0 + 1.18, r.z0 - 0.024),
        0.008,
        0.035,
        0.035,
        16,
        {
          pitch: Math.PI / 2,
          keepUVs: true,
        },
      );
    }
    // Slab-edge ring where the shaft passes the reception floor + cap.
    for (const z of [r.z0 + 0.06, r.z1 - 0.06])
      b.box("blackMetal", v3(cx, UP - 0.25, z), v3(w, 0.3, 0.12));
    for (const x of [r.x0 + 0.06, r.x1 - 0.06])
      b.box("blackMetal", v3(x, UP - 0.25, cz), v3(0.12, 0.3, d));
    b.box("blackMetal", v3(cx, H + 0.06, cz), v3(w + 0.04, 0.12, d + 0.04));
    // Pit floor.
    b.box("charcoal", v3(cx, 0.01, cz), v3(w - 0.1, 0.02, d - 0.1));
    // Shaft collider (doors count as closed: riders are moved by the lift).
    this.col(new Vector3(cx, H / 2, cz), new Vector3(w, H, d), { see: true });
  }

  private buildCar(): TransformNode {
    const { scene, materials } = this.ctx;
    const L = this.e.lift;
    const r = L.rect;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const w = r.x1 - r.x0 - 0.2;
    const d = r.z1 - r.z0 - 0.2;
    const node = new TransformNode("entrance:liftCar", scene);
    node.position.set(cx, this.floorY, cz);
    const cb = new ArtBatcher(scene, materials, "entranceCar", 3);
    cb.box("charcoal", v3(0, 0.04, 0), v3(w, 0.08, d));
    cb.box("blackMetal", v3(0, 2.42, 0), v3(w, 0.06, d));
    cb.box("lightPanel", v3(0, 2.385, 0), v3(w * 0.6, 0.01, d * 0.6), {
      keepUVs: true,
    });
    for (const x of [-w / 2 + 0.03, w / 2 - 0.03])
      for (const z of [-d / 2 + 0.03, d / 2 - 0.03])
        cb.box("aluminium", v3(x, 1.24, z), v3(0.05, 2.36, 0.05), {
          bevel: 0.005,
        });
    cb.box("aluminium", v3(0, 1.0, d / 2 - 0.04), v3(w - 0.1, 0.04, 0.04), {
      bevel: 0.005,
    });
    cb.box("glass", v3(0, 1.24, d / 2 - 0.02), v3(w - 0.08, 2.3, 0.01));
    for (const s of [-1, 1])
      cb.box("glass", v3(s * (w / 2 - 0.02), 1.24, 0), v3(0.01, 2.3, d - 0.08));
    for (const m of cb.build({ parent: node })) {
      m.unfreezeWorldMatrix();
      m.isPickable = false;
      this.meshes.push(m);
    }
    return node;
  }

  /** Invisible pick proxies on each lift door (interaction kind "lift"). */
  private buildLiftTargets(): void {
    const { scene } = this.ctx;
    const L = this.e.lift;
    for (const level of [0, 1] as LiftLevel[]) {
      const p = CreateBox(`entrance:liftCall${level}`, { size: 1 }, scene);
      p.scaling.set(L.door.width + 0.7, LIFT_DOOR_H, 0.08);
      p.position.set(
        L.door.x + 0.15,
        this.floorY + level * UP + LIFT_DOOR_H / 2,
        L.door.z - 0.06,
      );
      p.isVisible = false;
      p.isPickable = true;
      const target: InteractionTarget = {
        kind: "lift",
        sessionId: "",
        roomLabel: level === 0 ? "Lift · G" : "Lift · 1",
        stop: level,
      };
      p.metadata = { interact: target, noFocusFrame: true };
      this.meshes.push(p);
    }
  }

  // -------------------------------------------------------------------------
  // Gallery: the reception slab's underside inside the factory volume
  // -------------------------------------------------------------------------

  private buildGallery(b: ArtBatcher): void {
    const g = this.e.gallery;
    const strip = 0.8;
    // Soffit band (local y = UP - 0.45 .. UP - 0.1) either side of the glass strip.
    for (const [a, c] of [
      [g.x0, -strip],
      [strip, g.x1],
    ]) {
      b.box(
        "ceiling",
        v3((a + c) / 2, UP - 0.275, (g.z0 + g.z1) / 2),
        v3(c - a, 0.35, g.z1 - g.z0),
      );
    }
    // Steel edge beams framing the glass strip (inside its opening, bottoms
    // 2 cm below the soffit band: no coplanar faces) + a real downstand at
    // the open edge (0.75 deep, below the band's bottom) (G8).
    for (const s of [-1, 1])
      b.box(
        "blackMetal",
        v3(s * (strip - 0.03), UP - 0.26, (g.z0 + g.z1) / 2),
        v3(0.06, 0.42, g.z1 - g.z0),
      );
    b.box(
      "blackMetal",
      v3(0, UP - 0.45, g.z1 - 0.145),
      v3(g.x1 - g.x0, 0.6, 0.31),
    );
    // Slab-edge LED strips (light the factory floor under the gallery).
    for (const x of [-9, -4.5, 4.5, 9])
      this.fixtures.push(
        ...recessedSlot(
          b,
          "z",
          x,
          g.z0 + 0.4,
          g.z1 - 0.5,
          UP - 0.45,
          2.2,
          0.06,
          1.0,
        ),
      );
    // The reception's side glazing seen from the factory: charcoal fascia.
    for (const s of [-1, 1])
      b.box(
        "charcoal",
        v3(s * (g.x1 + T + 0.03), UP - 0.25, (g.z0 + g.z1) / 2),
        v3(0.06, 0.5, g.z1 - g.z0),
      );
  }

  // -------------------------------------------------------------------------
  // Furniture: benches (procedural), directory sign, plants
  // -------------------------------------------------------------------------

  private buildBenches(b: ArtBatcher): void {
    const e = this.e;
    const z = (e.rect.z0 + e.factoryDoor.z) / 2 + 0.2;
    for (const s of [-1, 1]) {
      const x = s * 4.6;
      const len = 2.4;
      for (let k = -2; k <= 2; k++)
        b.rbox("oak", v3(x, 0.44, z + k * 0.09), v3(len, 0.04, 0.075), {
          r: 0.006,
        });
      for (const dx of [-len / 2 + 0.25, len / 2 - 0.25])
        b.box("blackMetal", v3(x + dx, 0.21, z), v3(0.05, 0.42, 0.4), {
          bevel: 0.006,
        });
      this.col(new Vector3(x, 0.23, z), new Vector3(len, 0.46, 0.46));
    }
  }

  private buildDirectory(): void {
    const { scene } = this.ctx;
    const fd = this.e.factoryDoor;
    const tex = makeTexture(
      scene,
      "entranceDirectory",
      1024,
      640,
      drawDirectory,
    );
    this.textures.push(tex);
    // Re-bake on a language change (the board text is localised).
    const off = onWorldLocale(() => {
      const c = tex.getContext() as unknown as CanvasRenderingContext2D;
      c.clearRect(0, 0, 1024, 640);
      drawDirectory(c, 1024, 640);
      tex.update(true);
    });
    tex.onDisposeObservable?.add(off);
    // 2.2 × 1.375 m, centre 1.75 m: the row titles are ~0.17 m tall,
    // legible from the spawn just inside the doors (≈ 5 m) and from the
    // forecourt outside them.
    const W = 2.2;
    const H = 1.375;
    const p = texturedPlane(scene, "entranceDirectory", tex, W, H, {
      emissive: 0.9,
    });
    p.position.set(
      fd.x - fd.width / 2 - 0.35 - W / 2,
      this.floorY + 1.75,
      fd.z - ENTR_WALL_T - FEATURE_D - 0.012,
    );
    this.meshes.push(p);
  }

  private placeProps(): void {
    const e = this.e;
    const place = (
      role: Parameters<AssetLibrary["instantiate"]>[0],
      x: number,
      z: number,
      yaw: number,
      scale?: number,
      y = 0,
    ) =>
      this.ctx.assets.instantiate(
        role,
        null,
        { position: { x, y: e.floorY + y, z }, yaw, scale },
        { group: G },
      );
    const zBack = e.factoryDoor.z - ENTR_WALL_T - 0.55;
    // Tall planters flanking the feature wall, pairs by the doors and benches.
    for (const s of [-1, 1]) {
      const pts: [number, number, number][] = [
        [s * 7.0, zBack, 1.15],
        [s * 3.0, e.rect.z0 + 0.9, 1.0],
        [s * 6.3, (e.rect.z0 + e.factoryDoor.z) / 2 + 0.2, 1.0],
      ];
      for (const [x, z, sc] of pts) {
        place("planterTall", x, z, 0, sc);
        place(
          "plantTall",
          x,
          z,
          s * 1.3 + x,
          sc,
          PLANTER_SOIL_Y.planterTall * sc,
        );
      }
    }
    place("planter", 8.6, e.rect.z0 + 0.8, 0);
    place("plant", 8.6, e.rect.z0 + 0.8, 0.4, 1.0, PLANTER_SOIL_Y.planter);
  }

  /** Walkable forecourt up to the drawn fence (see forecourtColliders). */
  private buildForecourt(b: ArtBatcher): void {
    void b;
    for (const f of forecourtBoxes(this.e))
      this.col(new Vector3(...f.center), new Vector3(...f.size));
  }

  // -------------------------------------------------------------------------
  // Sliding doors + fade
  // -------------------------------------------------------------------------

  private slider(
    name: string,
    x: number,
    z: number,
    width: number,
    height: number,
    mat: "glassExterior" | "aluminium",
    yLocal = 0,
    maxTravel = Infinity,
  ): Slider {
    const { scene, materials } = this.ctx;
    const lw = width / 2;
    const leaves: Mesh[] = [];
    const closedX: number[] = [];
    const dir: number[] = [];
    for (const s of [-1, 1]) {
      const cb = new ArtBatcher(scene, materials, `entrance:${name}`, 5);
      cb.jitter = 0;
      if (mat === "glassExterior") {
        cb.box(
          "glassExterior",
          v3(0, height / 2, 0),
          v3(lw - 0.04, height - 0.08, 0.012),
        );
        cb.box("blackMetal", v3(0, 0.04, 0), v3(lw, 0.08, 0.04), {
          bevel: 0.004,
        });
        cb.box("blackMetal", v3(0, height - 0.04, 0), v3(lw, 0.08, 0.04), {
          bevel: 0.004,
        });
        cb.box(
          "blackMetal",
          v3((-s * lw) / 2 + s * 0.02, height / 2, 0),
          v3(0.04, height, 0.04),
          { bevel: 0.004 },
        );
        cb.box(
          "aluminium",
          v3(-s * (lw / 2 - 0.12), 1.05, -0.03),
          v3(0.025, 0.6, 0.025),
        );
      } else {
        cb.box(
          "aluminium",
          v3(0, height / 2, 0),
          v3(lw - 0.005, height - 0.005, 0.04),
        );
        cb.box(
          "shadowGap",
          v3((-s * lw) / 2 + s * 0.004, height / 2, -0.021),
          v3(0.008, height, 0.002),
        );
      }
      const parts = cb.build();
      const leaf =
        Mesh.MergeMeshes(parts, true, true, undefined, false, true) ?? parts[0];
      leaf.name = `entrance:${name}`;
      const cx = x + s * (lw / 2);
      leaf.position.set(cx, this.floorY + yLocal, z);
      leaf.isPickable = false;
      leaf.metadata = { moving: true };
      if (leaf.material?.needAlphaBlending()) leaf.alphaIndex = 0;
      this.meshes.push(leaf);
      leaves.push(leaf);
      closedX.push(cx);
      dir.push(s);
    }
    // Leaves part fully clear of the opening (into wall pockets / behind
    // the fixed glass).
    return {
      leaves,
      closedX,
      dir,
      travel: Math.min(maxTravel, lw + 0.03),
      open: 0,
    };
  }

  private isMoving(m: Mesh): boolean {
    return (m.metadata as { moving?: boolean } | null)?.moving === true;
  }

  private drive(s: Slider, want: boolean, dt: number): void {
    const target = want ? 1 : 0;
    if (s.open === target) return;
    const step = dt / 0.8;
    this.setSlider(
      s,
      target > s.open ? Math.min(1, s.open + step) : Math.max(0, s.open - step),
    );
  }

  private setSlider(s: Slider, open: number): void {
    if (Math.abs(open - s.open) < 1e-4 && open !== 0 && open !== 1) return;
    s.open = open;
    const u = open * open * (3 - 2 * open);
    s.leaves.forEach((l, i) => {
      l.position.x = s.closedX[i] + s.dir[i] * s.travel * u;
    });
  }

  private setFade(a: number): void {
    if (typeof document === "undefined") return;
    if (a <= 0 && !this.fadeEl) return;
    if (!this.fadeEl) {
      const host = this.ctx.scene
        .getEngine()
        .getRenderingCanvas()?.parentElement;
      if (!host) return;
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;inset:0;background:#000;pointer-events:none;opacity:0;z-index:5";
      host.appendChild(el);
      this.fadeEl = el;
    }
    this.fadeEl.style.opacity = a.toFixed(3);
  }
}

/**
 * An entrance stair's flights in the entrance frame (local y 0 = the lobby
 * floor): lower (floor → landing, foot at the north end) and upper
 * (landing → reception, head at the north end). Pure.
 */
export function entranceFlights(st: EntranceStair, floorY: number): Flight[] {
  const ly = st.landingY - floorY;
  const zHead = st.rect.z1;
  const zLand = st.landing.z1;
  const lo = st.lower;
  const up = st.upper;
  return [
    flight(lo.x0, lo.x1, zLand, zHead, ly, 0, RISE),
    flight(up.x0, up.x1, zHead, zLand, UP, ly, RISE),
  ];
}

/** Shared wall thickness (the factory's south wall). */
const ENTR_WALL_T = ENTRANCE.WALL_T;
/** Feature-wall slat depth on the lobby face of the shared wall. */
const FEATURE_D = 0.03;
/** Factory-door lining thickness (jambs + head). */
const LINING_T = 0.03;

/** Directory: "Reception · Offices ↑" / "Factory floor →". */
function drawDirectory(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#151618";
  roundRect(ctx, 0, 0, w, h, h * 0.04);
  ctx.fill();
  drawSpark(ctx, w * 0.1, h * 0.17, h * 0.06, "#D97757");
  ctx.fillStyle = "#A5A19A";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.08)}px ${FONT_STACK}`;
  ctx.fillText(worldT("world.dir.title"), w * 0.17, h * 0.17);
  ctx.fillStyle = "#3A3B3E";
  ctx.fillRect(w * 0.06, h * 0.28, w * 0.88, 3);
  const row = (y: number, title: string, sub: string, arrow: string) => {
    ctx.fillStyle = "#F7F4EF";
    ctx.textAlign = "left";
    ctx.font = `600 ${Math.round(h * 0.125)}px ${FONT_STACK}`;
    ctx.fillText(title, w * 0.07, y, w * 0.72);
    ctx.fillStyle = "#B4B0A8";
    ctx.font = `500 ${Math.round(h * 0.07)}px ${FONT_STACK}`;
    ctx.fillText(sub, w * 0.07, y + h * 0.11, w * 0.72);
    ctx.fillStyle = "#E08060";
    ctx.textAlign = "right";
    ctx.font = `400 ${Math.round(h * 0.2)}px ${FONT_STACK}`;
    ctx.fillText(arrow, w * 0.94, y + h * 0.04);
    ctx.textAlign = "left";
  };
  row(
    h * 0.43,
    worldT("world.dir.offices"),
    worldT("world.dir.officesSub"),
    "↑",
  );
  row(
    h * 0.74,
    worldT("world.sign.factory"),
    worldT("world.dir.factorySub"),
    "→",
  );
}
