import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetConsoleQueues,
  setConsoleScheduler,
  useConsoleStore,
} from "@/stores/consoleStore";
import {
  createConsoleController,
  needsOwnSocket,
  routeConsoleMessage,
  type ConsoleControllerDeps,
  type ConsoleSocketLike,
} from "@/utils/console/controller";
import { errorsSession, makeToolCall } from "@/components/console/fixtures";

let scheduled: Array<() => void> = [];
beforeEach(() => {
  resetConsoleQueues();
  scheduled = [];
  setConsoleScheduler((cb) => scheduled.push(cb));
  useConsoleStore.setState({ sessions: {}, lru: [] });
});

function deps(over: Partial<ConsoleControllerDeps> = {}) {
  const sockets: ConsoleSocketLike[] = [];
  const d: ConsoleControllerDeps = {
    fetchSnapshot: vi.fn(async () => errorsSession()),
    fetchOlder: vi.fn(async () => ({ calls: [], hasMore: false })),
    openSocket: vi.fn(() => {
      const s = { onmessage: null, close: vi.fn() };
      sockets.push(s);
      return s;
    }),
    ...over,
  };
  return { d, sockets };
}
const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe("console controller", () => {
  it("opens no second socket when sessionId is the selected session", async () => {
    const { d } = deps();
    const c = createConsoleController("s1", "s1", d);
    c.start();
    await flushPromises();
    expect(d.openSocket).not.toHaveBeenCalled();
    expect(useConsoleStore.getState().sessions.s1.status).toBe("ready");
    c.stop();
    expect(needsOwnSocket("s1", "s1")).toBe(false);
    expect(needsOwnSocket("s2", "s1")).toBe(true);
    expect(needsOwnSocket("s2", null)).toBe(true);
  });

  it("opens its own socket for another session, routes frames, closes on stop", async () => {
    const { d, sockets } = deps();
    const c = createConsoleController("s2", "s1", d);
    c.start();
    expect(d.openSocket).toHaveBeenCalledWith("s2");
    // A frame arriving before the snapshot resolves is held, then applied.
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "tool_call", toolCall: makeToolCall(9) }),
    });
    await flushPromises();
    expect(useConsoleStore.getState().sessions.s2.calls.has("toolu_9")).toBe(
      true,
    );
    sockets[0].onmessage?.({ data: "not json" }); // ignored
    c.stop();
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it("marks missing on a null snapshot and error on failure", async () => {
    const a = deps({ fetchSnapshot: vi.fn(async () => null) });
    createConsoleController("m", "m", a.d).start();
    const b = deps({
      fetchSnapshot: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    createConsoleController("e", "e", b.d).start();
    await flushPromises();
    const s = useConsoleStore.getState().sessions;
    expect(s.m.status).toBe("missing");
    expect(s.e).toMatchObject({ status: "error", errorMessage: "boom" });
  });

  it("pages older calls using oldestSeq", async () => {
    const { d } = deps({
      fetchSnapshot: vi.fn(async () => ({ ...errorsSession(), hasMore: true })),
      fetchOlder: vi.fn(async () => ({
        calls: [makeToolCall(0)],
        hasMore: false,
      })),
    });
    const c = createConsoleController("p", "p", d);
    c.start();
    await flushPromises();
    await c.loadOlder();
    expect(d.fetchOlder).toHaveBeenCalledWith("p", 1);
    const s = useConsoleStore.getState().sessions.p;
    expect(s.order[0]).toBe("toolu_0");
    expect(s.hasMore).toBe(false);
  });

  it("routes git_status and state_update", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("g");
    routeConsoleMessage("g", {
      type: "git_status",
      gitStatus: { branch: "x" },
    });
    routeConsoleMessage("g", {
      type: "state_update",
      state: { todos: [{ content: "t", status: "pending" }] },
    });
    const s = useConsoleStore.getState().sessions.g;
    expect(s.gitStatus).toEqual({ branch: "x" });
    expect(s.todos).toHaveLength(1);
    routeConsoleMessage("g", null);
  });
});

describe("routeConsoleMessage without a loaded session", () => {
  it("ignores frames for sessions the console never began loading", () => {
    routeConsoleMessage("nope", {
      type: "tool_call",
      toolCall: makeToolCall(1),
    });
    expect(scheduled).toHaveLength(0);
    expect(useConsoleStore.getState().sessions.nope).toBeUndefined();
  });
});
