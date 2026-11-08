"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  SessionNavProvider,
  WORLD_SESSION_NAV,
} from "@/components/shared/sessionNav";
import { GitStatusPanel } from "@/components/layout/GitStatusPanel";
import { ConversationHistory } from "@/components/layout/ConversationHistory";
import { EventLog } from "@/components/layout/EventLog";
import { AgentStatus } from "@/components/game/AgentStatus";
import {
  selectPanels,
  useWorldUiStore,
  type HudPanel,
} from "@/stores/worldUiStore";
import {
  ClickToLook,
  Crosshair,
  InteractionPrompt,
  KeyHints,
  LocationChip,
  StatsChip,
  EnterBanner,
  TeleportFade,
  ConnectionBanner,
} from "./hud/Overlays";
import { useCampusConnection } from "./hud/connectionStatus";
import { HudPanelFrame } from "./hud/HudPanel";
import { GraphicsPanel } from "./hud/GraphicsPanel";
import { HelpPanel } from "./hud/HelpPanel";
import { InspectPanel } from "./hud/InspectPanel";
import { PrPanel } from "./hud/factory/PrPanel";
import { StationPanel } from "./hud/factory/StationPanel";
import { LinePanel } from "./hud/factory/LinePanel";
import { DeployPanel } from "./hud/factory/DeployPanel";
import { Minimap } from "./hud/Minimap";
import { OverviewStrip } from "./hud/OverviewStrip";
import { SessionsPanel, type SessionHandlers } from "./hud/SessionsPanel";
import { useHudKeys } from "./hud/useHudKeys";
import { PANELS } from "./hud/panels";
import { OpsOverlay } from "./hud/ops/OpsOverlay";
import { ControlsCard } from "./hud/ControlsCard";
import { useApplyReducedMotion } from "./hud/reducedMotion";

export interface WorldHudProps extends SessionHandlers {
  isMobile: boolean;
}

// ----------------------------------------------------------------------------
// Orientation: tall viewports dock panels as a bottom sheet, wide ones to the
// right. Subscribed via matchMedia so it never causes effect-driven setState.
// ----------------------------------------------------------------------------

const PORTRAIT_QUERY = "(orientation: portrait)";

function subscribePortrait(cb: () => void): () => void {
  const mq = window.matchMedia(PORTRAIT_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function usePortrait(): boolean {
  return useSyncExternalStore(
    subscribePortrait,
    () => window.matchMedia(PORTRAIT_QUERY).matches,
    () => false,
  );
}

function PanelBody({
  id,
  props,
}: {
  id: HudPanel;
  props: WorldHudProps;
}): ReactNode {
  switch (id) {
    case "sessions":
      return (
        <HudPanelFrame id={id}>
          <SessionsPanel {...props} />
        </HudPanelFrame>
      );
    case "git":
      return (
        <HudPanelFrame id={id} flatten>
          <GitStatusPanel />
        </HudPanelFrame>
      );
    case "conversation":
      return (
        <HudPanelFrame id={id} flatten>
          <ConversationHistory />
        </HudPanelFrame>
      );
    case "events":
      return (
        <HudPanelFrame id={id} flatten>
          <EventLog />
        </HudPanelFrame>
      );
    case "agents":
      return (
        <HudPanelFrame id={id} flatten>
          <AgentStatus />
        </HudPanelFrame>
      );
    case "minimap":
      return (
        <HudPanelFrame id={id}>
          <Minimap sessions={props.sessions} />
        </HudPanelFrame>
      );
    case "help":
      return (
        <HudPanelFrame id={id}>
          <HelpPanel />
        </HudPanelFrame>
      );
    case "graphics":
      return (
        <HudPanelFrame id={id}>
          <GraphicsPanel />
        </HudPanelFrame>
      );
    case "inspect":
      return (
        <HudPanelFrame id={id}>
          <InspectPanel sessions={props.sessions} />
        </HudPanelFrame>
      );
    case "console":
      // Phase 1 stand-in: the Session Console replaces this body in phase 2.
      return (
        <HudPanelFrame id={id} flatten>
          <EventLog />
        </HudPanelFrame>
      );
    case "factoryPr":
      return (
        <HudPanelFrame id={id}>
          <PrPanel />
        </HudPanelFrame>
      );
    case "factoryStation":
      return (
        <HudPanelFrame id={id}>
          <StationPanel />
        </HudPanelFrame>
      );
    case "factoryLine":
      return (
        <HudPanelFrame id={id}>
          <LinePanel />
        </HudPanelFrame>
      );
    case "factoryDeploy":
      return (
        <HudPanelFrame id={id}>
          <DeployPanel />
        </HudPanelFrame>
      );
  }
}

/** Debug: `?hud=console|ops|events|sessions|...` opens it once the world is ready. */
function useHudQueryParam(sessionId: string): void {
  const ready = useWorldUiStore((s) => s.ready);
  useEffect(() => {
    if (!ready) return;
    const want = new URLSearchParams(window.location.search).get("hud");
    if (!want) return;
    const ui = useWorldUiStore.getState();
    if (want === "ops") ui.openOps();
    else if (want === "console") {
      if (sessionId) ui.openConsole(sessionId);
    } else if (want in PANELS) ui.open(want as HudPanel);
    // Once per ready, not on every session change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

function WorldHudBody(props: WorldHudProps): ReactNode {
  useHudKeys(props.sessionId);
  useHudQueryParam(props.sessionId);
  useApplyReducedMotion();
  const portrait = usePortrait();
  const panels = useWorldUiStore(selectPanels);
  const ready = useWorldUiStore((s) => s.ready);
  const sheet = useWorldUiStore(
    (s) => s.consolePresentation === "sheet" && s.panels.includes("console"),
  );
  const { isMobile } = props;

  if (!ready) return null;

  const docked = panels.length > 0;

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden font-sans">
      <Crosshair isMobile={isMobile} />
      <ClickToLook isMobile={isMobile} />
      <ControlsCard isMobile={isMobile} />

      <div className="absolute left-3 top-3">
        <LocationChip sessions={props.sessions} />
      </div>
      <div className="absolute right-3 top-3">
        <StatsChip />
      </div>

      <OverviewStrip sessions={props.sessions} portrait={portrait} />

      <InteractionPrompt />
      <EnterBanner />
      <TeleportFade />

      {!isMobile && (
        <div
          className="pointer-events-auto absolute bottom-3 left-16"
          style={{
            maxWidth:
              docked && !portrait ? "calc(100% - 508px)" : "calc(100% - 76px)",
          }}
        >
          <KeyHints portrait={portrait} />
        </div>
      )}

      {docked && !sheet && (
        <div
          className={
            portrait
              ? "absolute inset-x-2 bottom-2 flex h-[45%] gap-2 animate-[hud-sheet-up_200ms_ease-out]"
              : "absolute bottom-3 right-3 top-14 flex w-[420px] max-w-[calc(100%-24px)] flex-col gap-2 animate-[hud-sheet-left_200ms_ease-out]"
          }
        >
          {panels.map((id) => (
            <PanelBody key={id} id={id} props={props} />
          ))}
        </div>
      )}

      <OpsOverlay sessions={props.sessions} />

      {sheet && (
        <div className="absolute inset-x-2 bottom-2 top-12 z-50 flex animate-[hud-sheet-up_200ms_ease-out]">
          <PanelBody id="console" props={props} />
        </div>
      )}
    </div>
  );
}

/** The HUD, dimmed with a banner while the campus feed is down or frozen (D2). */
export function WorldHud(props: WorldHudProps): ReactNode {
  const conn = useCampusConnection();
  return (
    <SessionNavProvider value={WORLD_SESSION_NAV}>
      <ConnectionBanner status={conn} />
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${
          conn.kind === "ok" ? "" : "opacity-60"
        }`}
      >
        <WorldHudBody {...props} />
      </div>
    </SessionNavProvider>
  );
}
