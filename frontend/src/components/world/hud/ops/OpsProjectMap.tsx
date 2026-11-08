"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  STATUS_COLORS,
  type CampusProject,
  type CampusSession,
  type CheckState,
} from "@/engine/contracts";
import {
  layoutProjectMap,
  mapSessions,
  projectGroups,
  type MapDot,
  type P,
} from "@/engine/logic/projectMap";

const VB_W = 1000;
const VB_H = 430;

const CI_COLOR: Record<CheckState, string> = {
  success: "#22C55E",
  failure: "#EF4444",
  running: "#F59E0B",
  queued: "#94A3B8",
  cancelled: "#64748B",
  none: "#64748B",
};

const pathD = (pts: readonly P[]) =>
  pts
    .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

/** Subagent dot shuttling along its path (same timing as the wall's 3D dots). */
function Dot({ d }: { d: MapDot }): ReactNode {
  const dur = 1 / d.speed;
  return (
    <circle r={4.2} fill={d.color} stroke="#F8FAFC" strokeWidth={1.2}>
      <animateMotion
        dur={`${dur.toFixed(2)}s`}
        begin={`-${(d.phase * dur).toFixed(2)}s`}
        repeatCount="indefinite"
        path={pathD(d.path)}
        keyPoints="0.06;0.94;0.06"
        keyTimes="0;0.5;1"
        calcMode="spline"
        keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
      />
    </circle>
  );
}

/**
 * Transit-style project map (same pure layout as the control-room wall):
 * one line per project, a node per session coloured by status, subagents as
 * dots moving along the lines into the OPS hub.
 */
export function OpsProjectMap({
  campus,
  projects,
  labels,
  className = "",
}: {
  campus: readonly CampusSession[];
  projects?: readonly CampusProject[] | null;
  labels?: ReadonlyMap<string, string>;
  className?: string;
}): ReactNode {
  const { t } = useTranslation();
  const map = useMemo(
    () =>
      layoutProjectMap(
        projectGroups(campus, projects, labels),
        mapSessions(campus),
        VB_W,
        VB_H,
      ),
    [campus, projects, labels],
  );
  const live = map.lines.reduce((s, l) => s + l.live, 0);
  return (
    <section className={className}>
      <div className="flex flex-wrap items-baseline gap-x-2 px-4 pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
          {t("ops.map")}
        </h3>
        <span className="text-xs text-slate-500">
          {t("ops.map.sub", {
            projects: map.lines.length + map.moreLines,
            live,
          })}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          {(
            [
              ["needs_you", "hud.status.needs_you"],
              ["working", "hud.status.working"],
              ["done", "hud.status.done"],
            ] as const
          ).map(([s, k]) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: STATUS_COLORS[s] }}
              />
              {t(k)}
            </span>
          ))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="mt-1 block h-auto w-full"
        role="img"
        aria-label={t("ops.map")}
      >
        {map.lines.length === 0 && (
          <text
            x={VB_W / 2}
            y={VB_H / 2}
            textAnchor="middle"
            className="fill-slate-500 text-[22px]"
          >
            {t("ops.map.empty")}
          </text>
        )}
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {map.lines.map((l) => (
            <path
              key={`c${l.id}`}
              d={pathD(l.points)}
              stroke="#070B12"
              strokeWidth={13}
            />
          ))}
          {map.lines.map((l) => (
            <path
              key={l.id}
              d={pathD(l.points)}
              stroke={l.color}
              strokeOpacity={l.live ? 1 : 0.45}
              strokeWidth={6.5}
            />
          ))}
        </g>
        {map.lines.map((l) => {
          const p = l.points[0];
          return (
            <g key={`s${l.id}`}>
              <circle cx={p.x} cy={p.y} r={11} fill={l.color} />
              <circle cx={p.x} cy={p.y} r={7.5} fill="#F8FAFC" />
              <text
                x={p.x - 6}
                y={p.y - 19}
                className="fill-slate-100 text-[19px] font-semibold"
              >
                {l.name}
                {l.ci && (
                  <tspan dx={10} fill={CI_COLOR[l.ci]} className="text-[14px]">
                    {t(`ops.ci.${l.ci}`)}
                  </tspan>
                )}
                {l.openPrs > 0 && (
                  <tspan dx={8} fill="#A78BFA" className="text-[14px]">
                    {t("ops.prs", { n: l.openPrs })}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
        {map.nodes.map((n) => (
          <g key={n.sessionId}>
            {n.status === "needs_you" && (
              <circle
                cx={n.x}
                cy={n.y}
                r={17}
                fill={STATUS_COLORS.needs_you}
                opacity={0.25}
              >
                <animate
                  attributeName="r"
                  values="12;19;12"
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
            <circle cx={n.x} cy={n.y} r={10} fill="#F8FAFC" />
            <circle cx={n.x} cy={n.y} r={7} fill={STATUS_COLORS[n.status]} />
            <text
              x={n.x}
              y={n.y + 26}
              textAnchor="middle"
              className="fill-slate-400 text-[13px]"
            >
              {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
            </text>
          </g>
        ))}
        {map.dots.map((d) => (
          <Dot key={d.id} d={d} />
        ))}
        <g>
          <circle
            cx={map.hub.x}
            cy={map.hub.y}
            r={map.hub.r * 1.35}
            fill="#38BDF8"
            opacity={0.12}
          />
          <circle cx={map.hub.x} cy={map.hub.y} r={map.hub.r} fill="#F8FAFC" />
          <circle
            cx={map.hub.x}
            cy={map.hub.y}
            r={map.hub.r * 0.78}
            fill="#0B111B"
          />
          <text
            x={map.hub.x}
            y={map.hub.y + 7}
            textAnchor="middle"
            className="fill-sky-400 text-[20px] font-bold"
          >
            OPS
          </text>
        </g>
        {(map.moreLines > 0 || map.moreNodes > 0) && (
          <text x={16} y={VB_H - 10} className="fill-slate-500 text-[14px]">
            {t("ops.map.more", {
              projects: map.moreLines,
              sessions: map.moreNodes,
            })}
          </text>
        )}
      </svg>
    </section>
  );
}
