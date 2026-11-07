"use client";

/**
 * Material contact sheet: every materials2 candidate on a sphere and a 1x1 m
 * flat tile, lit by the Poly Haven HDRI + a directional light.
 * `?shot=1` sets document.title to "materials-ready" once rendered.
 * `?role=floorMain,wallMain` limits the roles shown.
 */

import { useEffect, useRef } from "react";
import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateGround,
  CreateSphere,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HDRCubeTexture,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
  CreatePlane,
} from "@/engine/babylon";
import {
  MATERIAL_CANDIDATES,
  material2Path,
  type MaterialRole,
  type PbrMaterialAsset,
} from "@/engine/assets/materials2";

const CELL = 1.6; // metres between grid cells (tile 1 m + sphere 0.45 m)

function makeMaterial(scene: Scene, a: PbrMaterialAsset): PBRMaterial {
  const mat = new PBRMaterial(`${a.role}-${a.id}`, scene);
  const mk = (file: string) => {
    const t = new Texture(material2Path(file), scene);
    t.uScale = t.vScale = 1 / a.tileMeters;
    return t;
  };
  mat.albedoTexture = mk(a.files.albedo);
  mat.bumpTexture = mk(a.files.normal);
  mat.metallicTexture = mk(a.files.orm);
  mat.useAmbientOcclusionFromMetallicTextureRed = true;
  mat.useRoughnessFromMetallicTextureGreen = true;
  mat.useMetallnessFromMetallicTextureBlue = true;
  mat.metallic = 1;
  mat.roughness = 1;
  if (a.tint) mat.albedoColor = Color3.FromHexString(a.tint);
  return mat;
}

function label(scene: Scene, text: string, x: number, z: number): void {
  const dt = new DynamicTexture("lbl", { width: 512, height: 64 }, scene, true);
  dt.hasAlpha = true;
  const ctx = dt.getContext();
  ctx.clearRect(0, 0, 512, 64);
  dt.drawText(
    text,
    8,
    44,
    "bold 28px monospace",
    "#ffffff",
    "#1c1c1c",
    true,
    true,
  );
  const mat = new StandardMaterial("lblm", scene);
  mat.diffuseTexture = dt;
  mat.emissiveColor = Color3.White();
  mat.disableLighting = true;
  mat.useAlphaFromDiffuseTexture = true;
  const p = CreatePlane("lbl", { width: 1.5, height: 0.19 }, scene);
  p.rotation.x = Math.PI / 2;
  p.position.set(x, 0.01, z);
  p.material = mat;
}

export default function MaterialsDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const params = new URLSearchParams(window.location.search);
    const shot = params.has("shot");
    const only = params.get("role")?.split(",");
    const roles = (Object.keys(MATERIAL_CANDIDATES) as MaterialRole[]).filter(
      (r) => !only || only.includes(r),
    );

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.16, 0.16, 0.17, 1);
    const hdr = new HDRCubeTexture(
      "/assets/hdri/blender_institute_1k.hdr",
      scene,
      256,
    );
    scene.environmentTexture = hdr;
    scene.environmentIntensity = 0.7;
    const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.5), scene);
    sun.intensity = 2.2;

    const per = 3; // candidates per role block
    const bc = Number(params.get("bc") ?? 2); // role blocks per row
    const brows = Math.ceil(roles.length / bc);
    const w = bc * per * CELL;
    const d = brows * CELL;
    const target = new Vector3(w / 2 - CELL / 2, 0, -(d / 2 - CELL / 2));
    const cam = new ArcRotateCamera(
      "cam",
      -Math.PI / 2,
      0.25,
      10,
      target,
      scene,
    );
    cam.fov = 0.6;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const halfV = Math.max(d / 2 + 0.3, (w / 2 + 0.3) / aspect);
    cam.radius = (halfV / Math.tan(cam.fov / 2)) * 1.05;
    cam.minZ = 0.1;
    cam.maxZ = 300;
    cam.attachControl(canvas, true);

    void (async () => {
      const present = new Map<string, boolean>();
      await Promise.all(
        roles
          .flatMap((r) => MATERIAL_CANDIDATES[r])
          .map(async (a) => {
            try {
              const res = await fetch(material2Path(a.files.albedo), {
                method: "HEAD",
              });
              present.set(a.id, res.ok);
            } catch {
              present.set(a.id, false);
            }
          }),
      );
      if (disposed) return;
      roles.forEach((role, ri) => {
        const bx = (ri % bc) * per * CELL;
        const bz = -Math.floor(ri / bc) * CELL;
        MATERIAL_CANDIDATES[role].forEach((a, ci) => {
          const x0 = bx + ci * CELL;
          if (!present.get(a.id)) {
            label(scene, `${role}: ${a.id} (not fetched)`, x0, bz - 0.58);
            return;
          }
          const mat = makeMaterial(scene, a);
          const x = bx + ci * CELL;
          const z = bz;
          const tile = CreateGround("tile", { width: 1, height: 1 }, scene);
          tile.position.set(x - 0.3, 0, z);
          tile.material = mat;
          const sph = CreateSphere(
            "sph",
            { diameter: 0.5, segments: 48 },
            scene,
          );
          sph.position.set(x + 0.45, 0.25, z + 0.2);
          sph.material = mat;
          label(scene, `${ci === 0 ? "* " : ""}${role}: ${a.id}`, x, z - 0.58);
        });
      });
    })();

    let frames = 0;
    engine.runRenderLoop(() => {
      scene.render();
      frames++;
      if (shot && frames === 60 && scene.isReady()) {
        document.title = "materials-ready";
      }
    });
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      disposed = true;
      engine.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100vw",
        height: "100vh",
        display: "block",
        outline: "none",
      }}
    />
  );
}
