"use client";

/**
 * Software Factory sandbox — conveyor + station pools (P2.1 / P2.2).
 *
 * Query params:
 *   cam=x,y,z,yawDeg,pitchDeg  fixed eye pose (disables fly controls)
 *   lanes=3                    lanes in the demo cell (1–60, stress test)
 *   shot=1                     set document.title = "ready" ~N frames after ready
 *   frames=40                  frames to wait before "ready" when shot=1
 *   t=0.03                     frozen animation time (s) when shot=1
 *   anim=1                     scripted state changes: arms, beacons, belts move
 *                              (with shot=1: fixed 30 fps steps, frames=N → N/30 s)
 *   radius=30                  arm animation radius (m); 1000 = stress worst case
 *
 * Controls: WASD move, Q/E down/up, drag to look.
 * `window.__worldStats` = { draws (median of 5), conveyors, stations, … }.
 */

import { useEffect, useRef, useState } from "react";
import type { SandboxHandle, SandboxParams } from "./sandbox";

function parseParams(): SandboxParams {
  const q = new URLSearchParams(window.location.search);
  let camera: SandboxParams["camera"];
  const cam = q.get("cam");
  if (cam) {
    const [x, y, z, yaw, pitch] = cam.split(",").map(Number);
    if ([x, y, z].every(Number.isFinite))
      camera = {
        x,
        y,
        z,
        yaw: ((yaw || 0) * Math.PI) / 180,
        pitch: ((pitch || 0) * Math.PI) / 180,
      };
  }
  return {
    camera,
    shot: q.get("shot") === "1",
    frames: Number(q.get("frames") ?? 40) || 40,
    t: q.get("t") ? Number(q.get("t")) || 0 : 0.03,
    anim: q.get("anim") === "1",
    radius: Number(q.get("radius") ?? 30) || 30,
    lanes: Math.max(1, Math.min(60, Number(q.get("lanes") ?? 3) || 3)),
  };
}

interface Stats {
  draws: number;
  conveyors: { draws: number; belt: number; frame: number; guard: number };
  stations: {
    draws: number;
    stations: number;
    animated: number;
    bufferWrites: number;
    partialWrites: number;
    armsActive?: number;
    armsWrittenLast?: number;
    armsSkipped?: number;
    updateMs?: number;
  };
  animMs?: number;
}

export default function ConveyorSandboxPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("loading…");
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = parseParams();
    let handle: SandboxHandle | null = null;
    let cancelled = false;
    void (async () => {
      const { createSandbox } = await import("./sandbox");
      if (cancelled) return;
      try {
        handle = await createSandbox(canvas, p, setStatus);
        if (cancelled) handle.dispose();
      } catch (err) {
        setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    const timer = setInterval(() => {
      const s = (globalThis as { __worldStats?: Stats }).__worldStats;
      if (s) setStats({ ...s });
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
      handle?.dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-neutral-950">
      <canvas
        ref={canvasRef}
        className="block h-full w-full outline-none"
        tabIndex={0}
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/55 px-3 py-2 font-mono text-xs leading-5 text-neutral-100">
        <div>factory-debug / conveyors · {status}</div>
        {stats && (
          <>
            <div>
              {stats.draws} draws · conveyors {stats.conveyors.draws} (
              {stats.conveyors.belt}/{stats.conveyors.frame}/
              {stats.conveyors.guard}) · stations {stats.stations.draws} (
              {stats.stations.stations})
            </div>
            <div>
              writes {stats.stations.bufferWrites} full ·{" "}
              {stats.stations.partialWrites} beacon · {stats.stations.animated}{" "}
              animated
            </div>
            <div>
              arms {stats.stations.armsWrittenLast ?? 0} written /{" "}
              {stats.stations.armsActive ?? 0} active /{" "}
              {stats.stations.armsSkipped ?? 0} skipped · cpu{" "}
              {(stats.animMs ?? 0).toFixed(3)} ms
            </div>
          </>
        )}
      </div>
    </div>
  );
}
