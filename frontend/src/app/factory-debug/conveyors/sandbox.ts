/**
 * Conveyor + station pool sandbox scene (P2.1 / P2.2). Standalone: its own
 * engine, a flat dark-epoxy floor at y = 0, three lanes merging into a trunk
 * that feeds the main line, ~20 inspection stations in mixed states, the
 * engine's Lighting (IBL + sun + fixture pools) and PostFx (bloom, ACES).
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
  type Mesh,
} from "@/engine/babylon";
import type { CheckKind, CheckState } from "@/engine/contracts";
import { Lighting, fixture } from "@/engine/fx/Lighting";
import { PostFx } from "@/engine/fx/PostFx";
import { planFx } from "@/engine/fx/fxPlan";
import {
  applyPreset,
  defaultGraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { lin } from "@/engine/materials/Materials";
import { Conveyors, type ConveyorPath } from "@/engine/world/factory/Conveyors";
import {
  Stations,
  type StationInstance,
} from "@/engine/world/factory/Stations";

export interface SandboxParams {
  camera?: { x: number; y: number; z: number; yaw: number; pitch: number };
  shot: boolean;
  frames: number;
  /** Frozen animation time (s) in shot mode. */
  t: number;
  /** Station count multiplier for stress tests (lanes per cell). */
  lanes: number;
}

export interface SandboxHandle {
  dispose(): void;
}

const LANE_X0 = 31;
const TRUNK_X = 8.5;
const STATION_X = [28, 25.5, 23, 20.5, 18, 15.5];
const KINDS: CheckKind[] = [
  "lint",
  "build",
  "test",
  "security",
  "deploy",
  "release",
];

/** Mixed demo states, one row per lane (≥ 3 rows repeat). */
const LANE_STATES: CheckState[][] = [
  ["success", "success", "running", "queued", "none", "none"],
  ["success", "failure", "none", "none", "none", "none"],
  ["success", "success", "success", "running", "queued", "none"],
  ["running", "queued", "none", "none", "none", "none"],
  ["success", "success", "success", "success", "success", "running"],
  ["success", "success", "failure", "none", "none", "none"],
];

export function laneZ(i: number): number {
  return 1.2 + i * 2.4;
}

export function sandboxPaths(lanes: number): ConveyorPath[] {
  const paths: ConveyorPath[] = [];
  for (let i = 0; i < lanes; i++) {
    const z = laneZ(i);
    paths.push({
      id: `lane-${i}`,
      kind: "lane",
      width: 0.9,
      points: [
        { x: LANE_X0, y: 0, z },
        { x: TRUNK_X, y: 0, z },
      ],
    });
  }
  const zTop = laneZ(lanes - 1) + 1.4;
  paths.push({
    id: "trunk",
    kind: "trunk",
    width: 0.9,
    points: [
      { x: TRUNK_X, y: 0, z: zTop },
      { x: TRUNK_X, y: 0, z: -1.2 },
      { x: 0, y: 0, z: -1.2 },
    ],
  });
  paths.push({
    id: "main",
    kind: "main",
    width: 1.1,
    points: [
      { x: 0, y: 0, z: -12 },
      { x: 0, y: 0, z: zTop + 8 },
    ],
  });
  return paths;
}

export function sandboxStations(lanes: number): StationInstance[] {
  const out: StationInstance[] = [];
  for (let i = 0; i < lanes; i++) {
    const states = LANE_STATES[i % LANE_STATES.length];
    STATION_X.forEach((x, k) =>
      out.push({
        id: `st-${i}-${k}`,
        x,
        y: 0,
        z: laneZ(i),
        yaw: Math.PI, // lanes run inward (−X)
        state: states[k],
        kind: KINDS[k],
      }),
    );
  }
  // Main line: QC gate + a deploy check, heading +Z (to the dock).
  out.push({
    id: "main-qc",
    x: 0,
    y: 0,
    z: 4,
    yaw: -Math.PI / 2,
    state: "running",
    kind: "test",
    beltWidth: 1.1,
  });
  out.push({
    id: "main-deploy",
    x: 0,
    y: 0,
    z: 9,
    yaw: -Math.PI / 2,
    state: "success",
    kind: "deploy",
    beltWidth: 1.1,
  });
  return out;
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

  // ---- camera (fly: WASD + QE, mouse drag to look)
  const cam = p.camera ?? {
    x: 3.5,
    y: 7.6,
    z: -7.5,
    yaw: 0.98,
    pitch: 0.36,
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

  // ---- lighting (engine Lighting: IBL + sun + fill + fixture pools)
  const lighting = new Lighting(scene);
  lighting.setCamera(camera);
  // Neutral, slightly cool plant light (the office defaults are warm).
  lighting.sun.intensity = 1.1;
  lighting.sun.diffuse = lin("#FFF5EA");
  lighting.sun.specular = lin("#FFF5EA").scale(0.3);
  lighting.key.diffuse = lin("#F4F7FF");
  lighting.fill.diffuse = lin("#E4ECF6");
  lighting.fill.groundColor = lin("#30353C");
  const fixtures = [];
  // Low-bay luminaires (clustered lights reach ≤ 8 m).
  for (let x = -3; x <= 33; x += 6)
    for (let z = -11; z <= 19; z += 5)
      fixtures.push(
        fixture(x, 4.6, z, {
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
  // Factory interior: no city skybox, the HDRI stays as IBL only.
  scene.getMeshByName("skybox")?.setEnabled(false);
  // The office IBL is a warm interior; the neutral daylight exterior HDRI
  // reads as a skylit plant and keeps the satin metals grey, not beige.
  if (lighting.exterior) {
    scene.environmentTexture = lighting.exterior;
    scene.environmentIntensity = 0.7;
  } else scene.environmentIntensity = 0.6;

  // ---- floor: dark epoxy + sparse safety-yellow walkway lines
  const floor = CreateGround("epoxyFloor", { width: 90, height: 64 }, scene);
  floor.position.set(12, 0, 3);
  const fm = new PBRMaterial("epoxy", scene);
  fm.albedoColor = lin("#353A40");
  fm.metallic = 0;
  fm.roughness = 0.24;
  fm.environmentIntensity = 0.7;
  floor.material = fm;
  floor.receiveShadows = true;
  const lineMat = new PBRMaterial("walkLine", scene);
  lineMat.albedoColor = lin("#E0B000");
  lineMat.metallic = 0;
  lineMat.roughness = 0.5;
  const lines: Mesh[] = [];
  const addLine = (x0: number, z0: number, x1: number, z1: number) => {
    const l = CreateBox(
      "walkLine",
      {
        width: Math.abs(x1 - x0) || 0.08,
        height: 0.003,
        depth: Math.abs(z1 - z0) || 0.08,
      },
      scene,
    );
    l.position.set((x0 + x1) / 2, 0.0015, (z0 + z1) / 2);
    l.material = lineMat;
    l.receiveShadows = true;
    lines.push(l);
  };
  addLine(1.6, -14, 1.6, 22); // main-line aisle
  addLine(6.6, -14, 6.6, 22); // trunk aisle (inner)
  addLine(10.4, -2.6, 33, -2.6); // cell boundary
  addLine(10.4, laneZ(p.lanes - 1) + 1.9, 33, laneZ(p.lanes - 1) + 1.9);

  // ---- pools
  const conveyors = new Conveyors(scene);
  conveyors.setPaths(sandboxPaths(p.lanes));
  const stations = new Stations(scene);
  stations.setStations(sandboxStations(p.lanes));
  lighting.addStaticCasters([
    ...conveyors.meshes(),
    ...stations.casterMeshes(),
  ]);
  for (const m of [...conveyors.meshes(), ...stations.casterMeshes()])
    lighting.addShadowCaster(m);

  if (p.shot) {
    // Deterministic frame: fixed animation time, belts frozen.
    stations.update(p.t);
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
        active: scene.getActiveMeshes().length,
        conveyors: conveyors.stats(),
        stations: stations.stats(),
        merges: conveyors.segments?.merges.length ?? 0,
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
      conveyors.dispose();
      stations.dispose();
      fx.dispose();
      lighting.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
