import { describe, expect, it } from "vitest";
import {
  bucketTodos,
  noteTilt,
  parseMonitorLines,
  statusForBossState,
} from "@/engine/screens/screenModels";
import {
  bubbleLayout,
  labelFade,
  LABEL_FADE_END,
  LABEL_FADE_START,
} from "@/engine/screens/labelMath";
import { buildMonitorLines } from "@/engine/logic/monitorText";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import {
  agentStateLabel,
  bossStateLabel,
  hashString,
  hexToRgb,
  pickAppearance,
  seed01,
  shadeHex,
} from "@/engine/characters/identity";
import {
  isUpperBodyBone,
  POSE_LAYERS,
  SEATED_CLIPS,
} from "@/engine/characters/gltfLayers";
import { isSeatedPose } from "@/engine/characters/poses";
import type { CharacterPose } from "@/engine/contracts";
import type { AgentState, BossState, TodoItem } from "@/types";

describe("parseMonitorLines", () => {
  it("parses buildMonitorLines output", () => {
    const { campus } = createDemoCampus(2, 61_000);
    const lines = buildMonitorLines(campus[0], "claude-office", 61_000);
    const m = parseMonitorLines(lines);
    expect(m.structured).toBe(true);
    expect(m.label).toBe("claude-office");
    expect(m.state).toBe(campus[0].boss.state.toUpperCase());
    expect(m.activity.length).toBeLessThanOrEqual(8);
    expect(m.todoTotal).toBe(campus[0].todos.length);
    expect(m.ctxPct).toBeGreaterThanOrEqual(0);
    expect(m.ctxPct).toBeLessThanOrEqual(100);
  });

  it("falls back to raw lines for unknown formats", () => {
    const m = parseMonitorLines(["hello", "world"]);
    expect(m.structured).toBe(false);
    expect(m.raw).toEqual(["hello", "world"]);
  });

  it("maps boss states to room status colours", () => {
    expect(statusForBossState("WAITING_PERMISSION")).toBe("needs_you");
    expect(statusForBossState("IDLE")).toBe("done");
    expect(statusForBossState("WORKING")).toBe("working");
  });
});

describe("bucketTodos", () => {
  const todos: TodoItem[] = [
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress", active_form: "Doing b" },
    { content: "c", status: "completed" },
    { content: "d", status: "completed" },
    { content: "e", status: "pending" },
    { content: "f", status: "pending" },
  ];

  it("buckets by status, newest done first, active form for in-progress", () => {
    const [pending, doing, done] = bucketTodos(todos, 5);
    expect(pending.items.map((i) => i.text)).toEqual(["a", "e", "f"]);
    expect(doing.items.map((i) => i.text)).toEqual(["Doing b"]);
    expect(done.items.map((i) => i.text)).toEqual(["d", "c"]);
    expect(pending.total).toBe(3);
  });

  it("reserves a slot for '+N more' when a column overflows", () => {
    const [pending] = bucketTodos(todos, 2);
    expect(pending.items).toHaveLength(1);
    expect(pending.overflow).toBe(2);
    expect(bucketTodos([], 3).every((c) => c.total === 0)).toBe(true);
  });

  it("note tilt is small and stable", () => {
    for (let i = 0; i < 20; i++) {
      expect(Math.abs(noteTilt(i))).toBeLessThanOrEqual(0.035);
      expect(noteTilt(i)).toBe(noteTilt(i));
    }
  });
});

describe("labels", () => {
  it("fades labels out between the fade distances and shrinks with distance", () => {
    expect(labelFade(2).alpha).toBe(1);
    expect(labelFade(LABEL_FADE_END + 1).alpha).toBe(0);
    const mid = labelFade((LABEL_FADE_START + LABEL_FADE_END) / 2).alpha;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(labelFade(10).scale).toBeLessThan(labelFade(2).scale);
  });
  it("sizes bubbles to the text", () => {
    const short = bubbleLayout("ok");
    const long = bubbleLayout("x".repeat(60));
    expect(long.width).toBeGreaterThanOrEqual(short.width);
    expect(long.lines).toBeGreaterThan(1);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.holdSec).toBeGreaterThan(short.holdSec);
  });
});

describe("identity", () => {
  it("is deterministic per id", () => {
    expect(hashString("agent-1")).toBe(hashString("agent-1"));
    expect(hashString("agent-1")).not.toBe(hashString("agent-2"));
    expect(pickAppearance("x", false)).toEqual(pickAppearance("x", false));
    expect(seed01("abc")).toBeGreaterThanOrEqual(0);
    expect(seed01("abc")).toBeLessThan(1);
  });
  it("labels every agent and boss state", () => {
    const agentStates: AgentState[] = [
      "arriving",
      "reporting",
      "walking_to_desk",
      "working",
      "thinking",
      "waiting_permission",
      "completed",
      "waiting",
      "reporting_done",
      "leaving",
      "in_elevator",
      "idle",
    ];
    for (const s of agentStates)
      expect(agentStateLabel(s).length).toBeGreaterThan(0);
    const bossStates: BossState[] = [
      "idle",
      "phone_ringing",
      "on_phone",
      "receiving",
      "working",
      "delegating",
      "waiting_permission",
      "reviewing",
      "completing",
    ];
    for (const s of bossStates)
      expect(bossStateLabel(s).length).toBeGreaterThan(0);
  });
  it("parses and shades hex colours", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb("nope")).toEqual([0.5, 0.5, 0.5]);
    expect(shadeHex("#808080", 0.5)).toBe("#404040");
  });
});

describe("glTF clip layers", () => {
  it("classifies Biped bones into upper / lower layers", () => {
    for (const n of [
      "Bip01 Spine2",
      "Bip01 L Clavicle",
      "Bip01 R UpperArm",
      "Bip01 L Forearm",
      "Bip01 R Hand",
      "Bip01 R Finger12",
      "Bip01 Neck",
      "Bip01 Head",
    ]) {
      expect(isUpperBodyBone(n)).toBe(true);
    }
    for (const n of [
      "Bip01",
      "Bip01 Pelvis",
      "Bip01 L Thigh",
      "Bip01 R Calf",
      "Bip01 L Foot",
      "Bip01 R Toe0",
    ]) {
      expect(isUpperBodyBone(n)).toBe(false);
    }
  });
  it("seated poses keep seated legs", () => {
    for (const [pose, [lower]] of Object.entries(POSE_LAYERS) as [
      CharacterPose,
      [string, string],
    ][]) {
      expect(SEATED_CLIPS.has(lower as never)).toBe(isSeatedPose(pose));
    }
  });
});
