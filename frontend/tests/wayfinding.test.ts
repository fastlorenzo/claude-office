/**
 * WS3 U3: in-world wayfinding signs are placed at every decision point,
 * readable (title ≈ 0.11 m at 0.32 of a 0.35 m plate) and never in the way
 * (hung with ≥ 2.1 m headroom over their floor).
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/en";
import { LAYOUT } from "@/engine/contracts";
import {
  allocatePods,
  allocateSlots,
  generateLayout,
} from "@/engine/layout/buildingLayout";
import { buildFactoryLayout, FLOOR_Y } from "@/engine/layout/factoryLayout";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { groupSessions } from "@/engine/logic/projectGroups";
import {
  entranceSigns,
  hallSigns,
  SIGN_FACES,
  SIGN_H,
  SIGN_W,
} from "@/engine/world/wayfinding";

function demo(n: number) {
  const d = createDemoCampus(n, 20000);
  const groups = groupSessions(d.campus, d.sessions, d.projects);
  const slots = allocateSlots(
    new Map(),
    groups.map((g) => ({
      id: g.id,
      createdAt: g.createdAt,
      sessions: g.sessionIds.length,
    })),
  );
  return generateLayout(slots, groups, allocatePods(new Map(), groups));
}

describe.each([4, 6, 10])("wayfinding signs (n=%i)", (n) => {
  const fl = buildFactoryLayout(demo(n));
  const hall = hallSigns(fl, LAYOUT.WALL_H);

  it("a sign at the hall start, every spine head and foot, the factory door", () => {
    expect(hall.filter((s) => s.front === "controlRoom")).toHaveLength(1);
    expect(hall.filter((s) => s.front === "spineDown")).toHaveLength(
      fl.spineStairs.length,
    );
    expect(hall.filter((s) => s.front === "officesUp")).toHaveLength(
      fl.spineStairs.length,
    );
    expect(hall.filter((s) => s.front === "receptionExit")).toHaveLength(1);
    for (const st of fl.spineStairs) {
      const head = hall.find(
        (s) => s.front === "spineDown" && Math.abs(s.x - st.top.x) < 1e-9,
      )!;
      // Over the well's head edge, on the hall side of the flight.
      expect(head.z).toBeLessThan(st.rect.z0);
      expect(st.rect.z0 - head.z).toBeLessThan(1);
    }
  });

  it("hung signs leave ≥ 2.1 m headroom and hang from above", () => {
    for (const s of hall) {
      const floor = s.y < 0 ? FLOOR_Y : 0;
      if (s.hangTo === undefined) continue;
      expect(s.y - SIGN_H / 2 - floor).toBeGreaterThanOrEqual(2.1);
      expect(s.hangTo).toBeGreaterThan(s.y + SIGN_H / 2);
    }
  });

  it("entrance stair heads carry 'Factory floor ↓' to the reception side", () => {
    const up = 6;
    const signs = entranceSigns(fl.entrance, up, 12);
    expect(signs).toHaveLength(fl.entrance.stairs.length);
    for (const s of signs) {
      expect(s.front).toBe("factoryDown");
      expect(s.y - SIGN_H / 2 - up).toBeGreaterThanOrEqual(2.1);
    }
  });
});

describe("sign faces", () => {
  it("titles are ≥ 0.1 m tall on a 4 : 1 plate", () => {
    expect(SIGN_W / SIGN_H).toBeCloseTo(4, 6);
    // drawWayfinding: title font = 0.32 of the plate height.
    expect(0.32 * SIGN_H).toBeGreaterThanOrEqual(0.1);
    for (const f of Object.values(SIGN_FACES))
      expect(en[f.titleKey].length).toBeGreaterThan(0);
  });
});
