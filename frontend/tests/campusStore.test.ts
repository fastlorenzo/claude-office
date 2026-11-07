import { beforeEach, describe, expect, it } from "vitest";
import { sessionsEqual, useCampusStore } from "@/stores/campusStore";
import type { CampusSession } from "@/engine/contracts";

function make(id: string, task = "t"): CampusSession {
  return {
    sessionId: id,
    bucket: "working",
    boss: { state: "working", currentTask: task },
    agents: [],
    office: {},
    todos: [],
    recentActivity: [],
    ended: false,
    lastUpdated: "2026-01-01T00:00:00Z",
  };
}

describe("campusStore", () => {
  beforeEach(() => useCampusStore.getState().clear());

  it("sessionsEqual compares structurally", () => {
    expect(sessionsEqual([make("a")], [make("a")])).toBe(true);
    expect(sessionsEqual([make("a")], [make("a", "other")])).toBe(false);
    expect(sessionsEqual([make("a")], [make("a"), make("b")])).toBe(false);
  });

  it("bails out (keeps the same state object) on identical frames", () => {
    const { setSessions } = useCampusStore.getState();
    setSessions([make("a")]);
    const first = useCampusStore.getState();
    setSessions([make("a")]);
    expect(useCampusStore.getState()).toBe(first);
    setSessions([make("a", "changed")]);
    expect(useCampusStore.getState().sessions[0].boss.currentTask).toBe(
      "changed",
    );
  });

  it("tracks connection and clears", () => {
    const s = useCampusStore.getState();
    s.setConnected(true);
    s.setSessions([make("a")]);
    expect(useCampusStore.getState().connected).toBe(true);
    s.clear();
    expect(useCampusStore.getState().sessions).toEqual([]);
    expect(useCampusStore.getState().connected).toBe(false);
  });
});
