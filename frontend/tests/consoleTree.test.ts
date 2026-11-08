import { describe, expect, it } from "vitest";
import {
  longSession,
  nestedAgentsSession,
  permissionSession,
  reattributionSession,
  makeToolCall,
} from "@/components/console/fixtures";
import { EMPTY_FILTERS, type ConsoleFilters } from "@/utils/console/filters";
import { matchesQuery } from "@/utils/console/search";
import { agentWithDescendants, flattenVisible } from "@/utils/console/tree";
import type { ConsoleSnapshot } from "@/utils/console/types";

function inputs(s: ConsoleSnapshot) {
  return {
    calls: new Map(s.toolCalls.map((c) => [c.id, c])),
    order: s.toolCalls.map((c) => c.id),
    agents: new Map(s.agents.map((a) => [a.id, a])),
  };
}
const flat = (
  s: ConsoleSnapshot,
  expanded: string[],
  f: Partial<ConsoleFilters>,
  mode: "tree" | "flat",
) => {
  const i = inputs(s);
  return flattenVisible(
    i.calls,
    i.order,
    i.agents,
    new Set(expanded),
    { ...EMPTY_FILTERS, ...f },
    mode,
  );
};
const keys = (rows: { key: string }[]) =>
  rows.map((r) => r.key.replace("toolu_", ""));

describe("flattenVisible", () => {
  it("tree: collapsed Task rows hide their blocks", () => {
    const rows = flat(nestedAgentsSession(), [], {}, "tree");
    expect(keys(rows)).toEqual(["1", "2", "8"]);
    expect(rows[1].childCount).toBe(5);
  });

  it("tree: expanding nests subagent rows with depth, including nested agents", () => {
    const rows = flat(
      nestedAgentsSession(),
      ["toolu_2", "toolu_4"],
      {},
      "tree",
    );
    expect(keys(rows)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1, 2, 2, 1, 0]);
    // Collapsing the outer block hides the inner one too.
    expect(keys(flat(nestedAgentsSession(), ["toolu_4"], {}, "tree"))).toEqual([
      "1",
      "2",
      "8",
    ]);
  });

  it("flat is chronological regardless of expansion, with ancestry depth", () => {
    const rows = flat(nestedAgentsSession(), [], {}, "flat");
    expect(keys(rows)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1, 2, 2, 1, 0]);
  });

  it("re-attribution moves the row under the subagent", () => {
    const { initial, merged } = reattributionSession();
    const before = flat(initial, ["toolu_2"], {}, "tree");
    expect(keys(before)).toEqual(["1", "2", "3", "4"]);
    expect(before.find((r) => r.key === "toolu_3")?.depth).toBe(0);
    const after = flat(
      {
        ...initial,
        toolCalls: initial.toolCalls.map((c) =>
          c.id === merged.id ? merged : c,
        ),
      },
      ["toolu_2"],
      {},
      "tree",
    );
    expect(after.find((r) => r.key === "toolu_3")?.depth).toBe(1);
    // Collapsed, the row disappears into the block.
    const collapsed = flat(
      {
        ...initial,
        toolCalls: initial.toolCalls.map((c) =>
          c.id === merged.id ? merged : c,
        ),
      },
      [],
      {},
      "tree",
    );
    expect(keys(collapsed)).toEqual(["1", "2", "4"]);
  });

  it("a filter that hides children keeps the Task row with a hidden count", () => {
    const s = nestedAgentsSession();
    const rows = flat(
      s,
      ["toolu_2", "toolu_4"],
      { kinds: new Set(["agent"]) },
      "tree",
    );
    // Only Task/Agent rows match; both stay, their other children are hidden.
    expect(keys(rows)).toEqual(["2", "4"]);
    expect(rows[0].hiddenCount).toBe(4); // 3, 5, 6, 7 hidden; 4 shown
    expect(rows[1].hiddenCount).toBe(2); // 5, 6
  });

  it("keeps an ancestor Task row that does not match when a descendant does", () => {
    const s = nestedAgentsSession();
    const rows = flat(
      s,
      ["toolu_2", "toolu_4"],
      { agentIds: new Set(["sub_b"]) },
      "tree",
    );
    expect(keys(rows)).toEqual(["2", "4", "5", "6"]);
  });

  it("errorsOnly and waitingOnly filter by status", () => {
    const s = longSession(200);
    const errs = flat(s, [], { errorsOnly: true }, "flat");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((r) => r.call.status === "error")).toBe(true);
    expect(flat(s, [], { waitingOnly: true }, "flat")).toHaveLength(0);
    const p = flat(permissionSession(), [], { waitingOnly: true }, "flat");
    expect(p.map((r) => r.call.status)).toEqual(["waiting_permission"]);
  });

  it("agentWithDescendants collects the subtree", () => {
    const i = inputs(nestedAgentsSession());
    expect([...agentWithDescendants(i.agents, "sub_a")].sort()).toEqual([
      "sub_a",
      "sub_b",
    ]);
    expect([...agentWithDescendants(i.agents, "sub_b")]).toEqual(["sub_b"]);
  });

  it("handles 5000 calls quickly in both modes", () => {
    const s = longSession(5000);
    const t = performance.now();
    expect(flat(s, [], {}, "flat")).toHaveLength(5000);
    const tree = flat(s, [], {}, "tree");
    expect(tree.length).toBeLessThan(5000);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("search", () => {
  const c = makeToolCall(1, {
    toolName: "Bash",
    target: "git push",
    inputPreview: { command: "git push origin FEAT", nested: { a: 1 } },
    outputPreview: "Everything up-to-date",
    error: "boom",
  });
  it("matches target, input, output, tool name and error case-insensitively", () => {
    for (const q of [
      "GIT PUSH",
      "origin feat",
      "up-to-date",
      "bash",
      "BOOM",
      "  git  ".trim(),
    ]) {
      expect(matchesQuery(c, q)).toBe(true);
    }
    expect(matchesQuery(c, "nope")).toBe(false);
    expect(matchesQuery(c, "")).toBe(true);
    expect(matchesQuery(c, '"a":1')).toBe(true);
  });
});
