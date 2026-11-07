import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { allocateSlots } from "@/engine/layout/buildingLayout";
import {
  applyToModel,
  createWorldModel,
  diffCampus,
} from "@/engine/logic/syncDiff";
import type { SyncInput } from "@/engine/contracts";

function setup(count: number, t: number, sel: string | null = null) {
  const { campus, sessions } = createDemoCampus(count, t);
  const slots = allocateSlots(new Map(), sessions);
  const input: SyncInput = { campus, sessions, selectedSessionId: sel };
  return { input, slots };
}

describe("syncDiff", () => {
  it("creates rooms, with agents spawned after createRoom, and is idempotent", () => {
    const model = createWorldModel();
    const { input, slots } = setup(3, 30000, "demo-1");
    const ops = diffCampus(model, input, slots);
    expect(ops.filter((o) => o.op === "createRoom")).toHaveLength(3);
    const firstUpdate = ops.findIndex((o) => o.op !== "createRoom");
    expect(ops.slice(0, firstUpdate).every((o) => o.op === "createRoom")).toBe(
      true,
    );
    expect(ops.some((o) => o.op === "spawnAgent")).toBe(true);
    expect(ops.some((o) => o.op === "boss")).toBe(true);
    expect(ops[ops.length - 1]).toEqual({ op: "select", sessionId: "demo-1" });
    applyToModel(model, ops);
    expect(diffCampus(model, input, slots)).toEqual([]);
  });

  it("updates, departs and disposes", () => {
    const model = createWorldModel();
    const { input, slots } = setup(2, 30000);
    applyToModel(model, diffCampus(model, input, slots));

    const next: SyncInput = structuredClone(input);
    const s0 = next.campus[0];
    s0.boss = { ...s0.boss, state: "reviewing" };
    s0.agents[0] = {
      ...s0.agents[0],
      state: "thinking",
      currentTask: "changed",
    };
    const departed = s0.agents.pop()!;
    next.sessions[0].label = "renamed";
    const ops = diffCampus(model, next, slots);
    expect(ops.some((o) => o.op === "roomLabel")).toBe(true);
    expect(ops.some((o) => o.op === "boss")).toBe(true);
    expect(ops.some((o) => o.op === "updateAgent")).toBe(true);
    expect(
      ops.some((o) => o.op === "departAgent" && o.agentId === departed.id),
    ).toBe(true);
    applyToModel(model, ops);
    expect(diffCampus(model, next, slots)).toEqual([]);

    const gone: SyncInput = { ...next, campus: next.campus.slice(0, 1) };
    const ops2 = diffCampus(model, gone, slots);
    expect(ops2).toEqual([{ op: "disposeRoom", sessionId: "demo-1" }]);
    applyToModel(model, ops2);
    expect(model.rooms.size).toBe(1);
  });

  it("falls back to short ids when meta is missing and spawns new agents", () => {
    const model = createWorldModel();
    const { input, slots } = setup(1, 30000);
    const noMeta: SyncInput = { ...input, sessions: [] };
    const ops = diffCampus(model, noMeta, slots);
    const create = ops.find((o) => o.op === "createRoom");
    expect(create && create.op === "createRoom" && create.label).toBe("demo-0");
    applyToModel(model, ops);
    const more = structuredClone(noMeta);
    more.campus[0].agents.push({
      id: "extra",
      color: "#fff",
      number: 9,
      state: "working",
      desk: 8,
    });
    expect(diffCampus(model, more, slots).map((o) => o.op)).toContain(
      "spawnAgent",
    );
  });
});
