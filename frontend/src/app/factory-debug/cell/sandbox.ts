/**
 * Cell dressing sandbox (P2.4): a real `generateLayout` (3 demo projects) ->
 * `buildFactoryLayout` -> `Cells` + `Conveyors` + `Stations` + `Workpieces` on
 * a dark epoxy floor at the real factory level (y = -6).
 */
import {
  Color4,
  CreateBox,
  CreateGround,
  Engine,
  PBRMaterial,
  Scene,
  SceneInstrumentation,
  UniversalCamera,
  Vector3,
} from "@/engine/babylon";
import type { CheckState } from "@/engine/contracts";
import { demoFactoryProjects } from "@/engine/demo/demoFactory";
import { Lighting, fixture } from "@/engine/fx/Lighting";
import { PostFx } from "@/engine/fx/PostFx";
import { planFx } from "@/engine/fx/fxPlan";
import {
  applyPreset,
  defaultGraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import {
  buildFactoryLayout,
  type CellLayout,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import {
  buildFactoryModel,
  worseState,
  type LineModel,
} from "@/engine/logic/factoryModel";
import { lin } from "@/engine/materials/Materials";
import { Cells, type CellDetail } from "@/engine/world/factory/Cell";
import { Conveyors, type ConveyorPath } from "@/engine/world/factory/Conveyors";
import {
  Stations,
  type StationInstance,
} from "@/engine/world/factory/Stations";
import {
  Workpieces,
  type PieceInstance,
  type Vec3,
} from "@/engine/world/factory/Workpieces";

export interface SandboxParams {
  camera?: { x: number; y: number; z: number; yaw: number; pitch: number };
  shot: boolean;
  frames: number;
  floor: number;
  cell: number;
  vis: CellDetail;
}

export interface SandboxHandle {
  dispose(): void;
}

const NOW = Date.parse("2026-03-10T12:00:00Z");
const SESSIONS = [3, 2, 4];

function makeLayout(): {
  layout: FactoryLayout;
  models: Map<string, LineModel>;
} {
  const projects = demoFactoryProjects([], NOW, { projects: 3 });
  const reqs = projects.map((p, i) => ({
    id: p.id,
    createdAt: i,
    sessions: SESSIONS[i % SESSIONS.length],
  }));
  const slots = allocateSlots(new Map(), reqs);
  const building = generateLayout(
    slots,
    reqs.map((r) => ({
      id: r.id,
      sessionIds: Array.from({ length: r.sessions }, (_, k) => `${r.id}s${k}`),
    })),
  );
  const layout = buildFactoryLayout(building);
  const model = buildFactoryModel(projects, [], NOW, {
    lanesFor: (id) =>
      layout.cells.find((c) => c.projectId === id)?.lanes.length ?? 4,
  });
  return { layout, models: new Map(model.lines.map((l) => [l.projectId, l])) };
}

// ---- adapters FactoryLayout/LineModel -> the other pools (sandbox-local)

const sgn = (c: CellLayout) => (c.side === "east" ? 1 : -1);

function conveyorPaths(layout: FactoryLayout): ConveyorPath[] {
  const y = layout.floorY;
  const out: ConveyorPath[] = [];
  for (const c of layout.cells) {
    const s = sgn(c);
    for (const l of c.lanes)
      out.push({
        id: `${c.projectId}:lane${l.index}`,
        kind: "lane",
        width: 0.9,
        points: [
          { x: s * 31, y, z: l.z },
          { x: c.trunk.x, y, z: l.z },
        ],
      });
    out.push({
      id: `${c.projectId}:trunk`,
      kind: "trunk",
      width: 0.9,
      points: [
        { x: c.trunk.x, y, z: c.trunk.z1 - 0.4 },
        { x: c.trunk.x, y, z: c.trunk.feederZ },
        { x: 0, y, z: c.trunk.feederZ },
      ],
    });
  }
  out.push({
    id: "main",
    kind: "main",
    width: 1.1,
    points: [
      { x: 0, y, z: 0 },
      { x: 0, y, z: layout.mainLine.z1 },
    ],
  });
  return out;
}

function stationsOf(layout: FactoryLayout, models: Map<string, LineModel>) {
  const out: StationInstance[] = [];
  for (const c of layout.cells) {
    const m = models.get(c.projectId);
    if (!m) continue;
    const s = sgn(c);
    for (const l of c.lanes) {
      const piece = m.workpieces.find((w) => w.lane === l.index);
      m.stations.forEach((st, k) => {
        if (k >= l.stationX.length) return;
        out.push({
          id: `${c.projectId}:${l.index}:${k}`,
          x: l.stationX[k],
          y: layout.floorY,
          z: l.z,
          yaw: s > 0 ? Math.PI : 0,
          state: piece?.stationStates[k] ?? "none",
          kind: st.kind,
        });
      });
    }
  }
  return out;
}

function piecesOf(layout: FactoryLayout, models: Map<string, LineModel>) {
  const y = layout.floorY;
  const pieces: PieceInstance[] = [];
  const queue: Vec3[] = [];
  for (const c of layout.cells) {
    const m = models.get(c.projectId);
    if (!m) continue;
    const s = sgn(c);
    let q = 0;
    for (const w of m.workpieces) {
      const state = w.stationStates.reduce<CheckState>(
        (a, b) => (b ? worseState(a, b) : a),
        "none",
      );
      const base: Omit<PieceInstance, "id" | "t"> = {
        sizeClass: w.sizeClass,
        state,
        draft: w.draft,
        bot: w.bot,
        labels: w.bands,
        tag: w.tag,
      };
      const id = `${c.projectId}:${w.id}`;
      const seg = w.position.segment;
      if (w.lane !== null && c.lanes[w.lane]) {
        const l = c.lanes[w.lane];
        let x: number;
        if (seg === "station")
          x = Math.abs(l.stationX[w.position.stationIndex ?? 0] ?? 22);
        else if (seg === "rework") x = Math.abs(l.reworkX);
        else if (seg === "qa") x = Math.abs(l.qaX);
        else if (seg === "gate") x = 12 - 1.4 * w.position.t;
        else x = 31 - 2 * w.position.t;
        pieces.push({
          ...base,
          id,
          t: 0.5,
          lanePath: [
            { x: s * (x - 0.01), y, z: l.z },
            { x: s * (x + 0.01), y, z: l.z },
          ],
        });
      } else if (seg === "trunk") {
        pieces.push({
          ...base,
          id,
          t: Math.min(0.95, w.position.t),
          lanePath: [
            { x: c.trunk.x, y, z: c.trunk.z1 - 0.4 },
            { x: c.trunk.x, y, z: c.trunk.feederZ },
            { x: 0, y, z: c.trunk.feederZ },
          ],
        });
      } else if (seg === "rack" && q < 4) {
        queue.push({ x: s * 28.8, y, z: c.z0 + 1.0 + q * 1.1 });
        pieces.push({ ...base, id, t: 0, queueSlot: queue.length - 1 });
        q++;
      }
    }
  }
  return { pieces, queue };
}

export async function createSandbox(
  canvas: HTMLCanvasElement,
  p: SandboxParams,
  onStatus: (s: string) => void,
): Promise<SandboxHandle> {
  const engine = new Engine(
    canvas,
    true,
    {
      stencil: true,
      antialias: true,
      preserveDrawingBuffer: p.shot,
      powerPreference: "high-performance",
    },
    true,
  );
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.035, 0.038, 0.043, 1);
  const instr = new SceneInstrumentation(scene);
  instr.captureFrameTime = false;

  const { layout, models } = makeLayout();
  const fy = p.floor;
  // The layout is authored at y = -6; shift everything when floor != -6.
  const dy = fy - layout.floorY;
  const shifted = (c: CellLayout): CellLayout => {
    const v = (q: { x: number; y: number; z: number }) => ({
      ...q,
      y: q.y + dy,
    });
    return {
      ...c,
      bench: v(c.bench),
      holding: v(c.holding),
      scrap: v(c.scrap),
      technician: v(c.technician),
      board: { ...c.board, position: v(c.board.position) },
    };
  };
  const cells = layout.cells.map(shifted);
  const sl: FactoryLayout = { ...layout, floorY: fy, cells };

  const focus = cells[Math.min(p.cell, cells.length - 1)];
  const fs = focus.side === "east" ? 1 : -1;
  const cam = p.camera ?? {
    x: fs * 5.5,
    y: fy + 2.6,
    z: focus.z0 + 1.2,
    yaw: fs > 0 ? 1.18 : -1.18,
    pitch: 0.13,
  };
  const camera = new UniversalCamera(
    "flyCam",
    new Vector3(cam.x, cam.y, cam.z),
    scene,
  );
  camera.rotation.set(cam.pitch, cam.yaw, 0);
  camera.minZ = 0.05;
  camera.maxZ = 400;
  camera.fov = 0.95;
  camera.speed = 0.35;
  camera.angularSensibility = 2500;
  camera.keysUp = [87];
  camera.keysDown = [83];
  camera.keysLeft = [65];
  camera.keysRight = [68];
  camera.keysUpward = [69];
  camera.keysDownward = [81];
  if (!p.camera) camera.attachControl(true);

  const lighting = new Lighting(scene);
  lighting.setCamera(camera);
  lighting.sun.intensity = 1.1;
  lighting.sun.diffuse = lin("#FFF5EA");
  lighting.sun.specular = lin("#FFF5EA").scale(0.3);
  lighting.key.diffuse = lin("#F4F7FF");
  lighting.fill.diffuse = lin("#E4ECF6");
  lighting.fill.groundColor = lin("#30353C");
  const fixtures = [];
  const zMax = Math.max(...cells.map((c) => c.z1)) + 2;
  for (let x = -30; x <= 33; x += 6)
    for (let z = -4; z <= zMax; z += 5)
      fixtures.push(
        fixture(x, fy + 4.6, z, {
          kind: "down",
          intensity: 1.5,
          range: 7.5,
          color: "#F2F5FF",
        }),
      );
  lighting.setFixtures(fixtures);
  lighting.setMaxDynamicLights(4);
  lighting.fill.intensity = 0.7;
  lighting.setShadowQuality("high");

  const fx = new PostFx(scene, camera);
  fx.apply(
    planFx({
      ...applyPreset("high", defaultGraphicsSettings()),
      glow: false,
      colorGrading: false,
      depthOfField: "off",
      motionBlur: false,
    }),
  );

  onStatus("loading environment…");
  await lighting.loadEnvironment("/assets", 256);
  scene.getMeshByName("skybox")?.setEnabled(false);
  if (lighting.exterior) {
    scene.environmentTexture = lighting.exterior;
    scene.environmentIntensity = 0.7;
  } else scene.environmentIntensity = 0.6;

  // ---- floor + outer walls (the boards mount on these)
  const zc = (zMax - 6) / 2;
  const floor = CreateGround(
    "epoxyFloor",
    { width: 90, height: zMax + 20 },
    scene,
  );
  floor.position.set(0, fy, zc);
  const fm = new PBRMaterial("epoxy", scene);
  fm.albedoColor = lin("#353A40");
  fm.metallic = 0;
  fm.roughness = 0.24;
  fm.environmentIntensity = 0.7;
  floor.material = fm;
  floor.receiveShadows = true;
  const wallMat = new PBRMaterial("wall", scene);
  wallMat.albedoColor = lin("#9AA1A8");
  wallMat.metallic = 0.2;
  wallMat.roughness = 0.5;
  for (const s of [-1, 1]) {
    const w = CreateBox(
      "outerWall",
      { width: 0.3, height: 9, depth: zMax + 14 },
      scene,
    );
    w.position.set(s * 34.15, fy + 4.5, zc);
    w.material = wallMat;
  }

  // ---- pools
  const conveyors = new Conveyors(scene);
  conveyors.setPaths(conveyorPaths(sl));
  const stations = new Stations(scene);
  stations.setStations(stationsOf(sl, models));
  const wp = new Workpieces(scene);
  const { pieces, queue } = piecesOf(sl, models);
  wp.setQueue(queue);
  wp.set(pieces);
  const cellPool = new Cells(scene);
  for (const c of cells) cellPool.setVisibility(c.projectId, p.vis);
  cellPool.setCells(cells, models);

  const casters = [
    ...conveyors.meshes(),
    ...stations.casterMeshes(),
    ...cellPool.casterMeshes(),
  ];
  lighting.addStaticCasters(casters);
  for (const m of casters) lighting.addShadowCaster(m);

  if (p.shot) {
    stations.update(0.03);
    conveyors.setSpeed(0);
  }

  const drawHist: number[] = [];
  let lastStats = 0;
  engine.runRenderLoop(() => {
    const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
    if (!p.shot) {
      conveyors.update(dt);
      stations.update(dt);
    } else stations.update(0);
    cellPool.update(p.shot ? 0 : dt);
    wp.updateLod(camera.position);
    lighting.update(dt, camera.position);
    scene.render();
    const now = performance.now();
    drawHist.push(instr.drawCallsCounter.current);
    if (drawHist.length > 5) drawHist.shift();
    if (now - lastStats > 500) {
      lastStats = now;
      const sorted = [...drawHist].sort((a, b) => a - b);
      (globalThis as { __worldStats?: unknown }).__worldStats = {
        draws: sorted[sorted.length >> 1],
        cells: cellPool.stats(),
        conveyors: conveyors.stats(),
        stations: stations.stats(),
        workpieces: wp.stats(),
      };
    }
  });
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  await new Promise<void>((resolve) => scene.executeWhenReady(() => resolve()));
  onStatus("ready");
  if (p.shot) {
    let left = p.frames;
    const tick = () => {
      left -= 1;
      if (left <= 0) document.title = "ready";
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return {
    dispose() {
      window.removeEventListener("resize", onResize);
      engine.stopRenderLoop();
      cellPool.dispose();
      conveyors.dispose();
      stations.dispose();
      wp.dispose();
      fx.dispose();
      lighting.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
