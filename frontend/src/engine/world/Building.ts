/**
 * The building shell around the session rooms:
 *  - Lobby (built once): double height, herringbone parquet, Claude-orange
 *    feature wall with the backlit logo behind a walnut/quartz reception desk,
 *    walnut slat wall + lounge, glass entrance facade, ring pendants.
 *  - Shell (rebuilt when the bay count changes): hall (polished tiles, twin
 *    linear lights, plants at the piers, wayfinding), inter-bay walls,
 *    exterior walls with window bands, control room (dark, cool, console
 *    desk facing the screen wall — the wall itself is ControlRoomWall).
 *  - Empty bays: plaster front + "Available" sign.
 *  - Exterior: sky / skyline backdrop seen through every window.
 */
import {
  CreateTorus,
  Mesh,
  Scene,
  Vector3,
  type DynamicTexture,
} from "@/engine/babylon";
import { LAYOUT, type BuildingLayout, type RoomSlot } from "@/engine/contracts";
import type { AssetLibrary } from "@/engine/assets/AssetLibrary";
import type { Lighting } from "@/engine/fx/Lighting";
import type { PostFx } from "@/engine/fx/PostFx";
import type { Materials } from "@/engine/materials/Materials";
import type { Colliders } from "@/engine/physics/Colliders";
import { MeshBatcher, v3 } from "@/engine/util/MeshBatcher";
import {
  drawLogo,
  drawSkyline,
  drawSpark,
  drawWayfinding,
  FONT_STACK,
  glassPartition,
  makeTexture,
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
  fixtures: Vector3[];
}

const emptyPart = (): Part => ({ meshes: [], textures: [], fixtures: [] });

export class Building {
  private lobby: Part | null = null;
  private shell: Part | null = null;
  private empty: Part | null = null;
  private exterior: Part | null = null;
  private bays = -1;
  private skyTex: DynamicTexture | null = null;

  constructor(private readonly ctx: BuildingContext) {}

  /** Rebuild what changed for this layout. */
  build(layout: BuildingLayout): void {
    if (!this.lobby) this.lobby = this.buildLobby(layout);
    if (layout.bays !== this.bays) {
      this.disposePart(this.shell, "shell");
      this.disposePart(this.exterior, "exterior");
      this.shell = this.buildShell(layout);
      this.exterior = this.buildExterior(layout);
      this.bays = layout.bays;
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

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  private buildLobby(layout: BuildingLayout): Part {
    const { scene, materials, colliders, assets } = this.ctx;
    const g = "lobby";
    const part = emptyPart();
    const b = new MeshBatcher(scene, materials, g);
    const halfW = layout.lobby.size.x / 2; // 10.5
    const D = layout.lobby.size.z; // 12
    const H = layout.lobby.size.y; // 4.5
    const z0 = -D;
    const hallHalf = LAYOUT.HALL_W / 2;
    const T = 0.2;

    // Floor / ceiling
    b.box("floorLobby", v3(0, -0.05, z0 / 2), v3(halfW * 2, 0.1, D));
    colliders.addBox(
      g,
      new Vector3(0, -0.1, z0 / 2),
      new Vector3(halfW * 2 + 1, 0.2, D),
    );
    b.box("ceiling", v3(0, H + 0.05, z0 / 2), v3(halfW * 2, 0.1, D));
    // Linear light slots across the ceiling.
    for (const z of [-10, -7, -4, -1.5]) {
      b.box("aluminium", v3(0, H - 0.004, z), v3(halfW * 2 - 2, 0.008, 0.14));
      b.box("lightPanel", v3(0, H - 0.01, z), v3(halfW * 2 - 2.1, 0.008, 0.08));
    }
    part.fixtures.push(
      new Vector3(-7, H - 0.6, -4),
      new Vector3(7, H - 0.6, -4),
      new Vector3(0, H - 0.6, -8),
    );

    // North wall: west + east sections (also bay-0 room walls) and bulkhead over the hall.
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
    b.box(
      "wall",
      v3(0, (LAYOUT.WALL_H + H) / 2, -T / 2),
      v3(hallHalf * 2, H - LAYOUT.WALL_H, T),
    );
    colliders.addBox(
      g,
      new Vector3(0, (LAYOUT.WALL_H + H) / 2, -T / 2),
      new Vector3(hallHalf * 2, H - LAYOUT.WALL_H, T),
    );
    // Hall portal reveal (charcoal frame)
    b.box(
      "charcoal",
      v3(-hallHalf - 0.05, LAYOUT.WALL_H / 2, -0.12),
      v3(0.1, LAYOUT.WALL_H, 0.26),
    );
    b.box(
      "charcoal",
      v3(hallHalf + 0.05, LAYOUT.WALL_H / 2, -0.12),
      v3(0.1, LAYOUT.WALL_H, 0.26),
    );
    b.box(
      "charcoal",
      v3(0, LAYOUT.WALL_H + 0.05, -0.12),
      v3(hallHalf * 2 + 0.2, 0.1, 0.26),
    );

    // Claude orange feature wall (west) + walnut slats (east).
    b.box(
      "wallAccentWarm",
      v3((-halfW - hallHalf) / 2 - 0.1, H / 2, -T - 0.015),
      v3(halfW - hallHalf - 0.2, H, 0.03),
    );
    for (let x = hallHalf + 0.7; x < halfW - 0.6; x += 0.11) {
      b.box("wood", v3(x, H / 2, -T - 0.03), v3(0.05, H - 0.02, 0.06));
    }
    b.box(
      "charcoal",
      v3((hallHalf + halfW) / 2, H / 2, -T - 0.005),
      v3(halfW - hallHalf - 1.0, H, 0.01),
    );

    // Side walls with tall windows.
    const sideWins: Opening[] = [
      { a0: -10.6, a1: -6.8, y0: 0.5, y1: 3.9 },
      { a0: -5.2, a1: -1.4, y0: 0.5, y1: 3.9 },
    ];
    for (const sx of [-1, 1]) {
      wallWithOpenings(
        b,
        colliders,
        g,
        "wall",
        "z",
        sx * (halfW + T / 2),
        T,
        z0,
        -T,
        H,
        sideWins,
      );
      for (const o of sideWins) windowUnit(b, "z", sx * (halfW + 0.04), o, 1.3);
    }

    // Entrance facade: full-height glazing with closed double doors.
    glassPartition(b, colliders, g, "x", z0, -halfW, halfW, H, null, {
      pitch: 1.5,
    });
    b.box("aluminium", v3(0, 3.0, z0), v3(halfW * 2, 0.08, 0.1)); // transom
    for (const dx of [-0.65, 0.65]) {
      b.box("aluminium", v3(dx, 1.25, z0 + 0.06), v3(0.035, 0.5, 0.04)); // pull handles
    }
    b.box("charcoal", v3(0, 0.005, z0 + 1.2), v3(3.2, 0.012, 1.6)); // entrance mat

    // Reception desk (west), receptionist faces the entrance.
    const rx = -7;
    const rz = -3.4;
    b.box("wood", v3(rx, 0.55, rz - 0.4), v3(3.4, 1.0, 0.06));
    for (let i = 0; i < 26; i++)
      b.box(
        "wood",
        v3(rx - 1.65 + i * 0.132, 0.53, rz - 0.44),
        v3(0.06, 0.94, 0.03),
      );
    b.box("quartz", v3(rx, 1.075, rz - 0.3), v3(3.5, 0.05, 0.36));
    b.box("quartz", v3(rx, 0.74, rz + 0.05), v3(3.3, 0.04, 0.8));
    b.box("charcoal", v3(rx, 0.05, rz - 0.1), v3(3.3, 0.1, 0.55));
    for (const sx of [-1, 1])
      b.box("wood", v3(rx + sx * 1.7, 0.55, rz), v3(0.06, 1.1, 0.86));
    colliders.addBox(g, new Vector3(rx, 0.55, rz), new Vector3(3.5, 1.1, 0.9));

    // Lounge (east): rug + low oak table.
    const lx = 7;
    const lz = -3.2;
    b.box("rug", v3(lx, 0.006, lz), v3(3.6, 0.012, 2.6));
    b.box("oak", v3(lx, 0.36, lz), v3(1.2, 0.04, 0.6));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        b.box(
          "charcoal",
          v3(lx + sx * 0.54, 0.17, lz + sz * 0.24),
          v3(0.03, 0.34, 0.03),
        );
    colliders.addBox(g, new Vector3(lx, 0.2, lz), new Vector3(1.2, 0.4, 0.6));

    // Ring pendants (emissive torus + cables).
    const rings: [number, number, number][] = [
      [lx, lz, 1.3],
      [rx, rz + 0.2, 1.0],
      [0, -7.5, 1.6],
    ];
    for (const [x, z, d] of rings) {
      const t = CreateTorus(
        `${g}:ring`,
        { diameter: d, thickness: 0.05, tessellation: 48 },
        scene,
      );
      t.position.set(x, 3.25, z);
      b.add("lightPanel", t, true);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        b.cylinder(
          "charcoal",
          v3(
            x + Math.cos(a) * d * 0.5,
            (3.25 + H) / 2,
            z + Math.sin(a) * d * 0.5,
          ),
          H - 3.25,
          0.006,
          0.006,
          4,
        );
      }
      part.fixtures.push(new Vector3(x, 3.0, z));
    }

    part.meshes.push(...b.build({ receiveShadows: true }));

    // Logo on the orange wall.
    const logoTex = makeTexture(
      scene,
      "logo",
      2048,
      400,
      (c, w, h) => drawLogo(c, w, h),
      { alpha: true },
    );
    const logo = texturedPlane(
      scene,
      "logo",
      logoTex,
      5.4,
      5.4 * (400 / 2048),
      { emissive: 1.25, alpha: true },
    );
    logo.position.set((-halfW - hallHalf) / 2 - 0.1, 2.75, -T - 0.035);
    part.meshes.push(logo);
    part.textures.push(logoTex);
    this.ctx.fx?.addGlow(logo);

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
    const way = texturedPlane(scene, "wayHall", wayTex, 2.6, 0.65, {
      emissive: 0.85,
    });
    way.position.set(0, 3.85, -T - 0.01);
    part.meshes.push(way);
    part.textures.push(wayTex);

    // Props
    const place = (
      role: Parameters<AssetLibrary["instantiate"]>[0],
      x: number,
      z: number,
      yaw: number,
      scale?: number,
    ) =>
      assets.instantiate(
        role,
        null,
        { position: { x, y: 0, z }, yaw, scale },
        { group: g },
      );
    place("sofa", lx, -1.0, Math.PI);
    place("chair", lx - 1.25, lz - 1.0, 0.5);
    place("chair", lx + 1.25, lz - 1.0, -0.5);
    place("plantTall", halfW - 0.6, -0.8, 0.3, 1.4);
    place("plant", hallHalf + 0.55, -0.75, 1.2, 1.3);
    place("plant", -hallHalf - 0.55, -0.75, 2.0, 1.3);
    place("plantTall", -halfW + 0.6, -11.2, 0.8, 1.5);
    place("plantTall", halfW - 0.6, -11.2, 2.2, 1.5);
    place("plant", -halfW + 0.6, -0.8, 0.1, 1.2);
    place("chair", rx, rz + 0.75, Math.PI);
    assets.instantiate(
      "laptop",
      null,
      { position: { x: rx + 0.6, y: 0.76, z: rz + 0.1 }, yaw: Math.PI - 0.2 },
      { group: g },
    );
    assets.instantiate(
      "plantSmall",
      null,
      { position: { x: rx - 1.4, y: 1.1, z: rz - 0.3 }, yaw: 0 },
      { group: g },
    );
    place("wetFloorSign", 2.2, -10.4, 0.6);

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
    const b = new MeshBatcher(scene, materials, g);
    const H = LAYOUT.WALL_H;
    const hallHalf = layout.hall.width / 2;
    const L = layout.hall.length;
    const outer = hallHalf + LAYOUT.ROOM_D; // 10.5
    const pitch = LAYOUT.ROOM_W + LAYOUT.ROOM_GAP;
    const T = 0.2;

    // Hall floor + ceiling + twin linear lights
    b.box("floorHall", v3(0, -0.05, L / 2), v3(hallHalf * 2, 0.1, L));
    colliders.addBox(
      g,
      new Vector3(0, -0.1, L / 2),
      new Vector3(hallHalf * 2, 0.2, L),
    );
    b.box("ceiling", v3(0, H + 0.05, L / 2), v3(hallHalf * 2 + 0.4, 0.1, L));
    for (const x of [-1.25, 1.25]) {
      b.box("charcoal", v3(x, H - 0.012, L / 2), v3(0.12, 0.024, L - 0.6));
      b.box("lightPanel", v3(x, H - 0.026, L / 2), v3(0.06, 0.006, L - 0.7));
    }
    for (let z = 2.3; z < L; z += 4.7)
      part.fixtures.push(new Vector3(0, H - 0.35, z));

    // Inter-bay walls (both sides) + the hall-end walls into the control room.
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
        // Charcoal pier face toward the hall
        b.box(
          "charcoal",
          v3(sx * (hallHalf - 0.09), H / 2, zc),
          v3(0.02, H, LAYOUT.ROOM_GAP + 0.04),
        );
      }
      // Plants at alternating piers
      const side = bay % 2 === 0 ? -1 : 1;
      assets.instantiate(
        "plant",
        null,
        {
          position: { x: side * (hallHalf - 0.55), y: 0, z: zc },
          yaw: bay * 1.7,
        },
        { group: g },
      );
    }
    // Wall between last bays and the control room (room side plaster, control side dark).
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

    // Exterior walls along the rooms, with a window band per bay.
    for (const sx of [-1, 1]) {
      const wins: Opening[] = [];
      for (let bay = 0; bay < layout.bays; bay++) {
        const z0 = bay * pitch;
        wins.push({
          a0: z0 + 0.7,
          a1: z0 + LAYOUT.ROOM_W - 0.7,
          y0: 0.8,
          y1: 2.75,
        });
      }
      wallWithOpenings(
        b,
        colliders,
        g,
        "wall",
        "z",
        sx * (outer + T / 2),
        T,
        0,
        L,
        H,
        wins,
      );
      for (const o of wins) windowUnit(b, "z", sx * (outer + 0.04), o, 1.27);
    }

    // Hall wayfinding hanging sign near the start (seen from the lobby).
    // Control room partition (smoked glass + door) at the hall end.
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
        frame: "charcoal",
      },
    );

    const shellMeshes = b.build({ receiveShadows: true });
    markExteriorGlass(shellMeshes);
    part.meshes.push(...shellMeshes);

    // ---- Control room (own batch: lit separately, cool and dim) ----
    const cb = new MeshBatcher(scene, materials, "control");
    const cz0 = L + T;
    const cz1 = layout.controlRoom.origin.z + layout.controlRoom.size.z / 2;
    const cH = layout.controlRoom.size.y;
    const cw = layout.controlRoom.size.x / 2;
    const gloss = materials.color("#141518", 0.42, 0.2);
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
    // Acoustic baffles under the ceiling
    for (let x = -cw + 1; x < cw - 0.5; x += 0.6)
      cb.box(
        "ceilingDark",
        v3(x, cH - 0.2, (cz0 + cz1) / 2),
        v3(0.06, 0.4, cz1 - cz0 - 1),
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
        { keepUVs: true },
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
    for (const z of [cz0 + 1.6, cz0 + 4.2]) {
      cb.box("charcoal", v3(0, cH - 0.42, z), v3(cw * 2 - 4, 0.024, 0.1));
      cb.box(
        "lightPanelDim",
        v3(0, cH - 0.436, z),
        v3(cw * 2 - 4.1, 0.006, 0.05),
      );
    }
    // Screen wall surround + flanking info panels + LED columns.
    const sw = layout.controlRoom.screenWall;
    const wallW = sw.cols * sw.cellW + 0.5;
    const wallH = sw.rows * sw.cellH + 0.4;
    cb.box(
      gloss,
      v3(sw.origin.x, sw.origin.y, cz1 - 0.02),
      v3(wallW + 5.2, wallH + 0.6, 0.04),
    );
    cb.box(
      "ledBlue",
      v3(sw.origin.x, sw.origin.y - wallH / 2 - 0.3, cz1 - 0.05),
      v3(wallW + 5.2, 0.015, 0.02),
      { keepUVs: true },
    );
    cb.box(
      "ledBlue",
      v3(sw.origin.x, sw.origin.y + wallH / 2 + 0.3, cz1 - 0.05),
      v3(wallW + 5.2, 0.015, 0.02),
      { keepUVs: true },
    );
    for (const sx of [-1, 1]) {
      cb.box(
        "charcoal",
        v3(sx * (wallW / 2 + 1.35), sw.origin.y, cz1 - 0.06),
        v3(2.1, 1.25, 0.05),
      );
      cb.box(
        "ledBlue",
        v3(sx * (wallW / 2 + 2.8), cH / 2, cz1 - 0.05),
        v3(0.03, cH - 0.2, 0.02),
        { keepUVs: true },
      );
    }

    // Console desk facing the screen wall (curved wings).
    const dz = cz1 - 3.6;
    cb.box("charcoal", v3(0, 0.37, dz), v3(5.2, 0.74, 0.85));
    cb.box(gloss, v3(0, 0.755, dz - 0.05), v3(5.4, 0.03, 1.0));
    cb.box("ledBlue", v3(0, 0.1, dz - 0.43), v3(5.1, 0.012, 0.01), {
      keepUVs: true,
    });
    for (const sx of [-1, 1]) {
      cb.box("charcoal", v3(sx * 3.1, 0.37, dz - 0.6), v3(1.2, 0.74, 0.8), {
        yaw: sx * 0.5,
      });
      cb.box(gloss, v3(sx * 3.1, 0.755, dz - 0.6), v3(1.3, 0.03, 0.9), {
        yaw: sx * 0.5,
      });
    }
    colliders.addBox(g, new Vector3(0, 0.4, dz), new Vector3(5.4, 0.8, 1.0));
    for (const sx of [-1, 1])
      colliders.addBox(
        g,
        new Vector3(sx * 3.1, 0.4, dz - 0.6),
        new Vector3(1.3, 0.8, 0.9),
        sx * 0.5,
      );
    for (let i = -1; i <= 1; i++) {
      cb.box(
        "charcoal",
        v3(i * 1.25, 0.77 + 0.12, dz + 0.22),
        v3(0.06, 0.24, 0.06),
      );
      cb.box(
        "charcoal",
        v3(i * 1.25, 0.77 + 0.35, dz + 0.24),
        v3(0.64, 0.38, 0.03),
      );
      cb.box("charcoal", v3(i * 1.25, 0.775, dz - 0.15), v3(0.44, 0.014, 0.14));
    }
    const controlMeshes = cb.build({ receiveShadows: true });
    part.meshes.push(...controlMeshes);

    // Console monitors + side panels (dashboard texture).
    const dashTex = makeTexture(scene, "dash", 512, 288, (c, w, h) =>
      drawDashboard(c, w, h),
    );
    part.textures.push(dashTex);
    const screens: Mesh[] = [];
    for (let i = -1; i <= 1; i++) {
      const s = texturedPlane(scene, `consoleScreen${i}`, dashTex, 0.6, 0.34, {
        emissive: 1.0,
      });
      s.position.set(i * 1.25, 0.77 + 0.35, dz + 0.222);
      screens.push(s);
    }
    for (const sx of [-1, 1]) {
      const s = texturedPlane(scene, `controlSide${sx}`, dashTex, 2.0, 1.125, {
        emissive: 0.8,
      });
      s.position.set(sx * (wallW / 2 + 1.35), sw.origin.y, cz1 - 0.09);
      screens.push(s);
    }
    part.meshes.push(...screens);
    for (const x of [-1.3, 0, 1.3]) {
      assets.instantiate(
        "taskChair",
        null,
        { position: { x, y: 0, z: dz - 0.85 }, yaw: 0 },
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
        intensity: 3.2,
        range: 9,
      },
      {
        pos: new Vector3(0, 2.6, cz0 + 2.5),
        color: "#AFC4FF",
        intensity: 2.2,
        range: 9,
      },
    ]);

    // Control room sign over the partition door (hall side).
    const ctlTex = makeTexture(scene, "wayCtl", 1024, 256, (c, w, h) =>
      drawWayfinding(c, w, h, "Control Room", "Live view of every session", ""),
    );
    part.textures.push(ctlTex);
    const ctl = texturedPlane(scene, "wayCtl", ctlTex, 1.8, 0.45, {
      emissive: 0.85,
    });
    ctl.position.set(0, 2.75, L - 0.03);
    part.meshes.push(ctl);

    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    return part;
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
    const b = new MeshBatcher(scene, materials, g);
    const H = LAYOUT.WALL_H;
    const hallHalf = LAYOUT.HALL_W / 2;
    const pitch = LAYOUT.ROOM_W + LAYOUT.ROOM_GAP;
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
        "charcoal",
        v3(sx * (hallHalf - 0.01), 0.04, zc),
        v3(0.016, 0.08, LAYOUT.ROOM_W),
      );
      // Walnut slat feature panel framing the sign.
      for (let k = -9; k <= 9; k++)
        b.box(
          "wood",
          v3(sx * (hallHalf - 0.03), 1.5, zc + k * 0.11),
          v3(0.04, 2.2, 0.05),
        );
      colliders.addBox(
        g,
        new Vector3(sx * (hallHalf + 0.06), H / 2, zc),
        new Vector3(0.16, H, LAYOUT.ROOM_W),
      );
      signs.push({
        x: sx * (hallHalf - 0.06),
        z: zc,
        yaw: sx > 0 ? Math.PI / 2 : -Math.PI / 2,
      });
      assets.instantiate(
        "plantTall",
        null,
        {
          position: { x: sx * (hallHalf - 0.45), y: 0, z: zc + 1.9 },
          yaw: s.bay,
        },
        { group: g },
      );
    }
    part.meshes.push(...b.build());
    if (signs.length) {
      const tex = makeTexture(scene, "available", 512, 512, (c, w, h) =>
        drawAvailable(c, w, h),
      );
      part.textures.push(tex);
      for (const s of signs) {
        const p = texturedPlane(scene, "availableSign", tex, 1.2, 1.2, {
          lit: true,
          roughness: 0.5,
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
  // Exterior backdrop
  // -------------------------------------------------------------------------

  private buildExterior(layout: BuildingLayout): Part {
    const { scene, materials } = this.ctx;
    const part = emptyPart();
    if (!this.skyTex)
      this.skyTex = makeTexture(scene, "sky", 2048, 512, (c, w, h) =>
        drawSkyline(c, w, h, 3),
      );
    const sky = this.skyTex;
    const min = layout.bounds.min;
    const max = layout.bounds.max;
    const len = max.z - min.z + 40;
    const zc = (min.z + max.z) / 2;
    const dist = 14;
    const height = 34;
    // Texture horizon (64 % down) at ~1.3 m so the skyline sits at eye level.
    const y = 1.3 + 0.64 * height - height / 2;
    // Side backdrops (east / west)
    for (const sx of [-1, 1]) {
      const p = texturedPlane(scene, "skyline", sky, len, height, {
        emissive: 1.35,
      });
      p.position.set(sx * (max.x + dist), y, zc);
      p.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
      part.meshes.push(p);
    }
    // South (lobby entrance)
    const south = texturedPlane(
      scene,
      "skylineS",
      sky,
      (max.x + dist) * 2 + 10,
      height,
      { emissive: 1.35 },
    );
    south.position.set(0, y, min.z - dist);
    south.rotation.y = Math.PI;
    part.meshes.push(south);
    // Ground outside
    const b = new MeshBatcher(scene, materials, "exterior");
    b.box(
      materials.color("#BDB6AA", 0.9),
      v3(0, -0.06, zc),
      v3((max.x + dist) * 2, 0.1, len),
    );
    part.meshes.push(...b.build({ receiveShadows: false }));
    for (const m of part.meshes) {
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    // Shared texture: owned by Building, not the part.
    return part;
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
    this.skyTex?.dispose();
    this.lobby = this.shell = this.empty = this.exterior = null;
  }
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

function drawAvailable(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#F2EFEA";
  ctx.fillRect(0, 0, w, h);
  drawSpark(ctx, w / 2, h * 0.36, h * 0.16, "#D97757");
  ctx.fillStyle = "#2B2D31";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(h * 0.12)}px ${FONT_STACK}`;
  ctx.fillText("Available", w / 2, h * 0.66);
  ctx.fillStyle = "#8E8A84";
  ctx.font = `400 ${Math.round(h * 0.055)}px ${FONT_STACK}`;
  ctx.fillText("Start a Claude Code session", w / 2, h * 0.78);
  ctx.fillText("to move in", w / 2, h * 0.85);
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
