"use client";

import { useSyncExternalStore, type ReactNode } from "react";
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
import { OpsOverlay } from "./hud/ops/OpsOverlay";

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

function WorldHudBody(props: WorldHudProps): ReactNode {
  useHudKeys();
  const portrait = usePortrait();
  const panels = useWorldUiStore(selectPanels);
  const ready = useWorldUiStore((s) => s.ready);
  const { isMobile } = props;

  if (!ready) return null;

  const docked = panels.length > 0;

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden font-sans">
      <Crosshair isMobile={isMobile} />
      <ClickToLook isMobile={isMobile} />

      <div className="absolute left-3 top-3">
        <LocationChip sessions={props.sessions} />
      </div>
      <div className="absolute right-3 top-3">
        <StatsChip />
      </div>

      <OverviewStrip sessions={props.sessions} portrait={portrait} />

      <InteractionPrompt />
      <EnterBanner />

      {!isMobile && (
        <div
          className="pointer-events-auto absolute bottom-3 left-3"
          style={{
            maxWidth:
              docked && !portrait ? "calc(100% - 464px)" : "calc(100% - 24px)",
          }}
        >
          <KeyHints portrait={portrait} />
        </div>
      )}

      {docked && (
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
    </div>
  );
}

/** The HUD, dimmed with a banner while the campus feed is down or frozen (D2). */
export function WorldHud(props: WorldHudProps): ReactNode {
  const conn = useCampusConnection();
  return (
    <>
      <ConnectionBanner status={conn} />
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${
          conn.kind === "ok" ? "" : "opacity-60"
        }`}
      >
        <WorldHudBody {...props} />
      </div>
    </>
  );
}
