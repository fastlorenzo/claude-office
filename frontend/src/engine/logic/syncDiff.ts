import type {
  CampusSession,
  RoomSlot,
  SyncInput,
  SyncOp,
  WorldAgentModel,
  WorldModel,
  WorldRoomModel,
} from "../contracts";
import type { Agent, BossState } from "@/types";
import { buildMonitorLines, todosKey } from "./monitorText";
import { roomStatus } from "./status";

export function createWorldModel(): WorldModel {
  return { rooms: new Map(), selectedSessionId: null };
}

const bubbleKey = (b: { text?: string } | null | undefined): string =>
  b?.text ?? "";

function agentModel(a: Agent): WorldAgentModel {
  return {
    state: a.state,
    desk: a.desk ?? null,
    bubbleKey: bubbleKey(a.bubble),
    taskKey: a.currentTask ?? "",
    color: a.color,
  };
}

function agentChanged(m: WorldAgentModel, a: Agent): boolean {
  const n = agentModel(a);
  return (
    m.state !== n.state ||
    m.desk !== n.desk ||
    m.bubbleKey !== n.bubbleKey ||
    m.taskKey !== n.taskKey ||
    m.color !== n.color
  );
}

function sameSlot(a: RoomSlot, b: RoomSlot): boolean {
  return a.index === b.index && a.side === b.side && a.bay === b.bay;
}

export function diffCampus(
  model: WorldModel,
  input: SyncInput,
  slots: ReadonlyMap<string, RoomSlot>,
): SyncOp[] {
  const labels = new Map(input.sessions.map((s) => [s.id, s.label]));
  const live = new Map<string, { s: CampusSession; slot: RoomSlot }>();
  for (const s of input.campus) {
    const slot = slots.get(s.sessionId);
    if (slot) live.set(s.sessionId, { s, slot });
  }
  const labelOf = (id: string) => labels.get(id) || id.slice(0, 8);

  const ops: SyncOp[] = [];
  const created = new Set<string>();

  for (const [id, room] of model.rooms) {
    const l = live.get(id);
    if (!l || !sameSlot(l.slot, room.slot))
      ops.push({ op: "disposeRoom", sessionId: id });
  }
  const disposed = new Set(
    ops.map((o) => (o as { sessionId: string }).sessionId),
  );

  for (const [id, { slot }] of live) {
    if (!model.rooms.has(id) || disposed.has(id)) {
      created.add(id);
      ops.push({ op: "createRoom", sessionId: id, slot, label: labelOf(id) });
    }
  }

  for (const [id, { s }] of live) {
    const isNew = created.has(id);
    const prev: WorldRoomModel | undefined = isNew
      ? undefined
      : model.rooms.get(id);
    const label = labelOf(id);
    if (prev && prev.label !== label)
      ops.push({ op: "roomLabel", sessionId: id, label });

    const status = roomStatus(s);
    if (!prev || prev.status !== status)
      ops.push({ op: "roomStatus", sessionId: id, status });

    const lines = buildMonitorLines(s, label, 0);
    const key = lines.join("\n");
    if (!prev || prev.monitorKey !== key)
      ops.push({ op: "monitor", sessionId: id, lines, key });

    const tk = todosKey(s.todos);
    if (!prev || prev.todosKey !== tk) {
      ops.push({ op: "todos", sessionId: id, todos: s.todos, key: tk });
    }

    const bk = bubbleKey(s.boss.bubble);
    if (
      !prev ||
      prev.boss.state !== s.boss.state ||
      prev.boss.bubbleKey !== bk
    ) {
      ops.push({ op: "boss", sessionId: id, boss: s.boss });
    }

    const seen = new Set<string>();
    for (const a of s.agents) {
      seen.add(a.id);
      const pa = prev?.agents.get(a.id);
      if (!pa) ops.push({ op: "spawnAgent", sessionId: id, agent: a });
      else if (agentChanged(pa, a))
        ops.push({ op: "updateAgent", sessionId: id, agent: a });
    }
    if (prev) {
      for (const aid of prev.agents.keys()) {
        if (!seen.has(aid))
          ops.push({ op: "departAgent", sessionId: id, agentId: aid });
      }
    }
  }

  if (input.selectedSessionId !== model.selectedSessionId) {
    ops.push({ op: "select", sessionId: input.selectedSessionId });
  }
  return ops;
}

export function applyToModel(model: WorldModel, ops: SyncOp[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "createRoom":
        model.rooms.set(op.sessionId, {
          slot: op.slot,
          label: op.label,
          status: "done",
          monitorKey: "",
          todosKey: "",
          boss: { state: "idle" as BossState, bubbleKey: "" },
          agents: new Map(),
        });
        break;
      case "disposeRoom":
        model.rooms.delete(op.sessionId);
        break;
      case "roomLabel": {
        const r = model.rooms.get(op.sessionId);
        if (r) r.label = op.label;
        break;
      }
      case "roomStatus": {
        const r = model.rooms.get(op.sessionId);
        if (r) r.status = op.status;
        break;
      }
      case "monitor": {
        const r = model.rooms.get(op.sessionId);
        if (r) r.monitorKey = op.key;
        break;
      }
      case "todos": {
        const r = model.rooms.get(op.sessionId);
        if (r) r.todosKey = op.key;
        break;
      }
      case "boss": {
        const r = model.rooms.get(op.sessionId);
        if (r)
          r.boss = {
            state: op.boss.state,
            bubbleKey: bubbleKey(op.boss.bubble),
          };
        break;
      }
      case "spawnAgent":
      case "updateAgent": {
        const r = model.rooms.get(op.sessionId);
        if (r) r.agents.set(op.agent.id, agentModel(op.agent));
        break;
      }
      case "departAgent":
        model.rooms.get(op.sessionId)?.agents.delete(op.agentId);
        break;
      case "select":
        model.selectedSessionId = op.sessionId;
        break;
    }
  }
}
