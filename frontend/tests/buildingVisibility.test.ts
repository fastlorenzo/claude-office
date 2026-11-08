import { describe, expect, it } from "vitest";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import { halfFovFor, visRoomsOfProjects } from "@/engine/world/Visibility";
import {
  BuildingGate,
  computeBuildingVisibility,
} from "@/engine/world/buildingVisibility";

const sessions = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i}`,
  createdAt: i,
}));
const layout = generateLayout(allocateSlots(new Map(), sessions));
const rooms = visRoomsOfProjects(layout.projects);
const p = layout.projects[0];
const s = layout.lobby.size;
const lobbyRect = { x0: -s.x / 2, x1: s.x / 2, z0: -s.z - 4, z1: 0 };

function gate(yawDeg: number, zone: "room" | "hall" = "room", eyeZ?: number) {
  const eye = { x: p.origin.x, y: 1.7, z: eyeZ ?? p.origin.z };
  return computeBuildingVisibility({
    lobbyRect,
    vis: {
      eye,
      yaw: (yawDeg * Math.PI) / 180,
      halfFov: halfFovFor(1, 1.6),
      zone:
        zone === "room"
          ? {
              kind: "room",
              sessionId: p.pods[0].sessionId,
              projectId: p.projectId,
            }
          : { kind: "hall" },
      rooms,
      hallLength: layout.hall.length,
      hallHalfWidth: layout.hall.width / 2,
    },
  });
}

describe("computeBuildingVisibility", () => {
  const east = p.slot.side === "east";
  it("looking out of the outer glazing keeps the factory and park, drops the lobby", () => {
    const v = gate(east ? 90 : -90);
    expect(v.factory).toBe(true);
    expect(v.exterior).toBe(true);
    expect(v.lobby).toBe(false);
    expect(v.entrance).toBe(false);
  });
  it("looking across the hall keeps the factory (floor strip, glazing)", () => {
    expect(gate(east ? -90 : 90).factory).toBe(true);
  });
  it("other zones keep everything", () => {
    expect(gate(0, "hall")).toEqual({
      lobby: true,
      entrance: true,
      factory: true,
      exterior: true,
    });
  });
});

describe("BuildingGate", () => {
  it("hides only after the grace period", () => {
    const calls: boolean[] = [];
    const g = new BuildingGate();
    const parts = { lobby: { setEnabled: (v: boolean) => calls.push(v) } };
    const off = {
      lobby: false,
      entrance: false,
      factory: false,
      exterior: false,
    };
    g.apply(0, { ...off, lobby: true }, parts);
    g.apply(100, off, parts);
    expect(calls).toEqual([true]);
    g.apply(2000, off, parts);
    expect(calls).toEqual([true, false]);
    g.reset(parts);
    expect(calls).toEqual([true, false, true]);
  });
});
