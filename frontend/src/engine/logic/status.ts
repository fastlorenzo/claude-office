import {
  STATUS_COLORS,
  type CampusSession,
  type CharacterPose,
  type RoomStatus,
} from "../contracts";
import type { AgentState, BossState } from "@/types";

export function roomStatus(s: CampusSession): RoomStatus {
  if (s.ended) return "ended";
  return s.bucket;
}

const BOSS_POSE = {
  idle: "sitting",
  phone_ringing: "raiseHand",
  on_phone: "typing",
  receiving: "typing",
  working: "typing",
  delegating: "typing",
  waiting_permission: "raiseHand",
  reviewing: "typing",
  completing: "celebrating",
} as const satisfies Record<BossState, CharacterPose>;

export function bossPose(state: BossState): CharacterPose {
  return BOSS_POSE[state];
}

const AGENT_POSE = {
  arriving: "walking",
  reporting: "walking",
  walking_to_desk: "walking",
  working: "typing",
  thinking: "thinking",
  waiting_permission: "raiseHand",
  completed: "celebrating",
  waiting: "sitting",
  reporting_done: "walking",
  leaving: "walking",
  in_elevator: "idle",
  idle: "sitting",
} as const satisfies Record<AgentState, CharacterPose>;

export function agentPose(state: AgentState): CharacterPose {
  return AGENT_POSE[state];
}

export type AgentLocomotion =
  "atDesk" | "toDesk" | "toBoss" | "toDoor" | "atDoor";

const AGENT_LOCOMOTION = {
  arriving: "atDoor",
  in_elevator: "atDoor",
  walking_to_desk: "toDesk",
  reporting: "toBoss",
  reporting_done: "toBoss",
  leaving: "toDoor",
  working: "atDesk",
  thinking: "atDesk",
  waiting_permission: "atDesk",
  completed: "atDesk",
  waiting: "atDesk",
  idle: "atDesk",
} as const satisfies Record<AgentState, AgentLocomotion>;

export function agentLocomotion(state: AgentState): AgentLocomotion {
  return AGENT_LOCOMOTION[state];
}

export function statusColor(status: RoomStatus): string {
  return STATUS_COLORS[status];
}
