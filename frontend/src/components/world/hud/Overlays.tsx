"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { MousePointerClick } from "lucide-react";
import { useTranslation, type TranslationKey } from "@/hooks/useTranslation";
import { useWorldUiStore, selectPanels } from "@/stores/worldUiStore";
import { useCampusStore } from "@/stores/campusStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { STATUS_COLORS, type PlayerPose } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import { campusStatus, labelMap } from "../sessionMeta";
import { getWorld } from "../worldRef";
import { GLASS, LABEL } from "./glass";
import { usePrefersReducedMotion } from "./reducedMotion";
import { Keycap } from "./Keycap";
import { HINT_ORDER, PANELS } from "./panels";
import type { ConnectionStatus } from "./connectionStatus";

// ============================================================================
// CROSSHAIR
// ============================================================================

export function Crosshair({ isMobile }: { isMobile: boolean }): ReactNode {
  const targeted = useWorldUiStore((s) => s.prompt !== null);
  const locked = useWorldUiStore((s) => s.pointerLocked);
  const panelOpen = useWorldUiStore((s) => s.panels.length > 0);
  if (isMobile || panelOpen) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
    >
      <div
        className={`rounded-full transition-all duration-200 ease-out ${
          targeted
            ? "h-7 w-7 border-2 border-[#D97757] bg-[#D97757]/10 shadow-[0_0_18px_rgba(217,119,87,0.55)]"
            : `h-1.5 w-1.5 bg-white/90 shadow-[0_0_6px_rgba(0,0,0,0.8)] ${
                locked ? "" : "opacity-50"
              }`
        }`}
      />
    </div>
  );
}

// ============================================================================
// INTERACTION PROMPT
// ============================================================================

export function InteractionPrompt(): ReactNode {
  const { t } = useTranslation();
  const prompt = useWorldUiStore((s) => s.prompt);
  const panelOpen = useWorldUiStore((s) => s.panels.length > 0);
  if (!prompt || panelOpen) return null;
  const { target, actions } = prompt;
  return (
    <div
      className={`pointer-events-none absolute bottom-24 left-1/2 max-w-[92%] -translate-x-1/2 rounded-2xl px-4 py-2.5 ${GLASS} animate-[hud-rise_160ms_ease-out]`}
    >
      <div className="mb-1.5 flex items-center justify-center gap-2">
        <span className={LABEL}>
          {t(`world.kind.${target.kind}` as TranslationKey)}
        </span>
        <span className="h-1 w-1 rounded-full bg-slate-600" />
        <span className="max-w-[16rem] truncate text-sm font-semibold text-white">
          {target.kind === "lift"
            ? t(target.stop === 1 ? "world.lift.l1" : "world.lift.g")
            : target.roomLabel}
        </span>
      </div>
      {target.kind === "lift" && (
        <div className="mb-1.5 text-center text-xs text-slate-300">
          {t("world.lift.hint")}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        {actions.map((a) => (
          <span
            key={a.id}
            className="flex items-center gap-1.5 text-xs text-slate-200"
          >
            <Keycap accent>{a.key}</Keycap>
            {t(a.labelKey as TranslationKey)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// LOCATION CHIP (top-left)
// ============================================================================

function zoneLabel(
  zone: PlayerPose["zone"],
  labels: Map<string, string>,
  t: (k: TranslationKey) => string,
): string | null {
  switch (zone.kind) {
    case "lobby":
      return t("world.zone.lobby");
    case "hall":
      return t("world.zone.hall");
    case "control":
      return t("world.zone.control");
    case "room":
      return labels.get(zone.sessionId) ?? zone.sessionId.slice(0, 8);
    case "factory":
      return t("hud.minimap.factory");
    case "cell":
      return t("hud.minimap.cell");
    case "dock":
      return t("hud.minimap.dock");
    case "stair":
      return t("hud.minimap.stairs");
    case "entrance":
      return t("hud.area.entrance");
    case "balcony":
      return t("hud.minimap.cell");
    default:
      return t("world.zone.outside");
  }
}

const FACTORY_KINDS = new Set([
  "factory",
  "cell",
  "dock",
  "stair",
  "balcony",
  "entrance",
]);

function isFactoryZone(zone: PlayerPose["zone"]): boolean {
  return FACTORY_KINDS.has(zone.kind);
}

export function LocationChip({ sessions }: { sessions: Session[] }): ReactNode {
  const { t } = useTranslation();
  const zone = useWorldUiStore((s) => s.pose?.zone ?? null);
  const flying = useWorldUiStore((s) => s.flying);
  const roomId = zone?.kind === "room" ? zone.sessionId : null;
  const projectName = useWorldUiStore((s) => {
    const z = s.pose?.zone;
    const id =
      z?.kind === "room"
        ? z.projectId
        : z?.kind === "cell" || z?.kind === "balcony"
          ? z.projectId
          : undefined;
    if (!id) return null;
    return s.layout?.projects.find((p) => p.projectId === id)?.name ?? null;
  });
  const campus = useCampusStore((s) =>
    roomId ? s.sessions.find((x) => x.sessionId === roomId) : undefined,
  );
  const allCampus = useCampusStore((s) => s.sessions);
  const labels = useMemo(
    () => labelMap(sessions, allCampus),
    [sessions, allCampus],
  );
  if (!zone) return null;
  const pod = zoneLabel(zone, labels, t);
  // In a team room: "project · pod session" (the pod under the player).
  const inFactory = isFactoryZone(zone);
  const where =
    projectName && pod && pod !== projectName
      ? inFactory
        ? `${pod} · ${projectName}`
        : `${projectName} · ${pod}`
      : pod;
  // "Level 1 · Offices" / "Ground · Factory" / "Ground · Dock".
  const level = inFactory
    ? `${t("hud.level.ground")} · ${t(zone.kind === "dock" ? "hud.minimap.dock" : zone.kind === "entrance" ? "hud.area.entrance" : "hud.area.factory")}`
    : `${t("hud.level.one")} · ${t("hud.area.offices")}`;
  // Free-fly camera: "Fly · <zone below the camera>".
  const label = flying ? `${t("hud.fly.label")} · ${where}` : where;
  return (
    <div
      className={`pointer-events-none flex items-center gap-2.5 rounded-2xl px-3.5 py-2 ${GLASS}`}
    >
      {roomId ? (
        <span
          className="h-2 w-2 rounded-full"
          style={{
            backgroundColor: STATUS_COLORS[campusStatus(campus)],
            boxShadow: `0 0 8px ${STATUS_COLORS[campusStatus(campus)]}`,
          }}
        />
      ) : (
        <span className="h-2 w-2 rounded-full bg-[#D97757]" />
      )}
      <div className="flex flex-col leading-tight">
        <span className={LABEL}>{level}</span>
        <span className="max-w-[14rem] truncate text-sm font-semibold text-white">
          {label}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// STATS CHIP (top-right)
// ============================================================================

export function StatsChip(): ReactNode {
  const { t } = useTranslation();
  const stats = useWorldUiStore((s) => s.stats);
  const showFps = usePreferencesStore((s) => s.graphics.showFps);
  const auto = usePreferencesStore((s) => s.graphics.preset === "auto");
  const connected = useCampusStore((s) => s.connected);
  return (
    <div
      className={`pointer-events-none flex items-center gap-3 rounded-2xl px-3.5 py-2 font-mono text-xs text-slate-300 ${GLASS}`}
    >
      {stats && showFps ? (
        <>
          <span>
            <span className="text-white">{Math.round(stats.fps)}</span> fps
          </span>
          <span className="uppercase text-slate-400">
            {auto ? "auto · " : ""}
            {stats.effective ??
              t(stats.tier === "high" ? "hud.tier.high" : "hud.tier.low")}
          </span>
          <span className="hidden sm:inline">
            <span className="text-white">{stats.drawCalls}</span> dc
          </span>
        </>
      ) : null}
      <span
        title={connected ? t("hud.connected") : t("hud.disconnected")}
        className={`h-2 w-2 rounded-full ${
          connected
            ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
            : "bg-rose-500"
        }`}
      />
    </div>
  );
}

// ============================================================================
// KEY HINTS (bottom-left)
// ============================================================================

export function KeyHints({ portrait }: { portrait: boolean }): ReactNode {
  const { t } = useTranslation();
  const panels = useWorldUiStore(selectPanels);
  const toggle = useWorldUiStore((s) => s.toggle);
  const cameraMode = useWorldUiStore((s) => s.cameraMode);
  const flying = useWorldUiStore((s) => s.flying);
  // The bottom sheet covers this row on tall viewports.
  if (portrait && panels.length > 0) return null;
  return (
    <div
      className={`flex max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-2 ${GLASS}`}
    >
      {HINT_ORDER.map((id) => {
        const meta = PANELS[id];
        if (!meta.hintKey) return null;
        const active = panels.includes(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              active ? "text-[#f0a58b]" : "text-slate-400 hover:text-white"
            }`}
          >
            <Keycap accent={active}>{meta.keyLabel}</Keycap>
            {t(meta.hintKey)}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => useWorldUiStore.getState().toggleOps()}
        className="flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-white"
      >
        <Keycap>B</Keycap>
        {t("hud.keys.ops")}
      </button>
      <span className="flex items-center gap-1.5 text-xs text-slate-400">
        <Keycap>V</Keycap>
        {t(cameraMode === "fp" ? "hud.camera.fp" : "hud.camera.tp")}
      </span>
      <button
        type="button"
        onClick={() => getWorld()?.toggleFly()}
        className={`flex items-center gap-1.5 text-xs transition-colors ${
          flying ? "text-[#f0a58b]" : "text-slate-400 hover:text-white"
        }`}
      >
        <Keycap accent={flying}>N</Keycap>
        {t(flying ? "hud.fly.on" : "hud.fly.off")}
      </button>
    </div>
  );
}

// ============================================================================
// CLICK TO LOOK
// ============================================================================

export function ClickToLook({ isMobile }: { isMobile: boolean }): ReactNode {
  const { t } = useTranslation();
  const ready = useWorldUiStore((s) => s.ready);
  const locked = useWorldUiStore((s) => s.pointerLocked);
  const panelOpen = useWorldUiStore((s) => s.panels.length > 0);
  const cardOpen = useWorldUiStore((s) => s.controlsOpen);
  if (isMobile || !ready || locked || panelOpen || cardOpen) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2">
      <div
        className={`flex flex-col items-center gap-1.5 rounded-2xl px-6 py-4 text-center ${GLASS} animate-[hud-pulse_2.4s_ease-in-out_infinite]`}
      >
        <MousePointerClick className="h-5 w-5 text-[#D97757]" />
        <span className="text-sm font-semibold text-white">
          {t("world.clickToLook")}
        </span>
        <span className="text-xs text-slate-400">
          {t("world.clickToLookHint")}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// ENTER BANNER (top-centre, auto-hides)
// ============================================================================

/** ~250 ms fade-to-black over a teleport; reduced motion gets an instant cut. */
export function TeleportFade(): ReactNode {
  const seq = useWorldUiStore((s) => s.fadeSeq);
  const reduce = usePrefersReducedMotion();
  if (seq === 0 || reduce) return null;
  return (
    <div
      key={seq}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[60] bg-black opacity-0 animate-[hud-fade_250ms_ease-in-out_forwards]"
    />
  );
}

export function EnterBanner(): ReactNode {
  const banner = useWorldUiStore((s) => s.banner);
  const clearBanner = useWorldUiStore((s) => s.clearBanner);
  useEffect(() => {
    if (!banner) return;
    const id = banner.id;
    const timer = setTimeout(() => clearBanner(id), 2000);
    return () => clearTimeout(timer);
  }, [banner, clearBanner]);
  if (!banner) return null;
  return (
    <div
      key={banner.id}
      role="status"
      className={`pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 animate-[hud-sheet-up_200ms_ease-out] rounded-2xl px-5 py-2.5 text-sm font-semibold text-white ${GLASS}`}
    >
      {banner.text}
    </div>
  );
}

// ============================================================================
// CONNECTION BANNER (top-centre; the feed is down or frozen)
// ============================================================================

function clock(ms: number | null): string {
  return ms === null
    ? "—"
    : new Date(ms).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function ConnectionBanner({
  status,
}: {
  status: ConnectionStatus;
}): ReactNode {
  const { t } = useTranslation();
  if (status.kind === "ok") return null;
  const time = clock(status.since);
  const text =
    status.kind === "reconnecting"
      ? t("conn.reconnecting", { time })
      : status.kind === "stalled"
        ? t("conn.stalled", { time })
        : status.kind === "tooMany"
          ? t("conn.tooMany")
          : status.kind === "origin"
            ? t("conn.origin")
            : t("conn.connecting");
  return (
    <div
      role="alert"
      className={`pointer-events-none absolute left-1/2 top-3 z-50 max-w-[calc(100%-24px)] -translate-x-1/2 rounded-2xl border border-amber-400/50 px-5 py-2.5 text-center text-sm font-semibold text-amber-200 ${GLASS}`}
    >
      {text}
    </div>
  );
}
