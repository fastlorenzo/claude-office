"use client";

/**
 * 3D world debug page — mounts the Babylon world full screen and feeds it the
 * demo campus every 500 ms.
 *
 * Query params:
 *   n=6                      number of demo sessions
 *   tierStep=low@60,high@120  live quality change after N frames (repro)
 *   quality=auto|high|medium|low
 *   cam=x,y,z,yawDeg,pitchDeg  fixed eye pose for screenshots (freezes the player)
 *   gfx=low|medium|high|ultra|auto  force a graphics preset
 *   gfxset=key:value,...     override single graphics settings (e.g. antiAliasing:taa)
 *   inspect=1                simulate the inspect action (DoF) after ready
 *   tp=1                     start in third person
 *   brand=Name brandTag=Tagline brandColor=cyan|#rrggbb brandFlicker=1  lobby sign
 *   shot=1                   set document.title = "ready" ~N frames after ready
 *   frames=40                frames to wait before "ready" when shot=1
 *   shotMs=ms                with shot=1: also wait this many ms after ready
 *   t=20000                  demo clock (ms) used when shot=1 (frozen)
 *   ops=1                    show the DOM Ops dashboard (control room) over the world
 *   live=1                   feed the live backend campus (/ws/campus) instead of
 *                            the demo campus (real projects / PRs on the factory)
 *   demoFactory=1            demo factory data on the production lines
 *   drawdbg=1                per-pass draw breakdown in __worldStats.passes
 *   panel=1                  press F on the first factory target in view and dock
 *                            the panel it opens (needs live=1 for panel data)
 *   walk=x,y,z,yawDeg;x,z;…  scripted walk with the real player collider from
 *                            the start pose through the waypoints (stairs);
 *                            progress in __worldStats.walk
 *   ctxloss=ms[,restoreMs]   lose the WebGL context this many ms after ready
 *                            and restore it restoreMs (default 1500) later
 *   texfail=regex[@n]        texture loads whose URL matches fail (404): the
 *                            materials loader and Babylon's own URL loads (e.g.
 *                            the context-restore re-fetch); first n attempts
 *   texfailAt=ms             arm texfail this many ms after ready (default: at once)
 *   texq=q@ms,…              texture-quality swaps after ready (low|medium|high)
 *
 * `window.__worldStats` (refreshed every 500 ms; read by shot.sh and by
 * `make perf-gate` / `make walk-gate`, see scripts/perf-gate.sh, walk-gate.sh):
 *   draws            smoothed draw calls (budgets: docs/design/review-plan.md WS4)
 *   active, textures active mesh count, scene texture count
 *   zone, kinds      current zone and active visibility-unit kinds
 *   actors, factory  actor-hub and factory stats (factory.animMs, bufferWrites)
 *   postProcesses    (WS4) post-process pass count; gate: <= 12 high, <= 6 medium
 *   screenUploads    (WS4) screen canvas uploads per second; gate: <= 2 while idle
 *   textureMB        (WS5) estimated GPU texture memory in MB
 *   notReady         { n, meshes, textures, ms }: enabled meshes whose
 *                    material has not been ready for > 3 s (Babylon skips them)
 *   texFail          texture URLs that failed after retries (neutral fallback)
 *   tex2             tiled-material maps { slots, loading, neutral }
 *   walk             only with ?walk=: { done, reached, of, t, feet:["x,y,z"], log }
 * The gates print "-" for fields the build does not report yet.
 */

import { useEffect, useRef, useState } from "react";
import { OpsDashboard } from "@/components/world/hud/ops/OpsDashboard";
import { isFactoryKind } from "@/engine/interaction/factoryTargets";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { FactoryPanelDock } from "./FactoryPanelDock";
import { connectLiveCampus, type LiveCampus } from "./liveFeed";
import {
  applyPreset,
  defaultGraphicsSettings,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { normalizeBranding } from "@/engine/world/brandLayout";
import { Tools } from "@/engine/babylon";
import {
  armTextureFailures,
  injectedTextureFailure,
  setTextureFailuresActive,
} from "@/engine/materials/readiness";
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
  const isQuality = (v: string | null | undefined): v is QualitySetting =>
    v === "auto" || v === "high" || v === "medium" || v === "low";
  const quality: QualitySetting = isQuality(qualityRaw) ? qualityRaw : "auto";
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
  let walk:
    | {
        start: { x: number; y: number; z: number; yaw: number };
        points: { x: number; z: number }[];
      }
    | undefined;
  const walkRaw = q.get("walk");
  if (walkRaw) {
    const [head, ...rest] = walkRaw.split(";");
    const [x, y, z, yaw] = head.split(",").map(Number);
    const points = rest
      .map((p) => p.split(",").map(Number))
      .filter(([px, pz]) => Number.isFinite(px) && Number.isFinite(pz))
      .map(([px, pz]) => ({ x: px, z: pz }));
    if ([x, y, z].every(Number.isFinite))
      walk = { start: { x, y, z, yaw: ((yaw || 0) * Math.PI) / 180 }, points };
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
    walk,
    shot: q.get("shot") === "1",
    frames: Number(q.get("frames") ?? 40) || 40,
    shotMs: Number(q.get("shotMs") ?? 0) || 0,
    t: q.get("t") ? Number(q.get("t")) : undefined,
    ops: q.get("ops") === "1",
    live: q.get("live") === "1",
    demoFactory: q.get("demoFactory") === "1",
    drawBreakdown: q.get("drawdbg") === "1",
    panel: q.get("panel") === "1",
    /** Dispose a first world after this many ms and build a second one on the same canvas (HMR / Fast Refresh remount). */
    remount: Number(q.get("remount") ?? 0) || 0,
    /** Session count changes after ready (nstep=10@2000,3@5000: n@ms). */
    nSteps: (q.get("nstep") ?? "")
      .split(",")
      .map((x) => x.split("@").map(Number))
      .filter(([c, ms]) => c >= 0 && c <= 32 && ms >= 0)
      .map(([c, ms]) => ({ n: c, ms })),
    ctxLoss: (q.get("ctxloss") ?? "")
      .split(",")
      .map(Number)
      .filter((x) => x > 0),
    texQ: (q.get("texq") ?? "")
      .split(",")
      .map((x) => x.split("@"))
      .filter(
        (x): x is ["low" | "medium" | "high", string] =>
          x.length === 2 &&
          (x[0] === "low" || x[0] === "medium" || x[0] === "high") &&
          Number(x[1]) >= 0,
      )
      .map(([tq, ms]) => ({ q: tq, ms: Number(ms) })),
    /**
     * Live single-setting changes (gfxStep=areaLights:false@60,maxDynamicLights:0@90:
     * key:value@frame) applied to the current graphics settings.
     */
    gfxSteps: (q.get("gfxStep") ?? "")
      .split(",")
      .map((x) => x.split("@"))
      .filter((x) => x.length === 2 && x[0].includes(":") && Number(x[1]) >= 0)
      .map(([kv, f]) => {
        const [k, v] = kv.split(":");
        const val: unknown =
          v === "true"
            ? true
            : v === "false"
              ? false
              : isNaN(Number(v))
                ? v
                : Number(v);
        return { key: k, value: val, frame: Number(f) };
      }),
    tierSteps: (q.get("tierStep") ?? "")
      .split(",")
      .map((x) => x.split("@"))
      .filter(
        (x): x is [QualitySetting, string] =>
          x.length === 2 && isQuality(x[0]) && Number(x[1]) >= 0,
      )
      .map(([quality, f]) => ({ quality, frame: Number(f) })),
  };
}

export default function WorldDebugPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("loading…");
  const [prompt, setPrompt] = useState<string | null>(null);
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
    // Dev-only failure injection for texture loads (see texfail above).
    const sq = new URLSearchParams(window.location.search);
    const texFail = sq.get("texfail");
    const texFailAt = Number(sq.get("texfailAt") ?? 0) || 0;
    if (texFail) {
      const [re, n] = texFail.split("@");
      armTextureFailures(new RegExp(re), n ? Number(n) : Infinity, !texFailAt);
      Tools.PreprocessUrl = (url: string) =>
        injectedTextureFailure(url) ? `${url}.injected-404` : url;
    }
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
      if (p.remount > 0) {
        // Fast Refresh re-runs WorldCanvas' effect: the first world is
        // disposed mid-init and a new one takes the same canvas.
        const first = createWorld(
          canvas,
          {
            quality: p.quality,
            graphics: p.graphics,
            cameraMode: p.cameraMode,
            isMobile: false,
            assetBase: "/assets",
          },
          { preserveDrawingBuffer: p.shot },
        );
        void first.init().catch(() => undefined);
        await new Promise((r) => setTimeout(r, p.remount));
        first.dispose();
        if (cancelled) return;
      }
      world = createWorld(
        canvas,
        {
          quality: p.quality,
          graphics: p.graphics,
          cameraMode: p.cameraMode,
          isMobile: false,
          assetBase: "/assets",
        },
        {
          camera: p.camera,
          walk: p.walk,
          preserveDrawingBuffer: p.shot,
          headBob: !p.camera && !p.walk,
          demoFactory: p.demoFactory,
          drawBreakdown: p.drawBreakdown,
        },
      );
      if (p.brand) world.setBranding?.(p.brand);
      offs.push(world.on("stats", (s) => setStats(s)));
      offs.push(world.on("error", (e) => setStatus(`error: ${e.message}`)));
      let pressed = false;
      offs.push(
        world.on("interaction", (e) => {
          setPrompt(e ? `${e.target.kind} · ${e.target.roomLabel}` : null);
          if (p.panel && e && !pressed && isFactoryKind(e.target.kind)) {
            pressed = true;
            world?.triggerAction("inspect");
          }
        }),
        world.on("action", ({ action, target }) => {
          if (action === "inspect" && isFactoryKind(target.kind))
            useWorldUiStore.getState().openFactory(target);
        }),
      );
      offs.push(
        world.on("ready", () => {
          setStatus("ready");
          useWorldUiStore.getState().setReady(true);
          if (texFail && texFailAt)
            setTimeout(() => {
              console.warn("[world-debug] texture failures armed");
              setTextureFailuresActive(true);
            }, texFailAt);
          if (p.ctxLoss.length) {
            // Context loss + restore (GPU reset / too many contexts).
            const [at, restore = 1500] = p.ctxLoss;
            const el = document.querySelector<HTMLCanvasElement>(
              "canvas[data-world-canvas]",
            );
            const gl = el?.getContext("webgl2") ?? el?.getContext("webgl");
            const ext = gl?.getExtension("WEBGL_lose_context");
            setTimeout(() => {
              if (cancelled || !ext) return;
              console.warn("[world-debug] losing the WebGL context");
              ext.loseContext();
              setTimeout(() => {
                if (cancelled) return;
                console.warn("[world-debug] restoring the WebGL context");
                ext.restoreContext();
              }, restore);
            }, at);
          }
          for (const st of p.texQ)
            setTimeout(() => {
              if (cancelled) return;
              const w = world as unknown as {
                debugTextureQuality?: (q: string) => void;
              };
              w.debugTextureQuality?.(st.q);
            }, st.ms);
          if (p.inspect) {
            const w = world as unknown as { debugInspect?: () => void };
            w.debugInspect?.();
          }
          for (const st of p.nSteps)
            setTimeout(() => {
              if (cancelled) return;
              n = st.n;
              feed();
            }, st.ms);
          if (p.tierSteps.length) {
            // Deterministic live tier change (e.g. tierStep=low@60,high@120).
            let n = 0;
            const steps = [...p.tierSteps];
            const tick = () => {
              if (cancelled) return;
              n += 1;
              while (steps.length && n >= steps[0].frame) {
                const st = steps.shift();
                if (st) world?.setQuality(st.quality);
              }
              if (steps.length) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
          if (p.gfxSteps.length) {
            // Deterministic live graphics-menu changes (one setting each).
            let n = 0;
            let cur: GraphicsSettings = {
              ...(p.graphics ?? applyPreset("high", defaultGraphicsSettings())),
            };
            const steps = [...p.gfxSteps];
            const tick = () => {
              if (cancelled) return;
              n += 1;
              while (steps.length && n >= steps[0].frame) {
                const st = steps.shift();
                if (!st) break;
                cur = { ...cur, [st.key]: st.value, preset: "custom" };
                console.warn(`[world-debug] gfx ${st.key}=${String(st.value)}`);
                world?.setGraphics(cur);
              }
              if (steps.length) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
          if (p.shot) {
            let left = p.frames;
            const until = performance.now() + p.shotMs;
            const tick = () => {
              left -= 1;
              if (left <= 0 && performance.now() >= until)
                document.title = "ready";
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        }),
      );
      // Screenshot mode freezes the demo clock so frames are deterministic.
      const t0 = Date.now();
      let n = p.n;
      let live: LiveCampus | null = null;
      if (p.live)
        offs.push(
          connectLiveCampus((s) => {
            live = s;
            feed();
          }),
        );
      const feed = () => {
        const demo = createDemoCampus(
          n,
          p.shot ? (p.t ?? 20000) : Date.now() - t0 + 20000,
        );
        if (live) {
          useCampusStore.getState().acceptFrame({
            sessions: live.campus,
            stats: live.stats,
            projects: live.projects,
            revs: live.revs,
            sentAt: live.sentAt,
          });
          world?.sync({
            campus: live.campus,
            sessions: live.sessions,
            selectedSessionId: live.sessions[0]?.id ?? null,
            stats: live.stats,
            projects: live.projects,
          });
          return;
        }
        if (p.live) return;
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
        {prompt && <div>F · {prompt}</div>}
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
      <FactoryPanelDock />
    </div>
  );
}
