// @vitest-environment happy-dom
/**
 * Session Console UI (WS5): virtualization, keyboard map, tool renderers,
 * legacy event-log fallback.
 */

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/consoleApi", () => ({
  fetchConsoleSnapshot: vi.fn(async () => null),
  fetchOlderCalls: vi.fn(async () => null),
  fetchToolCallDetail: vi.fn(async () => null),
}));

import {
  resetConsoleQueues,
  setConsoleScheduler,
  useConsoleStore,
} from "../src/stores/consoleStore";
import { useGameStore } from "../src/stores/gameStore";
import {
  FIXTURE_SESSION_ID,
  longSession,
  makeAgent,
  makeToolCall,
  MAIN_AGENT,
} from "../src/components/console/fixtures";
import { demoSession } from "../src/components/console/demoFixtures";
import { ConsoleClockContext } from "../src/components/console/clock";
import {
  SessionConsole,
  SessionConsoleView,
} from "../src/components/console/SessionConsole";
import { ToolCallDetailModal } from "../src/components/console/ToolCallDetail";
import { ToolBody } from "../src/components/console/renderers/ToolBody";
import { EventLog } from "../src/components/layout/EventLog";
import type { ConsoleSnapshot, ToolCall } from "../src/utils/console/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<() => void> = [];
function mount(el: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function seed(snap: ConsoleSnapshot): void {
  const s = useConsoleStore.getState();
  s.beginLoad(FIXTURE_SESSION_ID);
  s.applySnapshot(FIXTURE_SESSION_ID, snap);
}

function Harness(props: {
  width: number;
  presentation?: "sheet" | "dock" | "compact";
  onClose?: () => void;
  focusCallId?: string;
}): ReactNode {
  const session = useConsoleStore((s) => s.sessions[FIXTURE_SESSION_ID]);
  return (
    <ConsoleClockContext.Provider value={Date.parse("2026-11-08T15:00:00Z")}>
      <SessionConsoleView
        sessionId={FIXTURE_SESSION_ID}
        session={session}
        presentation={props.presentation ?? "dock"}
        width={props.width}
        onClose={props.onClose}
        focusCallId={props.focusCallId}
      />
    </ConsoleClockContext.Provider>
  );
}

// happy-dom has no layout: give the list a 600 px viewport and rows 30 px.
const realRect = Element.prototype.getBoundingClientRect;
const heightOf = (el: Element) =>
  el.getAttribute("role") === "listbox" ? 600 : 30;
const SIZE_PROPS = [
  "clientHeight",
  "clientWidth",
  "offsetHeight",
  "offsetWidth",
] as const;
const savedProps = new Map<string, PropertyDescriptor | undefined>();
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const h = heightOf(this);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 600,
      bottom: h,
      width: 600,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  };
  for (const p of SIZE_PROPS) {
    savedProps.set(
      p,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, p),
    );
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      get(this: HTMLElement) {
        return p.endsWith("Width") ? 600 : heightOf(this);
      },
    });
  }
}
function unstubLayout(): void {
  Element.prototype.getBoundingClientRect = realRect;
  for (const p of SIZE_PROPS) {
    const d = savedProps.get(p);
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  }
}

beforeEach(() => {
  setConsoleScheduler((cb) => cb());
  stubLayout();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  unstubLayout();
  resetConsoleQueues();
  setConsoleScheduler(null);
  useConsoleStore.setState({ sessions: {}, lru: [] });
});

describe("virtualization", () => {
  it("mounts fewer than 80 rows for a 5000-call session", () => {
    seed(longSession(5000));
    const host = mount(<Harness width={1600} presentation="sheet" />);
    const rows = host.querySelectorAll("[role=option]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(80);
    // The whole list is represented by the spacer height, not by nodes.
    expect(host.querySelectorAll("[data-index]").length).toBeLessThan(80);
  });
});

describe("keyboard", () => {
  function setup(onClose = vi.fn()) {
    const snap: ConsoleSnapshot = {
      ...demoSession("errors").snap,
    };
    seed(snap);
    const host = mount(<Harness width={640} onClose={onClose} />);
    const list = host.querySelector("[role=listbox]")!;
    return { host, list, onClose };
  }
  const active = (list: Element) => list.getAttribute("aria-activedescendant");
  const activeRow = (host: Element, list: Element) =>
    host.querySelector(`#${CSS.escape(active(list) ?? "")}`);

  it("j / k move the selection", () => {
    const { host, list } = setup();
    expect(active(list)).toBeNull();
    key(list, "j");
    const first = active(list);
    expect(first).toBeTruthy();
    key(list, "j");
    expect(active(list)).not.toBe(first);
    key(list, "k");
    expect(active(list)).toBe(first);
    expect(activeRow(host, list)?.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter expands a row inline and ← collapses it", () => {
    const { host, list } = setup();
    key(list, "j");
    key(list, "Enter");
    expect(activeRow(host, list)?.getAttribute("aria-expanded")).toBe("true");
    key(list, "ArrowLeft");
    expect(activeRow(host, list)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("] and [ jump between error rows", () => {
    const { host, list } = setup();
    key(list, "]");
    const a = activeRow(host, list);
    expect(a?.getAttribute("aria-label")).toMatch(/error/);
    key(list, "]");
    const b = activeRow(host, list);
    expect(b?.getAttribute("aria-label")).toMatch(/error/);
    expect(b).not.toBe(a);
    key(list, "[");
    expect(activeRow(host, list)?.id).toBe(a?.id);
  });

  it("/ focuses the search box", () => {
    const { host, list } = setup();
    key(list, "/");
    expect(document.activeElement).toBe(
      host.querySelector("input[type=search]"),
    );
  });

  it("e toggles errors-only", () => {
    const { host, list } = setup();
    const before = host.querySelectorAll("[role=option]").length;
    key(list, "e");
    const rows = [...host.querySelectorAll("[role=option]")];
    expect(rows.length).toBeLessThan(before);
    // Error rows and the Task row keeping its failing child.
    expect(
      rows.some((r) => /error/.test(r.getAttribute("aria-label") ?? "")),
    ).toBe(true);
    key(list, "e");
    expect(host.querySelectorAll("[role=option]").length).toBe(before);
  });

  it("f toggles live-follow (paused pill)", () => {
    const { host, list } = setup();
    const pill = () =>
      [...host.querySelectorAll("button")].find((b) =>
        /Paused/.test(b.textContent ?? ""),
      );
    expect(pill()).toBeUndefined();
    key(list, "f");
    expect(pill()).toBeDefined();
    key(list, "f");
    expect(pill()).toBeUndefined();
  });

  it("Esc clears the selection, then closes the console", () => {
    const { list, onClose } = setup();
    key(list, "j");
    expect(active(list)).toBeTruthy();
    key(list, "Escape");
    expect(active(list)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    key(list, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a deep-linked call is selected and revealed", () => {
    seed(demoSession("subagents").snap);
    const host = mount(
      <Harness
        width={1600}
        presentation="sheet"
        focusCallId="toolu_edit_store"
      />,
    );
    const list = host.querySelector("[role=listbox]")!;
    expect(active(list)).toContain("toolu_edit_store");
    // The Detail pane shows the diff of that Edit.
    expect(host.textContent).toContain("frontend/src/stores/consoleStore.ts");
  });
});

describe("tool renderers", () => {
  const agents = new Map([
    ["main", MAIN_AGENT],
    [
      "sub_a",
      makeAgent("sub_a", {
        name: "Audit hook payloads",
        color: "#3B82F6",
        spawnToolUseId: "toolu_9",
        toolCalls: 3,
        resultPreview: "Found **two** issues.",
      }),
    ],
  ]);
  const cases: Array<[string, Partial<ToolCall>]> = [
    [
      "Edit",
      {
        toolName: "Edit",
        inputPreview: {
          file_path: "src/a.ts",
          old_string: "const a = 1;\nconst b = 2;",
          new_string: "const a = 1;\nconst b = 3;",
        },
      },
    ],
    [
      "MultiEdit",
      {
        toolName: "MultiEdit",
        inputPreview: {
          file_path: "src/a.py",
          edits: [
            { old_string: "x = 1", new_string: "x = 2" },
            {
              old_string: "def f():",
              new_string: "def g():",
              replace_all: true,
            },
          ],
        },
      },
    ],
    [
      "Write",
      {
        toolName: "Write",
        inputPreview: {
          file_path: "docs/n.md",
          content: "# Title\n\nSome `code`.",
        },
      },
    ],
    [
      "Read",
      {
        toolName: "Read",
        inputPreview: { file_path: "src/b.go", offset: 10, limit: 3 },
        outputPreview: "func main() {\n\treturn 42 // answer\n}",
      },
    ],
    [
      "Bash",
      {
        toolName: "Bash",
        status: "error",
        error: "exit 1",
        inputPreview: {
          command: "uv run pytest -q && echo $HOME",
          description: "Run tests",
        },
        outputPreview: "....F\nFAILED t.py::x\n--- stderr ---\nboom",
        outputBytes: 9000,
        outputTruncated: true,
      },
    ],
    [
      "Grep",
      {
        toolName: "Grep",
        inputPreview: { pattern: "TODO", path: "src", "-i": true },
        outputPreview: "src/a.ts:3: // TODO\nsrc/b.ts",
      },
    ],
    [
      "WebFetch",
      {
        toolName: "WebFetch",
        inputPreview: { url: "https://example.com", prompt: "Summarise" },
        outputPreview: "**Example** domain",
      },
    ],
    [
      "Task",
      {
        id: "toolu_9",
        toolName: "Task",
        spawnedAgentId: "sub_a",
        inputPreview: {
          description: "Audit hook payloads",
          subagent_type: "Explore",
          prompt: "Look at `event_mapper.py`.",
        },
      },
    ],
    [
      "TodoWrite",
      {
        toolName: "TodoWrite",
        inputPreview: {
          todos: [
            { content: "A", status: "completed" },
            { content: "B", status: "in_progress", activeForm: "Doing B" },
            { content: "C", status: "pending" },
          ],
        },
      },
    ],
    [
      "mcp",
      {
        toolName: "mcp__github__get_pull_request",
        inputPreview: { owner: "o", pull_number: 1 },
        outputPreview: '{"number":1}',
      },
    ],
    [
      "unknown",
      {
        toolName: "Mystery",
        inputPreview: { q: "x" },
        outputPreview: "plain text",
      },
    ],
    [
      "denied",
      {
        toolName: "Write",
        status: "denied",
        inputPreview: { file_path: "~/.bashrc", content: "x" },
      },
    ],
  ];
  for (const [name, over] of cases) {
    it(`renders ${name}`, () => {
      const call = makeToolCall(1, over);
      const host = mount(
        <ToolBody
          call={call}
          input={call.inputPreview}
          output={call.outputPreview}
          outputBytes={call.outputBytes}
          outputTruncated={call.outputTruncated}
          agents={agents}
        />,
      );
      expect(host.innerHTML).toMatchSnapshot();
    });
  }
});

describe("EventLog fallback", () => {
  it("renders the legacy event log when the snapshot returns 404", async () => {
    useGameStore.setState({
      sessionId: "legacy-session",
      eventLog: [
        {
          id: "e2",
          type: "post_tool_use",
          agentId: "subagent_toolu_abc123",
          summary: "Completed Bash",
          timestamp: new Date("2026-11-08T14:00:02Z"),
        },
        {
          id: "e1",
          type: "pre_tool_use",
          agentId: "main",
          summary: "Using Bash ls",
          timestamp: new Date("2026-11-08T14:00:01Z"),
        },
      ] as never,
    });
    const host = mount(<EventLog />);
    await settle();
    expect(useConsoleStore.getState().sessions["legacy-session"]?.status).toBe(
      "missing",
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Using Bash ls");
    expect(text).toContain("Completed Bash");
    // Chronological: oldest first.
    expect(text.indexOf("Using Bash ls")).toBeLessThan(
      text.indexOf("Completed Bash"),
    );
    // No raw "@subagent…" labels.
    expect(text).not.toContain("@subagent");
    expect(text).toContain("Main agent");
  });
});

describe("connected console", () => {
  it("shows the unavailable state when the backend has no console data", async () => {
    useGameStore.setState({ sessionId: "no-console" });
    const host = mount(
      <SessionConsole
        sessionId="no-console"
        presentation="sheet"
        width={1400}
      />,
    );
    await settle();
    expect(useConsoleStore.getState().sessions["no-console"]?.status).toBe(
      "missing",
    );
    expect(host.textContent).toContain("Console data is not available");
  });

  it("ToolCallDetailModal renders a dialog and closes on Esc", () => {
    const onClose = vi.fn();
    const call = makeToolCall(1, {
      toolName: "Bash",
      inputPreview: { command: "ls -la" },
      outputPreview: "total 0",
    });
    mount(
      <ToolCallDetailModal
        sessionId="s"
        call={call}
        agents={new Map([["main", MAIN_AGENT]])}
        onClose={onClose}
      />,
    );
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("ls -la");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("ToolCallDetailModal labels a blank tool name and spaces the suffix", () => {
    const call = makeToolCall(2, {
      toolName: "",
      status: "error",
      error: "Tool call failed",
    });
    mount(
      <ToolCallDetailModal
        sessionId="s"
        call={call}
        agents={new Map([["main", MAIN_AGENT]])}
        onClose={() => {}}
      />,
    );
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Unknown tool",
    );
  });

  it("ToolCallDetailModal separates the subagent type chip from the target", () => {
    const call = makeToolCall(3, {
      toolName: "Agent",
      target: "WS3 backend console API",
      inputPreview: {
        description: "WS3 backend console API",
        subagent_type: "general-purpose",
      },
    });
    mount(
      <ToolCallDetailModal
        sessionId="s"
        call={call}
        agents={new Map([["main", MAIN_AGENT]])}
        onClose={() => {}}
      />,
    );
    const el = Array.from(document.querySelectorAll("span")).find(
      (e) => e.textContent === "general-purpose" && e.className.includes("ml-2"),
    );
    expect(el).toBeTruthy();
  });
});
