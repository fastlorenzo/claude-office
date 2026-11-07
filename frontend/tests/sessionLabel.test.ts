import { describe, expect, it } from "vitest";
import type { CampusSession } from "@/engine/contracts";
import type { Session } from "@/hooks/useSessions";
import {
  isEncodedPath,
  prettifyEncodedPath,
  projectBasename,
  sessionLabel,
  sessionSubLabel,
} from "@/components/world/sessionMeta";
import { sessionHeadline } from "@/components/world/hud/sessionGlance";

function sess(p: Partial<Session> = {}): Session {
  return {
    id: "abcdef1234567890",
    label: null,
    displayName: null,
    projectName: null,
    projectRoot: null,
    createdAt: "",
    updatedAt: "",
    status: "active",
    eventCount: 0,
    floorId: null,
    roomId: null,
    ...p,
  };
}
const cs = (p: Partial<CampusSession>) => p as CampusSession;

describe("sessionLabel precedence", () => {
  const enc = "-home-zio-git-claude-office";
  it("1. in-app rename wins", () => {
    expect(
      sessionLabel(
        sess({ label: "mine", displayName: "d" }),
        cs({ sessionName: "n" }),
      ),
    ).toBe("mine");
  });
  it("2. campus sessionName", () => {
    expect(
      sessionLabel(
        sess({ displayName: "d" }),
        cs({ sessionName: "claude-office" }),
      ),
    ).toBe("claude-office");
  });
  it("3. displayName unless encoded path", () => {
    expect(sessionLabel(sess({ displayName: "proj" }))).toBe("proj");
    expect(
      sessionLabel(
        sess({ displayName: enc, projectRoot: "/home/zio/git/claude-office" }),
      ),
    ).toBe("claude-office");
  });
  it("4. projectRoot basename, never encoded", () => {
    expect(
      sessionLabel(sess({ projectRoot: "/home/zio/git/claude-office/" })),
    ).toBe("claude-office");
    expect(sessionLabel(sess({ projectName: enc }))).toBe("git-claude-office");
    expect(sessionLabel(sess({ projectRoot: enc }))).toBe("git-claude-office");
  });
  it("5. short id", () => {
    expect(sessionLabel(sess())).toBe("abcdef12");
  });
});

describe("encoded path helpers", () => {
  it("detects and prettifies", () => {
    expect(isEncodedPath("-home-zio-git-x")).toBe(true);
    expect(isEncodedPath("claude-office")).toBe(false);
    expect(isEncodedPath("/home/zio")).toBe(false);
    expect(prettifyEncodedPath("-home-zio-git-x")).toBe("git-x");
    expect(prettifyEncodedPath("-Users-bob-app")).toBe("app");
  });
  it("sub label only when different", () => {
    const s = sess({ label: "my name", projectRoot: "/a/claude-office" });
    expect(sessionSubLabel(s)).toBe("claude-office");
    expect(
      sessionSubLabel(sess({ projectRoot: "/a/claude-office" })),
    ).toBeNull();
    expect(projectBasename(sess())).toBeNull();
  });
});

describe("sessionHeadline", () => {
  it("objective, else focus, else boss task", () => {
    const boss = { currentTask: "task" };
    expect(
      sessionHeadline(cs({ objective: "obj", focus: "f", boss } as never)),
    ).toBe("obj");
    expect(sessionHeadline(cs({ focus: "f", boss } as never))).toBe("f");
    expect(sessionHeadline(cs({ boss } as never))).toBe("task");
    expect(sessionHeadline(cs({ boss: {} } as never))).toBeNull();
  });
});
