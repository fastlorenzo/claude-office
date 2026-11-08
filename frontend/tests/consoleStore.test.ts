import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONSOLE_SESSIONS,
  detailKey,
  enqueueConsoleFrame,
  flushConsoleFrames,
  resetConsoleQueues,
  setConsoleScheduler,
  useConsoleStore,
} from "@/stores/consoleStore";
import {
  errorsSession,
  makeAgent,
  makeToolCall,
  reattributionSession,
} from "@/components/console/fixtures";
import { touchLru } from "@/utils/console/lru";
import type { ToolCall } from "@/utils/console/types";

let scheduled: Array<() => void> = [];
const tick = () => {
  const cbs = scheduled;
  scheduled = [];
  cbs.forEach((cb) => cb());
};

const frame = (toolCall: ToolCall) => ({
  type: "tool_call" as const,
  toolCall,
});
const get = (id = "s1") => useConsoleStore.getState().sessions[id];

beforeEach(() => {
  resetConsoleQueues();
  scheduled = [];
  setConsoleScheduler((cb) => scheduled.push(cb));
  useConsoleStore.setState({ sessions: {}, lru: [] });
});

describe("consoleStore", () => {
  it("200 frames in one tick produce one store notification", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", errorsSession());
    let notifications = 0;
    const unsub = useConsoleStore.subscribe(() => notifications++);
    for (let i = 0; i < 200; i++) {
      enqueueConsoleFrame("s1", frame(makeToolCall(100 + i)));
    }
    expect(notifications).toBe(0);
    expect(scheduled).toHaveLength(1);
    tick();
    unsub();
    expect(notifications).toBe(1);
    expect(get().order).toHaveLength(4 + 200);
  });

  it("keeps referential identity for unchanged calls", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", errorsSession());
    const before = get().calls.get("toolu_1");
    enqueueConsoleFrame("s1", frame(makeToolCall(50)));
    tick();
    expect(get().calls.get("toolu_1")).toBe(before);
    // Same-rev refresh of the snapshot also keeps it.
    st.applySnapshot("s1", errorsSession());
    expect(get().calls.get("toolu_1")).toBe(before);
  });

  it("ignores stale revs and applies newer ones", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", {
      ...errorsSession(),
      toolCalls: [makeToolCall(1, { rev: 5 })],
    });
    const cur = get().calls.get("toolu_1");
    enqueueConsoleFrame(
      "s1",
      frame(makeToolCall(1, { rev: 4, status: "error" })),
    );
    enqueueConsoleFrame(
      "s1",
      frame(makeToolCall(1, { rev: 5, status: "error" })),
    );
    tick();
    expect(get().calls.get("toolu_1")).toBe(cur);
    enqueueConsoleFrame(
      "s1",
      frame(makeToolCall(1, { rev: 6, status: "error" })),
    );
    tick();
    expect(get().calls.get("toolu_1")?.status).toBe("error");
  });

  it("applies a frame that arrived before the snapshot after it", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    // Live frame (rev 2) races ahead of a snapshot that still holds rev 1.
    enqueueConsoleFrame(
      "s1",
      frame(makeToolCall(1, { rev: 2, status: "error" })),
    );
    enqueueConsoleFrame("s1", frame(makeToolCall(9)));
    tick();
    expect(get().calls.size).toBe(0); // held, not applied
    st.applySnapshot("s1", errorsSession());
    expect(get().status).toBe("ready");
    expect(get().calls.get("toolu_1")?.rev).toBe(2);
    expect(get().calls.get("toolu_1")?.status).toBe("error");
    expect(get().order).toEqual([
      "toolu_1",
      "toolu_2",
      "toolu_3",
      "toolu_4",
      "toolu_9",
    ]);
  });

  it("keeps order sorted by seq for out-of-order frames and older pages", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", {
      ...errorsSession(),
      toolCalls: [makeToolCall(10), makeToolCall(11)],
      hasMore: true,
    });
    enqueueConsoleFrame("s1", frame(makeToolCall(12)));
    enqueueConsoleFrame("s1", frame(makeToolCall(11, { rev: 2 })));
    tick();
    st.applyOlderPage("s1", [makeToolCall(8), makeToolCall(9)], false);
    expect(get().order).toEqual([
      "toolu_8",
      "toolu_9",
      "toolu_10",
      "toolu_11",
      "toolu_12",
    ]);
    expect(get().oldestSeq).toBe(8);
    expect(get().hasMore).toBe(false);
  });

  it("stores agent nodes with rev guard and caches details by id@rev", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", errorsSession());
    enqueueConsoleFrame("s1", {
      type: "agent_node",
      agent: makeAgent("a", { rev: 2, state: "running" }),
    });
    enqueueConsoleFrame("s1", {
      type: "agent_node",
      agent: makeAgent("a", { rev: 1, state: "done" }),
    });
    tick();
    expect(get().agents.get("a")?.state).toBe("running");
    const call = makeToolCall(2, { rev: 3 });
    st.putDetail("s1", {
      call,
      outputSource: "hook",
      outputTruncated: false,
      output: "x",
    });
    expect(get().details.get(detailKey("toolu_2", 3))?.output).toBe("x");
    expect(get().details.get(detailKey("toolu_2", 2))).toBeUndefined();
  });

  it("re-attribution frame moves the call to the subagent", () => {
    const { initial, merged } = reattributionSession();
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", initial);
    expect(get().calls.get(merged.id)?.agentId).toBe("main");
    enqueueConsoleFrame("s1", frame(merged));
    tick();
    expect(get().calls.get(merged.id)?.agentId).toBe("sub_a");
    expect(get().order).toHaveLength(4);
  });

  it("flushConsoleFrames applies synchronously", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", errorsSession());
    enqueueConsoleFrame("s1", frame(makeToolCall(77)));
    flushConsoleFrames();
    expect(get().calls.has("toolu_77")).toBe(true);
  });

  it("conversation and todos keep identity when unchanged", () => {
    const st = useConsoleStore.getState();
    st.beginLoad("s1");
    st.applySnapshot("s1", errorsSession());
    const todos = [{ content: "a", status: "pending" as const }];
    st.setConversationAndTodos("s1", undefined, todos);
    const t1 = get().todos;
    st.setConversationAndTodos("s1", undefined, [
      { content: "a", status: "pending" as const },
    ]);
    expect(get().todos).toBe(t1);
  });

  it("evicts the least recently used session beyond 3", () => {
    const st = useConsoleStore.getState();
    for (const id of ["a", "b", "c"]) st.beginLoad(id);
    st.touch("a");
    enqueueConsoleFrame("b", frame(makeToolCall(1)));
    st.beginLoad("d");
    const s = useConsoleStore.getState();
    expect(Object.keys(s.sessions).sort()).toEqual(["a", "c", "d"]);
    expect(s.lru).toEqual(["c", "a", "d"]);
    expect(Object.keys(s.sessions)).toHaveLength(MAX_CONSOLE_SESSIONS);
  });

  it("touchLru is pure", () => {
    const base = ["a", "b", "c"];
    const r = touchLru(base, "d", 3);
    expect(r).toEqual({ list: ["b", "c", "d"], evicted: ["a"] });
    expect(base).toEqual(["a", "b", "c"]);
    expect(touchLru(base, "a", 3)).toEqual({
      list: ["b", "c", "a"],
      evicted: [],
    });
  });

  it("marks missing on 404 and holds status", () => {
    useConsoleStore.getState().markMissing("s1");
    expect(get().status).toBe("missing");
  });
});
