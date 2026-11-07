/**
 * Interaction action registry. Read-only today; write actions
 * (answer_permission, send_message) get added here without touching the HUD.
 */
import type { InteractionAction, InteractionTarget } from "@/engine/contracts";

const INSPECT: InteractionAction = {
  id: "inspect",
  key: "F",
  labelKey: "world.action.inspect",
};
const POPUP: InteractionAction = {
  id: "popup",
  key: "F",
  labelKey: "world.action.popup",
};
const OPEN_OPS: InteractionAction = {
  id: "inspect",
  key: "F",
  labelKey: "world.action.openOps",
};
const ENTER: InteractionAction = {
  id: "enter",
  key: "Enter",
  labelKey: "world.action.enter",
};

export function actionsFor(target: InteractionTarget): InteractionAction[] {
  switch (target.kind) {
    case "character":
      return [POPUP, ENTER];
    case "ops":
      return target.sessionId ? [OPEN_OPS, ENTER] : [OPEN_OPS];
    case "monitor":
    case "whiteboard":
    case "screen":
    case "door":
      return [INSPECT, ENTER];
    default:
      return [];
  }
}

export function isInteractionTarget(v: unknown): v is InteractionTarget {
  if (!v || typeof v !== "object") return false;
  const t = v as InteractionTarget;
  return typeof t.kind === "string" && typeof t.sessionId === "string";
}
