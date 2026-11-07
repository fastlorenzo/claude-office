"use client";

/**
 * Shipping dock sandbox: flat apron + the Dock with sample releases/deploys
 * and sample branding, fly camera.
 *
 * Query params:
 *   cam=x,y,z,yawDeg,pitchDeg   eye pose (yaw 180 looks toward -z, at the dock)
 *   brand=claude|northwind|custom   sample branding (default northwind)
 *   brandName= brandTag= brandColor=   override pieces of the branding
 *   door=0..1                   open the truck's roller door (default 0.7)
 *   depart=1                    run the departure stub right away
 *   shot=1 frames=30            document.title = "ready" after N frames
 * Fly: WASD / arrows + mouse drag, Shift = fast. window.__worldStats = {draws,...}
 */

import { useEffect, useRef, useState } from "react";
import {
  Color3,
  Color4,
  CreateGround,
  Engine,
  HDRCubeTexture,
  HemisphericLight,
  DirectionalLight,
  ImageProcessingConfiguration,
  PBRMaterial,
  Scene,
  SceneInstrumentation,
  UniversalCamera,
  Vector3,
} from "@/engine/babylon";
import type {
  BrandingOptions,
  PipelineRun,
  ReleaseInfo,
} from "@/engine/contracts";
import {
  DEFAULT_BRANDING,
  normalizeBranding,
} from "@/engine/world/brandLayout";
import { Dock } from "@/engine/world/factory/Dock";
import { MeshSoup, hexColor } from "@/engine/world/factory/meshSoup";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const RELEASES: ReleaseInfo[] = [
  { tag: "v1.14.0", name: "Spring Release", publishedAt: ago(90) },
  { tag: "v1.14.0-rc.2", publishedAt: ago(60 * 30), prerelease: true },
  { tag: "v1.13.2", publishedAt: ago(60 * 24 * 4) },
  { tag: "v1.13.1", publishedAt: ago(60 * 24 * 9) },
  { tag: "v1.13.0", publishedAt: ago(60 * 24 * 21) },
  { tag: "v1.12.4", publishedAt: ago(60 * 24 * 40) },
];

const DEPLOYS: PipelineRun[] = [
  {
    id: "1",
    workflow: "deploy-production",
    kind: "deploy",
    branch: "main",
    state: "running",
    startedAt: ago(3),
  },
  {
    id: "2",
    workflow: "deploy-staging",
    kind: "deploy",
    branch: "main",
    state: "success",
    startedAt: ago(48),
  },
  {
    id: "3",
    workflow: "release-docker",
    kind: "release",
    branch: "v1.14.0",
    state: "queued",
    startedAt: ago(1),
  },
  {
    id: "4",
    workflow: "deploy-eu-west",
    kind: "deploy",
    branch: "release/1.13",
    state: "failure",
    startedAt: ago(60 * 26),
  },
  {
    id: "5",
    workflow: "ci",
    kind: "ci",
    branch: "main",
    state: "success",
    startedAt: ago(10),
  },
];

const SVG_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><polygon points="128,14 226,71 226,185 128,242 30,185 30,71" fill="#19e3ff"/><polygon points="128,64 182,96 182,160 128,192 74,160 74,96" fill="#0a1a28"/></svg>';

function brandFromQuery(q: URLSearchParams): BrandingOptions {
  const preset = q.get("brand") ?? "northwind";
  const base: BrandingOptions =
    preset === "claude"
      ? DEFAULT_BRANDING
      : normalizeBranding({
          name: "Northwind Freight",
          tagline: "Ship it. Delivered.",
          color: "#19e3ff",
          logo: `data:image/svg+xml;base64,${btoa(SVG_LOGO)}`,
        });
  return normalizeBranding({
    name: q.get("brandName") ?? base.name,
    tagline: q.get("brandTag") ?? base.tagline,
    color: q.get("brandColor") ?? base.color,
    logo: q.get("noLogo") === "1" ? null : base.logo,
  });
}

export default function DockDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("loading…");
  const [draws, setDraws] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const q = new URLSearchParams(window.location.search);
    const shot = q.get("shot") === "1";
    const frames = Number(q.get("frames") ?? 30) || 30;
    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: shot,
      stencil: true,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.56, 0.64, 0.74, 1);
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.05;
    try {
      const env = new HDRCubeTexture(
        "/assets/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr",
        scene,
        256,
      );
      scene.environmentTexture = env;
      scene.environmentIntensity = 0.9;
    } catch {
      /* flat lighting fallback */
    }
    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.3), scene);
    hemi.intensity = 0.7;
    const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.5), scene);
    sun.intensity = 1.6;

    // Flat apron with bay lines.
    const ground = CreateGround("apron", { width: 160, height: 160 }, scene);
    const gm = new PBRMaterial("apron:mat", scene);
    gm.albedoColor = new Color3(0.34, 0.35, 0.37);
    gm.metallic = 0;
    gm.roughness = 0.92;
    ground.material = gm;
    const lines = new MeshSoup();
    const yel = hexColor("#f2c500");
    for (const x of [-9, 0, 9])
      for (const s of [-1, 1])
        lines.span(
          x + s * 2.0 - 0.07,
          0.003,
          0.6,
          x + s * 2.0 + 0.07,
          0.006,
          20,
          yel,
        );
    for (let x = -20; x <= 20; x += 4)
      lines.span(x - 0.06, 0.003, 36, x + 0.06, 0.006, 40, hexColor("#d8dce0"));
    const lm = lines.build("apron:lines", scene);
    if (lm) {
      const m = new PBRMaterial("apron:linesMat", scene);
      m.albedoColor = Color3.White();
      m.roughness = 0.8;
      m.metallic = 0;
      lm.material = m;
    }

    const brand = brandFromQuery(q);
    const dock = new Dock(scene, { branding: brand });
    dock.setNow(NOW);
    dock.setReleases(RELEASES);
    dock.setDeploys(DEPLOYS);
    dock.setDoor(1, Number(q.get("door") ?? 0.7));
    if (q.get("depart") === "1") dock.departTruck();

    // Fly camera.
    const cam = new UniversalCamera("cam", new Vector3(-11, 3.4, 27), scene);
    cam.minZ = 0.1;
    cam.maxZ = 400;
    cam.fov = 1.0;
    cam.rotation.y = Math.PI - 0.4;
    cam.rotation.x = 0.06;
    const c = q.get("cam");
    if (c) {
      const [x, y, z, yaw, pitch] = c.split(",").map(Number);
      if ([x, y, z].every(Number.isFinite)) {
        cam.position.set(x, y, z);
        cam.rotation.y = ((yaw || 0) * Math.PI) / 180;
        cam.rotation.x = ((pitch || 0) * Math.PI) / 180;
      }
    }
    cam.keysUp = [87, 38];
    cam.keysDown = [83, 40];
    cam.keysLeft = [65, 37];
    cam.keysRight = [68, 39];
    cam.keysUpward = [69];
    cam.keysDownward = [81];
    cam.speed = 0.35;
    cam.angularSensibility = 2200;
    cam.inertia = 0.7;
    if (!shot) cam.attachControl(canvas, true);

    const instr = new SceneInstrumentation(scene);
    let last = performance.now();
    let left = frames;
    let done = false;
    let lastStat = 0;
    engine.runRenderLoop(() => {
      const now = performance.now();
      dock.update(Math.min(0.1, (now - last) / 1000));
      last = now;
      scene.render();
      if (now - lastStat > 400) {
        lastStat = now;
        const d = instr.drawCallsCounter.current;
        setDraws(d);
        (globalThis as { __worldStats?: unknown }).__worldStats = {
          draws: d,
          active: scene.getActiveMeshes().length,
          textures: scene.textures.length,
          dockDraws: dock.meshes.filter((m) => m.isEnabled()).length,
          truckDraws: dock.truck?.meshes.length ?? 0,
        };
      }
      if (!done && --left <= 0) {
        done = true;
        setStatus("ready");
        if (shot) document.title = "ready";
      }
    });
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.stopRenderLoop();
      dock.dispose();
      scene.dispose();
      engine.dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-neutral-900">
      <canvas
        ref={canvasRef}
        className="block h-full w-full outline-none"
        tabIndex={0}
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/55 px-3 py-2 font-mono text-xs leading-5 text-neutral-100">
        <div>factory-debug/dock · {status}</div>
        <div>{draws} draws</div>
      </div>
    </div>
  );
}
