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
  /** A part over one fake node: idempotent, returns the nodes it switched. */
  const part = (node: { on: boolean }, calls: boolean[] = []) => ({
    setEnabled: (v: boolean) => {
      calls.push(v);
      if (node.on === v) return 0;
      node.on = v;
      return 1;
    },
  });
  const off = {
    lobby: false,
    entrance: false,
    factory: false,
    exterior: false,
  };

  it("hides only after the grace period, enforcing every tick", () => {
    const node = { on: true };
    const calls: boolean[] = [];
    const g = new BuildingGate();
    const parts = { lobby: part(node, calls) };
    g.apply(0, { ...off, lobby: true }, parts);
    g.apply(100, off, parts);
    expect(node.on).toBe(true); // grace
    g.apply(2000, off, parts);
    expect(node.on).toBe(false);
    g.reset(parts);
    expect(node.on).toBe(true);
    expect(calls).toEqual([true, true, false, true]);
  });

  it("re-enables a part another system switched off (no change-only cache)", () => {
    const node = { on: true };
    const g = new BuildingGate();
    const parts = { factory: part(node) };
    g.apply(0, { ...off, factory: true }, parts);
    node.on = false; // a second system toggles the shared node
    g.apply(200, { ...off, factory: true }, parts);
    expect(node.on).toBe(true);
    expect(g.drift.last).toBe(1);
    expect(g.drift.total).toBe(1);
  });

  it("reset re-enables parts it never hid itself", () => {
    const node = { on: false };
    const g = new BuildingGate();
    g.reset({ exterior: part(node) });
    expect(node.on).toBe(true);
  });
});
