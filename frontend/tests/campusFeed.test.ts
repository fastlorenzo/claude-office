/**
 * WS1 (D1-D10, U4 LinePanel): data integrity and the live campus feed.
 * The hook is exercised against a fake socket under a tiny hook runtime (no
 * DOM); everything else is pure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- minimal react hook runtime (the four hooks useCampusWebSocket uses) ----
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
vi.mock("zustand", async () => {
  const vanilla =
    await vi.importActual<typeof import("zustand/vanilla")>("zustand/vanilla");
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

import type {
  CampusProject,
  CampusSession,
  PullRequestInfo,
} from "@/engine/contracts";
import { demoFactoryProjects } from "@/engine/demo/demoFactory";
import {
  getFactoryLive,
  liveLine,
  publishFactoryLive,
} from "@/engine/logic/factoryLive";
import {
  STATE_RANK,
  STALE_PR_MS,
  buildFactoryModel,
  worseState,
} from "@/engine/logic/factoryModel";
import { buildOpsModel as buildOps } from "@/engine/logic/opsModel";
import { projectGroups } from "@/engine/logic/projectMap";
import { FactorySync } from "@/engine/world/factory/factorySync";
import { useCampusWebSocket } from "@/hooks/useCampusWebSocket";
import { useCampusStore } from "@/stores/campusStore";
import {
  CONNECT_GRACE_MS,
  STALL_MS,
  connectionStatus,
} from "@/components/world/hud/connectionStatus";
import {
  lineFor,
  lineView,
  queuePosition,
} from "@/components/world/hud/factory/factoryPanelModel";
import {
  connectLiveCampus,
  liveSessionMetas,
} from "@/app/world-debug/liveFeed";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const D = 24 * 3600 * 1000;

function pr(n: number, extra: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: n,
    title: `PR ${n}`,
    branch: `feat/${n}`,
    draft: false,
    state: "open",
    checks: {
      state: "success",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      runs: [],
    },
    updatedAt: new Date(NOW - n * 60_000).toISOString(),
    ...extra,
  } as PullRequestInfo;
}
function project(
  id: string,
  prs: PullRequestInfo[],
  extra: Partial<CampusProject> = {},
): CampusProject {
  return {
    id,
    name: id.split("/")[1] ?? id,
    repo: id,
    defaultBranch: "main",
    sessionIds: [],
    pullRequests: prs,
    pipelines: [],
    ciAvailable: true,
    updatedAt: new Date(NOW).toISOString(),
    ...extra,
  };
}
const input = (
  projects: CampusProject[] | null | undefined,
  ids: string[] = ["a/x"],
) => ({
  projects,
  campus: [] as CampusSession[],
  nowMs: NOW,
  lanesFor: () => 4,
  cellIds: ids,
});

// ---------------------------------------------------------------------------
describe("D1: an empty feed is real data, never demo", () => {
  it("projects [] yields zero pieces and no demo ids", () => {
    const sync = new FactorySync();
    const r = sync.update({ ...input([]), demo: false });
    expect(sync.stats.demo).toBe(false);
    expect(r.projects).toEqual([]);
    expect(sync.stats.pieces).toBe(0);
    expect(r.model?.lines ?? []).toHaveLength(0);
    expect(JSON.stringify(r.model)).not.toMatch(/acme/);
  });

  it("null / undefined feeds are not demo either; cells without data stay empty", () => {
    for (const projects of [null, undefined]) {
      const sync = new FactorySync();
      sync.update(input(projects));
      expect(sync.stats.demo).toBe(false);
      expect(sync.stats.pieces).toBe(0);
    }
  });

  it("demo only when forced, or undefined + the dev fallback", () => {
    const forced = new FactorySync();
    forced.update({ ...input([]), demo: true });
    expect(forced.stats.demo).toBe(true);
    expect(forced.stats.pieces).toBeGreaterThan(0);
    const dev = new FactorySync();
    dev.update({ ...input(undefined), devFallback: true });
    expect(dev.stats.demo).toBe(true);
    const devButNull = new FactorySync();
    devButNull.update({ ...input(null), devFallback: true });
    expect(devButNull.stats.demo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("D3: the panel and the 3D scene share one model", () => {
  it("lineFor agrees with the published scene model on lane and queue for every piece", () => {
    const projects = demoFactoryProjects([], NOW, { projects: 4 });
    const lanes = 1; // tiny cells force overflow onto the intake rack
    const sync = new FactorySync();
    sync.update({
      projects,
      campus: [],
      nowMs: NOW,
      lanesFor: () => lanes,
      cellIds: projects.map((p) => p.id),
    });
    const snap = getFactoryLive();
    expect(snap?.demo).toBe(false);
    let pieces = 0;
    let queued = 0;
    for (const p of projects) {
      const scene = liveLine(snap, p.id)!.line;
      const panel = lineFor(p, [], NOW, { lanesFor: () => lanes })!;
      expect(panel.workpieces.map((w) => [w.id, w.lane])).toEqual(
        scene.workpieces.map((w) => [w.id, w.lane]),
      );
      for (const w of scene.workpieces) {
        const mine = panel.workpieces.find((x) => x.id === w.id)!;
        expect(queuePosition(panel, mine)).toBe(queuePosition(scene, w));
        pieces++;
        if (w.stamp === "QUEUED") queued++;
      }
    }
    expect(pieces).toBeGreaterThan(0);
    expect(queued).toBeGreaterThan(0);
  });

  it("publishes the model (and demo flag) for the HUD", () => {
    const sync = new FactorySync();
    sync.update({ ...input([project("o/r", [pr(1)])]), demo: true });
    expect(getFactoryLive()?.demo).toBe(true);
    publishFactoryLive(null);
    expect(liveLine(getFactoryLive(), "o/r")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("D4/D5/D6: one definition each", () => {
  const model = (p: PullRequestInfo) =>
    buildFactoryModel([project("o/r", [p])], [], NOW).lines[0].workpieces[0];

  it("honours pr.stale over the age fallback (14 d)", () => {
    expect(STALE_PR_MS).toBe(14 * D);
    const recent = pr(1, { updatedAt: new Date(NOW - D).toISOString() });
    expect(model({ ...recent, stale: true }).position.segment).toBe("holding");
    const tenDays = pr(1, { updatedAt: new Date(NOW - 10 * D).toISOString() });
    expect(model({ ...tenDays, stale: false }).position.segment).not.toBe(
      "holding",
    );
    expect(model(tenDays).position.segment).not.toBe("holding"); // fallback < 14 d
    const old = pr(1, { updatedAt: new Date(NOW - 15 * D).toISOString() });
    expect(model(old).position.segment).toBe("holding"); // fallback > 14 d
  });

  it("one STATE_RANK: cancelled is worse than success everywhere", () => {
    expect(STATE_RANK.cancelled).toBeGreaterThan(STATE_RANK.success);
    expect(worseState("success", "cancelled")).toBe("cancelled");
    const cancelledOnly = project("o/r", [
      pr(1, {
        checks: {
          state: "cancelled",
          total: 1,
          passed: 0,
          failed: 0,
          pending: 0,
          runs: [],
        },
      }),
      pr(2),
    ]);
    const g = projectGroups([], [cancelledOnly]).find((x) => x.id === "o/r");
    expect(g?.ci).toBe("cancelled");
  });

  it("the trunk rolls up from mainHealth, not pipelines[0]", () => {
    const p = project("o/r", [], {
      mainHealth: "failure",
      pipelines: [
        { id: "1", workflow: "ci", kind: "deploy", state: "success" },
      ] as CampusProject["pipelines"],
    });
    expect(projectGroups([], [p]).find((x) => x.id === "o/r")?.ci).toBe(
      "failure",
    );
  });

  it("subagent rows use the backend's inactive states", () => {
    const cs = (state: string) =>
      ({
        sessionId: "s",
        bucket: "working",
        boss: { state: "working" },
        agents: [
          { id: "a", state },
          { id: "b", state: "working" },
        ],
        office: {},
        todos: [],
        recentActivity: [],
        ended: false,
        lastUpdated: new Date(NOW).toISOString(),
      }) as unknown as CampusSession;
    for (const s of ["completed", "leaving", "reporting_done", "in_elevator"])
      expect(buildOps([cs(s)], null, NOW).rows[0].subagents).toBe(1);
    expect(buildOps([cs("thinking")], null, NOW).rows[0].subagents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("D7/U4: LinePanel view model", () => {
  it("carries ciError, fetched age, demo flag and PR links", () => {
    const p = project(
      "o/r",
      [pr(7, { url: "https://github.com/o/r/pull/7" })],
      {
        ciError: "gh: not authenticated",
        fetchedAt: new Date(NOW - 5 * 60_000).toISOString(),
        stale: true,
      },
    );
    const line = lineFor(p, [], NOW)!;
    const v = lineView(p, line, NOW, true);
    expect(v.ciError).toBe("gh: not authenticated");
    expect(v.fetched).toEqual({ key: "factory.ago.m", n: 5 });
    expect(v.demo).toBe(true);
    expect(v.prs[0].url).toBe("https://github.com/o/r/pull/7");
    expect(lineView(p, line, NOW).demo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("D2/D10: store frames", () => {
  beforeEach(() => useCampusStore.getState().clear());
  const sessions = [{ sessionId: "a" }] as unknown as CampusSession[];

  it("lastUpdated advances on every accepted frame, even identical ones", () => {
    const { acceptFrame } = useCampusStore.getState();
    acceptFrame({ sessions });
    const t1 = useCampusStore.getState().lastUpdated!;
    acceptFrame({ sessions });
    const t2 = useCampusStore.getState().lastUpdated!;
    expect(t2).toBeGreaterThan(t1);
  });

  it("skips sections whose server rev is unchanged (no compare, same reference)", () => {
    const { acceptFrame } = useCampusStore.getState();
    const revs = { sessions: "1", projects: "1", stats: "1" };
    acceptFrame({ sessions, revs });
    const first = useCampusStore.getState().sessions;
    // Same rev: even different content is not applied (the server says equal).
    acceptFrame({ sessions: [{ sessionId: "b" }] as never, revs });
    expect(useCampusStore.getState().sessions).toBe(first);
    acceptFrame({
      sessions: [{ sessionId: "b" }] as never,
      revs: { ...revs, sessions: "2" },
    });
    expect(useCampusStore.getState().sessions[0].sessionId).toBe("b");
  });

  it("falls back to a structural compare without revs (older backends)", () => {
    const { acceptFrame } = useCampusStore.getState();
    acceptFrame({ sessions, projects: [] });
    const s = useCampusStore.getState().sessions;
    acceptFrame({ sessions: structuredClone(sessions), projects: [] });
    expect(useCampusStore.getState().sessions).toBe(s);
  });
});

describe("connection status", () => {
  const base = { connected: true, lastUpdated: 1_000, closeCode: null };
  it("ok while frames are fresh, stalled after 30 s of silence", () => {
    expect(connectionStatus(base, 1_000 + STALL_MS, 99_999).kind).toBe("ok");
    expect(connectionStatus(base, 1_001 + STALL_MS, 99_999).kind).toBe(
      "stalled",
    );
  });
  it("reconnecting keeps the time of the last data", () => {
    expect(
      connectionStatus({ ...base, connected: false }, 5_000, 99_999),
    ).toEqual({
      kind: "reconnecting",
      since: 1_000,
    });
  });
  it("first connect gets a grace period; 4003 and 4013 are named", () => {
    const fresh = { connected: false, lastUpdated: null, closeCode: null };
    expect(connectionStatus(fresh, 0, CONNECT_GRACE_MS - 1).kind).toBe("ok");
    expect(connectionStatus(fresh, 0, CONNECT_GRACE_MS).kind).toBe(
      "connecting",
    );
    expect(connectionStatus({ ...fresh, closeCode: 4013 }, 0, 0).kind).toBe(
      "tooMany",
    );
    expect(connectionStatus({ ...fresh, closeCode: 4003 }, 0, 0).kind).toBe(
      "origin",
    );
    expect(connectionStatus({ ...base, closeCode: 4003 }, 0, 0).kind).toBe(
      "origin",
    );
  });
});

// ---------------------------------------------------------------------------
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close(): void {}
  open(): void {
    this.onopen?.();
  }
  send(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code, reason: "" });
  }
}
const frame = (ids: string[], state: Record<string, unknown> = {}) => ({
  type: "state_update",
  state: {
    sessions: ids.map((sessionId) => ({ sessionId })),
    projects: [],
    ...state,
  },
});

function mount(enabled: boolean): void {
  rt.i = 0;
  rt.effects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- test harness
  useCampusWebSocket({ enabled });
  for (const e of rt.effects) e();
}
function unmount(): void {
  for (const s of rt.slots) if (typeof s.cleanup === "function") s.cleanup();
  rt.slots = [];
}

describe("useCampusWebSocket (WS1)", () => {
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

  it("a drop keeps the last data, flips connected, and lastUpdated advances after reconnect", () => {
    mount(true);
    const a = FakeSocket.all[0];
    a.open();
    a.send(frame(["a"]));
    const t1 = useCampusStore.getState().lastUpdated!;
    a.drop();
    const dropped = useCampusStore.getState();
    expect(dropped.connected).toBe(false);
    expect(dropped.sessions).toHaveLength(1); // data kept (banner shows its age)
    expect(dropped.lastUpdated).toBe(t1);
    expect(connectionStatus(dropped, t1 + 5_000, 99_999).kind).toBe(
      "reconnecting",
    );
    vi.advanceTimersByTime(1_600);
    const b = FakeSocket.all[1];
    b.open();
    b.send(frame(["a"]));
    b.send(frame(["a"])); // identical payload: still a live frame
    const t3 = useCampusStore.getState().lastUpdated!;
    expect(t3).toBeGreaterThan(t1);
    b.send(frame(["a"]));
    expect(useCampusStore.getState().lastUpdated!).toBeGreaterThan(t3);
    expect(useCampusStore.getState().connected).toBe(true);
  });

  it("stops retrying on 4003 and records the code", () => {
    mount(true);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(4003);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(useCampusStore.getState().closeCode).toBe(4003);
  });

  it("keeps retrying on 4013 (slowly) and records the code", () => {
    mount(true);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(4013);
    expect(useCampusStore.getState().closeCode).toBe(4013);
    vi.advanceTimersByTime(9_000);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("applies revs and sentAt from the frame", () => {
    mount(true);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.send(
      frame(["a"], {
        sentAt: 123,
        revs: { sessions: "x", projects: "y", stats: "z" },
      }),
    );
    const s = useCampusStore.getState();
    expect(s.sentAt).toBe(123);
    expect(s.revs?.sessions).toBe("x");
  });
});

describe("world-debug live feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconnects with backoff, stops on 4003, reports status", () => {
    const states: number[] = [];
    const status: [boolean, number | null][] = [];
    const close = connectLiveCampus(
      (s) => states.push(s.campus.length),
      (c, code) => status.push([c, code]),
    );
    FakeSocket.all[0].open();
    FakeSocket.all[0].send(frame(["a", "b"]));
    expect(states).toEqual([2]);
    FakeSocket.all[0].drop();
    vi.advanceTimersByTime(1_600);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].drop(4003);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(status.at(-1)).toEqual([false, 4003]);
    close();
  });

  it("derives session status from the feed instead of hard-coding active", () => {
    const metas = liveSessionMetas([
      { sessionId: "a", ended: false },
      { sessionId: "b", ended: true },
    ] as unknown as CampusSession[]);
    expect(metas.map((m) => m.status)).toEqual(["active", "completed"]);
  });
});
