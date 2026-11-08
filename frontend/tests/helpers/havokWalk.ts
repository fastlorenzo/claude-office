/**
 * Headless walk harness: real Havok (wasm from node_modules), the real
 * Player (PhysicsCharacterController) and real Colliders on a NullEngine
 * scene, driven like world-debug `?walk=` (yaw toward the next waypoint,
 * forward input, 50 ms steps). Lets layout tests replay acceptance walks
 * without a browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HavokPlugin, NullEngine, Scene, Vector3 } from "@/engine/babylon";
import type { InputController } from "@/engine/input/Input";
import { Colliders } from "@/engine/physics/Colliders";
import { Player } from "@/engine/player/Player";

let hk: unknown = null;

async function havok(): Promise<unknown> {
  if (hk) return hk;
  const wasmPath = fileURLToPath(
    new URL(
      "../../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm",
      import.meta.url,
    ),
  );
  const wasmBinary = readFileSync(wasmPath);
  const mod = (await import("@babylonjs/havok")) as unknown as {
    default: (o: { wasmBinary: ArrayBuffer }) => Promise<unknown>;
  };
  hk = await mod.default({
    wasmBinary: wasmBinary.buffer.slice(
      wasmBinary.byteOffset,
      wasmBinary.byteOffset + wasmBinary.byteLength,
    ) as ArrayBuffer,
  });
  return hk;
}

export interface WalkWorld {
  scene: Scene;
  colliders: Colliders;
  dispose(): void;
}

export async function walkWorld(): Promise<WalkWorld> {
  const scene = new Scene(new NullEngine());
  scene.enablePhysics(
    new Vector3(0, -9.81, 0),
    new HavokPlugin(true, await havok()),
  );
  const colliders = new Colliders(scene);
  colliders.enablePhysics(true);
  return {
    scene,
    colliders,
    dispose: () => {
      colliders.dispose();
      scene.dispose();
    },
  };
}

export interface WalkResult {
  feet: { x: number; y: number; z: number };
  reached: number;
  log: { x: number; y: number; z: number }[];
}

/** Walk from `start` (feet, yaw rad) through `points`; `seconds` of sim. */
export function walk(
  w: WalkWorld,
  start: { x: number; y: number; z: number; yaw: number },
  points: { x: number; z: number }[],
  seconds = 30,
): WalkResult {
  const player = new Player(w.scene, {
    physics: true,
    spawn: new Vector3(start.x, start.y + 0.05, start.z),
    yaw: start.yaw,
    mode: "fp",
    headBob: false,
  });
  player.teleport(new Vector3(start.x, start.y + 0.05, start.z), start.yaw);
  player.markReady();
  let move = 0;
  const input = {
    consumeLook: () => ({ dx: 0, dy: 0 }),
    moveAxis: () => ({ x: 0, y: move }),
    sprint: false,
    consumeJump: () => false,
  } as unknown as InputController;
  const log: WalkResult["log"] = [];
  let idx = 0;
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    const p = player.position;
    if (idx < points.length) {
      const q = points[idx];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (Math.hypot(dx, dz) < 0.25) idx += 1;
      else {
        player.yaw = Math.atan2(dx, dz);
        move = 1;
      }
    }
    if (idx >= points.length) move = 0;
    player.update(dt, input);
    w.scene.getPhysicsEngine()?._step(dt);
    if (Math.round(t / dt) % 10 === 0) log.push({ x: p.x, y: p.y, z: p.z });
  }
  const f = player.position;
  return { feet: { x: f.x, y: f.y, z: f.z }, reached: idx, log };
}
