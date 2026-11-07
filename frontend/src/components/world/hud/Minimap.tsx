"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { STATUS_COLORS } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import { campusStatus, labelMap } from "../sessionMeta";
import { getWorld } from "../worldRef";
import { clip, sessionHeadline } from "./sessionGlance";

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

  return (
    <div className="flex h-full min-h-[240px] items-center justify-center p-3">
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
