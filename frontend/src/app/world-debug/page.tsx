"use client";

/**
 * 3D world debug page — mounts the Babylon world full screen and feeds it the
 * demo campus every 500 ms.
 *
 * Query params:
 *   n=6                      number of demo sessions
 *   quality=auto|high|low
 *   cam=x,y,z,yawDeg,pitchDeg  fixed eye pose for screenshots (freezes the player)
 *   tp=1                     start in third person
 *   shot=1                   set document.title = "ready" ~N frames after ready
 *   frames=40                frames to wait before "ready" when shot=1
 *   t=20000                  demo clock (ms) used when shot=1 (frozen)
 */

import { useEffect, useRef, useState } from "react";
import type {
  CameraMode,
  IWorld,
  QualitySetting,
  WorldEvents,
} from "@/engine/contracts";

type Stats = WorldEvents["stats"];

function parseParams() {
  const q = new URLSearchParams(window.location.search);
  const n = Math.max(0, Math.min(32, Number(q.get("n") ?? 6) || 0));
  const qualityRaw = q.get("quality");
  const quality: QualitySetting =
    qualityRaw === "high" || qualityRaw === "low" ? qualityRaw : "auto";
  const cameraMode: CameraMode = q.get("tp") === "1" ? "tp" : "fp";
  let camera:
    { x: number; y: number; z: number; yaw: number; pitch: number } | undefined;
  const cam = q.get("cam");
  if (cam) {
    const [x, y, z, yaw, pitch] = cam.split(",").map(Number);
    if ([x, y, z].every(Number.isFinite)) {
      camera = {
        x,
        y,
        z,
        yaw: ((yaw || 0) * Math.PI) / 180,
        pitch: ((pitch || 0) * Math.PI) / 180,
      };
    }
  }
  return {
    n,
    quality,
    cameraMode,
    camera,
    shot: q.get("shot") === "1",
    frames: Number(q.get("frames") ?? 40) || 40,
    t: q.get("t") ? Number(q.get("t")) : undefined,
  };
}

export default function WorldDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("loading…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = parseParams();
    let world: IWorld | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const offs: (() => void)[] = [];

    void (async () => {
      const [{ createWorld }, { createDemoCampus }] = await Promise.all([
        import("@/engine/world/World"),
        import("@/engine/demo/demoCampus"),
      ]);
      if (cancelled) return;
      world = createWorld(
        canvas,
        {
          quality: p.quality,
          cameraMode: p.cameraMode,
          isMobile: false,
          assetBase: "/assets",
        },
        { camera: p.camera, preserveDrawingBuffer: p.shot, headBob: !p.camera },
      );
      offs.push(world.on("stats", (s) => setStats(s)));
      offs.push(world.on("error", (e) => setStatus(`error: ${e.message}`)));
      offs.push(
        world.on("ready", () => {
          setStatus("ready");
          if (p.shot) {
            let left = p.frames;
            const tick = () => {
              left -= 1;
              if (left <= 0) document.title = "ready";
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        }),
      );
      // Screenshot mode freezes the demo clock so frames are deterministic.
      const t0 = Date.now();
      const feed = () => {
        const demo = createDemoCampus(
          p.n,
          p.shot ? (p.t ?? 20000) : Date.now() - t0 + 20000,
        );
        world?.sync({
          campus: demo.campus,
          sessions: demo.sessions,
          selectedSessionId: demo.sessions[0]?.id ?? null,
        });
      };
      feed();
      timer = setInterval(feed, 500);
      try {
        await world.init();
      } catch (err) {
        setStatus(
          `init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      for (const off of offs) off();
      world?.dispose();
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
        <div>world-debug · {status}</div>
        {stats && (
          <div>
            {stats.fps} fps · {stats.frameMs} ms · {stats.drawCalls} draws ·{" "}
            {stats.tier}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
    </div>
  );
}
