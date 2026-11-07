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

  it("openInspect stores the target and opens the panel", () => {
    useWorldUiStore.getState().openInspect({
      kind: "monitor",
      sessionId: "s1",
      roomLabel: "Room",
    });
    const st = useWorldUiStore.getState();
    expect(st.openPanel).toBe("inspect");
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
