"use client";

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { PeerPopup } from "@/components/command/PeerPopup";
import type { CommandPeer } from "@/components/command/useCommandCenterPeers";
import { useCampusWebSocket } from "@/hooks/useCampusWebSocket";
import { canFocusTerminal } from "@/stores/attentionStore";
import { useCampusStore } from "@/stores/campusStore";
import { useWorldUiStore } from "@/stores/worldUiStore";
import type { Session } from "@/hooks/useSessions";
import { sessionLabel } from "./sessionMeta";
import { enterSession } from "./enterSession";
import { WorldHud } from "./WorldHud";
import { TouchControls } from "./hud/TouchControls";
import { ErrorScreen, LoadingScreen } from "./WorldStatus";

const WorldCanvas = dynamic(
  () => import("./WorldCanvas").then((m) => ({ default: m.WorldCanvas })),
  { ssr: false },
);

export interface WorldViewProps {
  sessions: Session[];
  sessionsLoading: boolean;
  sessionId: string;
  onSessionSelect: (id: string) => Promise<void>;
  onDeleteSession: (session: Session) => void;
  onRenameSession: (sessionId: string, newName: string) => Promise<void>;
  isMobile: boolean;
}

/** Build the PeerPopup's CommandPeer shape from campus feed data. */
function usePeer(sessions: Session[]): CommandPeer | null {
  const popup = useWorldUiStore((s) => s.peerPopup);
  const cs = useCampusStore((s) =>
    popup ? s.sessions.find((x) => x.sessionId === popup.sessionId) : undefined,
  );
  return useMemo(() => {
    if (!popup) return null;
    const meta = sessions.find((s) => s.id === popup.sessionId);
    return {
      sessionId: popup.sessionId,
      label: meta ? sessionLabel(meta, cs) : popup.sessionId.slice(0, 8),
      bucket: !cs || cs.ended ? "ended" : cs.bucket,
      state: cs?.boss.state ?? null,
      currentTask: cs?.boss.currentTask ?? null,
      todoDone: cs?.todos.filter((t) => t.status === "completed").length ?? 0,
      todoTotal: cs?.todos.length ?? 0,
      subagentCount: cs?.agents.length ?? 0,
      slotIndex: 0,
      position: { x: 0, y: 0 },
    };
  }, [popup, cs, sessions]);
}

/**
 * The 3D renderer's root: canvas + HUD + touch controls. Fills its parent.
 */
export function WorldView(props: WorldViewProps): ReactNode {
  const { isMobile, onSessionSelect, sessions } = props;
  useCampusWebSocket({ enabled: true });

  const popup = useWorldUiStore((s) => s.peerPopup);
  const setPeerPopup = useWorldUiStore((s) => s.setPeerPopup);
  const peer = usePeer(sessions);
  const epoch = useWorldUiStore((s) => s.worldEpoch);

  return (
    <div className="relative min-h-0 flex-grow overflow-hidden rounded-lg border border-slate-800 bg-slate-950 shadow-2xl">
      <WorldCanvas
        key={epoch}
        sessions={sessions}
        sessionId={props.sessionId}
        onSessionSelect={onSessionSelect}
        isMobile={isMobile}
      />
      <WorldHud {...props} />
      {isMobile && <TouchControls />}
      <LoadingScreen />
      <ErrorScreen />
      <PeerPopup
        popup={popup && peer ? { peer, x: popup.x, y: popup.y } : null}
        onClose={() => setPeerPopup(null)}
        onDrillIn={(id) => void enterSession(id)}
        drillLabelKey="world.action.enter"
        showTerminal={canFocusTerminal()}
      />
    </div>
  );
}
