import { describe, expect, it } from "vitest";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import {
  IMPOSTOR_M,
  computeVisibility,
  footprintDistance,
  halfFovFor,
  visRoomsOf,
  type VisInput,
} from "@/engine/world/Visibility";
import {
  characterBudget,
  selectTier,
  wantsShadow,
  SHADOW_IN_M,
} from "@/engine/characters/lod";
import { liveScale, nextLive } from "@/engine/screens/ScreenHub";
import { segmentHitsBox } from "@/engine/screens/labelOcclusion";

const sessions = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i}`,
  createdAt: i,
}));
const layout = generateLayout(allocateSlots(new Map(), sessions));
const rooms = visRoomsOf(layout.rooms);
const HF = halfFovFor(1, 1.6);

function vis(
  eye: [number, number, number],
  yawDeg: number,
  zone: VisInput["zone"],
) {
  return computeVisibility({
    eye: { x: eye[0], y: eye[1], z: eye[2] },
    yaw: (yawDeg * Math.PI) / 180,
    halfFov: HF,
    zone,
    rooms,
    hallLength: layout.hall.length,
    hallHalfWidth: layout.hall.width / 2,
  });
}
const shown = (m: Map<string, string>) =>
  [...m].filter(([, d]) => d !== "hidden").map(([id]) => id);

describe("computeVisibility", () => {
  it("inside a room only sees itself and opposite-side rooms", () => {
    const own = layout.rooms[0]; // east, bay 0
    const m = vis([own.origin.x, 1.7, own.origin.z], -90, {
      kind: "room",
      sessionId: own.sessionId,
    });
    expect(m.get(own.sessionId)).toBe("full");
    // same-side neighbour is behind a solid wall
    const sameSide = layout.rooms.find(
      (r) => r.slot.side === own.slot.side && r.sessionId !== own.sessionId,
    )!;
    expect(m.get(sameSide.sessionId)).toBe("hidden");
    // looking at the hall (-X): opposite-side rooms in view
    const opp = layout.rooms.filter((r) => r.slot.side !== own.slot.side);
    expect(opp.some((r) => m.get(r.sessionId) !== "hidden")).toBe(true);
  });

  it("looking away from the glass hides the opposite side", () => {
    const own = layout.rooms[0];
    const m = vis([own.origin.x, 1.7, own.origin.z], 90, {
      kind: "room",
      sessionId: own.sessionId,
    });
    expect(shown(m)).toEqual([own.sessionId]);
  });

  it("in the hall looking down the hall sees rooms ahead, not behind", () => {
    const m = vis([0, 1.7, 9], 0, { kind: "hall" });
    const bay0 = layout.rooms.filter((r) => r.slot.bay === 0);
    const bay2 = layout.rooms.filter((r) => r.slot.bay === 2);
    expect(bay2.every((r) => m.get(r.sessionId) !== "hidden")).toBe(true);
    // behind and far enough away: hidden (unless within the always-keep radius)
    for (const r of bay0) {
      const near = footprintDistance(
        { x: 0, z: 9 },
        rooms.find((x) => x.id === r.sessionId)!,
      );
      if (near > 4) expect(m.get(r.sessionId)).toBe("hidden");
    }
  });

  it("from the lobby only rooms seen through the hall opening are kept", () => {
    const m = vis([0, 1.7, -10], 0, { kind: "lobby" });
    expect(shown(m).length).toBeGreaterThan(0);
    expect(shown(m).length).toBeLessThanOrEqual(rooms.length);
    // a lobby viewer looking backwards sees nothing
    const back = vis([0, 1.7, -10], 180, { kind: "lobby" });
    expect(shown(back)).toHaveLength(0);
  });

  it("marks rooms farther than IMPOSTOR_M as impostor", () => {
    const m = vis([0, 1.7, -10], 0, { kind: "lobby" });
    for (const [id, d] of m) {
      const r = rooms.find((x) => x.id === id)!;
      const far = footprintDistance({ x: 0, z: -10 }, r) > IMPOSTOR_M;
      if (d !== "hidden") expect(d).toBe(far ? "impostor" : "full");
    }
  });

  it("control room sees back down the hall through the door", () => {
    const m = vis([0, 1.7, 29.5], 180, { kind: "control" });
    expect(shown(m).length).toBeGreaterThan(0);
    const wall = vis([0, 1.7, 29.5], 0, { kind: "control" });
    expect(shown(wall)).toHaveLength(0);
  });
});

describe("character LOD", () => {
  it("selects tiers by distance and hides culled rooms", () => {
    expect(selectTier("near", 3, "full")).toBe("near");
    expect(selectTier("near", 14, "full")).toBe("mid");
    expect(selectTier("near", 40, "full")).toBe("far");
    expect(selectTier("near", 3, "hidden")).toBe("hidden");
    expect(selectTier("near", 3, "impostor")).toBe("far");
  });

  it("has hysteresis", () => {
    expect(selectTier("near", 9.5, "full")).toBe("near");
    expect(selectTier("mid", 9.5, "full")).toBe("mid");
    expect(selectTier("mid", 16.5, "full")).toBe("mid");
    expect(selectTier("far", 16.5, "full")).toBe("far");
  });

  it("scales with the characterDetail setting", () => {
    const low = characterBudget("low");
    expect(selectTier("near", 10, "full", low.scale)).toBe("mid");
    expect(low.maxSkinned).toBeLessThan(characterBudget("high").maxSkinned);
  });

  it("only close characters cast shadows", () => {
    expect(wantsShadow(false, SHADOW_IN_M - 0.1)).toBe(true);
    expect(wantsShadow(false, SHADOW_IN_M + 0.1)).toBe(false);
    expect(wantsShadow(true, SHADOW_IN_M + 0.5)).toBe(true);
    expect(wantsShadow(true, 12)).toBe(false);
  });
});

describe("screens + labels", () => {
  it("monitors go live only when close, with hysteresis", () => {
    expect(nextLive(false, 7)).toBe(true);
    expect(nextLive(false, 9)).toBe(false);
    expect(nextLive(true, 9)).toBe(true);
    expect(nextLive(true, 12)).toBe(false);
    expect(nextLive(false, 1, liveScale("off"))).toBe(false);
  });

  it("segmentHitsBox", () => {
    const min = { x: 0, y: 0, z: 0 };
    const max = { x: 0.2, y: 3, z: 4 };
    expect(
      segmentHitsBox({ x: -2, y: 1.6, z: 2 }, { x: 2, y: 1.6, z: 2 }, min, max),
    ).toBe(true);
    expect(
      segmentHitsBox({ x: -2, y: 1.6, z: 5 }, { x: 2, y: 1.6, z: 5 }, min, max),
    ).toBe(false);
    expect(
      segmentHitsBox(
        { x: -2, y: 1.6, z: 2 },
        { x: -0.5, y: 1.6, z: 2 },
        min,
        max,
      ),
    ).toBe(false);
  });
});
