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
  const travel = (to: { sessionId: string } | "lobby" | "control"): void => {
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

        {layout.rooms.map((r) => {
          const st = status.get(r.sessionId) ?? "ended";
          const c = STATUS_COLORS[st];
          const label = labels.get(r.sessionId) ?? r.sessionId.slice(0, 8);
          const objective = objectives.get(r.sessionId) ?? null;
          const rw = r.bounds.max.x - r.bounds.min.x;
          // ~0.42 world units per glyph at fontSize 0.7; leave a margin.
          const objChars = Math.floor((rw - 0.6) / 0.38);
          const cx = (r.bounds.min.x + r.bounds.max.x) / 2;
          const cz = (r.bounds.min.z + r.bounds.max.z) / 2;
          return (
            <g
              key={r.sessionId}
              className="cursor-pointer"
              onClick={() => travel({ sessionId: r.sessionId })}
              role="button"
              aria-label={label}
            >
              <title>{objective ? `${label}\n${objective}` : label}</title>
              <rect
                x={sx(r.bounds.min.x)}
                y={sz(r.bounds.max.z)}
                width={r.bounds.max.x - r.bounds.min.x}
                height={r.bounds.max.z - r.bounds.min.z}
                fill={`${c}33`}
                stroke={c}
                strokeWidth={0.14}
                rx={0.3}
              />
              <circle cx={sx(cx)} cy={sz(cz) - 0.9} r={0.4} fill={c} />
              <text
                x={sx(cx)}
                y={sz(cz) + 0.4}
                fill="#e2e8f0"
                fontSize={0.8}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {clip(label, Math.max(6, Math.floor((rw - 0.6) / 0.5)))}
              </text>
              {objective && objChars >= 8 ? (
                <text
                  x={sx(cx)}
                  y={sz(cz) + 1.5}
                  fill="#94a3b8"
                  fontSize={0.62}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {clip(objective, objChars)}
                </text>
              ) : null}
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
