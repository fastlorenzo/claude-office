import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Server rendering reads zustand's *initial* state, so fake the two stores the
// panels read: campus data present, and no world factory target.
const fake = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock("@/stores/campusStore", () => ({
  useCampusStore: (sel: (s: unknown) => unknown) =>
    sel({ projects: fake.projects, sessions: [] }),
}));
vi.mock("@/stores/worldUiStore", () => ({
  useWorldUiStore: (sel: (s: unknown) => unknown) =>
    sel({ factoryTarget: null }),
}));
import { primaryAction, type SessionNav } from "@/components/shared/sessionNav";
import {
  buildDashboardSearch,
  dashboardHref,
  parseDashboardUrl,
  threeDHref,
} from "@/components/dashboard/dashboardUrl";
import { demoFactoryProjects } from "@/engine/demo/demoFactory";
import { factoryTarget } from "@/engine/interaction/factoryTargets";
import { buildFactoryModel } from "@/engine/logic/factoryModel";
import { DeployPanel } from "@/components/world/hud/factory/DeployPanel";
import { LinePanel } from "@/components/world/hud/factory/LinePanel";
import { PrPanel } from "@/components/world/hud/factory/PrPanel";
import { StationPanel } from "@/components/world/hud/factory/StationPanel";

describe("primaryAction", () => {
  it("walks into the room when the host can, else opens the console", () => {
    const openConsole = vi.fn();
    const enterRoom = vi.fn();
    const withRoom: SessionNav = { openConsole, enterRoom };
    primaryAction(withRoom)("a");
    expect(enterRoom).toHaveBeenCalledWith("a");
    primaryAction({ openConsole })("b");
    expect(openConsole).toHaveBeenCalledWith("b");
  });
});

describe("dashboard URL", () => {
  it("round-trips every param", () => {
    const state = {
      tab: "console" as const,
      session: "abc",
      project: "o/r",
      pr: "412",
      call: "toolu_1",
      agent: "main",
      tool: "Bash",
      err: true,
      q: "git push",
    };
    const parsed = parseDashboardUrl(buildDashboardSearch(state));
    expect(parsed).toEqual(state);
  });

  it("defaults to ops and ignores unknown tabs", () => {
    expect(parseDashboardUrl("").tab).toBe("ops");
    expect(parseDashboardUrl("?tab=nope").tab).toBe("ops");
  });

  it("preserves the token on every link", () => {
    expect(parseDashboardUrl("?tab=ops&token=sek").token).toBe("sek");
    expect(dashboardHref({ tab: "factory", project: "p" }, "sek")).toContain(
      "token=sek",
    );
    expect(threeDHref("s1", "sek")).toBe("/?session=s1&token=sek");
    expect(threeDHref()).toBe("/");
    expect(dashboardHref({ tab: "ops" })).not.toContain("token");
  });
});

describe("factory panels with an explicit target", () => {
  const NOW = Date.parse("2026-11-07T12:00:00Z");
  const projects = demoFactoryProjects([], NOW, { projects: 1 });
  const project = projects[0];
  const line = buildFactoryModel([project], [], NOW).lines[0];
  const base = { projectId: project.id, label: project.name };

  beforeEach(() => {
    fake.projects = projects;
  });

  it("renders all four with no worldUiStore target", () => {
    const none = renderToStaticMarkup(createElement(LinePanel));
    const piece = line.workpieces.find((w) => w.prNumber !== undefined)!;
    const html = {
      line: renderToStaticMarkup(
        createElement(LinePanel, { target: factoryTarget("lineBoard", base) }),
      ),
      deploy: renderToStaticMarkup(
        createElement(DeployPanel, { target: factoryTarget("dock", base) }),
      ),
      pr: renderToStaticMarkup(
        createElement(PrPanel, {
          target: factoryTarget("lanePlate", {
            ...base,
            prNumber: piece.prNumber,
          }),
        }),
      ),
      station: renderToStaticMarkup(
        createElement(StationPanel, {
          target: factoryTarget("station", {
            ...base,
            checkName: line.stations[0].name,
            label: line.stations[0].name,
          }),
        }),
      ),
    };
    // The empty state differs from every rendered panel.
    for (const [k, v] of Object.entries(html)) {
      expect(v, k).not.toBe(none);
      expect(v.length, k).toBeGreaterThan(none.length);
    }
    expect(html.pr).toContain(`#${piece.prNumber}`);
  });
});
