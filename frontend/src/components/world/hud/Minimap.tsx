"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { STATUS_COLORS } from "@/engine/contracts";
import {
  allStairs,
  buildFactoryLayout,
  type FactoryLayout,
} from "@/engine/layout/factoryLayout";
import type { Session } from "@/hooks/useSessions";
import { campusStatus, labelMap } from "../sessionMeta";
import { getWorld } from "../worldRef";
import { clip, sessionHeadline } from "./sessionGlance";

type Level = "office" | "factory";
const FACTORY_ZONES = new Set(["factory", "cell", "dock", "stair"]);

/** Fast-travel targets on the factory floor (World.teleport handles these). */
export type FactoryTeleport = { factoryCell: string } | { factoryDock: true };

/**
 * Top-down SVG of the building. World +Z points up the screen (lobby at the
 * bottom), +X to the right. Click a room to fast-travel to its door.
 */
export function Minimap({ sessions }: { sessions: Session[] }): ReactNode {
  const { t } = useTranslation();
  const layout = useWorldUiStore((s) => s.layout);
  const pose = useWorldUiStore((s) => s.pose);
  const campus = useCampusStore((s) => s.sessions);
  const close = useWorldUiStore((s) => s.close);

  const [pick, setPick] = useState<Level | null>(null);
  const factory = useMemo<FactoryLayout | null>(
    () => (layout ? buildFactoryLayout(layout) : null),
    [layout],
  );
  // Auto: follow the player's level until a toggle is chosen.
  const auto: Level =
    pose && FACTORY_ZONES.has(pose.zone.kind) ? "factory" : "office";
  const level: Level = pick ?? auto;

  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  const objectives = useMemo(
    () => new Map(campus.map((c) => [c.sessionId, sessionHeadline(c)])),
    [campus],
  );
  const status = useMemo(
    () => new Map(campus.map((c) => [c.sessionId, campusStatus(c)])),
    [campus],
  );

  if (!layout) {
    return (
      <p className="p-6 text-center text-sm text-slate-400">
        {t("hud.minimap.loading")}
      </p>
    );
  }

  const pad = 2;
  const { min, max } = layout.bounds;
  const x0 = min.x - pad;
  const w = max.x - min.x + pad * 2;
  const zTop = max.z + pad;
  const h = max.z - min.z + pad * 2;
  // world (x, z) -> svg (x, -z)
  const sx = (x: number): number => x;
  const sz = (z: number): number => -z;

  const { lobby, hall, controlRoom } = layout;
  const travel = (
    to: { sessionId: string } | { projectId: string } | "lobby" | "control",
  ): void => {
    getWorld()?.teleport(to);
    close("minimap");
  };
  const travelFactory = (to: FactoryTeleport): void => {
    // Same teleport entry point as the office targets (World widens its union).
    (
      getWorld() as unknown as { teleport(t: FactoryTeleport): void } | null
    )?.teleport(to);
    close("minimap");
  };

  const toggle = (
    <div
      className="absolute left-3 top-3 z-10 flex gap-1 text-xs"
      role="group"
      aria-label={t("hud.minimap.level")}
    >
      {(["office", "factory"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={level === l}
          onClick={() => setPick(l)}
          className={`rounded px-2 py-1 ${
            level === l
              ? "bg-slate-600 text-white"
              : "bg-slate-800 text-slate-300 hover:bg-slate-700"
          }`}
        >
          {t(l === "office" ? "hud.minimap.office" : "hud.minimap.factory")}
        </button>
      ))}
    </div>
  );

  if (level === "factory" && factory) {
    const fb = factory.bounds;
    const fx0 = fb.min.x - pad;
    const fw = fb.max.x - fb.min.x + pad * 2;
    const fzTop = fb.max.z + pad;
    const fh = fb.max.z - fb.min.z + pad * 2;
    const rect = (r: { x0: number; x1: number; z0: number; z1: number }) => ({
      x: r.x0,
      y: -r.z1,
      width: r.x1 - r.x0,
      height: r.z1 - r.z0,
    });
    const ml = factory.mainLine;
    return (
      <div className="relative flex h-full min-h-[240px] items-center justify-center p-3">
        {toggle}
        <svg
          viewBox={`${fx0} ${-fzTop} ${fw} ${fh}`}
          className="h-full max-h-full w-full max-w-full"
          role="img"
          aria-label={t("hud.minimap.factory")}
        >
          {factory.cells.map((c) => {
            const name =
              layout.projects.find((p) => p.projectId === c.projectId)?.name ??
              c.projectId;
            return (
              <g
                key={c.projectId}
                className="cursor-pointer"
                onClick={() => travelFactory({ factoryCell: c.projectId })}
                role="button"
                aria-label={`${t("hud.minimap.cell")}: ${name}`}
              >
                <title>{name}</title>
                <rect
                  {...rect(c.rect)}
                  fill="#3b82f61a"
                  stroke="#60a5fa"
                  strokeWidth={0.14}
                  rx={0.3}
                />
                {c.lanes.map((ln) => (
                  <line
                    key={ln.index}
                    x1={ln.intakeX}
                    x2={ln.gateX}
                    y1={-ln.z}
                    y2={-ln.z}
                    stroke="#94a3b8"
                    strokeWidth={0.2}
                    strokeLinecap="round"
                  />
                ))}
                <line
                  x1={c.trunk.x}
                  x2={c.trunk.x}
                  y1={-c.trunk.z0}
                  y2={-c.trunk.z1}
                  stroke="#64748b"
                  strokeWidth={0.3}
                />
                <text
                  x={(c.rect.x0 + c.rect.x1) / 2}
                  y={-c.z0 - 0.7}
                  fill="#e2e8f0"
                  fontSize={0.9}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {clip(name, 14)}
                </text>
              </g>
            );
          })}
          <line
            x1={ml.x}
            x2={ml.x}
            y1={-ml.z0}
            y2={-ml.z1}
            stroke="#f59e0b"
            strokeWidth={0.5}
            strokeLinecap="round"
          >
            <title>{t("hud.minimap.mainLine")}</title>
          </line>
          {allStairs(factory).map((st) => (
            <rect
              key={st.id}
              {...rect(st.rect)}
              fill="#a5b4fc55"
              stroke="#818cf8"
              strokeWidth={0.08}
            >
              <title>{t("hud.minimap.stairs")}</title>
            </rect>
          ))}
          <g
            className="cursor-pointer"
            onClick={() => travelFactory({ factoryDock: true })}
            role="button"
            aria-label={t("hud.minimap.dock")}
          >
            <rect
              {...rect(factory.dock)}
              fill="#D977571f"
              stroke="#D97757"
              strokeWidth={0.14}
              rx={0.4}
            />
            <text
              x={(factory.dock.x0 + factory.dock.x1) / 2}
              y={-(factory.dock.z0 + factory.dock.z1) / 2}
              fill="#f0a58b"
              fontSize={0.9}
              fontWeight={600}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {t("hud.minimap.dock")}
            </text>
          </g>
          {pose ? (
            <g
              transform={`translate(${pose.x} ${-pose.z}) rotate(${
                (pose.yaw * 180) / Math.PI
              })`}
              pointerEvents="none"
            >
              <path
                d="M0 -0.95 L0.65 0.7 L0 0.3 L-0.65 0.7 Z"
                fill="#D97757"
                stroke="#fff"
                strokeWidth={0.12}
                strokeLinejoin="round"
              />
            </g>
          ) : null}
        </svg>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-[240px] items-center justify-center p-3">
      {factory ? toggle : null}
      <svg
        viewBox={`${x0} ${-zTop} ${w} ${h}`}
        className="h-full max-h-full w-full max-w-full"
        role="img"
        aria-label={t("hud.panel.minimap")}
      >
        <rect
          x={sx(hall.origin.x - hall.width / 2)}
          y={sz(hall.origin.z + hall.length)}
          width={hall.width}
          height={hall.length}
          fill="#1e293b"
          stroke="#334155"
          strokeWidth={0.12}
          rx={0.3}
        />
        <g
          className="cursor-pointer"
          onClick={() => travel("lobby")}
          role="button"
          aria-label={t("world.zone.lobby")}
        >
          <rect
            x={sx(lobby.origin.x - lobby.size.x / 2)}
            y={sz(lobby.origin.z + lobby.size.z / 2)}
            width={lobby.size.x}
            height={lobby.size.z}
            fill="#D977571f"
            stroke="#D97757"
            strokeWidth={0.14}
            rx={0.4}
          />
          <text
            x={lobby.origin.x}
            y={-lobby.origin.z}
            fill="#f0a58b"
            fontSize={0.9}
            fontWeight={600}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {t("world.zone.lobby")}
          </text>
        </g>
        <g
          className="cursor-pointer"
          onClick={() => travel("control")}
          role="button"
          aria-label={t("world.zone.control")}
        >
          <rect
            x={sx(controlRoom.origin.x - controlRoom.size.x / 2)}
            y={sz(controlRoom.origin.z + controlRoom.size.z / 2)}
            width={controlRoom.size.x}
            height={controlRoom.size.z}
            fill="#6366f11f"
            stroke="#818cf8"
            strokeWidth={0.14}
            rx={0.4}
          />
          <text
            x={controlRoom.origin.x}
            y={-controlRoom.origin.z}
            fill="#a5b4fc"
            fontSize={0.9}
            fontWeight={600}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {t("world.zone.control")}
          </text>
        </g>

        {layout.projects.map((p) => {
          const b = p.bounds;
          const rw = b.max.x - b.min.x;
          const sts = p.pods.map((d) => status.get(d.sessionId) ?? "ended");
          const top: keyof typeof STATUS_COLORS = sts.includes("needs_you")
            ? "needs_you"
            : sts.includes("working")
              ? "working"
              : sts.includes("done")
                ? "done"
                : "ended";
          const c = STATUS_COLORS[top];
          // Name along the entry bay (lobby end), pods in their bays.
          const ex = (b.min.x + b.max.x) / 2;
          const ez = b.min.z + 2.4;
          return (
            <g key={p.projectId}>
              <g
                className="cursor-pointer"
                onClick={() => travel({ projectId: p.projectId })}
                role="button"
                aria-label={`${t("hud.minimap.teamRoom")}: ${p.name}`}
              >
                <title>{`${p.name} · ${p.pods.length}`}</title>
                <rect
                  x={sx(b.min.x)}
                  y={sz(b.max.z)}
                  width={rw}
                  height={b.max.z - b.min.z}
                  fill={`${c}1f`}
                  stroke={c}
                  strokeWidth={0.14}
                  rx={0.3}
                />
                <text
                  x={sx(ex)}
                  y={sz(ez)}
                  fill="#e2e8f0"
                  fontSize={0.9}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {clip(p.name, Math.max(6, Math.floor((rw - 0.6) / 0.55)))}
                </text>
              </g>
              {p.pods.map((d) => {
                const st = status.get(d.sessionId) ?? "ended";
                const pc = STATUS_COLORS[st];
                const label =
                  labels.get(d.sessionId) ?? d.sessionId.slice(0, 8);
                const objective = objectives.get(d.sessionId) ?? null;
                const db = d.bounds;
                const cx = (db.min.x + db.max.x) / 2;
                const cz = (db.min.z + db.max.z) / 2;
                return (
                  <g
                    key={d.sessionId}
                    className="cursor-pointer"
                    onClick={() => travel({ sessionId: d.sessionId })}
                    role="button"
                    aria-label={label}
                  >
                    <title>
                      {objective ? `${label}\n${objective}` : label}
                    </title>
                    <rect
                      x={sx(db.min.x + 0.35)}
                      y={sz(db.max.z - 0.35)}
                      width={db.max.x - db.min.x - 0.7}
                      height={db.max.z - db.min.z - 0.7}
                      fill={`${pc}33`}
                      stroke={pc}
                      strokeWidth={0.1}
                      rx={0.25}
                    />
                    <circle cx={sx(cx)} cy={sz(cz) - 0.9} r={0.38} fill={pc} />
                    <text
                      x={sx(cx)}
                      y={sz(cz) + 0.5}
                      fill="#cbd5e1"
                      fontSize={0.7}
                      fontWeight={600}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {clip(label, Math.max(6, Math.floor((rw - 1) / 0.45)))}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {pose ? (
          <g
            transform={`translate(${sx(pose.x)} ${sz(pose.z)}) rotate(${
              (pose.yaw * 180) / Math.PI
            })`}
            pointerEvents="none"
          >
            <circle r={1.1} fill="#D977572e" />
            <path
              d="M0 -0.95 L0.65 0.7 L0 0.3 L-0.65 0.7 Z"
              fill="#D97757"
              stroke="#fff"
              strokeWidth={0.12}
              strokeLinejoin="round"
            />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
