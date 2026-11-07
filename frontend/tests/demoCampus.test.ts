import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import type { BossState } from "@/types";

const PALETTE = [
  "#3B82F6",
  "#22C55E",
  "#A855F7",
  "#F97316",
  "#EC4899",
  "#14B8A6",
  "#EAB308",
  "#EF4444",
];

describe("demoCampus", () => {
  it("is deterministic", () => {
    expect(createDemoCampus(4, 12345)).toEqual(createDemoCampus(4, 12345));
  });

  it("produces valid shapes", () => {
    let maxAgents = 0;
    for (let t = 0; t < 200000; t += 1500) {
      const { campus, sessions } = createDemoCampus(6, t);
      expect(campus).toHaveLength(6);
      expect(sessions).toHaveLength(6);
      for (const s of campus) {
        const desks = new Set<number>();
        expect(s.agents.length).toBeLessThanOrEqual(6);
        maxAgents = Math.max(maxAgents, s.agents.length);
        for (const a of s.agents) {
          expect(a.desk).toBeGreaterThanOrEqual(1);
          expect(a.desk).toBeLessThanOrEqual(8);
          expect(desks.has(a.desk as number)).toBe(false);
          desks.add(a.desk as number);
          expect(PALETTE).toContain(a.color);
        }
        expect(s.recentActivity.length).toBeLessThanOrEqual(8);
        const cu = s.office.contextUtilization ?? 0;
        expect(cu).toBeGreaterThanOrEqual(0);
        expect(cu).toBeLessThanOrEqual(1);
      }
    }
    expect(maxAgents).toBeGreaterThan(0);
  });

  it("has an ended session at count >= 5 and needs_you at some t", () => {
    expect(createDemoCampus(5, 0).campus.filter((s) => s.ended)).toHaveLength(
      1,
    );
    expect(createDemoCampus(4, 0).campus.some((s) => s.ended)).toBe(false);
    const states = new Set<BossState>();
    let needs = false;
    for (let t = 0; t < 80000; t += 1000) {
      for (const s of createDemoCampus(3, t).campus) {
        states.add(s.boss.state);
        if (s.bucket === "needs_you") needs = true;
      }
    }
    expect(needs).toBe(true);
    expect(states.size).toBeGreaterThan(3);
  });
});
