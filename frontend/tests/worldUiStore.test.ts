import { beforeEach, describe, expect, it } from "vitest";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { parseGraphicsQuality, parseRenderer } from "@/stores/preferencesStore";

describe("worldUiStore", () => {
  beforeEach(() => useWorldUiStore.getState().reset());

  it("toggles panels and tracks the top-most", () => {
    const s = useWorldUiStore.getState();
    s.toggle("git");
    expect(useWorldUiStore.getState().openPanel).toBe("git");
    s.toggle("git");
    expect(useWorldUiStore.getState().openPanel).toBeNull();
  });

  it("caps open panels at two, dropping the oldest", () => {
    const s = useWorldUiStore.getState();
    s.open("git");
    s.open("events");
    s.open("minimap");
    expect(useWorldUiStore.getState().panels).toEqual(["events", "minimap"]);
  });

  it("closeTop closes the latest and reports whether it did", () => {
    const s = useWorldUiStore.getState();
    expect(s.closeTop()).toBe(false);
    s.open("help");
    s.open("agents");
    expect(s.closeTop()).toBe(true);
    expect(useWorldUiStore.getState().openPanel).toBe("help");
  });

  it("openInspect on a session monitor opens the console", () => {
    useWorldUiStore.getState().openInspect({
      kind: "monitor",
      sessionId: "s1",
      roomLabel: "Room",
    });
    const st = useWorldUiStore.getState();
    expect(st.openPanel).toBe("console");
    expect(st.consoleTarget?.sessionId).toBe("s1");
    expect(st.inspectTarget?.sessionId).toBe("s1");
  });
});

describe("preference parsing", () => {
  it("renderer defaults to 3d and only 'pixel' selects pixel", () => {
    expect(parseRenderer(undefined)).toBe("3d");
    expect(parseRenderer("")).toBe("3d");
    expect(parseRenderer("false")).toBe("3d");
    expect(parseRenderer("pixel")).toBe("pixel");
    expect(parseRenderer("3d")).toBe("3d");
  });

  it("graphics quality falls back to auto", () => {
    expect(parseGraphicsQuality(undefined)).toBe("auto");
    expect(parseGraphicsQuality("ultra")).toBe("auto");
    expect(parseGraphicsQuality("low")).toBe("low");
    expect(parseGraphicsQuality("high")).toBe("high");
  });
});

describe("console panel", () => {
  beforeEach(() => useWorldUiStore.getState().reset());

  it("is exclusive and carries a target", () => {
    const s = useWorldUiStore.getState();
    s.open("git");
    s.open("events");
    s.openConsole("s1", { callId: "c1" });
    let st = useWorldUiStore.getState();
    expect(st.panels).toEqual(["console"]);
    expect(st.consoleTarget).toEqual({ sessionId: "s1", callId: "c1" });
    expect(st.consolePresentation).toBe("dock");
    expect(st.returnTo).toBeNull();
    // Another panel dismisses it.
    st.open("git");
    st = useWorldUiStore.getState();
    expect(st.panels).toEqual(["git"]);
    // Opening it again replaces everything.
    st.open("console");
    expect(useWorldUiStore.getState().panels).toEqual(["console"]);
  });

  it("opened from ops it is a sheet over ops, and closing returns to ops", () => {
    const s = useWorldUiStore.getState();
    s.openOps();
    s.openConsole("s2", { from: "ops" });
    let st = useWorldUiStore.getState();
    expect(st.consolePresentation).toBe("sheet");
    expect(st.returnTo).toBe("ops");
    expect(st.opsOpen).toBe(true);
    expect(st.closeTop()).toBe(true);
    st = useWorldUiStore.getState();
    expect(st.panels).toEqual([]);
    expect(st.opsOpen).toBe(true);
    expect(st.returnTo).toBeNull();
  });
});
