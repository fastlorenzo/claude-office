import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConsoleQueues, useConsoleStore } from "@/stores/consoleStore";
import { MAX_SEEK_PAGES, seekCall } from "@/utils/console/focusCall";
import { errorsSession, makeToolCall } from "@/components/console/fixtures";
import type { ToolCallDetail } from "@/utils/console/types";

const SID = "s1";

function setup(targetSeq: number) {
  resetConsoleQueues();
  useConsoleStore.setState({ sessions: {}, lru: [] });
  const st = useConsoleStore.getState();
  st.beginLoad(SID);
  const snap = errorsSession();
  st.applySnapshot(SID, { ...snap, hasMore: true });
  const oldest = useConsoleStore.getState().sessions[SID].oldestSeq!;
  const target = makeToolCall(targetSeq, { id: "far" });
  return { oldest, target };
}

const detailOf = (call: ReturnType<typeof makeToolCall>): ToolCallDetail =>
  ({ call, input: {}, output: null }) as unknown as ToolCallDetail;

describe("seekCall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("injects the call, then pages back to it", async () => {
    const { oldest, target } = setup(-100);
    let page = 0;
    const loadOlder = vi.fn(async () => {
      const s = useConsoleStore.getState().sessions[SID];
      page++;
      const seq = s.oldestSeq! - 40;
      useConsoleStore
        .getState()
        .applyOlderPage(SID, [makeToolCall(seq, { id: `p${page}` })], true);
    });
    const ok = await seekCall(SID, "far", {
      fetchDetail: async () => detailOf(target),
      loadOlder,
      sleep: async () => undefined,
    });
    expect(ok).toBe(true);
    const s = useConsoleStore.getState().sessions[SID];
    expect(s.calls.has("far")).toBe(true);
    expect(s.oldestSeq).toBeLessThanOrEqual(-100);
    expect(loadOlder.mock.calls.length).toBeGreaterThan(1);
    expect(oldest).toBeGreaterThan(-100);
  });

  it("injected call does not move the paging cursor", async () => {
    const { oldest, target } = setup(-100);
    useConsoleStore.getState().putFocusedCall(SID, target);
    const s = useConsoleStore.getState().sessions[SID];
    expect(s.calls.has("far")).toBe(true);
    expect(s.oldestSeq).toBe(oldest);
  });

  it("stops at the page cap", async () => {
    const { target } = setup(-1_000_000);
    const loadOlder = vi.fn(async () => {
      const s = useConsoleStore.getState().sessions[SID];
      useConsoleStore
        .getState()
        .applyOlderPage(
          SID,
          [makeToolCall(s.oldestSeq! - 1, { id: `q${s.oldestSeq}` })],
          true,
        );
    });
    await seekCall(SID, "far", {
      fetchDetail: async () => detailOf(target),
      loadOlder,
      sleep: async () => undefined,
    });
    expect(loadOlder).toHaveBeenCalledTimes(MAX_SEEK_PAGES);
  });

  it("returns false when the call does not exist", async () => {
    setup(0);
    const loadOlder = vi.fn(async () => undefined);
    const ok = await seekCall(SID, "nope", {
      fetchDetail: async () => null,
      loadOlder,
    });
    expect(ok).toBe(false);
    expect(loadOlder).not.toHaveBeenCalled();
  });
});
