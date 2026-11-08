// @vitest-environment happy-dom
/**
 * Session Console accessibility (WS5): listbox semantics, accessible names,
 * labelled controls, and the "nothing below 12 px" rule over class names.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetConsoleQueues,
  setConsoleScheduler,
  useConsoleStore,
} from "../src/stores/consoleStore";
import { FIXTURE_SESSION_ID } from "../src/components/console/fixtures";
import { demoSession } from "../src/components/console/demoFixtures";
import { ConsoleClockContext } from "../src/components/console/clock";
import { SessionConsoleView } from "../src/components/console/SessionConsole";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
function mount(el: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function key(target: Element, k: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
}

function Console({ width }: { width: number }): ReactNode {
  const session = useConsoleStore((s) => s.sessions[FIXTURE_SESSION_ID]);
  return (
    <ConsoleClockContext.Provider value={Date.parse("2026-11-08T15:00:00Z")}>
      <SessionConsoleView
        sessionId={FIXTURE_SESSION_ID}
        session={session}
        presentation="sheet"
        width={width}
        onClose={() => undefined}
        onEnterRoom={() => undefined}
      />
    </ConsoleClockContext.Provider>
  );
}

const SIZE_PROPS = [
  "clientHeight",
  "clientWidth",
  "offsetHeight",
  "offsetWidth",
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const realRect = Element.prototype.getBoundingClientRect;
const tall = (el: Element) =>
  el.getAttribute("role") === "listbox" ? 2000 : 30;

beforeEach(() => {
  setConsoleScheduler((cb) => cb());
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const h = tall(this);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 900,
      bottom: h,
      width: 900,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  };
  for (const p of SIZE_PROPS) {
    saved.set(p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      get(this: HTMLElement) {
        return p.endsWith("Width") ? 900 : tall(this);
      },
    });
  }
  const s = useConsoleStore.getState();
  s.beginLoad(FIXTURE_SESSION_ID);
  s.applySnapshot(FIXTURE_SESSION_ID, demoSession("subagents").snap);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  Element.prototype.getBoundingClientRect = realRect;
  for (const p of SIZE_PROPS) {
    const d = saved.get(p);
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  }
  resetConsoleQueues();
  setConsoleScheduler(null);
  useConsoleStore.setState({ sessions: {}, lru: [] });
});

describe("timeline semantics", () => {
  for (const width of [1600, 1000, 390]) {
    it(`listbox + options + activedescendant at ${width}px`, () => {
      const host = mount(<Console width={width} />);
      const list = host.querySelector("[role=listbox]");
      expect(list).not.toBeNull();
      expect(list!.getAttribute("aria-label")).toBeTruthy();
      expect(list!.getAttribute("tabindex")).toBe("0");
      expect(host.querySelector("[data-hud-keytrap]")).not.toBeNull();
      const options = host.querySelectorAll("[role=option]");
      expect(options.length).toBeGreaterThan(5);
      for (const o of options) {
        expect(o.getAttribute("aria-label")).toBeTruthy();
        expect(o.hasAttribute("aria-selected")).toBe(true);
        expect(o.id).toBeTruthy();
      }
      key(list!, "j");
      const id = list!.getAttribute("aria-activedescendant");
      expect(id).toBeTruthy();
      expect(
        host
          .querySelector(`#${CSS.escape(id!)}`)
          ?.getAttribute("aria-selected"),
      ).toBe("true");
    });
  }

  it("Task rows expose aria-expanded", () => {
    const host = mount(<Console width={1600} />);
    const task = [...host.querySelectorAll("[role=option]")].find((o) =>
      o.getAttribute("aria-label")?.includes("Audit hook payloads"),
    );
    expect(task?.getAttribute("aria-expanded")).toBe("true");
  });

  it("error rows name their status; agent names are in every label", () => {
    const host = mount(<Console width={1600} />);
    const labels = [...host.querySelectorAll("[role=option]")].map(
      (o) => o.getAttribute("aria-label") ?? "",
    );
    const err = labels.find((l) => l.includes("pytest"));
    expect(err).toMatch(/error/);
    expect(err).toContain("Audit hook payloads");
    expect(labels.some((l) => l.startsWith("Main agent"))).toBe(true);
    expect(labels.every((l) => !l.includes("@subagent"))).toBe(true);
  });

  it("every button has an accessible name; tabs and toggles carry state", () => {
    const host = mount(<Console width={1600} />);
    for (const b of host.querySelectorAll("button")) {
      const name = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
      expect(name.length, b.outerHTML.slice(0, 120)).toBeGreaterThan(0);
    }
    const tabs = host.querySelectorAll("[role=tab]");
    expect(tabs.length).toBe(4);
    expect(
      [...tabs].filter((t) => t.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    expect(
      host.querySelectorAll("button[aria-pressed]").length,
    ).toBeGreaterThan(8);
    expect(host.querySelector("[role=tree]")).not.toBeNull();
  });
});

describe("no text below 12 px", () => {
  const root = join(__dirname, "../src");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
  const files = [
    ...walk(join(root, "components/console")),
    join(root, "components/layout/EventLog.tsx"),
    join(root, "components/layout/ConversationHistory.tsx"),
    join(root, "components/game/EventDetailModal.tsx"),
    join(root, "components/game/AgentStatus.tsx"),
    join(root, "app/console-debug/page.tsx"),
  ];

  it("uses no arbitrary font size under 12 px", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g)) {
        const px = m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
        if (px < 12) hits.push(`${f.slice(root.length + 1)}: ${m[0]}`);
      }
      for (const m of src.matchAll(/fontSize:\s*(\d+)/g)) {
        if (Number(m[1]) < 12)
          hits.push(`${f.slice(root.length + 1)}: ${m[0]}`);
      }
      // Tailwind sizes below text-xs (12 px) do not exist by default; guard custom ones.
      for (const m of src.matchAll(/\btext-(2xs|3xs|tiny|micro)\b/g)) {
        hits.push(`${f.slice(root.length + 1)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
