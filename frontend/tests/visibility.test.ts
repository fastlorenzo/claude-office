import { describe, expect, it } from "vitest";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import {
  IMPOSTOR_M,
  computeVisibility,
  footprintDistance,
  halfFovFor,
  podDetail,
  POD_IMPOSTOR_M,
  visRoomsOfProjects,
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
const rooms = visRoomsOfProjects(layout.projects);
const own0 = layout.projects[0];
const roomZone = (p: (typeof layout.projects)[number]) =>
  ({
    kind: "room",
    sessionId: p.pods[0].sessionId,
    projectId: p.projectId,
  }) as const;
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
    const own = own0; // east, bay 0
    const m = vis([own.origin.x, 1.7, own.origin.z], -90, roomZone(own));
    expect(m.get(own.projectId)).toBe("full");
    // same-side neighbour is behind a solid wall
    const sameSide = layout.projects.find(
      (r) => r.slot.side === own.slot.side && r.projectId !== own.projectId,
    )!;
    expect(m.get(sameSide.projectId)).toBe("hidden");
    // looking at the hall (-X): opposite-side rooms in view
    const opp = layout.projects.filter((r) => r.slot.side !== own.slot.side);
    expect(opp.some((r) => m.get(r.projectId) !== "hidden")).toBe(true);
  });

  it("looking away from the glass hides the opposite side", () => {
    const m = vis([own0.origin.x, 1.7, own0.origin.z], 90, roomZone(own0));
    expect(shown(m)).toEqual([own0.projectId]);
  });

  it("in the hall looking down the hall sees rooms ahead, not behind", () => {
    const z = layout.hall.length * 0.55;
    const m = vis([0, 1.7, z], 0, { kind: "hall" });
    const ahead = layout.projects.filter((r) => r.bounds.min.z > z);
    const behind = layout.projects.filter((r) => r.bounds.max.z < z);
    expect(ahead.length).toBeGreaterThan(0);
    expect(ahead.every((r) => m.get(r.projectId) !== "hidden")).toBe(true);
    for (const r of behind) {
      const near = footprintDistance(
        { x: 0, z },
        rooms.find((x) => x.id === r.projectId)!,
      );
      if (near > 4) expect(m.get(r.projectId)).toBe("hidden");
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

  it("the control room is sealed: no project room from inside it", () => {
    const cz = layout.hall.length + 4;
    expect(shown(vis([0, 1.7, cz], 180, { kind: "control" }))).toHaveLength(0);
    expect(shown(vis([0, 1.7, cz], 0, { kind: "control" }))).toHaveLength(0);
  });
});

describe("factory floor rule", () => {
  const floorEye: [number, number, number] = [0, -4.3, layout.hall.length / 2];

  it("from the floor rooms are at most impostor, never full", () => {
    for (const yaw of [0, 90, 180, 270]) {
      const m = vis(floorEye, yaw, { kind: "factory" });
      for (const d of m.values()) expect(d).not.toBe("full");
    }
  });

  it("rooms above the cone are hidden, rooms in it impostor", () => {
    const z = layout.hall.length / 2;
    const ahead = layout.projects.filter((r) => r.bounds.min.z > z + 10);
    const m = vis([0, -4.3, z], 0, { kind: "factory" });
    expect(ahead.every((r) => m.get(r.projectId) === "impostor")).toBe(true);
    // stand at the far end looking at the dock: everything behind is hidden
    const e = layout.hall.length - 1;
    const m2 = vis([0, -4.3, e], 0, { kind: "factory" });
    const behind = layout.projects.filter((r) => r.bounds.max.z < e - 10);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((r) => m2.get(r.projectId) === "hidden")).toBe(true);
  });

  it("office zones keep their behaviour", () => {
    const m = vis([own0.origin.x, 1.7, own0.origin.z], 90, roomZone(own0));
    expect(shown(m)).toEqual([own0.projectId]);
  });
});

describe("pod detail", () => {
  it("drops far pods of a visible room to impostor", () => {
    expect(podDetail("full", 2)).toBe("full");
    expect(podDetail("full", POD_IMPOSTOR_M + 1)).toBe("impostor");
    expect(podDetail("hidden", 0)).toBe("hidden");
    expect(podDetail("impostor", 0)).toBe("impostor");
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
