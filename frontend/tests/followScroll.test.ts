import { describe, expect, it } from "vitest";
import {
  INITIAL_FOLLOW,
  followReducer,
  type FollowState,
} from "@/utils/console/followScroll";

const paused: FollowState = { mode: "paused", unseen: 0 };

describe("followScroll", () => {
  it("starts following", () => {
    expect(INITIAL_FOLLOW).toEqual({ mode: "following", unseen: 0 });
  });
  it("pauses only after scrolling more than 48 px up", () => {
    expect(
      followReducer(INITIAL_FOLLOW, { type: "scroll", distanceFromBottom: 48 }),
    ).toBe(INITIAL_FOLLOW);
    expect(
      followReducer(INITIAL_FOLLOW, { type: "scroll", distanceFromBottom: 49 })
        .mode,
    ).toBe("paused");
  });
  it("ignores programmatic scrolls", () => {
    expect(
      followReducer(INITIAL_FOLLOW, {
        type: "scroll",
        distanceFromBottom: 500,
        userInitiated: false,
      }),
    ).toBe(INITIAL_FOLLOW);
  });
  it("expanding or selecting a row pauses", () => {
    expect(followReducer(INITIAL_FOLLOW, { type: "interact" }).mode).toBe(
      "paused",
    );
    expect(followReducer(paused, { type: "interact" })).toBe(paused);
  });
  it("counts new rows only while paused", () => {
    expect(followReducer(INITIAL_FOLLOW, { type: "rows", count: 3 })).toBe(
      INITIAL_FOLLOW,
    );
    const s = followReducer(followReducer(paused, { type: "rows", count: 2 }), {
      type: "rows",
      count: 3,
    });
    expect(s).toEqual({ mode: "paused", unseen: 5 });
  });
  it("scrolling back to the bottom resumes and clears the counter", () => {
    const s = followReducer(
      { mode: "paused", unseen: 4 },
      { type: "scroll", distanceFromBottom: 0 },
    );
    expect(s).toEqual(INITIAL_FOLLOW);
  });
  it("resume (pill / f) and toggle", () => {
    expect(
      followReducer({ mode: "paused", unseen: 4 }, { type: "resume" }),
    ).toEqual(INITIAL_FOLLOW);
    expect(followReducer(INITIAL_FOLLOW, { type: "resume" })).toBe(
      INITIAL_FOLLOW,
    );
    expect(followReducer(INITIAL_FOLLOW, { type: "toggle" }).mode).toBe(
      "paused",
    );
    expect(followReducer(paused, { type: "toggle" })).toEqual(INITIAL_FOLLOW);
  });
  it("scrolling a little while paused stays paused", () => {
    expect(
      followReducer(paused, { type: "scroll", distanceFromBottom: 20 }),
    ).toBe(paused);
  });
});
