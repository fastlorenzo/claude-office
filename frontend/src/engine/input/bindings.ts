/**
 * Key bindings by `KeyboardEvent.code` (layout independent: WASD stays put on
 * AZERTY). The HUD owns Tab/G/C/L/A/M/H/Esc; the engine owns these.
 */
export type HoldAction =
  "forward" | "back" | "left" | "right" | "sprint" | "jump" | "lobby";
export type PressAction = "camera" | "inspect" | "enter" | "fly";
export type GameAction = HoldAction | PressAction;

export const BINDINGS: Readonly<Record<string, GameAction>> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  Space: "jump",
  KeyV: "camera",
  KeyN: "fly",
  KeyF: "inspect",
  Enter: "enter",
  NumpadEnter: "enter",
  KeyR: "lobby",
};

export const PRESS_ACTIONS: ReadonlySet<GameAction> = new Set<GameAction>([
  "camera",
  "inspect",
  "enter",
  "fly",
]);

/** Hold R this long to teleport back to the lobby (unstuck). */
export const LOBBY_HOLD_MS = 800;

/** Radians per CSS pixel of mouse movement. */
export const MOUSE_SENSITIVITY = 0.0022;
/** Radians per CSS pixel of touch drag. */
export const TOUCH_SENSITIVITY = 0.005;
