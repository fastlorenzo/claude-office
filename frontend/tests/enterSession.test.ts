import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldUiStore } from "@/stores/worldUiStore";
import { enterSession, setEnterContext } from "@/components/world/enterSession";
import { setWorld } from "@/components/world/worldRef";
import type { IWorld } from "@/engine/contracts";
import { canFocusTerminal, mapFocusFailure } from "@/stores/attentionStore";

describe("enterSession", () => {
  const teleport = vi.fn();
  const select = vi.fn();
  let selected = "other";

  beforeEach(() => {
    useWorldUiStore.getState().reset();
    teleport.mockClear();
    select.mockClear();
    selected = "other";
    setWorld({ teleport } as unknown as IWorld);
    setEnterContext({
      select,
      selectedId: () => selected,
      label: () => "My Room",
    });
  });

  it("teleports, selects, opens panels and shows a banner", async () => {
    await enterSession("s1");
    expect(teleport).toHaveBeenCalledWith({ sessionId: "s1" });
    expect(select).toHaveBeenCalledWith("s1");
    const s = useWorldUiStore.getState();
    expect(s.panels).toEqual(["events", "conversation"]);
    expect(s.banner?.text).toContain("My Room");
  });

  it("skips teleport inside the room and select when already selected", async () => {
    useWorldUiStore.getState().setPose({
      x: 0,
      z: 0,
      yaw: 0,
      zone: { kind: "room", sessionId: "s1" },
    });
    selected = "s1";
    await enterSession("s1");
    expect(teleport).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(useWorldUiStore.getState().banner).not.toBeNull();
  });
});

describe("focus helpers", () => {
  it("maps statuses to soft toasts", () => {
    expect(mapFocusFailure(401)).toEqual({
      level: "low",
      key: "focus.needsToken",
    });
    expect(mapFocusFailure(403).key).toBe("focus.needsToken");
    expect(mapFocusFailure(404).key).toBe("focus.notFound");
    expect(mapFocusFailure(500).key).toBe("focus.unsupported");
    expect(mapFocusFailure(503).level).toBe("info");
    expect(mapFocusFailure(400).key).toBe("focus.failed");
  });

  it("only offers terminal focus on macOS with a token", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(canFocusTerminal(mac, "tok")).toBe(true);
    expect(canFocusTerminal(mac, null)).toBe(false);
    expect(canFocusTerminal("Mozilla/5.0 (X11; Linux x86_64)", "tok")).toBe(
      false,
    );
  });
});
