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

beforeEach(() => {
  vi.stubGlobal("window", {
    addEventListener: (_: string, h: Handler) => {
      handler = h;
    },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    querySelector: () => null,
    activeElement: null,
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
});
