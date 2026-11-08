"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { factoryTarget } from "@/engine/interaction/factoryTargets";
import { PANELS } from "@/components/world/hud/panels";
import { DeployPanel } from "@/components/world/hud/factory/DeployPanel";
import { LinePanel } from "@/components/world/hud/factory/LinePanel";
import { PrPanel } from "@/components/world/hud/factory/PrPanel";
import { StationPanel } from "@/components/world/hud/factory/StationPanel";
import { useFactoryData } from "@/components/world/hud/factory/useFactoryData";
import { PanelCard, Picker } from "./parts";

const NO_PROJECTS: never[] = [];

/**
 * The four factory panels in a responsive grid, driven by explicit targets
 * (no worldUiStore): project picker, PR and station choosers.
 */
export function FactoryTab({
  projectId,
  pr,
  onPick,
}: {
  projectId: string | undefined;
  pr: string | undefined;
  onPick: (patch: { project?: string; pr?: string }) => void;
}): ReactNode {
  const { t } = useTranslation();
  const projects = useCampusStore((s) => s.projects) ?? NO_PROJECTS;
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const base = useMemo(
    () => ({ projectId: project?.id, label: project?.name ?? "" }),
    [project?.id, project?.name],
  );
  const lineTarget = useMemo(
    () => (project ? factoryTarget("lineBoard", base) : null),
    [project, base],
  );
  const dockTarget = useMemo(
    () => (project ? factoryTarget("dock", base) : null),
    [project, base],
  );
  // Line model (same one the panels read) to offer PRs and a default station.
  const { data } = useFactoryData(lineTarget);
  const prNumbers = useMemo(
    () =>
      (data?.line.workpieces ?? [])
        .map((w) => w.prNumber)
        .filter((n): n is number => n !== undefined),
    [data],
  );
  const prNumber = Number(pr) || prNumbers[0];
  const prTarget = useMemo(
    () =>
      project && prNumber !== undefined
        ? factoryTarget("lanePlate", { ...base, prNumber })
        : null,
    [project, base, prNumber],
  );
  const station = data?.line.stations[0];
  const stationTarget = useMemo(
    () =>
      project && station
        ? factoryTarget("station", {
            ...base,
            checkName: station.name,
            label: station.name,
          })
        : null,
    [project, base, station],
  );

  if (projects.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">
        {t("factory.none")}
      </p>
    );

  const card = (
    id: "factoryLine" | "factoryPr" | "factoryStation" | "factoryDeploy",
    body: ReactNode,
    className = "",
  ): ReactNode => (
    <PanelCard
      title={t(PANELS[id].titleKey)}
      icon={PANELS[id].icon}
      className={className}
    >
      {body}
    </PanelCard>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Picker
          label={t("dashboard.pickProject")}
          value={project?.id ?? ""}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => onPick({ project: v, pr: undefined })}
          className="w-full sm:w-64"
        />
        {prNumbers.length > 0 && (
          <Picker
            label={t("hud.panel.factoryPr")}
            value={String(prNumber ?? "")}
            options={prNumbers.map((n) => ({
              value: String(n),
              label: `#${n}`,
            }))}
            onChange={(v) => onPick({ pr: v })}
            className="w-full sm:w-32"
          />
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        {card("factoryLine", <LinePanel target={lineTarget} />)}
        {card("factoryPr", <PrPanel target={prTarget} />)}
        {card("factoryStation", <StationPanel target={stationTarget} />)}
        {card("factoryDeploy", <DeployPanel target={dockTarget} />)}
      </div>
    </div>
  );
}
