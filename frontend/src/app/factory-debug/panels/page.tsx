"use client";

/**
 * Factory HUD panel sandbox (dev only): demo projects in campusStore and one
 * panel docked like the real HUD.
 *
 * Query params:
 *   panel=pr|station|line|deploy   which panel (default pr)
 *   project=0..3                   demo project index (default 0)
 *   pr=412                         PR number (default: first PR on lane 1)
 *   lane=0                         lane (pr panel, when pr is absent)
 *   check=name                     station check (default: first station)
 *   t=20000                        demo clock offset in ms (default 20000)
 *   w=tall                         force the bottom-sheet layout
 * Esc closes the panel.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { InteractionTarget } from "@/engine/contracts";
import {
  demoFactoryProjects,
  demoFactoryTick,
} from "@/engine/demo/demoFactory";
import { buildFactoryModel } from "@/engine/logic/factoryModel";
import { factoryTarget } from "@/engine/interaction/factoryTargets";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { HudPanelFrame } from "@/components/world/hud/HudPanel";
import { useHudKeys } from "@/components/world/hud/useHudKeys";
import { DeployPanel } from "@/components/world/hud/factory/DeployPanel";
import { LinePanel } from "@/components/world/hud/factory/LinePanel";
import { PrPanel } from "@/components/world/hud/factory/PrPanel";
import { StationPanel } from "@/components/world/hud/factory/StationPanel";

const NOW = Date.parse("2026-11-07T12:00:00Z");

function init(): InteractionTarget | null {
  const q = new URLSearchParams(window.location.search);
  const t0 = Number(q.get("t") ?? 20000) || 0;
  const base = demoFactoryProjects([], NOW, { projects: 4 });
  const projects = demoFactoryTick(base, NOW + t0);
  const idx = Math.max(
    0,
    Math.min(projects.length - 1, Number(q.get("project") ?? 0) || 0),
  );
  const project = projects[idx];
  useCampusStore.getState().setProjects(projects);
  const line = buildFactoryModel([project], [], NOW + t0).lines[0];
  const base_ = { projectId: project.id, label: project.name };
  const panel = q.get("panel") ?? "pr";
  if (panel === "line") return factoryTarget("lineBoard", base_);
  if (panel === "deploy") return factoryTarget("dock", base_);
  if (panel === "station") {
    const name = q.get("check") ?? line.stations[0]?.name ?? "";
    return factoryTarget("station", { ...base_, checkName: name, label: name });
  }
  const want = Number(q.get("pr"));
  const piece =
    line.workpieces.find((w) => want && w.prNumber === want) ??
    line.workpieces.find((w) => w.lane === (Number(q.get("lane") ?? 0) || 0));
  const prNumber = want || piece?.prNumber;
  return factoryTarget("workpiece", {
    ...base_,
    prNumber,
    lane: piece?.lane ?? undefined,
    label: `#${prNumber}`,
  });
}

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

export default function FactoryPanelsDebug(): ReactNode {
  useHudKeys();
  const [tall] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("w") === "tall",
  );
  const top = useWorldUiStore((s) => s.openPanel);

  useEffect(() => {
    const target = init();
    const ui = useWorldUiStore.getState();
    ui.setReady(true);
    if (target) ui.openFactory(target);
    return () => useWorldUiStore.getState().reset();
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-gradient-to-br from-slate-800 to-slate-950 font-sans">
      {top && top.startsWith("factory") && (
        <div
          className={
            tall
              ? "absolute inset-x-2 bottom-2 flex h-[55%] gap-2"
              : "absolute bottom-3 right-3 top-14 flex w-[420px] max-w-[calc(100%-24px)] flex-col gap-2"
          }
        >
          <HudPanelFrame id={top}>
            <Body id={top} />
          </HudPanelFrame>
        </div>
      )}
    </div>
  );
}
