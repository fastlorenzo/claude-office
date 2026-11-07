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

import {
  extractRefs,
  formatElapsed,
  humanizeBranch,
  sanitizeFocus,
  sessionPhase,
  sessionRefs,
  sessionSummary,
  stripRefs,
} from "@/engine/logic/sessionInfo";

describe("refs", () => {
  it("extracts tickets and PR numbers", () => {
    expect(
      extractRefs("CONT-839 fix", "feat/cont-839-sso", "see #412"),
    ).toEqual(["CONT-839", "#412"]);
  });
  it("prefers backend refs", () => {
    expect(
      sessionRefs(mk({ sessionId: "x", refs: ["A-1"], gitBranch: "b/z-9" })),
    ).toEqual(["A-1"]);
    expect(
      sessionRefs(mk({ sessionId: "x", sessionName: "cont-839" })),
    ).toEqual(["CONT-839"]);
  });
  it("strips refs", () => {
    expect(stripRefs("CONT-839")).toBe("");
    expect(stripRefs("CONT-839: Add SSO (#412)")).toBe("Add SSO");
  });
});

describe("humanizeBranch", () => {
  it("humanizes", () => {
    expect(humanizeBranch("feat/cont-839-sso-login")).toBe("SSO login");
    expect(humanizeBranch("zio/fix/retry_webhooks")).toBe("Retry webhooks");
    expect(humanizeBranch("main")).toBeNull();
    expect(humanizeBranch("feat/CONT-839")).toBeNull();
  });
});

describe("sanitizeFocus", () => {
  it("drops prompts, tags and shell commands", () => {
    expect(sanitizeFocus("are we done?")).toBeNull();
    expect(
      sanitizeFocus('<agent-message from="x">hi</agent-message>'),
    ).toBeNull();
    expect(sanitizeFocus("git status")).toBeNull();
    expect(sanitizeFocus("pytest -q tests/")).toBeNull();
    expect(sanitizeFocus("Fixing parallel subagent tracking")).toBe(
      "Fixing parallel subagent tracking",
    );
  });
});

describe("sessionSummary fallbacks", () => {
  it("summary > objective > branch > null", () => {
    expect(
      sessionSummary(mk({ sessionId: "x", summary: "Do X", objective: "Y" })),
    ).toBe("Do X");
    expect(
      sessionSummary(mk({ sessionId: "x", objective: "CONT-839: Add SSO" })),
    ).toBe("Add SSO");
    expect(
      sessionSummary(
        mk({
          sessionId: "x",
          objective: "CONT-839",
          gitBranch: "feat/cont-839-sso-login",
        }),
      ),
    ).toBe("SSO login");
    expect(
      sessionSummary(mk({ sessionId: "x", objective: "CONT-839" })),
    ).toBeNull();
  });
});

describe("sessionSummary skips ref-only objectives", () => {
  const branch = "feat/cont-839-sso-login";
  it.each(["CONT-587 and CONT-635", "#12 + #13", "fix CONT-1"])(
    "%s falls through to the branch",
    (objective) => {
      expect(
        sessionSummary(mk({ sessionId: "x", objective, gitBranch: branch })),
      ).toBe("SSO login");
    },
  );
});

describe("sessionPhase fallback", () => {
  it("uses backend phase when present", () => {
    const p = { kind: "git", label: "Git" } as const;
    expect(sessionPhase(mk({ sessionId: "x", phase: p })).kind).toBe("git");
  });
  it("derives from boss state and activity", () => {
    expect(
      sessionPhase(
        mk({ sessionId: "x", boss: { state: "waiting_permission" } as never }),
      ).kind,
    ).toBe("needs_approval");
    expect(
      sessionPhase(mk({ sessionId: "x", boss: { state: "idle" } as never }))
        .kind,
    ).toBe("waiting_user");
    expect(sessionPhase(mk({ sessionId: "x", ended: true })).kind).toBe(
      "ended",
    );
    const act = (summary: string) => ({
      timestamp: "2026-01-01T00:00:00Z",
      type: "pre_tool_use",
      agentId: "main",
      summary,
    });
    expect(
      sessionPhase(
        mk({ sessionId: "x", recentActivity: [act("Bash: pytest -q")] }),
      ).kind,
    ).toBe("testing");
    expect(
      sessionPhase(mk({ sessionId: "x", recentActivity: [act("Edit foo.ts")] }))
        .kind,
    ).toBe("coding");
    expect(
      sessionPhase(
        mk({ sessionId: "x", recentActivity: [act("Bash: git push")] }),
      ).kind,
    ).toBe("git");
    const p = sessionPhase(mk({ sessionId: "x", focus: "Fixing tracking" }));
    expect(p.label).toBe("Working");
    expect(p.detail).toBe("Fixing tracking");
  });
});

describe("formatElapsed", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  it("formats", () => {
    expect(formatElapsed("2026-01-01T00:08:00Z", now)).toBe("2m");
    expect(formatElapsed("2026-01-01T00:09:30Z", now)).toBe("30s");
    expect(formatElapsed("2025-12-31T22:50:00Z", now)).toBe("1h 20m");
    expect(formatElapsed(null, now)).toBeNull();
    expect(formatElapsed("2026-01-02T00:00:00Z", now)).toBeNull();
  });
});
