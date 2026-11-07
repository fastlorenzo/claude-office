import { describe, expect, it } from "vitest";
import type { CampusSession } from "@/engine/contracts";
import {
  shouldCollapse,
  sessionFocus,
  sessionObjective,
  sessionWorkItems,
  sortSessions,
  todoProgress,
} from "@/components/world/hud/sessionGlance";

function mk(p: Partial<CampusSession> & { sessionId: string }): CampusSession {
  return {
    bucket: "working",
    boss: { state: "working", currentTask: null },
    agents: [],
    office: {},
    todos: [],
    recentActivity: [],
    ended: false,
    lastUpdated: "2026-01-01T00:00:00Z",
    ...p,
  } as unknown as CampusSession;
}

describe("sortSessions", () => {
  it("orders needs_you, working, done, ended; newest first within a bucket", () => {
    const list = [
      mk({ sessionId: "ended", ended: true, bucket: "working" }),
      mk({ sessionId: "done", bucket: "done" }),
      mk({ sessionId: "w-old", lastUpdated: "2026-01-01T00:00:00Z" }),
      mk({ sessionId: "w-new", lastUpdated: "2026-02-01T00:00:00Z" }),
      mk({ sessionId: "needs", bucket: "needs_you" }),
    ];
    expect(sortSessions(list).map((s) => s.sessionId)).toEqual([
      "needs",
      "w-new",
      "w-old",
      "done",
      "ended",
    ]);
  });
  it("does not mutate input", () => {
    const list = [
      mk({ sessionId: "b", bucket: "done" }),
      mk({ sessionId: "a" }),
    ];
    sortSessions(list);
    expect(list[0].sessionId).toBe("b");
  });
});

describe("focus / workItems fallback", () => {
  it("prefers backend values", () => {
    const cs = mk({
      sessionId: "x",
      objective: "  Ship it ",
      focus: "Testing",
      workItems: ["a", " ", "b"],
      boss: { state: "working", currentTask: "boss task" } as never,
    });
    expect(sessionObjective(cs)).toBe("Ship it");
    expect(sessionFocus(cs)).toBe("Testing");
    expect(sessionWorkItems(cs)).toEqual(["a", "b"]);
  });
  it("falls back to boss.currentTask and in-progress todos", () => {
    const cs = mk({
      sessionId: "x",
      focus: null,
      boss: { state: "working", currentTask: "boss task" } as never,
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress", active_form: "Doing two" },
        { content: "three", status: "in_progress" },
        { content: "four", status: "pending" },
      ] as never,
    });
    expect(sessionObjective(cs)).toBeNull();
    expect(sessionFocus(cs)).toBe("boss task");
    expect(sessionWorkItems(cs)).toEqual(["Doing two", "three"]);
    expect(todoProgress(cs)).toEqual({ done: 1, total: 4, pct: 25 });
  });
  it("handles everything missing", () => {
    const cs = mk({ sessionId: "x" });
    expect(sessionFocus(cs)).toBeNull();
    expect(sessionWorkItems(cs)).toEqual([]);
  });
  it("caps fallback items at 4", () => {
    const todos = Array.from({ length: 7 }, (_, i) => ({
      content: `t${i}`,
      status: "in_progress",
    }));
    expect(
      sessionWorkItems(mk({ sessionId: "x", todos: todos as never })),
    ).toHaveLength(4);
  });
});

describe("shouldCollapse", () => {
  it("collapses above 6", () => {
    expect(shouldCollapse(6)).toBe(false);
    expect(shouldCollapse(7)).toBe(true);
  });
});
