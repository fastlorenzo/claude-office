import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  DASH,
  formatCost,
  formatTokens,
  infoRow,
  infoRows,
} from "@/engine/logic/projectInfo";
import { drawProjectInfo } from "@/engine/screens/ProjectInfoScreen";
import { projectLedContent } from "@/engine/world/RoomSign";
import type { CampusSession } from "@/engine/contracts";

/** Minimal 2D context: every method is a no-op, measureText is linear. */
function fakeCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "measureText")
        return (text: string) => ({ width: text.length * 8 });
      if (k.startsWith("create")) return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const NOW = Date.now();

describe("project info screen rows", () => {
  const { campus, sessions } = createDemoCampus(6, 20000);
  const labels = new Map(sessions.map((s) => [s.id, s.label]));

  it("formats tokens and cost", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(166_000)).toBe("166k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(null)).toBeNull();
    expect(formatCost(42.75)).toBe("$42.75");
    expect(formatCost(null)).toBe(DASH);
  });

  it("builds a row per session with telemetry, and dashes without it", () => {
    const r = infoRow(campus[1], labels.get(campus[1].sessionId), NOW);
    expect(r.name).toBe("sso-login");
    expect(r.summary).toBe("Add SSO login to the admin dashboard");
    expect(r.model).toBe("Opus 5.5 · xhigh");
    expect(r.ctxPct).toBeGreaterThan(80);
    expect(r.tokens).toMatch(/k \/ 200k$/);
    expect(r.cost).toMatch(/^\$\d+\.\d\d$/);
    const bare: CampusSession = { ...campus[0], telemetry: null };
    const b = infoRow(bare, "x", NOW);
    expect([b.model, b.tokens, b.cost]).toEqual([DASH, DASH, DASH]);
    expect(b.ctxPct).toBeNull();
  });

  it("never repeats the LED panel's project name or status words", () => {
    const cont = campus.filter((c) => c.project === "continuum");
    const led = projectLedContent(
      "continuum",
      cont.map(() => "working"),
    );
    expect(led.ticker).toBeNull();
    expect(led.line.map((s) => s.text).join("")).toBe(
      "CONTINUUM  ·  3 SESSIONS  ·  WORKING",
    );
    const { rows } = infoRows(cont, labels, NOW);
    for (const r of rows) {
      expect(r.name.toUpperCase()).not.toBe("CONTINUUM");
      expect(r.summary).not.toMatch(/sessions/i);
    }
  });

  it("LED status words: needs you (amber) > working (blue) > idle (green)", () => {
    const needs = projectLedContent("p", ["working", "needs_you", "done"]);
    expect(needs.line.at(-1)).toEqual({
      text: "1 NEEDS YOU",
      color: "#F5A524",
    });
    expect(projectLedContent("p", ["done", "working"]).line.at(-1)?.text).toBe(
      "WORKING",
    );
    expect(projectLedContent("p", ["done"]).line.at(-1)).toEqual({
      text: "IDLE",
      color: "#34D399",
    });
    expect(projectLedContent("p", ["done"]).line[2].text).toBe("1 SESSION");
  });

  it("caps rows but keeps sessions that need the user", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...campus[0],
      sessionId: `s${i}`,
      bucket: i === 7 ? ("needs_you" as const) : ("working" as const),
    }));
    const { rows, more } = infoRows(many, new Map(), NOW, 6);
    expect(rows).toHaveLength(6);
    expect(more).toBe(2);
    expect(rows.some((r) => r.sessionId === "s7")).toBe(true);
  });

  it("draws without throwing (rows, overflow, empty)", () => {
    const { rows } = infoRows(campus, labels, NOW);
    expect(() => drawProjectInfo(fakeCtx(), 1024, 632, rows, 2)).not.toThrow();
    expect(() => drawProjectInfo(fakeCtx(), 1024, 632, [], 0)).not.toThrow();
  });
});
