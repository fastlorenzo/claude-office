"use client";

/**
 * 3D world debug page — mounts the Babylon world full screen and feeds it the
 * demo campus every 500 ms.
 *
 * Query params:
 *   n=6                      number of demo sessions
 *   quality=auto|high|low
 *   cam=x,y,z,yawDeg,pitchDeg  fixed eye pose for screenshots (freezes the player)
 *   gfx=low|medium|high|ultra|auto  force a graphics preset
 *   gfxset=key:value,...     override single graphics settings (e.g. antiAliasing:taa)
 *   inspect=1                simulate the inspect action (DoF) after ready
 *   tp=1                     start in third person
 *   brand=Name brandTag=Tagline brandColor=cyan|#rrggbb brandFlicker=1  lobby sign
 *   shot=1                   set document.title = "ready" ~N frames after ready
 *   frames=40                frames to wait before "ready" when shot=1
 *   t=20000                  demo clock (ms) used when shot=1 (frozen)
 *   ops=1                    show the DOM Ops dashboard (control room) over the world
 */

import { useEffect, useRef, useState } from "react";
import { OpsDashboard } from "@/components/world/hud/ops/OpsDashboard";
import {
  applyPreset,
  defaultGraphicsSettings,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { normalizeBranding } from "@/engine/world/brandLayout";
import type {
  CameraMode,
  CampusSession,
  CampusStats,
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
  const gfxRaw = q.get("gfx");
  let graphics: GraphicsSettings | undefined;
  if (gfxRaw) {
    const preset =
      gfxRaw === "low" ||
      gfxRaw === "medium" ||
      gfxRaw === "high" ||
      gfxRaw === "ultra"
        ? gfxRaw
        : "auto";
    graphics = {
      ...applyPreset(preset, defaultGraphicsSettings()),
      showFps: true,
    };
    const over = q.get("gfxset");
    if (over) {
      const g = graphics as unknown as Record<string, unknown>;
      for (const kv of over.split(",")) {
        const [k, v] = kv.split(":");
        if (!(k in g)) continue;
        g[k] =
          v === "true"
            ? true
            : v === "false"
              ? false
              : isNaN(Number(v))
                ? v
                : Number(v);
      }
      graphics.preset = "custom";
    }
  }
  const brand =
    q.has("brand") || q.has("brandColor") || q.has("brandTag")
      ? normalizeBranding({
          name: q.get("brand"),
          tagline: q.get("brandTag"),
          color: q.get("brandColor"),
          flicker: q.get("brandFlicker") === "1",
        })
      : undefined;
  return {
    brand,
    graphics,
    inspect: q.get("inspect") === "1",
    n,
    quality,
    cameraMode,
    camera,
    shot: q.get("shot") === "1",
    frames: Number(q.get("frames") ?? 40) || 40,
    t: q.get("t") ? Number(q.get("t")) : undefined,
    ops: q.get("ops") === "1",
  };
}

export default function WorldDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("loading…");
  const [ops, setOps] = useState<{
    campus: CampusSession[];
    stats: CampusStats;
    labels: Map<string, string>;
    nowMs: number;
  } | null>(null);

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
          graphics: p.graphics,
          cameraMode: p.cameraMode,
          isMobile: false,
          assetBase: "/assets",
        },
        { camera: p.camera, preserveDrawingBuffer: p.shot, headBob: !p.camera },
      );
      if (p.brand) world.setBranding?.(p.brand);
      offs.push(world.on("stats", (s) => setStats(s)));
      offs.push(world.on("error", (e) => setStatus(`error: ${e.message}`)));
      offs.push(
        world.on("ready", () => {
          setStatus("ready");
          if (p.inspect) {
            const w = world as unknown as { debugInspect?: () => void };
            w.debugInspect?.();
          }
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
          stats: demo.stats,
          projects: demo.projects,
        });
        if (p.ops)
          setOps({
            campus: demo.campus,
            stats: demo.stats,
            labels: new Map(demo.sessions.map((s) => [s.id, s.label])),
            nowMs: Date.now(),
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
            {stats.effective ?? stats.tier} · {stats.postProcesses ?? 0} pp
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
      {ops && (
        <OpsDashboard
          campus={ops.campus}
          stats={ops.stats}
          labels={ops.labels}
          nowMs={ops.nowMs}
          onClose={() => setOps(null)}
        />
      )}
    </div>
  );
}
