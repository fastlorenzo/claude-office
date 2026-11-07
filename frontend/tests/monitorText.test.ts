import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  agentScreenText,
  buildMonitorLines,
  todosKey,
} from "@/engine/logic/monitorText";

describe("monitorText", () => {
  it("is always 13 lines of <= 46 chars", () => {
    for (let t = 0; t < 120000; t += 7000) {
      for (const s of createDemoCampus(5, t).campus) {
        const lines = buildMonitorLines(
          s,
          "a-very-long-project-name-that-keeps-going-and-going",
          0,
        );
        expect(lines).toHaveLength(13);
        for (const l of lines) expect(l.length).toBeLessThanOrEqual(46);
      }
    }
  });

  it("renders header, idle, bars", () => {
    const s = createDemoCampus(1, 0).campus[0];
    s.boss = { state: "working", currentTask: null };
    s.recentActivity = [];
    s.office = { contextUtilization: 0.42 };
    s.todos = Array.from({ length: 10 }, (_, i) => ({
      content: `t${i}`,
      status: i < 6 ? "completed" : "pending",
    }));
    const lines = buildMonitorLines(s, "proj", 0);
    expect(lines[0]).toBe("claude@proj — WORKING");
    expect(lines[1]).toBe("— idle —");
    expect(lines[3]).toBe("");
    expect(lines[11]).toBe("todo [██████░░░░] 6/10");
    expect(lines[12]).toBe("ctx  [████░░░░░░] 42%");
  });

  it("formats activity lines and wraps tasks", () => {
    const s = createDemoCampus(1, 5000).campus[0];
    s.boss = { state: "working", currentTask: "word ".repeat(40) };
    const lines = buildMonitorLines(s, "p", 0);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(lines[3]).toMatch(/^\d\d:\d\d {2}\S/);
  });

  it("agent text and todo key", () => {
    const a = createDemoCampus(1, 20000).campus[0].agents[0];
    const t = agentScreenText({ ...a, currentTask: "x ".repeat(60) });
    expect(t.length).toBeLessThanOrEqual(4);
    expect(todosKey([{ content: "a", status: "pending" }])).toBe("pending:a");
  });
});
