// @vitest-environment happy-dom
/**
 * Demo files in the "⋯" header menu: pick a .jsonl to play, export the session.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeaderMoreMenu } from "../src/components/layout/HeaderMoreMenu";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(props: Partial<Parameters<typeof HeaderMoreMenu>[0]> = {}) {
  const handlers = {
    debugMode: false,
    onSimulate: vi.fn(async () => {}),
    onPlayDemo: vi.fn(async (_file: File) => {}),
    onExportDemo: vi.fn(async () => {}),
    onReset: vi.fn(),
    onClearDB: vi.fn(),
    onToggleDebug: vi.fn(),
    ...props,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<HeaderMoreMenu {...handlers} />));
  return handlers;
}

function openMenu(): HTMLButtonElement[] {
  act(() => host!.querySelector<HTMLButtonElement>("button")!.click());
  return Array.from(
    host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("demo menu items", () => {
  it("exports the current session", () => {
    const handlers = mount();
    const items = openMenu();
    const exportItem = items.find((b) => b.textContent?.includes("EXPORT"));
    expect(exportItem).toBeDefined();
    act(() => exportItem!.click());
    expect(handlers.onExportDemo).toHaveBeenCalledOnce();
    // The menu closes after an action.
    expect(host!.querySelector('[role="menu"]')).toBeNull();
  });

  it("plays the picked demo file", () => {
    const handlers = mount();
    const input = host!.querySelector<HTMLInputElement>(
      '[data-testid="demo-file-input"]',
    )!;
    const clicked = vi.spyOn(input, "click").mockImplementation(() => {});
    const playItem = openMenu().find((b) =>
      b.textContent?.includes("DEMO FILE"),
    );
    act(() => playItem!.click());
    expect(clicked).toHaveBeenCalledOnce();

    const file = new File(['{"event_type": "stop"}\n'], "pitch.jsonl", {
      type: "application/x-ndjson",
    });
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(handlers.onPlayDemo).toHaveBeenCalledWith(file);
  });
});
