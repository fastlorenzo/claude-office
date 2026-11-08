import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useEffect: (fn: () => void) => void fn() }));

import { useWorldUiStore } from "@/stores/worldUiStore";
import { useHudKeys } from "./useHudKeys";

type Handler = (e: KeyboardEvent) => void;
let handler: Handler;

function key(code: string, k: string): KeyboardEvent {
  return {
    code,
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

let activeEl: unknown = null;

beforeEach(() => {
  activeEl = null;
  vi.stubGlobal("window", {
    addEventListener: (_: string, h: Handler) => {
      handler = h;
    },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    querySelector: () => null,
    activeElement: activeEl,
  });
  useWorldUiStore.getState().reset();
  useWorldUiStore.getState().setReady(true);
  useHudKeys();
});

describe("useHudKeys", () => {
  it("does not open a panel for engine-owned WASD while input is on", () => {
    for (const [c, k] of [
      ["KeyA", "a"],
      ["KeyW", "w"],
      ["KeyS", "s"],
      ["KeyD", "d"],
    ] as const)
      handler(key(c, k));
    expect(useWorldUiStore.getState().panels).toEqual([]);
  });

  it("opens Agents on T", () => {
    handler(key("KeyT", "t"));
    expect(useWorldUiStore.getState().panels).toEqual(["agents"]);
  });

  it("still toggles panels such as G and H", () => {
    handler(key("KeyG", "g"));
    handler(key("KeyH", "h"));
    expect(useWorldUiStore.getState().panels).toEqual(["git", "help"]);
  });

  it("toggles the console on I for the room you stand in", () => {
    useWorldUiStore.getState().setPose({
      x: 0,
      z: 0,
      yaw: 0,
      zone: { kind: "room", sessionId: "s1" },
    });
    handler(key("KeyI", "i"));
    const st = useWorldUiStore.getState();
    expect(st.panels).toEqual(["console"]);
    expect(st.consoleTarget?.sessionId).toBe("s1");
    handler(key("KeyI", "i"));
    expect(useWorldUiStore.getState().panels).toEqual([]);
  });

  it("falls back to the selected session for I", () => {
    useHudKeys("sel");
    handler(key("KeyI", "i"));
    expect(useWorldUiStore.getState().consoleTarget?.sessionId).toBe("sel");
  });

  it("ignores keys inside a keytrap except Esc", () => {
    useWorldUiStore.getState().open("help");
    activeEl = { tagName: "DIV", closest: () => ({}) };
    // activeElement was captured at stub time: re-stub with the trap active.
    vi.stubGlobal("document", {
      querySelector: () => null,
      activeElement: activeEl,
    });
    handler(key("KeyG", "g"));
    expect(useWorldUiStore.getState().panels).toEqual(["help"]);
    handler(key("Escape", "Escape"));
    expect(useWorldUiStore.getState().panels).toEqual([]);
  });

  it("Esc closes the console before ops", () => {
    const ui = useWorldUiStore.getState();
    ui.openOps();
    ui.openConsole("s1", { from: "ops" });
    handler(key("Escape", "Escape"));
    const st = useWorldUiStore.getState();
    expect(st.panels).toEqual([]);
    expect(st.opsOpen).toBe(true);
  });
});
