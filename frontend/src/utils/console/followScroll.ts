/**
 * Live-follow versus paused: the tiny pure state machine behind the timeline
 * scroll behaviour (spec section 2.5). The component owns the DOM and feeds
 * events in; this module decides the mode and the "N new" counter.
 */

/** Scrolling further than this above the bottom pauses following. */
export const PAUSE_THRESHOLD_PX = 48;
/** Within this distance the list counts as being at the bottom. */
export const BOTTOM_EPSILON_PX = 2;

export interface FollowState {
  mode: "following" | "paused";
  /** Rows that arrived while paused. */
  unseen: number;
}

export type FollowEvent =
  /** The list scrolled. Pass `userInitiated: false` for programmatic scrolls. */
  | { type: "scroll"; distanceFromBottom: number; userInitiated?: boolean }
  /** Rows were appended to the list. */
  | { type: "rows"; count: number }
  /** A row was expanded or selected. */
  | { type: "interact" }
  /** The pill was clicked or `f` pressed while paused (resume) / toggle. */
  | { type: "resume" }
  | { type: "toggle" };

export const INITIAL_FOLLOW: FollowState = { mode: "following", unseen: 0 };

/** Reduce one event. Returns the same object when nothing changed. */
export function followReducer(
  state: FollowState,
  event: FollowEvent,
): FollowState {
  switch (event.type) {
    case "scroll": {
      if (event.userInitiated === false) return state;
      if (event.distanceFromBottom <= BOTTOM_EPSILON_PX) {
        return state.mode === "following" && state.unseen === 0
          ? state
          : INITIAL_FOLLOW;
      }
      if (
        state.mode === "following" &&
        event.distanceFromBottom > PAUSE_THRESHOLD_PX
      ) {
        return { mode: "paused", unseen: 0 };
      }
      return state;
    }
    case "rows":
      if (state.mode === "following" || event.count <= 0) return state;
      return { ...state, unseen: state.unseen + event.count };
    case "interact":
      return state.mode === "paused" ? state : { mode: "paused", unseen: 0 };
    case "resume":
      return state.mode === "following" ? state : INITIAL_FOLLOW;
    case "toggle":
      return state.mode === "following"
        ? { mode: "paused", unseen: 0 }
        : INITIAL_FOLLOW;
  }
}
