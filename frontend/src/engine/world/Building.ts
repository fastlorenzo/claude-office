/**
 * The building shell around the session rooms — contemporary tech HQ.
 *
 *  - Lobby (built once): double-height (6 m) reception, polished terrazzo,
 *    a graphite concrete feature wall carrying the backlit Claude logo
 *    (orange used sparingly: the spark + its halo), a sculptural curved
 *    white solid-surface reception desk on a glowing toe-kick, a living moss
 *    wall framed in oak behind the lounge, an oak slat ceiling raft with
 *    integrated linear LEDs, ring pendants, double-height glazing with slim
 *    black mullions, an entrance canopy and a black fascia outside.
 *  - Shell (rebuilt when the bay count changes): hall with a microcement
 *    floor, twin recessed LED slots and a central oak slat raft, graphite
 *    piers with planters, inter-bay walls, exterior walls with deep-reveal
 *    windows (+ daylight portals), and the control room's floor (its round
 *    drum, interior and slab are ControlRoom / ControlRoomShell).
 *  - Empty bays: plaster front with a felt panel cluster + "Available" plate.
 *  - Exterior: plaza paving; the sky / city is the exterior HDRI skybox
 *    (Lighting), visible through every window at infinity.
 */
import {
  CreateTorus,
  Mesh,
  Scene,
  Vector3,
  type AbstractMesh,
  type DynamicTexture,
} from "@/engine/babylon";
import {
  LAYOUT,
  type BuildingLayout,
  type BrandingOptions,
  type CampusSession,
  type ProjectSlot,
} from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import {
  fixture,
  type FixturePoint,
  type Lighting,
} from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { ArtBatcher } from "@/engine/art/geometry";
import { v3 } from "@/engine/util/MeshBatcher";
import { Exterior } from "@/engine/world/Exterior";
import { BrandSign } from "@/engine/world/BrandSign";
import { DEFAULT_BRANDING } from "@/engine/world/brandLayout";
import { LedPanel, type LedContent } from "@/engine/world/LedPanel";
import { controlPlan, drumPlan } from "@/engine/world/controlRoomPlan";
import { floorOutline, prismData } from "@/engine/world/ControlRoomShell";
import { roomStatus } from "@/engine/logic/status";
import { buildFactoryLayout } from "@/engine/layout/factoryLayout";
import { PLANTER_SOIL_Y } from "@/engine/assets/proceduralProps";
import {
  DOOR_H,
  floorPieces,
  railOpening,
  rectMinusHoles,
  type PlanRect,
  downlight,
  FONT_STACK,
  glassPartition,
  makeTexture,
  recessedSlot,
  texturedPlane,
  wallWithOpenings,
  windowUnit,
  type Opening,
} from "@/engine/world/architecture";

export interface BuildingContext {
  scene: Scene;
  materials: Materials;
  assets: AssetLibrary;
  colliders: Colliders;
  lighting: Lighting;
  fx: PostFx | null;
}

interface Part {
  meshes: Mesh[];
  textures: DynamicTexture[];
  fixtures: FixturePoint[];
}

const emptyPart = (): Part => ({ meshes: [], textures: [], fixtures: [] });

/** Lobby clear height (double height; the hall and rooms are LAYOUT.WALL_H). */
const LOBBY_H = 6.0;

/** Elevator doors along the sky-lobby west wall (z centres). */
const ELEVATOR_Z = [-9.55, -7.25, -4.95, -2.65];

/** Structural glass strip down the spine (over the factory main line). */
export const SPINE_GLASS_W = 1.6;
/** Glazed tower bay at the control-room end of the spine. */
export const TOWER_BAY_D = 4;
/** Balcony door clear width in the outer glazing. */
export const BALCONY_DOOR_W = 1.4;
/** Slab-edge fascia depth under the hall floor edge at empty bays. */
const SLAB_EDGE_H = 0.4;

/** Contiguous bay runs covered by project rooms, per side. */
function roomRuns(
  layout: BuildingLayout,
): { side: "east" | "west"; b0: number; b1: number }[] {
  const out: { side: "east" | "west"; b0: number; b1: number }[] = [];
  for (const side of ["east", "west"] as const) {
    const spans = layout.projects
      .filter((p) => p.slot.side === side)
      .map((p) => [p.slot.bay, p.slot.bay + p.slot.span] as const)
      .sort((a, b) => a[0] - b[0]);
    for (const [b0, b1] of spans) {
      const last = out[out.length - 1];
      if (last && last.side === side && last.b1 === b0) last.b1 = b1;
      else out.push({ side, b0, b1 });
    }
  }
  return out;
}

/** Control-room door LED line (on the bulkhead over the door). */
const CONTROL_LED_Y = 2.82;
const CONTROL_LED_W = 3.0;

/** Our floor number (sky lobby signage / indicators). */
const FLOOR_NO = 47;

/** Static architecture: probes + daylight occluders. */
function tagStatic(meshes: AbstractMesh[]): void {
  for (const m of meshes) m.metadata = { ...(m.metadata ?? {}), probe: true };
}

export class Building {
  private lobby: Part | null = null;
  private shell: Part | null = null;
  private empty: Part | null = null;
  private exterior: Part | null = null;
  private bays = -1;
  private skyline: Exterior | null = null;
  private controlLed: LedPanel | null = null;
  /** Control-room floor / ceiling / walls (ControlRoom adds the interior). */
  private controlShell: Mesh[] = [];
  private brand: BrandSign | null = null;
  private brandOpts: BrandingOptions = DEFAULT_BRANDING;
  private campusCounts = { working: 0, needs: 0, idle: 0, projects: 0 };

  constructor(private readonly ctx: BuildingContext) {
    ctx.materials.setExteriorReflection(ctx.lighting.exterior);
    // Once the skyline bake lands, exterior glass reflects sky + city.
    ctx.lighting.onSkyBaked = (refl) =>
      ctx.materials.setExteriorReflection(refl);
  }

  /** Rebuild what changed for this layout. */
  build(layout: BuildingLayout): void {
    if (!this.lobby) this.lobby = this.buildLobby(layout);
    if (layout.bays !== this.bays) {
      this.disposePart(this.shell, "shell");
      this.disposePart(this.exterior, "exterior");
      this.shell = this.buildShell(layout);
      this.exterior = this.buildExterior(layout);
      this.bays = layout.bays;
      this.registerProbes(layout);
    }
    this.setEmptyBays(layout, layout.emptySlots);
    this.setOuterWalls(layout);
  }

  /** Live control-room panel summary ("3 WORKING · 1 NEEDS YOU"). */
  setCampus(sessions: CampusSession[], projects = 0): void {
    const c = { working: 0, needs: 0, idle: 0, projects };
    for (const cs of sessions) {
      const st = roomStatus(cs);
      if (st === "needs_you") c.needs += 1;
      else if (st === "working") c.working += 1;
      else if (st === "done") c.idle += 1;
    }
    this.campusCounts = c;
    this.controlLed?.set(controlLedContent(c));
  }

  /** Lobby neon sign: name / tagline / logo / colour / flicker. */
  setBranding(opts: BrandingOptions): void {
    this.brandOpts = opts;
    this.brand?.set(opts);
  }

  /** Per-frame: LED ticker. */
  update(dt: number): void {
    this.controlLed?.update(dt);
    this.brand?.update(dt);
  }

  /** Control-room shell meshes of the current shell build (for ControlRoom). */
  get controlShellMeshes(): Mesh[] {
    return this.controlShell.filter((m) => !m.isDisposed());
  }

  get fixtures(): Vector3[] {
    return [
      ...(this.lobby?.fixtures ?? []),
      ...(this.shell?.fixtures ?? []),
      ...(this.outer?.fixtures ?? []),
    ];
  }

  /** All static meshes (feed render lists for hall views, debugging). */
  get meshes(): Mesh[] {
    return [
      this.lobby,
      this.shell,
      this.empty,
      this.outer,
      this.exterior,
    ].flatMap((p) => p?.meshes ?? []);
  }

  private finish(part: Part, meshes: Mesh[]): void {
    tagStatic(meshes);
    part.meshes.push(...meshes);
    this.ctx.lighting.addStaticCasters(
      meshes.filter((m) => !m.material?.needAlphaBlending() && !isEmissive(m)),
    );
  }

  private registerProbes(layout: BuildingLayout): void {
    const { lighting, materials, scene } = this.ctx;
    const statics = () =>
      scene.meshes.filter(
        (m) =>
          (m.metadata as { probe?: boolean } | null)?.probe === true &&
          m.isEnabled(),
      );
    const L = layout.hall.length;
    lighting.registerProbe(
      "hall",
      new Vector3(0, LAYOUT.WALL_H / 2, L / 2),
      new Vector3(LAYOUT.HALL_W, LAYOUT.WALL_H, L),
      [materials.get("floorHall")],
      () => statics().filter((m) => !m.name.includes("floorHall")),
    );
    const lz = -layout.lobby.size.z / 2;
    lighting.registerProbe(
      "lobby",
      new Vector3(0, LOBBY_H / 2, lz),
      new Vector3(layout.lobby.size.x, LOBBY_H, layout.lobby.size.z),
      [materials.get("floorLobby")],
      () => statics().filter((m) => !m.name.includes("floorLobby")),
    );
    const c = layout.controlRoom;
    lighting.registerProbe(
      "control",
      new Vector3(c.origin.x, c.size.y / 2, c.origin.z),
      new Vector3(c.size.x, c.size.y, c.size.z),
      [materials.get("floorDark")],
      () =>
        scene.meshes.filter(
          (m) =>
            m.isEnabled() &&
            !m.name.includes("floorDark") &&
            (((m.metadata as { probe?: boolean } | null)?.probe ?? false) ||
              /wallScreen|wallRim|consoleScreen|controlSide/.test(m.name)),
        ),
    );
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  private buildLobby(layout: BuildingLayout): Part {
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "lobby";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 3);
    const halfW = layout.lobby.size.x / 2; // 10.5
    const D = layout.lobby.size.z; // 12
    const H = LOBBY_H;
    const z0 = -D;
    const hallHalf = LAYOUT.HALL_W / 2;
    const WH = LAYOUT.WALL_H;
    const T = 0.2;

    // ---- Floor / ceiling
    // Floor with the stair well down to the factory (rails until it lands).
    const lobbyHole = buildFactoryLayout(layout).lobbyStair.rect;
    floorPieces(
      b,
      colliders,
      g,
      "floorLobby",
      rectMinusHoles({ x0: -halfW - 0.5, x1: halfW + 0.5, z0, z1: 0 }, [
        lobbyHole,
      ]),
    );
    railOpening(b, colliders, g, lobbyHole);
    b.box(
      "ceiling",
      v3(0, H + 0.05, z0 / 2),
      v3(halfW * 2 + 0.4, 0.1, D + 0.2),
    );
    // ---- Oak slat ceiling raft with integrated linear LEDs.
    const raftX = 8.6;
    const raftZ0 = -10.7;
    const raftZ1 = -1.3;
    const raftY = H - 0.5;
    const ledX = [-6, -2, 2, 6];
    b.box(
      "shadowGap",
      v3(0, raftY + 0.075, (raftZ0 + raftZ1) / 2),
      v3(raftX * 2 + 0.1, 0.02, raftZ1 - raftZ0 + 0.1),
    );
    for (let x = -raftX; x <= raftX + 1e-6; x += 0.085) {
      if (ledX.some((lx) => Math.abs(lx - x) < 0.06)) continue;
      b.rbox(
        "oakSlat",
        v3(x, raftY, (raftZ0 + raftZ1) / 2),
        v3(0.045, 0.12, raftZ1 - raftZ0),
        { r: 0.004 },
      );
    }
    for (const lx of ledX)
      part.fixtures.push(
        ...recessedSlot(
          b,
          "z",
          lx,
          raftZ0 + 0.2,
          raftZ1 - 0.2,
          raftY - 0.05,
          2.4,
          0.04,
          1.1,
        ),
      );
    // Raft hangers
    for (const x of [-raftX + 0.3, 0, raftX - 0.3])
      for (const z of [raftZ0 + 0.4, raftZ1 - 0.4])
        b.cylinder(
          "blackMetal",
          v3(x, (raftY + 0.08 + H) / 2, z),
          H - raftY - 0.08,
          0.008,
          0.008,
          6,
        );

    // ---- North wall: west + east sections and bulkhead over the hall portal.
    wallWithOpenings(
      b,
      colliders,
      g,
      "wall",
      "x",
      -T / 2,
      T,
      -halfW - T,
      -hallHalf,
      H,
    );
    wallWithOpenings(
      b,
      colliders,
      g,
      "wall",
      "x",
      -T / 2,
      T,
      hallHalf,
      halfW + T,
      H,
    );
    b.box("wall", v3(0, (WH + H) / 2, -T / 2), v3(hallHalf * 2, H - WH, T));
    colliders.addBox(
      g,
      new Vector3(0, (WH + H) / 2, -T / 2),
      new Vector3(hallHalf * 2, H - WH, T),
    );
    // Hall portal: deep black reveal
    for (const sx of [-1, 1])
      b.rbox(
        "blackMetal",
        v3(sx * (hallHalf + 0.04), WH / 2, -0.16),
        v3(0.08, WH, 0.34),
        { r: 0.006 },
      );
    b.rbox(
      "blackMetal",
      v3(0, WH + 0.04, -0.16),
      v3(hallHalf * 2 + 0.16, 0.08, 0.34),
      { r: 0.006 },
    );

    // ---- Feature wall (west): graphite concrete panels + backlit logo.
    const fx0 = -halfW + 0.02;
    const fx1 = -hallHalf - 0.1;
    const fwc = (fx0 + fx1) / 2;
    b.box("shadowGap", v3(fwc, H / 2, -T - 0.004), v3(fx1 - fx0, H, 0.008));
    b.slats(
      "wallFeature",
      fx0,
      fx1,
      1.38,
      0.012,
      (a) => ({ c: v3(a, H / 2, -T - 0.02), s: v3(1.38, H - 0.01, 0.03) }),
      0.004,
    );
    // Wall-wash slot over the feature wall (grazes the concrete).
    for (const p of recessedSlot(
      b,
      "x",
      -0.55,
      fx0 + 0.3,
      fx1 - 0.3,
      H,
      2.2,
      0.06,
      0.9,
    )) {
      p.spec = {
        kind: "accent",
        dir: new Vector3(0, -1, 0.35),
        intensity: 1.2,
      };
      part.fixtures.push(p);
    }

    // ---- Moss wall (east), oak frame, planter plinth, grazing slot.
    const mx0 = hallHalf + 0.7;
    const mx1 = halfW - 0.6;
    const mc = (mx0 + mx1) / 2;
    const my0 = 0.5;
    const my1 = 4.4;
    // Hollow oak frame (moss sits recessed behind its face).
    const fw = 0.07;
    const mh = my1 - my0;
    const mw = mx1 - mx0;
    const myc = (my0 + my1) / 2;
    b.rbox("oak", v3(mc, my1 + fw / 2, -T - 0.07), v3(mw + fw * 2, fw, 0.12), {
      r: 0.008,
    });
    b.rbox("oak", v3(mc, my0 - fw / 2, -T - 0.07), v3(mw + fw * 2, fw, 0.12), {
      r: 0.008,
    });
    b.rbox("oak", v3(mx0 - fw / 2, myc, -T - 0.07), v3(fw, mh, 0.12), {
      r: 0.008,
    });
    b.rbox("oak", v3(mx1 + fw / 2, myc, -T - 0.07), v3(fw, mh, 0.12), {
      r: 0.008,
    });
    b.box("moss", v3(mc, myc, -T - 0.04), v3(mw, mh, 0.04));
    b.rbox(
      "quartz",
      v3(mc, 0.24, -T - 0.25),
      v3(mx1 - mx0 + 0.12, 0.48, 0.42),
      { r: 0.012 },
    );
    colliders.addBox(
      g,
      new Vector3(mc, 0.24, -T - 0.25),
      new Vector3(mx1 - mx0 + 0.12, 0.48, 0.42),
    );
    for (const p of recessedSlot(
      b,
      "x",
      -0.6,
      mx0 + 0.2,
      mx1 - 0.2,
      H,
      2.0,
      0.06,
      0.9,
    )) {
      p.spec = {
        kind: "accent",
        dir: new Vector3(0, -1, 0.3),
        intensity: 1.4,
        color: "#FFE9C8",
      };
      part.fixtures.push(p);
    }

    // ---- West: elevator bank (sky lobby). East: floor-to-ceiling glazing.
    {
      const wx = -(halfW + T / 2);
      wallWithOpenings(b, colliders, g, "wall", "z", wx, T, z0, -T, H);
      const fx = -halfW; // wall face
      const bz0 = -10.9;
      const bz1 = -1.5;
      // Graphite core cladding up to the band, plaster above.
      b.box(
        "shadowGap",
        v3(fx + 0.004, 1.9, (bz0 + bz1) / 2),
        v3(0.008, 3.8, bz1 - bz0),
      );
      b.slats(
        "wallFeature",
        bz0,
        bz1,
        1.16,
        0.012,
        (a) => ({ c: v3(fx + 0.02, 1.9, a), s: v3(0.03, 3.79, 1.16) }),
        0.004,
      );
      // Black glass indicator band running along the bank.
      b.rbox(
        "nocGloss",
        v3(fx + 0.045, 2.78, (bz0 + bz1) / 2),
        v3(0.02, 0.24, bz1 - bz0),
        {
          r: 0.004,
        },
      );
      for (const z of ELEVATOR_Z) {
        // Portal frame + brushed doors (two leaves, centre split).
        // (Leaves sit 2.5 cm proud of the portal face: no coplanar z-fight.)
        b.rbox("blackMetal", v3(fx + 0.05, 1.25, z), v3(0.08, 2.5, 1.36), {
          r: 0.006,
        });
        for (const s2 of [-1, 1])
          b.rbox(
            "aluminium",
            v3(fx + 0.1, 1.2, z + s2 * 0.2775),
            v3(0.03, 2.38, 0.55),
            {
              r: 0.004,
            },
          );
        // Call button between doors
        b.rbox(
          "blackMetal",
          v3(fx + 0.05, 1.15, z + 0.98),
          v3(0.02, 0.2, 0.09),
          { r: 0.006 },
        );
        b.cylinder(
          "ledWarm",
          v3(fx + 0.062, 1.18, z + 0.98),
          0.008,
          0.03,
          0.03,
          16,
          {
            roll: Math.PI / 2,
            keepUVs: true,
          },
        );
      }
      colliders.addBox(
        g,
        new Vector3(fx + 0.1, 1.5, (bz0 + bz1) / 2),
        new Vector3(0.2, 3, bz1 - bz0),
      );
      // Downlights over the bank
      for (const z of ELEVATOR_Z)
        part.fixtures.push(downlight(b, fx + 1.0, z, H, 0.9));
    }
    {
      const sx = 1;
      const wx = sx * (halfW + T / 2);
      const wins: Opening[] = [
        { a0: z0 + 0.2, a1: -T - 0.2, y0: 0.04, y1: H - 0.06 },
      ];
      wallWithOpenings(b, colliders, g, "wall", "z", wx, T, z0, -T, H, wins);
      for (const o of wins) {
        part.fixtures.push(
          ...windowUnit(b, "z", wx, o, { pitch: 1.5, inward: -1, wallT: T }),
        );
        b.box(
          "blackMetal",
          v3(wx, WH, (o.a0 + o.a1) / 2),
          v3(0.07, 0.05, o.a1 - o.a0),
        );
      }
    }

    // ---- South: full-height curtain wall onto the city (sky lobby).
    glassPartition(b, colliders, g, "x", z0, -halfW, halfW, H, null, {
      pitch: 1.5,
      glass: "glassExterior",
    });
    b.rbox("blackMetal", v3(0, WH, z0), v3(halfW * 2, 0.06, 0.08), {
      r: 0.004,
    });
    // Daylight through the curtain wall.
    for (const x of [-7.5, -2.5, 2.5, 7.5])
      part.fixtures.push(
        fixture(x, 2.6, z0 + 0.5, {
          kind: "window",
          dir: new Vector3(0, -0.4, 1),
          intensity: 1.3,
        }),
      );

    // ---- Reception desk: curved white solid surface, oak counter, glowing toe kick.
    const rx = -6.7;
    const rc = -0.75; // arc centre z (towards the wall)
    const A0 = Math.PI - 0.78;
    const A1 = Math.PI + 0.78;
    const C = v3(rx, 0, rc);
    b.arc("quartz", C, 1.85, 2.45, A0, A1, 0.08, 1.04, 40);
    b.arc("oak", C, 2.0, 2.56, A0 - 0.02, A1 + 0.02, 1.04, 1.075, 40);
    b.arc("oak", C, 1.4, 1.86, A0 + 0.03, A1 - 0.03, 0.71, 0.74, 32);
    b.arc("shadowGap", C, 1.9, 2.36, A0 + 0.01, A1 - 0.01, 0, 0.08, 32);
    b.arc("ledWarm", C, 2.36, 2.375, A0 + 0.02, A1 - 0.02, 0.012, 0.022, 40, {
      keepUVs: true,
    });
    colliders.addBox(
      g,
      new Vector3(rx, 0.55, rc - 2.15),
      new Vector3(3.5, 1.1, 0.75),
    );
    colliders.addBox(
      g,
      new Vector3(rx - 1.6, 0.55, rc - 1.55),
      new Vector3(0.8, 1.1, 1.0),
      -0.6,
    );
    colliders.addBox(
      g,
      new Vector3(rx + 1.6, 0.55, rc - 1.55),
      new Vector3(0.8, 1.1, 1.0),
      0.6,
    );

    // ---- Ring pendants over the reception and lounge.
    const lx = 6.8;
    const lz = -4.6;
    const rings: [number, number, number, number][] = [
      [rx, rc - 2.0, 1.4, 3.3],
      [lx, lz, 1.8, 3.4],
      [lx, lz, 1.1, 3.75],
    ];
    for (const [x, z, d, y] of rings) {
      const t = CreateTorus(
        `${g}:ring`,
        { diameter: d, thickness: 0.045, tessellation: 64 },
        scene,
      );
      t.position.set(x, y, z);
      b.add("blackMetal", t, true);
      const glowRing = CreateTorus(
        `${g}:ringGlow`,
        { diameter: d, thickness: 0.02, tessellation: 64 },
        scene,
      );
      glowRing.position.set(x, y - 0.02, z);
      b.add("lightPanel", glowRing, true);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.3;
        b.cylinder(
          "blackMetal",
          v3(
            x + Math.cos(a) * d * 0.5,
            (y + raftY) / 2,
            z + Math.sin(a) * d * 0.5,
          ),
          raftY - y,
          0.004,
          0.004,
          4,
        );
      }
      part.fixtures.push(
        fixture(x, y - 0.1, z, { kind: "down", intensity: 0.9 }),
      );
    }

    // ---- Lounge rug
    b.rbox("rug", v3(lx, 0.006, lz), v3(3.8, 0.012, 3.0), { r: 0.004 });

    this.finish(part, b.build({ receiveShadows: true }));

    // ---- Brand: neon sign (BrandSign) on the graphite wall.
    this.brand = new BrandSign(
      scene,
      { x: fwc, y: 3.4, wallZ: -T },
      this.brandOpts,
    );
    part.meshes.push(...this.brand.meshes);
    part.textures.push(this.brand.texture);
    this.brand.set(this.brandOpts);

    // Elevator floor indicators on the black glass band (one plane, 1 draw).
    {
      const bz0 = -10.9;
      const bz1 = -1.5;
      const len = bz1 - bz0;
      const tex = makeTexture(scene, "liftBand", 2048, 52, (c, w, h) =>
        drawLiftBand(c, w, h, (z) => (z - bz0) / len),
      );
      const band = texturedPlane(scene, "liftBand", tex, len - 0.04, 0.22, {
        emissive: 1.1,
      });
      band.rotation.y = -Math.PI / 2;
      band.position.set(-halfW + 0.056, 2.78, (bz0 + bz1) / 2);
      part.meshes.push(band);
      part.textures.push(tex);
    }

    // ---- Props
    const place = (
      role: Parameters<AssetLibrary["instantiate"]>[0],
      x: number,
      z: number,
      yaw: number,
      scale?: number,
      y = 0,
    ) =>
      assets.instantiate(
        role,
        null,
        { position: { x, y, z }, yaw, scale },
        { group: g },
      );
    place("sofa", lx, lz + 1.75, Math.PI);
    place("chair", lx - 1.0, lz - 1.35, 0.35);
    place("chair", lx + 1.0, lz - 1.35, -0.35);
    place("loungeTable", lx, lz, 0);
    place("floorLamp", lx + 1.65, lz + 1.6, 0);
    place("sideTable", lx - 1.5, lz + 1.7, 0);
    // Planters + plants: portal, facade corners, window piers.
    for (const sx of [-1, 1]) {
      // One pot per plant: scanned foliage (pot stripped) sits at the rim of
      // a procedural planter (planter 0.46 m, planterTall 0.62 m × scale).
      // Portal pair: clear of the moss plinth (z ≥ -0.66) and portal frame.
      // Foliage sits IN the planter: base at the soil line × planter scale.
      place("planterTall", sx * (hallHalf + 0.5), -1.12, 0);
      place(
        "plantTall",
        sx * (hallHalf + 0.5),
        -1.12,
        sx * 1.2,
        1.0,
        PLANTER_SOIL_Y.planterTall,
      );
      place("planterTall", sx * (halfW - 0.75), z0 + 0.85, 0, 1.15);
      place(
        "plantTall",
        sx * (halfW - 0.75),
        z0 + 0.85,
        sx * 2.1,
        1.15,
        PLANTER_SOIL_Y.planterTall * 1.15,
      );
      if (sx > 0) {
        place("planter", halfW - 0.55, -6.0, 0);
        place("plant", halfW - 0.55, -6.0, 0.7, 1.0, PLANTER_SOIL_Y.planter);
      }
    }
    place("taskChair", rx, rc - 1.25, Math.PI);
    place("laptop", rx + 0.5, rc - 1.62, Math.PI - 0.25, undefined, 0.74);
    place("plantSmall", rx - 1.1, rc - 2.25, 0, 1.2, 1.075);

    markExteriorGlass(part.meshes);
    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    return part;
  }

  // -------------------------------------------------------------------------
  // Shell: hall, bay walls, exterior walls, control room
  // -------------------------------------------------------------------------

  private buildShell(layout: BuildingLayout): Part {
    const { scene, materials, colliders } = this.ctx;
    const g = "shell";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 5);
    const H = LAYOUT.WALL_H;
    const hallHalf = layout.hall.width / 2;
    const L = layout.hall.length;
    const T = 0.2;

    // ---- Hall floor: an elevated spine over the factory. Microcement
    // either side of a 1.6 m structural glass strip (over the main line),
    // a glazed tower bay before the control room, spine-stair wells cut out
    // with guard rails (the stairs themselves are the factory's).
    const fl = buildFactoryLayout(layout);
    const stairHoles = fl.spineStairs.map((st) => st.rect);
    const strip: PlanRect = {
      x0: -SPINE_GLASS_W / 2,
      x1: SPINE_GLASS_W / 2,
      z0: 0,
      z1: L - TOWER_BAY_D,
    };
    const bay: PlanRect = {
      x0: -hallHalf,
      x1: hallHalf,
      z0: L - TOWER_BAY_D,
      z1: L,
    };
    floorPieces(
      b,
      colliders,
      g,
      "floorHall",
      rectMinusHoles({ x0: -hallHalf, x1: hallHalf, z0: 0, z1: L }, [
        strip,
        bay,
        ...stairHoles,
      ]),
    );
    floorPieces(b, colliders, g, "glass", rectMinusHoles(strip, stairHoles), {
      thickness: 0.04,
      seeThrough: true,
    });
    floorPieces(b, colliders, g, "glass", rectMinusHoles(bay, stairHoles), {
      thickness: 0.04,
      seeThrough: true,
    });
    // Steel edge profiles framing the glass.
    for (const sx of [-1, 1])
      b.box(
        "blackMetal",
        v3(sx * (SPINE_GLASS_W / 2 + 0.02), -0.01, (L - TOWER_BAY_D) / 2),
        v3(0.04, 0.022, L - TOWER_BAY_D),
      );
    b.box(
      "blackMetal",
      v3(0, -0.01, L - TOWER_BAY_D - 0.02),
      v3(hallHalf * 2, 0.022, 0.04),
    );
    // Rails on the open sides (the room fronts close the outer side).
    for (const h of stairHoles)
      railOpening(b, colliders, g, h, [
        "z0", // the factory's flight starts on this edge
        ...(Math.abs(h.x1 - hallHalf) < 0.01 ? (["x1"] as const) : []),
        ...(Math.abs(h.x0 + hallHalf) < 0.01 ? (["x0"] as const) : []),
      ]);
    b.box("ceiling", v3(0, H + 0.05, L / 2), v3(hallHalf * 2 + 0.4, 0.1, L));
    // Twin recessed LED slots.
    for (const x of [-1.75, 1.75])
      part.fixtures.push(
        ...recessedSlot(b, "z", x, 0.35, L - 0.35, H, 2.35, 0.08, 1),
      );
    // Central oak slat raft running the length of the hall.
    b.box("shadowGap", v3(0, H - 0.004, L / 2), v3(2.7, 0.008, L - 0.4));
    b.slats(
      "oakSlat",
      -1.3,
      1.3,
      0.04,
      0.04,
      (a) => ({ c: v3(a, H - 0.07, L / 2), s: v3(0.04, 0.1, L - 0.5) }),
      0.003,
    );

    // Project rooms bring their own end walls (ProjectShell); the round
    // control room's drum + neck (ControlRoomShell) meets the hall at the
    // glazed partition below: no square wall across the room bands.

    if (layout.hall.overlook) {
      const sx = layout.hall.overlook === "east" ? 1 : -1;
      const wx = sx * (hallHalf + T / 2);
      const wins: Opening[] = [
        { a0: 0.15, a1: L - 0.15, y0: 0.04, y1: H - 0.06 },
      ];
      wallWithOpenings(b, colliders, g, "wall", "z", wx, T, 0, L, H, wins);
      for (const o of wins)
        part.fixtures.push(
          ...windowUnit(b, "z", wx, o, {
            pitch: 1.5,
            inward: sx > 0 ? -1 : 1,
            wallT: T,
          }),
        );
    }

    // ---- Control room partition (smoked glass) + door with a SOLID
    // bulkhead over it (no glass above the door); the LED line sits on it.
    const cd = layout.controlRoom.doorWidth / 2;
    glassPartition(
      b,
      colliders,
      g,
      "x",
      L + 0.05,
      -hallHalf,
      hallHalf,
      H,
      { a0: -cd, a1: cd, h: DOOR_H },
      {
        pitch: 1.2,
        glass: "glassTint",
        frame: "blackMetal",
        transom: "solid",
        bulkhead: { mat: "wallFeature", depth: 0.18, a0: -1.75, a1: 1.75 },
      },
    );
    b.rbox(
      "blackMetal",
      v3(0, CONTROL_LED_Y, L + 0.05 - 0.091),
      v3(CONTROL_LED_W + 0.06, 0.28, 0.006),
      { r: 0.004 },
    );

    const shellMeshes = b.build({ receiveShadows: true });
    markExteriorGlass(shellMeshes);
    this.finish(part, shellMeshes);

    this.buildControlRoom(layout, part);
    this.buildControlLed(layout);

    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    return part;
  }

  /**
   * Control-room floor only: the round room (+ the neck to the hall door,
   * glazed floor strips cut out along the ribbon windows). The drum, slab,
   * columns and interior are engine/world/ControlRoom(+Shell).ts, built by
   * World on top of `controlShell` (isolateZone runs over shell + interior).
   */
  private buildControlRoom(layout: BuildingLayout, part: Part): void {
    const { scene, materials, colliders } = this.ctx;
    const g = "shell";
    const p = controlPlan(layout);
    const d = drumPlan(p);
    const cb = new ArtBatcher(scene, materials, "control", 7);
    const floor = new Mesh("control:floor", scene);
    prismData(floorOutline(p, d), { x: p.cx, z: p.cz }, -0.1, 0).applyToMesh(
      floor,
    );
    cb.add("floorDark", floor);
    // Colliders: z strips inscribed in the circle (walls stop you at the
    // edge; the glazed strips are walkable) + the neck.
    const r = d.rIn + 0.05;
    for (let z = p.cz - r; z < p.cz + r - 1e-3; z += 0.6) {
      const z1 = Math.min(p.cz + r, z + 0.6);
      const dz = Math.max(Math.abs(z - p.cz), Math.abs(z1 - p.cz));
      const hw = Math.sqrt(Math.max(0, r * r - dz * dz)) + 0.3;
      colliders.addBox(
        g,
        new Vector3(p.cx, -0.1, (z + z1) / 2),
        new Vector3(2 * hw, 0.2, z1 - z + 0.02),
      );
    }
    const zn = p.cz - Math.sqrt(r * r - p.neckHW * p.neckHW) + 0.6;
    colliders.addBox(
      g,
      new Vector3(p.cx, -0.1, (p.z0 + zn) / 2),
      new Vector3(2 * p.neckHW, 0.2, zn - p.z0),
    );
    const controlMeshes = cb.build({ receiveShadows: true });
    tagStatic(controlMeshes);
    part.meshes.push(...controlMeshes);
    this.controlShell = controlMeshes;
  }

  /** Control-room door LED (hall side): same one-line family as the rooms. */
  private buildControlLed(layout: BuildingLayout): void {
    const L = layout.hall.length;
    this.controlLed?.dispose();
    this.controlLed = new LedPanel(this.ctx.scene, {
      name: "control",
      x: 0,
      y: CONTROL_LED_Y,
      z: L + 0.05 - 0.094,
      yaw: 0,
      width: CONTROL_LED_W,
      height: 0.22,
      rows: 1,
    });
    this.ctx.fx?.addGlow(this.controlLed.mesh);
    this.controlLed.set(controlLedContent(this.campusCounts));
  }

  // -------------------------------------------------------------------------
  // Outer walls (rebuilt when the bays or the balcony doors change)
  // -------------------------------------------------------------------------

  private outer: Part | null = null;
  private outerKey = "";

  /**
   * Outer walls along the room bands: full-height curtain wall per bay (the
   * rooms' overlook glazing onto the factory), with a real door opening to
   * each project's balcony at its entry bay.
   */
  setOuterWalls(layout: BuildingLayout): void {
    const doors = layout.projects.map((p) => ({
      side: p.slot.side,
      z: p.balcony.door.z,
    }));
    const runs = roomRuns(layout);
    const key = `${layout.bays}|${runs
      .map((r) => `${r.side}:${r.b0}-${r.b1}`)
      .join(",")}|${doors
      .map((d) => `${d.side}:${d.z.toFixed(2)}`)
      .sort()
      .join(",")}`;
    if (key === this.outerKey) return;
    this.outerKey = key;
    this.disposePart(this.outer, "outer");
    const { scene, materials, colliders } = this.ctx;
    const g = "outer";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 15);
    const H = LAYOUT.WALL_H;
    const outer = layout.hall.width / 2 + LAYOUT.ROOM_D;
    const pitch = LAYOUT.ROOM_W;
    const T = 0.2;
    const half = BALCONY_DOOR_W / 2;
    // Only where rooms stand: an empty slot has no room box to close.
    for (const run of runs) {
      const sx = run.side === "east" ? 1 : -1;
      const side = run.side;
      const r0 = run.b0 * pitch;
      const r1 = run.b1 * pitch;
      const doorZ = doors.filter((d) => d.side === side).map((d) => d.z);
      const wins: Opening[] = [];
      const gaps: Opening[] = [];
      for (let bay = run.b0; bay < run.b1; bay++) {
        const z0 = bay * pitch + 0.12;
        const z1 = (bay + 1) * pitch - 0.12;
        const dz = doorZ.find((z) => z > z0 && z < z1);
        if (dz === undefined) {
          wins.push({ a0: z0, a1: z1, y0: 0.04, y1: H - 0.06 });
          continue;
        }
        wins.push({ a0: z0, a1: dz - half - 0.08, y0: 0.04, y1: H - 0.06 });
        wins.push({ a0: dz + half + 0.08, a1: z1, y0: 0.04, y1: H - 0.06 });
        gaps.push({ a0: dz - half, a1: dz + half, y0: 0, y1: DOOR_H });
      }
      const wx = sx * (outer + T / 2);
      wallWithOpenings(b, null, g, "wall", "z", wx, T, r0, r1, H, [
        ...wins,
        ...gaps,
      ]);
      for (const o of wins)
        part.fixtures.push(
          ...windowUnit(b, "z", wx, o, {
            pitch: 1.2,
            inward: sx > 0 ? -1 : 1,
            wallT: T,
          }),
        );
      for (const o of gaps) {
        // Black door frame + threshold (walk-through: no collider in the gap).
        for (const a of [o.a0 + 0.03, o.a1 - 0.03])
          b.box(
            "blackMetal",
            v3(wx, DOOR_H / 2, a),
            v3(T + 0.02, DOOR_H, 0.06),
          );
        b.box(
          "blackMetal",
          v3(wx, DOOR_H + 0.03, (o.a0 + o.a1) / 2),
          v3(T + 0.02, 0.06, o.a1 - o.a0),
        );
        b.box(
          "blackMetal",
          v3(wx, -0.02, (o.a0 + o.a1) / 2),
          v3(T + 0.02, 0.04, o.a1 - o.a0),
        );
      }
      // Colliders: solid except the door gaps (glass blocks, but not sight).
      let z = r0;
      for (const o of [...gaps].sort((p, q) => p.a0 - q.a0)) {
        if (o.a0 > z)
          colliders.addBox(
            g,
            new Vector3(wx, H / 2, (z + o.a0) / 2),
            new Vector3(T, H, o.a0 - z),
            0,
            { seeThrough: true },
          );
        colliders.addBox(
          g,
          new Vector3(wx, (DOOR_H + H) / 2, (o.a0 + o.a1) / 2),
          new Vector3(T, H - DOOR_H, o.a1 - o.a0),
        );
        z = o.a1;
      }
      if (r1 > z)
        colliders.addBox(
          g,
          new Vector3(wx, H / 2, (z + r1) / 2),
          new Vector3(T, H, r1 - z),
          0,
          { seeThrough: true },
        );
    }
    const meshes = b.build({ receiveShadows: true });
    markExteriorGlass(meshes);
    this.finish(part, meshes);
    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    this.outer = part;
    this.ctx.lighting.invalidateStaticShadows();
  }

  // -------------------------------------------------------------------------
  // Empty bays
  // -------------------------------------------------------------------------

  private emptyKey = "";

  setEmptyBays(layout: BuildingLayout, slots: ProjectSlot[]): void {
    const key =
      slots.map((s) => `${s.side}:${s.bay}:${s.span}`).join(",") +
      `|${layout.bays}`;
    if (key === this.emptyKey) return;
    this.emptyKey = key;
    this.disposePart(this.empty, "empty");
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "empty";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 9);
    const H = LAYOUT.WALL_H;
    const hallHalf = LAYOUT.HALL_W / 2;
    const pitch = LAYOUT.ROOM_W;
    const T = 0.2;
    for (const s of slots) {
      const sx = s.side === "east" ? 1 : -1;
      const z0 = s.bay * pitch;
      const len = s.span * pitch;
      const z1 = z0 + len;
      const zc = z0 + len / 2;
      // The spine's own exterior wall: full-height curtain wall per bay
      // (same rhythm and cladding as the rooms' outer walls), looking down
      // on the empty cell. No room front, frames or bulkheads here.
      const wx = sx * (hallHalf + T / 2);
      const wins: Opening[] = [];
      for (let bay = s.bay; bay < s.bay + s.span; bay++)
        wins.push({
          a0: bay * pitch + 0.12,
          a1: (bay + 1) * pitch - 0.12,
          y0: 0.04,
          y1: H - 0.06,
        });
      wallWithOpenings(b, null, g, "wall", "z", wx, T, z0, z1, H, wins);
      for (const o of wins)
        windowUnit(b, "z", wx, o, {
          pitch: 1.2,
          inward: sx > 0 ? -1 : 1,
          wallT: T,
          portals: false,
        });
      colliders.addBox(
        g,
        new Vector3(wx, H / 2, zc),
        new Vector3(T, H, len),
        0,
        { seeThrough: true },
      );
      // Slab-edge fascia under the wall (finishes the hall floor edge seen
      // from the factory) + a short soffit return under the floor edge.
      b.box(
        "wallFeature",
        v3(sx * (hallHalf + T / 2), -SLAB_EDGE_H / 2, zc),
        v3(T + 0.02, SLAB_EDGE_H, len),
      );
      b.box(
        "ceiling",
        v3(sx * (hallHalf - 0.4), -SLAB_EDGE_H + 0.02, zc),
        v3(0.8, 0.04, len),
      );
      if (len >= 4) {
        const px = sx * (hallHalf - 0.6);
        const pz = zc + Math.min(2.6, len / 2 - 0.6);
        assets.instantiate(
          "planterTall",
          null,
          { position: { x: px, y: 0, z: pz }, yaw: 0 },
          { group: g },
        );
        assets.instantiate(
          "plantTall",
          null,
          {
            position: { x: px, y: PLANTER_SOIL_Y.planterTall, z: pz },
            yaw: s.bay,
          },
          { group: g },
        );
      }
    }
    const meshes = b.build({ receiveShadows: true });
    markExteriorGlass(meshes);
    this.finish(part, meshes);
    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    this.empty = part;
  }

  // -------------------------------------------------------------------------
  // Exterior
  // -------------------------------------------------------------------------

  private buildExterior(layout: BuildingLayout): Part {
    // Industrial park around the factory (near geometry + baked far cube).
    const min = layout.bounds.min;
    const max = layout.bounds.max;
    const center = new Vector3((min.x + max.x) / 2, 0, (min.z + max.z) / 2);
    if (!this.skyline)
      this.skyline = new Exterior(
        this.ctx.scene,
        this.ctx.lighting,
        center,
        fb,
      );
    else this.skyline.setCenter(center, fb);
    return emptyPart();
  }

  private disposePart(part: Part | null, group: string): void {
    if (!part) return;
    this.ctx.assets.disposeGroup(group);
    this.ctx.colliders.disposeGroup(group);
    for (const m of part.meshes) {
      const mat = m.material;
      m.dispose(false, false);
      if (mat && mat.name.endsWith(":mat")) mat.dispose(false, false);
    }
    for (const t of part.textures) t.dispose();
  }

  dispose(): void {
    this.disposePart(this.lobby, "lobby");
    this.disposePart(this.shell, "shell");
    this.disposePart(this.empty, "empty");
    this.disposePart(this.outer, "outer");
    this.disposePart(this.exterior, "exterior");
    this.skyline?.dispose();
    this.skyline = null;
    this.controlLed?.dispose();
    this.controlLed = null;
    this.lobby = this.shell = this.empty = this.outer = this.exterior = null;
  }
}

function isEmissive(m: AbstractMesh): boolean {
  const mat = m.material as { disableLighting?: boolean } | null;
  return !!mat?.disableLighting;
}

/**
 * Transparent ordering: exterior windows / facade first (alphaIndex 0), then
 * smoked partitions (5), then room glass (10, set in Room). Babylon sorts
 * transparent meshes by alphaIndex before distance, which merged glass
 * meshes (huge bounding spheres) would otherwise get wrong.
 */
function markExteriorGlass(meshes: Mesh[]): void {
  for (const m of meshes) {
    if (!m.material?.needAlphaBlending()) continue;
    m.alphaIndex = m.material.name.includes("glassTint") ? 5 : 0;
  }
}

/** Control-room door panel: name + live counts in the room status colours. */
function controlLedContent(c: {
  working: number;
  needs: number;
  idle: number;
  projects: number;
}): LedContent {
  const sep = { text: " · ", color: "#6E6A64" };
  const counts: { text: string; color: string }[] = [];
  if (c.projects)
    counts.push({
      text: `${c.projects} PROJECT${c.projects === 1 ? "" : "S"}`,
      color: "#B8B2A8",
    });
  const add = (n: number, word: string, color: string) => {
    if (!n) return;
    if (counts.length) counts.push(sep);
    counts.push({ text: `${n} ${word}`, color });
  };
  add(c.working, "WORKING", "#5B9DFF");
  add(c.needs, "NEEDS YOU", "#F5A524");
  add(c.idle, "IDLE", "#34D399");
  if (!counts.length) counts.push({ text: "NO SESSIONS", color: "#7C7A76" });
  const dot = c.needs ? "#F5A524" : c.working ? "#5B9DFF" : "#34D399";
  return {
    dot,
    line: [
      { text: "CONTROL ROOM", color: "#FFFFFF" },
      { text: "  ·  ", color: "#6E6A64" },
      ...counts,
    ],
    ticker: null,
  };
}

/** Indicator band: per door "47 ▲", plus the floor name at the end. */
function drawLiftBand(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: (z: number) => number,
): void {
  ctx.fillStyle = "#0B0C0E";
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ELEVATOR_Z.forEach((z, i) => {
    const x = u(z) * w;
    ctx.fillStyle = "#F4E9DA";
    ctx.font = `500 ${Math.round(h * 0.62)}px ${FONT_STACK}`;
    ctx.fillText(String(FLOOR_NO - [0, 12, 3, 31][i]), x - h * 0.35, h * 0.54);
    ctx.fillStyle = i % 2 ? "#E8875F" : "#9FD8A6";
    ctx.font = `600 ${Math.round(h * 0.5)}px ${FONT_STACK}`;
    ctx.fillText(i % 2 ? "▼" : "▲", x + h * 0.55, h * 0.52);
  });
  ctx.textAlign = "left";
  ctx.fillStyle = "#8E8A84";
  ctx.font = `500 ${Math.round(h * 0.42)}px ${FONT_STACK}`;
  ctx.fillText(`${FLOOR_NO} · SKY LOBBY`, h * 0.4, h * 0.54);
}
