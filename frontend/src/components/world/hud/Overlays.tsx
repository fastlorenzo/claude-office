"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { MousePointerClick } from "lucide-react";
import { useTranslation, type TranslationKey } from "@/hooks/useTranslation";
import { useWorldUiStore, selectPanels } from "@/stores/worldUiStore";
import { useCampusStore } from "@/stores/campusStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { STATUS_COLORS, type Zone } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import { campusStatus, labelMap } from "../sessionMeta";
import { GLASS, LABEL } from "./glass";
import { Keycap } from "./Keycap";
import { HINT_ORDER, PANELS } from "./panels";

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
          {target.roomLabel}
        </span>
      </div>
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
  zone: Zone,
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
    default:
      return t("world.zone.outside");
  }
}

export function LocationChip({ sessions }: { sessions: Session[] }): ReactNode {
  const { t } = useTranslation();
  const zone = useWorldUiStore((s) => s.pose?.zone ?? null);
  const roomId = zone?.kind === "room" ? zone.sessionId : null;
  const projectName = useWorldUiStore((s) => {
    const z = s.pose?.zone;
    if (z?.kind !== "room" || !z.projectId) return null;
    return (
      s.layout?.projects.find((p) => p.projectId === z.projectId)?.name ?? null
    );
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
  const label =
    projectName && pod && pod !== projectName ? `${projectName} · ${pod}` : pod;
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
        <span className={LABEL}>
          {roomId ? t("world.enter.current") : t("hud.location")}
        </span>
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
      className={`pointer-events-none flex items-center gap-3 rounded-2xl px-3.5 py-2 font-mono text-[11px] text-slate-300 ${GLASS}`}
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
            tabIndex={-1}
            onClick={() => toggle(id)}
            className={`flex items-center gap-1.5 text-[11px] transition-colors ${
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
        tabIndex={-1}
        onClick={() => useWorldUiStore.getState().toggleOps()}
        className="flex items-center gap-1.5 text-[11px] text-slate-400 transition-colors hover:text-white"
      >
        <Keycap>B</Keycap>
        {t("hud.keys.ops")}
      </button>
      <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <Keycap>V</Keycap>
        {t(cameraMode === "fp" ? "hud.camera.fp" : "hud.camera.tp")}
      </span>
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
  if (isMobile || !ready || locked || panelOpen) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2">
      <div
        className={`flex flex-col items-center gap-1.5 rounded-2xl px-6 py-4 text-center ${GLASS} animate-[hud-pulse_2.4s_ease-in-out_infinite]`}
      >
        <MousePointerClick className="h-5 w-5 text-[#D97757]" />
        <span className="text-sm font-semibold text-white">
          {t("world.clickToLook")}
        </span>
        <span className="text-[11px] text-slate-400">
          {t("world.clickToLookHint")}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// ENTER BANNER (top-centre, auto-hides)
// ============================================================================

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
