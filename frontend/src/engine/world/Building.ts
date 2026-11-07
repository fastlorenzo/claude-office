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
 *    windows (+ daylight portals), and the control room (dark NOC: black
 *    acoustic baffles, graphite walls, curved console with LED accents).
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
import { LAYOUT, type BuildingLayout, type RoomSlot } from "@/engine/contracts";
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
import { Skyline } from "@/engine/world/Skyline";
import {
  downlight,
  drawLogo,
  drawLogoHalo,
  drawSpark,
  drawWayfinding,
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
  private skyline: Skyline | null = null;

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
  }

  get fixtures(): Vector3[] {
    return [...(this.lobby?.fixtures ?? []), ...(this.shell?.fixtures ?? [])];
  }

  /** All static meshes (feed render lists for hall views, debugging). */
  get meshes(): Mesh[] {
    return [this.lobby, this.shell, this.empty, this.exterior].flatMap(
      (p) => p?.meshes ?? [],
    );
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
    b.box("floorLobby", v3(0, -0.05, z0 / 2), v3(halfW * 2, 0.1, D));
    colliders.addBox(
      g,
      new Vector3(0, -0.1, z0 / 2),
      new Vector3(halfW * 2 + 1, 0.2, D),
    );
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
        b.rbox("blackMetal", v3(fx + 0.06, 1.25, z), v3(0.09, 2.5, 1.36), {
          r: 0.006,
        });
        for (const s2 of [-1, 1])
          b.rbox(
            "aluminium",
            v3(fx + 0.09, 1.2, z + s2 * 0.2775),
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

    // ---- Logo: stand-off letters + halo on the graphite wall.
    const logoW = 5.0;
    const logoTex = makeTexture(
      scene,
      "logo",
      2048,
      400,
      (c, w, h) => drawLogo(c, w, h),
      {
        alpha: true,
      },
    );
    const logo = texturedPlane(
      scene,
      "logo",
      logoTex,
      logoW,
      logoW * (400 / 2048),
      {
        emissive: 1.6,
        alpha: true,
      },
    );
    logo.position.set(fwc, 3.4, -T - 0.08);
    const haloTex = makeTexture(
      scene,
      "logoHalo",
      1024,
      256,
      (c, w, h) => drawLogoHalo(c, w, h),
      {
        alpha: true,
      },
    );
    const halo = texturedPlane(
      scene,
      "logoHalo",
      haloTex,
      logoW * 1.25,
      logoW * 1.25 * 0.25,
      {
        emissive: 0.9,
        alpha: true,
      },
    );
    halo.position.set(fwc - 0.1, 3.38, -T - 0.04);
    part.meshes.push(logo, halo);
    part.textures.push(logoTex, haloTex);
    this.ctx.fx?.addGlow(logo);
    part.fixtures.push(
      fixture(fwc - 1.6, 3.4, -T - 0.4, {
        kind: "accent",
        color: "#E8875F",
        intensity: 0.5,
        dir: new Vector3(0, 0, 1),
        range: 2.5,
      }),
    );

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

    // Wayfinding over the hall portal.
    const wayTex = makeTexture(scene, "wayHall", 1024, 256, (c, w, h) =>
      drawWayfinding(
        c,
        w,
        h,
        "Sessions",
        "Rooms · Control room at the end of the hall",
        "→",
      ),
    );
    const way = texturedPlane(scene, "wayHall", wayTex, 2.4, 0.6, {
      emissive: 0.8,
    });
    way.position.set(0, WH + 0.62, -T - 0.012);
    part.meshes.push(way);
    part.textures.push(wayTex);

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
      place("planterTall", sx * (hallHalf + 0.55), -0.75, 0);
      place("plantTall", sx * (hallHalf + 0.55), -0.75, sx * 1.2, 1.25, 0.14);
      place("planterTall", sx * (halfW - 0.7), z0 + 0.8, 0, 1.15);
      place("plantTall", sx * (halfW - 0.7), z0 + 0.8, sx * 2.1, 1.5, 0.1);
      if (sx > 0) {
        place("planter", halfW - 0.55, -6.0, 0);
        place("plant", halfW - 0.55, -6.0, 0.7, 1.0, 0.02);
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
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "shell";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 5);
    const H = LAYOUT.WALL_H;
    const hallHalf = layout.hall.width / 2;
    const L = layout.hall.length;
    const outer = hallHalf + LAYOUT.ROOM_D; // 10.5
    const pitch = LAYOUT.ROOM_W + LAYOUT.ROOM_GAP;
    const T = 0.2;

    // ---- Hall floor / ceiling
    b.box("floorHall", v3(0, -0.05, L / 2), v3(hallHalf * 2, 0.1, L));
    colliders.addBox(
      g,
      new Vector3(0, -0.1, L / 2),
      new Vector3(hallHalf * 2, 0.2, L),
    );
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

    // ---- Inter-bay walls (both sides) + piers facing the hall.
    for (let bay = 1; bay < layout.bays; bay++) {
      const zc = bay * pitch - LAYOUT.ROOM_GAP / 2;
      for (const sx of [-1, 1]) {
        const x0 = sx * (hallHalf - 0.08);
        const x1 = sx * (outer + T);
        b.box(
          "wall",
          v3((x0 + x1) / 2, H / 2, zc),
          v3(Math.abs(x1 - x0), H, LAYOUT.ROOM_GAP),
        );
        colliders.addBox(
          g,
          new Vector3((x0 + x1) / 2, H / 2, zc),
          new Vector3(Math.abs(x1 - x0), H, LAYOUT.ROOM_GAP),
        );
        b.rbox(
          "wallFeature",
          v3(sx * (hallHalf - 0.1), H / 2, zc),
          v3(0.04, H, LAYOUT.ROOM_GAP + 0.06),
          {
            r: 0.006,
          },
        );
      }
      const side = bay % 2 === 0 ? -1 : 1;
      const px = side * (hallHalf - 0.5);
      assets.instantiate(
        "planter",
        null,
        { position: { x: px, y: 0, z: zc }, yaw: 0 },
        { group: g },
      );
      assets.instantiate(
        "plant",
        null,
        { position: { x: px, y: 0.02, z: zc }, yaw: bay * 1.7, scale: 0.95 },
        { group: g },
      );
    }
    // Wall between the last bays and the control room.
    for (const sx of [-1, 1]) {
      const x0 = sx * (hallHalf - 0.08);
      const x1 = sx * (outer + T);
      b.box(
        "wall",
        v3((x0 + x1) / 2, H / 2, L + T / 2),
        v3(Math.abs(x1 - x0), H, T),
      );
      b.box(
        "wallDark",
        v3((x0 + x1) / 2, H / 2, L + T + 0.01),
        v3(Math.abs(x1 - x0) - 0.4, H, 0.02),
      );
      colliders.addBox(
        g,
        new Vector3((x0 + x1) / 2, H / 2, L + T / 2),
        new Vector3(Math.abs(x1 - x0), H, T),
      );
    }

    // ---- Exterior walls along the rooms, one window band per bay.
    for (const sx of [-1, 1]) {
      const wins: Opening[] = [];
      for (let bay = 0; bay < layout.bays; bay++) {
        const z0 = bay * pitch;
        // Floor-to-ceiling curtain wall (high floor: the city is below).
        wins.push({
          a0: z0 + 0.15,
          a1: z0 + LAYOUT.ROOM_W - 0.15,
          y0: 0.04,
          y1: H - 0.06,
        });
      }
      const wx = sx * (outer + T / 2);
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

    // ---- Control room partition (smoked glass + door) at the hall end.
    glassPartition(
      b,
      colliders,
      g,
      "x",
      L + 0.05,
      -hallHalf,
      hallHalf,
      H,
      { a0: -0.9, a1: 0.9, h: 2.4 },
      {
        pitch: 1.2,
        glass: "glassTint",
        frame: "blackMetal",
      },
    );

    const shellMeshes = b.build({ receiveShadows: true });
    markExteriorGlass(shellMeshes);
    this.finish(part, shellMeshes);

    this.buildControlRoom(layout, part);

    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    return part;
  }

  /** Dark NOC: graphite walls, black baffles, curved console, LED accents. */
  private buildControlRoom(layout: BuildingLayout, part: Part): void {
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "shell";
    const L = layout.hall.length;
    const T = 0.2;
    const cb = new ArtBatcher(scene, materials, "control", 7);
    const cz0 = L + T;
    const cz1 = layout.controlRoom.origin.z + layout.controlRoom.size.z / 2;
    const cH = layout.controlRoom.size.y;
    const cw = layout.controlRoom.size.x / 2;
    cb.box("floorDark", v3(0, -0.05, (L + cz1) / 2), v3(cw * 2, 0.1, cz1 - L));
    colliders.addBox(
      g,
      new Vector3(0, -0.1, (L + cz1) / 2),
      new Vector3(cw * 2, 0.2, cz1 - L),
    );
    cb.box(
      "ceilingDark",
      v3(0, cH + 0.05, (L + cz1) / 2),
      v3(cw * 2, 0.1, cz1 - L),
    );
    // Acoustic baffles
    for (let x = -cw + 0.9; x < cw - 0.5; x += 0.45)
      cb.rbox(
        "ceilingDark",
        v3(x, cH - 0.22, (cz0 + cz1) / 2),
        v3(0.05, 0.42, cz1 - cz0 - 1),
        {
          r: 0.01,
        },
      );
    for (const sx of [-1, 1]) {
      wallWithOpenings(
        cb,
        colliders,
        g,
        "wallDark",
        "z",
        sx * (cw + T / 2),
        T,
        L,
        cz1 + T,
        cH,
      );
      cb.box(
        "ledBlue",
        v3(sx * (cw - 0.02), 0.06, (cz0 + cz1) / 2),
        v3(0.01, 0.012, cz1 - cz0 - 0.4),
        {
          keepUVs: true,
        },
      );
      // Vertical acoustic fins on the side walls
      for (let z = cz0 + 0.6; z < cz1 - 0.4; z += 0.5)
        cb.rbox(
          "ceilingDark",
          v3(sx * (cw - 0.05), cH / 2, z),
          v3(0.08, cH - 0.4, 0.04),
          { r: 0.006 },
        );
    }
    wallWithOpenings(
      cb,
      colliders,
      g,
      "wallDark",
      "x",
      cz1 + T / 2,
      T,
      -cw - T,
      cw + T,
      cH,
    );
    // Cool linear lights between baffles (dim).
    for (const z of [cz0 + 1.4, cz0 + 3.8]) {
      cb.rbox("blackMetal", v3(0, cH - 0.46, z), v3(cw * 2 - 4, 0.03, 0.08), {
        r: 0.006,
      });
      cb.box(
        "lightPanelDim",
        v3(0, cH - 0.477, z),
        v3(cw * 2 - 4.1, 0.004, 0.05),
        { keepUVs: true },
      );
    }
    // Screen wall surround + LED lines + side panels.
    const sw = layout.controlRoom.screenWall;
    const wallW = sw.cols * sw.cellW + 0.5;
    const wallH = sw.rows * sw.cellH + 0.4;
    const gloss = materials.get("nocGloss");
    cb.rbox(
      gloss,
      v3(sw.origin.x, sw.origin.y, cz1 - 0.03),
      v3(wallW + 5.2, wallH + 0.6, 0.06),
      {
        r: 0.01,
      },
    );
    for (const dy of [-1, 1])
      cb.box(
        "ledBlue",
        v3(sw.origin.x, sw.origin.y + dy * (wallH / 2 + 0.3), cz1 - 0.065),
        v3(wallW + 5.2, 0.012, 0.012),
        { keepUVs: true },
      );
    for (const sx of [-1, 1]) {
      cb.rbox(
        "blackMetal",
        v3(sx * (wallW / 2 + 1.35), sw.origin.y, cz1 - 0.07),
        v3(2.1, 1.25, 0.04),
        {
          r: 0.01,
        },
      );
      cb.box(
        "ledBlue",
        v3(sx * (wallW / 2 + 2.8), cH / 2, cz1 - 0.065),
        v3(0.02, cH - 0.3, 0.012),
        {
          keepUVs: true,
        },
      );
    }

    // ---- Curved console (operators on the convex side, facing the wall).
    const R = 4.4;
    const cc = v3(0, 0, cz1 + 0.6); // arc centre behind the screen wall
    const dzFront = cc.z - R; // operator edge at the centre line
    const a0 = Math.PI - 0.62;
    const a1 = Math.PI + 0.62;
    cb.arc("blackMetal", cc, R - 0.78, R - 0.08, a0, a1, 0.1, 0.72, 48);
    cb.arc(gloss, cc, R - 0.86, R, a0 - 0.01, a1 + 0.01, 0.72, 0.76, 48);
    cb.arc("shadowGap", cc, R - 0.7, R - 0.16, a0, a1, 0, 0.1, 40);
    cb.arc(
      "ledBlue",
      cc,
      R - 0.012,
      R + 0.002,
      a0 + 0.01,
      a1 - 0.01,
      0.705,
      0.715,
      48,
      { keepUVs: true },
    );
    cb.arc(
      "ledBlue",
      cc,
      R - 0.17,
      R - 0.155,
      a0 + 0.01,
      a1 - 0.01,
      0.015,
      0.025,
      48,
      { keepUVs: true },
    );
    // Monitor stands along the arc
    const screenAngles = [-0.36, 0, 0.36];
    const screenPos = screenAngles.map((da) => {
      const a = Math.PI + da;
      const r = R - 0.55;
      return { x: Math.sin(a) * r + cc.x, z: Math.cos(a) * r + cc.z, yaw: da };
    });
    for (const s of screenPos) {
      cb.rbox("blackMetal", v3(s.x, 0.77 + 0.12, s.z), v3(0.05, 0.24, 0.05), {
        r: 0.006,
      });
      cb.rbox("blackMetal", v3(s.x, 0.765, s.z), v3(0.26, 0.012, 0.18), {
        r: 0.004,
        yaw: s.yaw,
      });
      cb.rbox("blackMetal", v3(s.x, 0.77 + 0.36, s.z), v3(0.66, 0.39, 0.025), {
        r: 0.006,
        yaw: s.yaw,
      });
    }
    colliders.addBox(
      g,
      new Vector3(0, 0.4, dzFront + 0.4),
      new Vector3(3.2, 0.8, 0.85),
    );
    for (const sx of [-1, 1])
      colliders.addBox(
        g,
        new Vector3(sx * 2.2, 0.4, dzFront + 0.75),
        new Vector3(1.8, 0.8, 0.85),
        sx * 0.45,
      );
    const controlMeshes = cb.build({ receiveShadows: true });
    tagStatic(controlMeshes);
    part.meshes.push(...controlMeshes);

    // Console monitors + side panels (dashboard texture).
    const dashTex = makeTexture(scene, "dash", 512, 288, (c, w, h) =>
      drawDashboard(c, w, h),
    );
    part.textures.push(dashTex);
    const screens: Mesh[] = [];
    screenPos.forEach((s, i) => {
      const m = texturedPlane(scene, `consoleScreen${i}`, dashTex, 0.62, 0.35, {
        emissive: 1.0,
      });
      // Just in front of the housing, along the screen normal (towards the operator).
      m.position.set(
        s.x - Math.sin(s.yaw) * 0.0145,
        0.77 + 0.36,
        s.z - Math.cos(s.yaw) * 0.0145,
      );
      m.rotation.y = s.yaw;
      screens.push(m);
    });
    for (const sx of [-1, 1]) {
      const s = texturedPlane(scene, `controlSide${sx}`, dashTex, 2.0, 1.125, {
        emissive: 0.8,
      });
      s.position.set(sx * (wallW / 2 + 1.35), sw.origin.y, cz1 - 0.095);
      screens.push(s);
    }
    part.meshes.push(...screens);
    for (const da of [-0.32, 0, 0.32]) {
      const a = Math.PI + da;
      const r = R + 0.55;
      assets.instantiate(
        "taskChair",
        null,
        {
          position: {
            x: Math.sin(a) * r + cc.x,
            y: 0,
            z: Math.cos(a) * r + cc.z,
          },
          yaw: da,
        },
        { group: g },
      );
    }
    assets.instantiate(
      "securityCamera",
      null,
      { position: { x: cw - 0.3, y: cH - 0.35, z: cz0 + 0.3 }, yaw: -2.3 },
      { group: g },
    );
    this.ctx.lighting.isolateZone(controlMeshes, [
      {
        pos: new Vector3(0, 2.9, cz1 - 1.2),
        color: "#8FB0FF",
        intensity: 4.2,
        range: 9,
      },
      {
        pos: new Vector3(0, 2.7, dzFront - 1.0),
        color: "#B4C8FF",
        intensity: 2.0,
        range: 8,
      },
    ]);

    // Control room sign over the partition door (hall side).
    const ctlTex = makeTexture(scene, "wayCtl", 1024, 256, (c, w, h) =>
      drawWayfinding(c, w, h, "Control Room", "Live view of every session", ""),
    );
    part.textures.push(ctlTex);
    const ctl = texturedPlane(scene, "wayCtl", ctlTex, 1.8, 0.45, {
      emissive: 0.8,
    });
    ctl.position.set(0, 2.78, L - 0.03);
    part.meshes.push(ctl);
  }

  // -------------------------------------------------------------------------
  // Empty bays
  // -------------------------------------------------------------------------

  private emptyKey = "";

  setEmptyBays(layout: BuildingLayout, slots: RoomSlot[]): void {
    const key = slots.map((s) => s.index).join(",") + `|${layout.bays}`;
    if (key === this.emptyKey) return;
    this.emptyKey = key;
    this.disposePart(this.empty, "empty");
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "empty";
    const part = emptyPart();
    const b = new ArtBatcher(scene, materials, g, 9);
    const H = LAYOUT.WALL_H;
    const hallHalf = LAYOUT.HALL_W / 2;
    const pitch = LAYOUT.ROOM_W + LAYOUT.ROOM_GAP;
    const felt = materials.felt("#7F8A80");
    const signs: { x: number; z: number; yaw: number }[] = [];
    for (const s of slots) {
      const sx = s.side === "east" ? 1 : -1;
      const z0 = s.bay * pitch;
      const zc = z0 + LAYOUT.ROOM_W / 2;
      b.box(
        "wall",
        v3(sx * (hallHalf + 0.06), H / 2, zc),
        v3(0.16, H, LAYOUT.ROOM_W),
      );
      b.box(
        "skirting",
        v3(sx * (hallHalf - 0.025), 0.035, zc),
        v3(0.01, 0.07, LAYOUT.ROOM_W),
      );
      // Felt panel cluster framing the plate.
      b.box(
        "shadowGap",
        v3(sx * (hallHalf - 0.024), 1.5, zc),
        v3(0.008, 2.3, 4.1),
      );
      b.slats(
        felt,
        zc - 2.0,
        zc + 2.0,
        0.62,
        0.016,
        (a) => ({
          c: v3(sx * (hallHalf - 0.04), 1.5, a),
          s: v3(0.03, 2.2, 0.62),
        }),
        0.008,
      );
      b.rbox(
        "blackMetal",
        v3(sx * (hallHalf - 0.07), 1.6, zc),
        v3(0.03, 1.08, 1.08),
        { r: 0.006 },
      );
      colliders.addBox(
        g,
        new Vector3(sx * (hallHalf + 0.06), H / 2, zc),
        new Vector3(0.16, H, LAYOUT.ROOM_W),
      );
      signs.push({
        x: sx * (hallHalf - 0.087),
        z: zc,
        yaw: sx > 0 ? Math.PI / 2 : -Math.PI / 2,
      });
      const px = sx * (hallHalf - 0.45);
      assets.instantiate(
        "planterTall",
        null,
        { position: { x: px, y: 0, z: zc + 2.6 }, yaw: 0 },
        { group: g },
      );
      assets.instantiate(
        "plantTall",
        null,
        { position: { x: px, y: 0.14, z: zc + 2.6 }, yaw: s.bay, scale: 1.3 },
        { group: g },
      );
    }
    this.finish(part, b.build());
    if (signs.length) {
      const tex = makeTexture(scene, "available", 512, 512, (c, w, h) =>
        drawAvailable(c, w, h),
      );
      part.textures.push(tex);
      for (const s of signs) {
        const p = texturedPlane(scene, "availableSign", tex, 1.0, 1.0, {
          emissive: 0.75,
        });
        p.position.set(s.x, 1.6, s.z);
        p.rotation.y = s.yaw;
        part.meshes.push(p);
      }
    }
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
    // High floor: no street-level exterior. The city (near towers + baked far
    // skyline) is built once around the floor plate's centre.
    if (!this.skyline) {
      const min = layout.bounds.min;
      const max = layout.bounds.max;
      this.skyline = new Skyline(
        this.ctx.scene,
        this.ctx.lighting,
        new Vector3((min.x + max.x) / 2, 0, (min.z + max.z) / 2),
      );
    }
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
    this.disposePart(this.exterior, "exterior");
    this.skyline?.dispose();
    this.skyline = null;
    this.lobby = this.shell = this.empty = this.exterior = null;
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

function drawAvailable(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#151618";
  ctx.fillRect(0, 0, w, h);
  drawSpark(ctx, w / 2, h * 0.36, h * 0.14, "#D97757");
  ctx.fillStyle = "#F2EFEA";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `500 ${Math.round(h * 0.11)}px ${FONT_STACK}`;
  ctx.fillText("Available", w / 2, h * 0.64);
  ctx.fillStyle = "#8E8A84";
  ctx.font = `400 ${Math.round(h * 0.05)}px ${FONT_STACK}`;
  ctx.fillText("Start a Claude Code session", w / 2, h * 0.76);
  ctx.fillText("to move in", w / 2, h * 0.83);
}

function drawDashboard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#0B1220";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#3B82F6";
  ctx.font = `600 18px ${FONT_STACK}`;
  ctx.fillText("CLAUDE OFFICE · OPS", 16, 28);
  ctx.strokeStyle = "rgba(59,130,246,0.25)";
  for (let y = 60; y < h - 20; y += 30) {
    ctx.beginPath();
    ctx.moveTo(16, y);
    ctx.lineTo(w - 16, y);
    ctx.stroke();
  }
  const series = [
    ["#3B82F6", 0.3],
    ["#22C55E", 1.7],
    ["#F59E0B", 3.1],
  ] as const;
  for (const [col, ph] of series) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let x = 16; x < w - 16; x += 6) {
      const y =
        h * 0.62 -
        Math.sin(x * 0.02 + ph) * 40 -
        Math.sin(x * 0.07 + ph * 2) * 14;
      if (x === 16) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 3 === 0 ? "#F59E0B" : i % 2 ? "#22C55E" : "#3B82F6";
    ctx.fillRect(16 + i * 80, h - 30, 60 * (0.4 + ((i * 37) % 10) / 16), 8);
  }
}
