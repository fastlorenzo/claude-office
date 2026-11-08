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

const RIDE_UP: InteractionAction = {
  id: "ride",
  key: "F",
  labelKey: "world.action.liftUp",
};
const RIDE_DOWN: InteractionAction = {
  id: "ride",
  key: "F",
  labelKey: "world.action.liftDown",
};

function factoryInspect(labelKey: string): InteractionAction {
  return { id: "inspect", key: "F", labelKey };
}

const FACTORY_INSPECT: Partial<
  Record<InteractionTarget["kind"], InteractionAction>
> = {
  lanePlate: factoryInspect("factory.action.openPr"),
  workpiece: factoryInspect("factory.action.openPr"),
  station: factoryInspect("factory.action.openStation"),
  lineBoard: factoryInspect("factory.action.openLine"),
  trunk: factoryInspect("factory.action.openLine"),
  mainLine: factoryInspect("factory.action.openLine"),
  dock: factoryInspect("factory.action.openDeploy"),
};

/** "Open on GitHub": no keyboard binding (panels carry the button); touch / panels call it. */
export const OPEN_GITHUB: InteractionAction = {
  id: "github",
  key: "Enter",
  labelKey: "factory.action.github",
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
    case "lift":
      return [target.stop === 1 ? RIDE_DOWN : RIDE_UP];
    case "lanePlate":
    case "workpiece":
    case "station":
    case "lineBoard":
    case "dock":
    case "trunk":
    case "mainLine": {
      const inspect = FACTORY_INSPECT[target.kind];
      if (!inspect) return [];
      return target.sessionId ? [inspect, ENTER] : [inspect];
    }
    default:
      return [];
  }
}

export function isInteractionTarget(v: unknown): v is InteractionTarget {
  if (!v || typeof v !== "object") return false;
  const t = v as InteractionTarget;
  return typeof t.kind === "string" && typeof t.sessionId === "string";
}
