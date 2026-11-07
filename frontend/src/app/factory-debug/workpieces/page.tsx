"use client";

/**
 * Workpiece pool sandbox: flat floor, three straight placeholder belts, ~30
 * pieces in mixed sizes / states, a queue of 5 on a staging deck.
 *
 *   cam=x,y,z,yawDeg,pitchDeg   eye pose (default looks across the lanes)
 *   shot=1                      document.title = "ready" after `frames` frames
 *   frames=40                   frames to wait when shot=1
 *   n=30                        piece count on lanes (queue is always 5)
 *   WASD + mouse drag to fly. window.__worldStats.draws = scene draw calls,
 *   window.__worldStats.workpieces = pool stats.
 */

import { useEffect, useRef } from "react";
import {
  Color3,
  Color4,
  CreateBox,
  CreateGround,
  DirectionalLight,
  Engine,
  HDRCubeTexture,
  HemisphericLight,
  PBRMaterial,
  Scene,
  SceneInstrumentation,
  UniversalCamera,
  Vector3,
} from "@/engine/babylon";
import type { CheckState } from "@/engine/contracts";
import {
  Workpieces,
  type PieceInstance,
  type PieceSize,
  type Vec3,
} from "@/engine/world/factory/Workpieces";

const LANES_Z = [0, 2.4, 4.8];
const X0 = -8;
const X1 = 8;
const SIZES: PieceSize[] = ["XS", "S", "M", "L", "XL", "M", "S", "L"];
const STATES: CheckState[] = [
  "running",
  "success",
  "queued",
  "failure",
  "success",
  "running",
  "none",
];
const TITLES = [
  "Fix flaky webhook retry",
  "Add lane plates to factory floor",
  "Bump deps",
  "Refactor session store",
  "Typed event bus",
  "Speed up minimap redraw",
  "Handle stale PRs gracefully",
  "Replace polling with SSE",
];

function pieces(n: number, queueCount: number): PieceInstance[] {
  const out: PieceInstance[] = [];
  const perLane = Math.ceil(n / LANES_Z.length);
  for (let i = 0; i < n; i++) {
    const lane = i % LANES_Z.length;
    const k = Math.floor(i / LANES_Z.length);
    const path: Vec3[] = [
      { x: X0, y: 0, z: LANES_Z[lane] },
      { x: X1, y: 0, z: LANES_Z[lane] },
    ];
    out.push({
      id: `pr${100 + i}`,
      lanePath: path,
      t: 0.06 + (k / perLane) * 0.88,
      sizeClass: SIZES[i % SIZES.length],
      state: STATES[(i * 3) % STATES.length],
      draft: i % 11 === 4,
      bot: i % 7 === 3,
      labels: i % 5 === 0 ? [{ name: "bug", color: "#ef4444" }] : [],
      tag: `#${412 + i} · ${TITLES[i % TITLES.length]}`,
    });
  }
  for (let q = 0; q < queueCount; q++) {
    out.push({
      id: `q${q}`,
      queueSlot: q,
      t: 0,
      sizeClass: SIZES[(q * 3) % SIZES.length],
      state: "queued",
      bot: q === 2,
      tag: `#${600 + q} · ${TITLES[(q + 2) % TITLES.length]}`,
    });
  }
  return out;
}

export default function WorkpiecesDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const q = new URLSearchParams(window.location.search);
    const shot = q.get("shot") === "1";
    const frames = Number(q.get("frames") ?? 40) || 40;
    const n = Math.max(0, Math.min(120, Number(q.get("n") ?? 30) || 30));

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: shot,
      stencil: true,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.07, 0.08, 0.1, 1);
    scene.environmentTexture = new HDRCubeTexture(
      "/assets/hdri/blender_institute_1k.hdr",
      scene,
      256,
    );
    scene.environmentIntensity = 0.45;
    const hemi = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.2;
    const sun = new DirectionalLight("sun", new Vector3(-0.35, -1, 0.5), scene);
    sun.intensity = 0.9;

    const floorMat = new PBRMaterial("floor", scene);
    floorMat.albedoColor = new Color3(0.1, 0.11, 0.13);
    floorMat.metallic = 0.1;
    floorMat.roughness = 0.65;
    const floor = CreateGround("floor", { width: 40, height: 30 }, scene);
    floor.position.set(-2, 0, 2.4);
    floor.material = floorMat;

    const beltMat = new PBRMaterial("belt", scene);
    beltMat.albedoColor = new Color3(0.09, 0.1, 0.12);
    beltMat.metallic = 0.7;
    beltMat.roughness = 0.35;
    const frameMat = new PBRMaterial("beltFrame", scene);
    frameMat.albedoColor = new Color3(0.5, 0.54, 0.6);
    frameMat.metallic = 0.8;
    frameMat.roughness = 0.4;
    for (const z of LANES_Z) {
      const len = X1 - X0;
      const belt = CreateBox("belt", { width: len, height: 0.08, depth: 0.9 }, scene);
      belt.position.set((X0 + X1) / 2, 0.81, z);
      belt.material = beltMat;
      for (const s of [-1, 1]) {
        const rail = CreateBox("rail", { width: len, height: 0.12, depth: 0.05 }, scene);
        rail.position.set((X0 + X1) / 2, 0.83, z + s * 0.475);
        rail.material = frameMat;
      }
      for (let x = X0 + 0.5; x <= X1; x += 2) {
        const leg = CreateBox("leg", { width: 0.08, height: 0.77, depth: 0.8 }, scene);
        leg.position.set(x, 0.385, z);
        leg.material = frameMat;
      }
    }
    // Queue staging deck.
    const queue: Vec3[] = [];
    for (let i = 0; i < 5; i++) queue.push({ x: -11, y: 0.3, z: -0.4 + i * 1.3 });
    const deck = CreateBox("deck", { width: 1.6, height: 0.3, depth: 7 }, scene);
    deck.position.set(-11, 0.15, 1.8);
    deck.material = frameMat;

    const wp = new Workpieces(scene);
    wp.setQueue(queue);
    wp.set(pieces(n, 5));

    const cam = new UniversalCamera("cam", new Vector3(-4, 2.2, -4.5), scene);
    cam.rotation.set((10 * Math.PI) / 180, (30 * Math.PI) / 180, 0);
    const cp = q.get("cam");
    if (cp) {
      const [x, y, z, yaw, pitch] = cp.split(",").map(Number);
      if ([x, y, z].every(Number.isFinite)) {
        cam.position.set(x, y, z);
        cam.rotation.set(((pitch || 0) * Math.PI) / 180, ((yaw || 0) * Math.PI) / 180, 0);
      }
    }
    cam.minZ = 0.05;
    cam.maxZ = 200;
    cam.fov = 0.9;
    cam.speed = 0.15;
    cam.angularSensibility = 2500;
    cam.keysUp = [87, 38];
    cam.keysDown = [83, 40];
    cam.keysLeft = [65, 37];
    cam.keysRight = [68, 39];
    cam.attachControl(canvas, true);
    scene.activeCamera = cam;

    const instr = new SceneInstrumentation(scene);
    instr.captureFrameTime = false;
    let frame = 0;
    engine.runRenderLoop(() => {
      scene.render();
      frame++;
      (globalThis as { __worldStats?: unknown }).__worldStats = {
        draws: instr.drawCallsCounter.current,
        workpieces: wp.stats(),
      };
      if (shot && frame >= frames && scene.isReady()) {
        document.title = "ready";
      }
    });
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      wp.dispose();
      instr.dispose();
      engine.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{ width: "100vw", height: "100vh", display: "block", outline: "none" }}
    />
  );
}
