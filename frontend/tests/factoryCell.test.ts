import { describe, expect, it } from "vitest";
import { CHECK_COLORS } from "@/engine/contracts";
import { demoFactoryProjects } from "@/engine/demo/demoFactory";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import { buildFactoryLayout } from "@/engine/layout/factoryLayout";
import { buildFactoryModel, type LineModel } from "@/engine/logic/factoryModel";
import {
  BOARD,
  FURNITURE_PARTS,
  GATE_HEX,
  GATE_OPEN_ANGLE,
  boardLine,
  cellFurnitureKey,
  gateColor,
  laneGateState,
  packPart,
  planCell,
} from "@/engine/world/factory/cellPlan";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const projects = demoFactoryProjects([], NOW, { projects: 3 });
const reqs = projects.map((p, i) => ({
  id: p.id,
  createdAt: i,
  sessions: [3, 2, 4][i],
}));
const slots = allocateSlots(new Map(), reqs);
const building = generateLayout(
  slots,
  reqs.map((r) => ({
    id: r.id,
    sessionIds: Array.from({ length: r.sessions }, (_, k) => `${r.id}s${k}`),
  })),
);
const layout = buildFactoryLayout(building);
const model = buildFactoryModel(projects, [], NOW, {
  lanesFor: (id) =>
    layout.cells.find((c) => c.projectId === id)?.lanes.length ?? 4,
});
const lines = new Map(model.lines.map((l) => [l.projectId, l]));
const count = (items: { kind: string }[], kind: string) =>
  items.filter((i) => i.kind === kind).length;

describe("planCell furniture", () => {
  it("emits one kit per lane and the per-cell pieces", () => {
    expect(layout.cells.length).toBe(3);
    for (const cell of layout.cells) {
      const n = cell.lanes.length;
      const plan = planCell(cell, lines.get(cell.projectId));
      expect(count(plan.items, "qaDesk") > 0).toBe(true);
      expect(count(plan.items, "gateArm")).toBe(n);
      expect(plan.gates.length).toBe(n);
      expect(count(plan.items, "lanePlate")).toBe(2 * n); // post + plate
      expect(plan.items.filter((i) => i.part === "plate").length).toBe(n);
      expect(count(plan.items, "intakeRack") > 0).toBe(true);
      expect(count(plan.items, "reworkArch") / n).toBe(4);
      expect(count(plan.items, "bollard")).toBe(12);
      expect(count(plan.items, "holdingRack") > 0).toBe(true);
      expect(count(plan.items, "scrapBin") > 0).toBe(true);
      expect(count(plan.items, "bench") > 0).toBe(true);
      expect(count(plan.items, "boardMount")).toBe(2);
    }
  });

  it("puts lane furniture at the layout x positions, mirrored by side", () => {
    for (const cell of layout.cells) {
      const plan = planCell(cell, lines.get(cell.projectId));
      for (const lane of cell.lanes) {
        const arms = plan.items.filter(
          (i) => i.kind === "gateArm" && i.lane === lane.index,
        );
        expect(arms.length).toBe(1);
        expect(arms[0].x).toBeCloseTo(lane.gateX, 5);
        expect(Math.abs(arms[0].z - lane.z)).toBeLessThan(0.7);
        const arch = plan.items.find(
          (i) => i.kind === "reworkArch" && Math.abs(i.z - lane.z) < 0.7,
        );
        expect(arch?.x).toBeCloseTo(lane.reworkX, 5);
      }
      for (const it of plan.items) {
        if (it.kind === "boardMount") continue;
        // everything stands on / above the cell floor, inside the cell rect (+1 m)
        expect(it.y).toBeGreaterThanOrEqual(cell.bench.y - 1e-6);
        expect(it.x).toBeGreaterThan(Math.min(cell.rect.x0, cell.rect.x1) - 1);
        expect(it.x).toBeLessThan(Math.max(cell.rect.x0, cell.rect.x1) + 1);
        expect(it.z).toBeGreaterThan(cell.z0 - 1);
        expect(it.z).toBeLessThan(cell.z1 + 1);
      }
    }
  });

  it("uses at most 4 pools and packs every item", () => {
    const items = layout.cells.flatMap(
      (c) => planCell(c, lines.get(c.projectId)).items,
    );
    expect(FURNITURE_PARTS.length).toBeLessThanOrEqual(6);
    let total = 0;
    for (const p of FURNITURE_PARTS) {
      const pk = packPart(items, p);
      expect(pk.mats.length).toBe(pk.count * 16);
      expect(pk.cols.length).toBe(pk.count * 4);
      total += pk.count;
    }
    expect(total).toBe(items.length);
  });

  it("detail levels: hidden empty, impostor drops minor items", () => {
    const cell = layout.cells[0];
    const m = lines.get(cell.projectId);
    const full = planCell(cell, m, "full");
    const imp = planCell(cell, m, "impostor");
    const hid = planCell(cell, m, "hidden");
    expect(hid.items.length).toBe(0);
    expect(imp.items.length).toBeLessThan(full.items.length);
    expect(imp.items.every((i) => !i.minor)).toBe(true);
    expect(count(imp.items, "gateArm")).toBe(count(full.items, "gateArm"));
  });

  it("furniture key tracks gate state but not the header text", () => {
    const cell = layout.cells[0];
    const m = lines.get(cell.projectId) as LineModel;
    const k0 = cellFurnitureKey(cell, m, "full");
    expect(cellFurnitureKey(cell, { ...m, header: "X" }, "full")).toBe(k0);
    expect(cellFurnitureKey(cell, m, "impostor")).not.toBe(k0);
  });

  it("raises the gate arm only for a mergeable piece", () => {
    const cell = layout.cells[0];
    const m = lines.get(cell.projectId) as LineModel;
    const mk = (seg: "gate" | "qa", t: number, stuck = false): LineModel => ({
      ...m,
      workpieces: [
        {
          ...m.workpieces[0],
          lane: 0,
          stuck,
          position: { segment: seg, t },
        },
      ],
    });
    const open = planCell(cell, mk("gate", 1));
    const arm = open.items.find((i) => i.kind === "gateArm" && i.lane === 0)!;
    expect(arm.rx).toBeCloseTo(GATE_OPEN_ANGLE, 5);
    const closed = planCell(cell, mk("gate", 0.4));
    expect(
      closed.items.find((i) => i.kind === "gateArm" && i.lane === 0)!.rx ?? 0,
    ).toBe(0);
  });
});

describe("gate colour mapping", () => {
  const base = lines.values().next().value as LineModel;
  const withPiece = (
    seg: "gate" | "qa",
    t: number,
    stuck = false,
  ): LineModel => ({
    ...base,
    workpieces: [
      { ...base.workpieces[0], lane: 1, stuck, position: { segment: seg, t } },
    ],
  });

  it("maps states to the check colours", () => {
    expect(laneGateState(null, 0)).toBe("idle");
    expect(laneGateState(withPiece("qa", 0), 1)).toBe("review");
    expect(laneGateState(withPiece("gate", 0.5), 1)).toBe("pending");
    expect(laneGateState(withPiece("gate", 1), 1)).toBe("open");
    expect(laneGateState(withPiece("gate", 1, true), 1)).toBe("blocked");
    expect(laneGateState(withPiece("gate", 1), 0)).toBe("idle");
    expect(gateColor("open")).toBe(CHECK_COLORS.done);
    expect(gateColor("review")).toBe(CHECK_COLORS.needs_you);
    expect(gateColor("blocked")).toBe(CHECK_COLORS.failure);
    expect(new Set(Object.values(GATE_HEX)).size).toBe(5);
  });
});

describe("header board text", () => {
  it("starts with LineModel.header and appends lanes + queue", () => {
    for (const l of model.lines) {
      const b = boardLine(l);
      expect(b.text.startsWith(l.header)).toBe(true);
      expect(b.text).toContain(
        `LANES ${l.laneBusy.filter(Boolean).length}/${l.lanes}`,
      );
      if (l.queued > 0) expect(b.text).toContain(`${l.queued} queued`);
      else expect(b.text).not.toContain("queued");
      expect(b.segments.map((s) => s.text).join("")).toBe(b.text);
    }
    expect(model.lines.some((l) => l.queued > 0)).toBe(true);
  });

  it("local (no CI) lines show only the header", () => {
    const l = {
      ...model.lines[0],
      mode: "local" as const,
      header: "X · LOCAL · no CI",
    };
    expect(boardLine(l).text).toBe("X · LOCAL · no CI");
  });

  it("board aspect matches the LED single-line texture", () => {
    expect(BOARD.w / BOARD.h).toBeCloseTo(12.8, 5);
  });
});
