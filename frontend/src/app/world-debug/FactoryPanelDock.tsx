"use client";

/**
 * world-debug: the factory HUD panel the World opened (F on a workpiece /
 * station / lane / board / dock), docked like the real HUD. Data comes from
 * campusStore (filled by the page from the feed).
 */
import type { ReactNode } from "react";
import { HudPanelFrame } from "@/components/world/hud/HudPanel";
import { DeployPanel } from "@/components/world/hud/factory/DeployPanel";
import { LinePanel } from "@/components/world/hud/factory/LinePanel";
import { PrPanel } from "@/components/world/hud/factory/PrPanel";
import { StationPanel } from "@/components/world/hud/factory/StationPanel";
import { useWorldUiStore } from "@/stores/worldUiStore";

function Body({ id }: { id: string }): ReactNode {
  switch (id) {
    case "factoryPr":
      return <PrPanel />;
    case "factoryStation":
      return <StationPanel />;
    case "factoryLine":
      return <LinePanel />;
    default:
      return <DeployPanel />;
  }
}

export function FactoryPanelDock(): ReactNode {
  const top = useWorldUiStore((s) => s.openPanel);
  if (!top || !top.startsWith("factory")) return null;
  return (
    <div className="absolute bottom-3 right-3 top-14 flex w-[420px] max-w-[calc(100%-24px)] flex-col gap-2">
      <HudPanelFrame id={top}>
        <Body id={top} />
      </HudPanelFrame>
    </div>
  );
}
