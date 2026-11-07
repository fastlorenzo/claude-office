"use client";

/**
 * Software Factory sandbox — cell dressing (P2.4): header boards + furniture
 * pool together with the conveyor / station / workpiece pools on a real
 * generateLayout (3 demo projects) so a cell reads complete.
 *
 * Query params:
 *   cam=x,y,z,yawDeg,pitchDeg  fixed eye pose (disables fly controls)
 *   floor=-6                   floor y (default -6, the real factory floor)
 *   cell=0                     which cell the default camera looks at
 *   vis=full|impostor|hidden   visibility applied to every cell
 *   shot=1                     document.title = "ready" ~N frames after ready
 *   frames=40                  frames to wait before "ready" when shot=1
 *
 * Controls: WASD move, Q/E down/up, drag to look.
 * `window.__worldStats` = { draws (median of 5), cells, conveyors, stations, workpieces }.
 */

import { useEffect, useRef, useState } from "react";
import type { SandboxHandle, SandboxParams } from "./sandbox";

interface Stats {
  draws: number;
  cells: {
    draws: number;
    furnitureDraws: number;
    boards: number;
    instances: number;
    rebuilds: number;
  };
  stations: { draws: number; stations: number };
  conveyors: { draws: number };
  workpieces: { draws: number; pieces: number };
}

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
  const vis = q.get("vis");
  return {
    camera,
    shot: q.get("shot") === "1",
    frames: Number(q.get("frames") ?? 40) || 40,
    floor: q.get("floor") ? Number(q.get("floor")) || 0 : -6,
    cell: Math.max(0, Math.floor(Number(q.get("cell") ?? 0) || 0)),
    vis: vis === "impostor" || vis === "hidden" ? vis : "full",
  };
}

export default function CellSandboxPage() {
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
      {
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/55 px-3 py-2 font-mono text-xs leading-5 text-neutral-100">
          <div>factory-debug / cell · {status}</div>
          {stats && (
            <>
              <div>
                {stats.draws} draws · cells {stats.cells.draws} (furniture{" "}
                {stats.cells.furnitureDraws} + boards {stats.cells.boards}) ·
                conveyors {stats.conveyors.draws} · stations{" "}
                {stats.stations.draws} · pieces {stats.workpieces.draws}
              </div>
              <div>
                {stats.cells.instances} furniture instances ·{" "}
                {stats.cells.rebuilds} rebuilds
              </div>
            </>
          )}
        </div>
      }
    </div>
  );
}
