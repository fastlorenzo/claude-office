/**
 * C6: `useCampusWebSocket` against a fake socket (no DOM / testing-library:
 * `react` is replaced by a tiny hook runtime that supports the four hooks the
 * hook uses). Behaviour under test: connect, apply frames, reconnect with
 * backoff, connection-id guard, teardown.
 *
 * Tests tagged WS1 encode the review-plan acceptance (D2/D9/D10) for work that
 * lands in the live-feed workstream; they are `skip`ped until it does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- minimal react hook runtime -------------------------------------------
interface Slot {
  v?: unknown;
  deps?: unknown[];
  cleanup?: void | (() => void);
}
const rt = { slots: [] as Slot[], i: 0, effects: [] as (() => void)[] };

vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const s = (rt.slots[rt.i] ??= { v: { current: init } });
    rt.i++;
    return s.v;
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const s = (rt.slots[rt.i] ??= { v: fn, deps });
    if (!s.deps || deps.some((d, k) => d !== (s.deps as unknown[])[k])) {
      s.v = fn;
      s.deps = deps;
    }
    rt.i++;
    return s.v;
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const s = (rt.slots[rt.i] ??= {});
    const idx = rt.i;
    rt.i++;
    if (
      !s.deps ||
      deps.length !== s.deps.length ||
      deps.some((d, k) => d !== (s.deps as unknown[])[k])
    ) {
      s.deps = deps;
      rt.effects.push(() => {
        const slot = rt.slots[idx];
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = fn();
      });
    }
  },
}));

// zustand's React binding uses the real react; give the store a hook that just
// reads the vanilla store so it works under the fake runtime.
vi.mock("zustand", async () => {
  const vanilla = await vi.importActual<typeof import("zustand/vanilla")>(
    "zustand/vanilla",
  );
  return {
    create: () => (init: never) => {
      const api = vanilla.createStore(init);
      const use = ((sel?: (s: unknown) => unknown) =>
        sel ? sel(api.getState()) : api.getState()) as unknown as Record<
        string,
        unknown
      >;
      return Object.assign(use, api);
    },
  };
});

vi.mock("@/utils/api", () => ({ WS_BASE: "ws://test" }));

import { useCampusStore } from "@/stores/campusStore";
import { useCampusWebSocket } from "@/hooks/useCampusWebSocket";

// Alias without the `use` prefix: this harness is not a React component.
const runHook = useCampusWebSocket;

function render(enabled: boolean): void {
  rt.i = 0;
  rt.effects = [];
  runHook({ enabled });
  // effects run after "commit"; effects that re-render are not needed here
  for (const e of rt.effects) e();
  // second pass so refs set in effects (connectRef) are visible, as in React
}

function unmount(): void {
  for (const s of rt.slots) {
    if (typeof s.cleanup === "function") s.cleanup();
  }
  rt.slots = [];
}

// ---- fake socket ----------------------------------------------------------
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  send(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code = 1006, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

const session = (id: string) => ({ sessionId: id }) as never;
const frame = (ids: string[], extra: Record<string, unknown> = {}) => ({
  type: "state_update",
  state: { sessions: ids.map(session), stats: null, projects: [], ...extra },
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useCampusStore.getState().clear();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCampusWebSocket", () => {
  it("connects to /ws/campus and flags connected on open", () => {
    render(true);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].url).toBe("ws://test/ws/campus");
    expect(useCampusStore.getState().connected).toBe(false);
    FakeSocket.all[0].open();
    expect(useCampusStore.getState().connected).toBe(true);
  });

  it("does not connect while disabled", () => {
    render(false);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("applies state_update frames to the store", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(frame(["a", "b"], { projects: [{ id: "o/r" }] }));
    const s = useCampusStore.getState();
    expect(s.sessions.map((x) => x.sessionId)).toEqual(["a", "b"]);
    expect(s.projects).toEqual([{ id: "o/r" }]);
    expect(s.lastUpdated).not.toBeNull();
  });

  it("ignores malformed frames without clobbering state", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(frame(["a"]));
    ws.send({ type: "state_update", state: { sessions: "nope" } });
    ws.onmessage?.({ data: "{not json" });
    expect(useCampusStore.getState().sessions).toHaveLength(1);
  });

  it("reconnects after a drop with exponential backoff and resets on open", () => {
    render(true);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop();
    expect(useCampusStore.getState().connected).toBe(false);
    // 1st retry: 1000 + <500 jitter
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
    // fails to open: 2nd retry waits 2000+
    FakeSocket.all[1].drop();
    vi.advanceTimersByTime(1900);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(700);
    expect(FakeSocket.all).toHaveLength(3);
    // opens -> counter resets: next drop retries after ~1 s again
    FakeSocket.all[2].open();
    expect(useCampusStore.getState().connected).toBe(true);
    FakeSocket.all[2].drop();
    vi.advanceTimersByTime(1600);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("caps the backoff at 30 s (+ jitter)", () => {
    render(true);
    for (let k = 0; k < 8; k++) {
      FakeSocket.all[FakeSocket.all.length - 1].drop();
      vi.advanceTimersByTime(30_600);
    }
    const n = FakeSocket.all.length;
    FakeSocket.all[n - 1].drop();
    vi.advanceTimersByTime(30_600);
    expect(FakeSocket.all).toHaveLength(n + 1);
  });

  it("ignores events from a superseded socket (connection-id guard)", () => {
    render(true);
    const old = FakeSocket.all[0];
    old.open();
    old.drop();
    vi.advanceTimersByTime(1600);
    const fresh = FakeSocket.all[1];
    fresh.open();
    fresh.send(frame(["fresh"]));
    old.send(frame(["stale"]));
    old.drop(); // must not schedule another reconnect or flip connected
    expect(useCampusStore.getState().connected).toBe(true);
    expect(useCampusStore.getState().sessions[0].sessionId).toBe("fresh");
    vi.advanceTimersByTime(40_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("closes the socket, cancels the retry and clears the store on unmount", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(frame(["a"]));
    ws.drop();
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(useCampusStore.getState().sessions).toEqual([]);
    expect(useCampusStore.getState().connected).toBe(false);
  });

  it("does not reconnect when disabled between drop and retry", () => {
    render(true);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop();
    render(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  // ---- WS1 acceptance (D2, D9, D10) ----------------------------------------
  it("stops retrying on close code 4003 and records it", () => {
    render(true);
    FakeSocket.all[0].drop(4003, "origin");
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(useCampusStore.getState().closeCode).toBe(4003);
  });

  it("records 4013 and keeps retrying, but no sooner than 10 s", () => {
    render(true);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(4013, "cap");
    expect(useCampusStore.getState().closeCode).toBe(4013);
    vi.advanceTimersByTime(9_900);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open(); // a successful open clears the code
    expect(useCampusStore.getState().closeCode).toBeNull();
  });

  it("keeps the last data after a drop (the banner marks it stale)", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(frame(["a"]));
    ws.drop();
    const s = useCampusStore.getState();
    expect(s.connected).toBe(false);
    expect(s.sessions).toHaveLength(1);
    expect(s.lastUpdated).not.toBeNull();
  });

  it("advances lastUpdated on every frame, even when the payload is unchanged", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(frame(["a"]));
    const t1 = useCampusStore.getState().lastUpdated as number;
    ws.send(frame(["a"]));
    const t2 = useCampusStore.getState().lastUpdated as number;
    ws.send(frame(["a"]));
    const t3 = useCampusStore.getState().lastUpdated as number;
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });

  it("skips replacing a section whose rev did not move (per-section revs)", () => {
    render(true);
    const ws = FakeSocket.all[0];
    ws.open();
    const revs = { sessions: "r1", projects: "p1", stats: "s1" };
    ws.send(frame(["a"], { revs }));
    const first = useCampusStore.getState().sessions;
    // same rev, different content: trusted as identical, array kept
    ws.send(frame(["a", "b"], { revs }));
    expect(useCampusStore.getState().sessions).toBe(first);
    // rev moved: replaced
    ws.send(frame(["a", "b"], { revs: { ...revs, sessions: "r2" } }));
    expect(useCampusStore.getState().sessions).toHaveLength(2);
  });
});
