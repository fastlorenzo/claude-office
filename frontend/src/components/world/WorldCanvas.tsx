"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { IWorld, SyncInput } from "@/engine/contracts";
import { useCampusStore } from "@/stores/campusStore";
import { selectBranding, usePreferencesStore } from "@/stores/preferencesStore";
import { useAttentionStore } from "@/stores/attentionStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import type { Session } from "@/hooks/useSessions";
import { sessionLabel, toSessionMeta } from "./sessionMeta";
import { enterSession, setEnterContext } from "./enterSession";
import { githubUrlOf, isFactoryKind } from "@/engine/interaction/factoryTargets";
import { setWorld } from "./worldRef";

const SYNC_THROTTLE_MS = 50;

interface WorldCanvasProps {
  sessions: Session[];
  sessionId: string;
  onSessionSelect: (id: string) => Promise<void>;
  isMobile: boolean;
}

/**
 * Full-bleed Babylon canvas. The world is created exactly once per mount in an
 * effect (guarded so StrictMode / HMR double-mounts dispose the first
 * instance). All data flows in through store subscriptions — no React state.
 */
export function WorldCanvas({
  sessions,
  sessionId,
  onSessionSelect,
  isMobile,
}: WorldCanvasProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest props for the long-lived subscriptions below.
  const sessionsRef = useRef(sessions);
  const selectedRef = useRef(sessionId);
  const selectRef = useRef(onSessionSelect);
  const isMobileRef = useRef(isMobile);
  const syncNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    sessionsRef.current = sessions;
    selectedRef.current = sessionId;
    selectRef.current = onSessionSelect;
    isMobileRef.current = isMobile;
    syncNowRef.current?.();
  }, [sessions, sessionId, onSessionSelect, isMobile]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let disposed = false;
    let world: IWorld | null = null;
    let inited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    const teardown: (() => void)[] = [];
    const ui = useWorldUiStore.getState();

    const buildInput = (): SyncInput => ({
      campus: useCampusStore.getState().sessions,
      sessions: sessionsRef.current.map((s) =>
        toSessionMeta(
          s,
          useCampusStore.getState().sessions.find((c) => c.sessionId === s.id),
        ),
      ),
      selectedSessionId: selectedRef.current || null,
      stats: useCampusStore.getState().stats,
      projects: useCampusStore.getState().projects,
      locale: usePreferencesStore.getState().language,
    });

    const flush = (): void => {
      timer = null;
      if (!world || !inited || disposed) return;
      world.sync(buildInput());
    };
    // Trailing throttle: at most one sync per window, always with fresh data.
    const schedule = (): void => {
      if (!inited || timer) return;
      timer = setTimeout(flush, SYNC_THROTTLE_MS);
    };
    syncNowRef.current = schedule;
    setEnterContext({
      select: (id) => selectRef.current(id),
      selectedId: () => selectedRef.current,
      label: (id) => {
        const s = sessionsRef.current.find((x) => x.id === id);
        return s
          ? sessionLabel(
              s,
              useCampusStore
                .getState()
                .sessions.find((c) => c.sessionId === id),
            )
          : id.slice(0, 8);
      },
    });

    const updateInput = (): void => {
      if (!world) return;
      const s = useWorldUiStore.getState();
      const blocked =
        s.panels.length > 0 ||
        s.opsOpen ||
        s.peerPopup !== null ||
        useAttentionStore.getState().focusPopup !== null;
      world.setInputEnabled(!blocked);
    };

    void (async () => {
      try {
        const { createWorld } = await import("@/engine/world/World");
        if (disposed) return;
        const prefs = usePreferencesStore.getState();
        const w = createWorld(canvas, {
          quality: prefs.graphicsQuality,
          graphics: prefs.graphics,
          cameraMode: useWorldUiStore.getState().cameraMode,
          isMobile: isMobileRef.current,
          assetBase: "/assets",
        });
        world = w;
        setWorld(w);
        w.setBranding?.(selectBranding(prefs));
        // Graphics menu: push settings into the live world as they change.
        teardown.push(
          usePreferencesStore.subscribe((st, prev) => {
            if (st.graphics !== prev.graphics) w.setGraphics?.(st.graphics);
          }),
          // Lobby neon sign: live name / tagline / logo / colour / flicker.
          usePreferencesStore.subscribe((st, prev) => {
            if (
              st.brandName !== prev.brandName ||
              st.brandTagline !== prev.brandTagline ||
              st.brandLogo !== prev.brandLogo ||
              st.brandNeonColor !== prev.brandNeonColor ||
              st.brandFlicker !== prev.brandFlicker
            )
              w.setBranding?.(selectBranding(st));
          }),
        );

        teardown.push(
          w.on("error", ({ message }) =>
            useWorldUiStore.getState().setError(message),
          ),
          w.on("interaction", (e) => useWorldUiStore.getState().setPrompt(e)),
          w.on("pose", (p) => useWorldUiStore.getState().setPose(p)),
          w.on("stats", (s) => useWorldUiStore.getState().setStats(s)),
          w.on("pointerLock", (l) =>
            useWorldUiStore.getState().setPointerLocked(l),
          ),
          w.on("cameraMode", (m) =>
            useWorldUiStore.getState().setCameraMode(m),
          ),
          w.on("fly", (f) => useWorldUiStore.getState().setFlying(f)),
          w.on("layout", (l) => useWorldUiStore.getState().setLayout(l)),
          w.on("action", ({ action, target, screenPos }) => {
            const store = useWorldUiStore.getState();
            if (action === "github") {
              const url = githubUrlOf(target);
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            } else if (action === "enter") {
              void enterSession(target.sessionId);
            } else if (isFactoryKind(target.kind)) {
              if (action === "inspect") store.openFactory(target);
            } else if (target.kind === "ops") {
              store.openOps(target.sessionId || null);
            } else if (action === "inspect") {
              store.openInspect(target);
            } else if (action === "popup" && target.kind === "character") {
              if (target.sessionId === selectedRef.current) {
                useAttentionStore
                  .getState()
                  .openFocusPopup(
                    target.agentId ?? "boss",
                    screenPos.x,
                    screenPos.y,
                  );
              } else {
                store.setPeerPopup({
                  sessionId: target.sessionId,
                  x: screenPos.x,
                  y: screenPos.y,
                });
              }
            }
          }),
          w.on("ready", () => useWorldUiStore.getState().setReady(true)),
        );

        await w.init();
        if (disposed) return;
        inited = true;
        useWorldUiStore.getState().setReady(true);
        w.sync(buildInput());
        updateInput();

        teardown.push(
          useCampusStore.subscribe((s, prev) => {
            if (
              s.sessions !== prev.sessions ||
              s.stats !== prev.stats ||
              s.projects !== prev.projects
            )
              schedule();
          }),
          // Control-room wall text follows the UI language.
          usePreferencesStore.subscribe((s, prev) => {
            if (s.language !== prev.language) schedule();
          }),
          useWorldUiStore.subscribe((s, prev) => {
            if (
              s.panels !== prev.panels ||
              s.peerPopup !== prev.peerPopup ||
              s.opsOpen !== prev.opsOpen
            )
              updateInput();
          }),
          useAttentionStore.subscribe((s, prev) => {
            if (s.focusPopup !== prev.focusPopup) updateInput();
          }),
        );
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        useWorldUiStore.getState().setError(message);
      }
    })();

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => world?.resize());
    });
    ro.observe(container);

    return () => {
      disposed = true;
      syncNowRef.current = null;
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      teardown.forEach((off) => off());
      setWorld(null);
      setEnterContext(null);
      world?.dispose();
      world = null;
      ui.reset();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-tour-id="game-canvas"
      className="absolute inset-0 overflow-hidden bg-slate-950"
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none outline-none"
        tabIndex={0}
      />
    </div>
  );
}
