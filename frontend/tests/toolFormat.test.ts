import { describe, expect, it } from "vitest";
import {
  editStats,
  formatDuration,
  parseMcpName,
  rendererFor,
  summarizeCall,
  toolKindOf,
} from "@/utils/console/toolFormat";

const sum = (
  toolName: string,
  inputPreview: Record<string, unknown> | null,
  target: string | null = null,
) => summarizeCall({ toolName, target, inputPreview });

describe("toolFormat covers the section 2.5 table", () => {
  it("Edit: path and +a -b", () => {
    const s = sum("Edit", {
      file_path: "a.ts",
      old_string: "x\ny",
      new_string: "x\nz\nw",
    });
    expect(s).toMatchObject({
      kind: "edit",
      renderer: "diff",
      target: "a.ts",
      stat: "+2 −1",
    });
  });
  it("MultiEdit sums all edits", () => {
    const s = sum("MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "", new_string: "c\nd" },
      ],
    });
    expect(s).toMatchObject({ renderer: "diff", stat: "+3 −1" });
    expect(editStats({ foo: 1 })).toBeNull();
  });
  it("Write: path and line count", () => {
    expect(
      sum("Write", { file_path: "w.md", content: "a\nb\nc" }),
    ).toMatchObject({
      kind: "edit",
      renderer: "write",
      target: "w.md",
      stat: "3 lines",
    });
    expect(sum("Write", { file_path: "w.md", content: "a" }).stat).toBe(
      "1 line",
    );
  });
  it("Read: path and :offset-limit", () => {
    expect(
      sum("Read", { file_path: "r.ts", offset: 10, limit: 50 }),
    ).toMatchObject({
      kind: "read",
      renderer: "read",
      target: "r.ts",
      suffix: ":10-60",
    });
    expect(sum("Read", { file_path: "r.ts" }).suffix).toBeNull();
  });
  it("Bash: first command line", () => {
    expect(
      sum("Bash", { command: "ls -la\necho hi", description: "d" }),
    ).toMatchObject({
      kind: "bash",
      renderer: "bash",
      target: "ls -la",
    });
  });
  it("Grep / Glob: pattern and path", () => {
    expect(sum("Grep", { pattern: "TODO", path: "src" })).toMatchObject({
      kind: "search",
      renderer: "search",
      target: "TODO src",
    });
    expect(sum("Glob", { pattern: "**/*.ts" }).target).toBe("**/*.ts");
  });
  it("WebFetch / WebSearch: url and query", () => {
    expect(
      sum("WebFetch", { url: "https://x.dev", prompt: "p" }),
    ).toMatchObject({
      kind: "web",
      renderer: "web",
      target: "https://x.dev",
    });
    expect(sum("WebSearch", { query: "vitest" }).target).toBe("vitest");
  });
  it("Task / Agent: description and subagent type", () => {
    for (const name of ["Task", "Agent"]) {
      expect(
        sum(name, {
          description: "Audit",
          subagent_type: "Explore",
          prompt: "p",
        }),
      ).toMatchObject({
        kind: "agent",
        renderer: "task",
        target: "Audit",
        suffix: "Explore",
      });
    }
  });
  it("TodoWrite: n todos (k done)", () => {
    expect(
      sum("TodoWrite", {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      }),
    ).toMatchObject({ renderer: "todo", target: "2 todos (1 done)" });
    expect(
      sum("TodoWrite", { todos: [{ content: "a", status: "pending" }] }).target,
    ).toBe("1 todo (0 done)");
  });
  it("mcp__srv__tool: srv › tool", () => {
    expect(parseMcpName("mcp__rea__list_names")).toEqual({
      server: "rea",
      tool: "list_names",
    });
    expect(parseMcpName("Bash")).toBeNull();
    expect(sum("mcp__rea__list_names", { query: "main" })).toMatchObject({
      kind: "mcp",
      renderer: "mcp",
      label: "rea › list_names",
      target: "main",
    });
  });
  it("unknown: first string field and JSON renderer", () => {
    expect(sum("Weird", { n: 1, s: "hello\nworld" })).toMatchObject({
      kind: "other",
      renderer: "json",
      target: "hello",
    });
    expect(toolKindOf("Weird")).toBe("other");
    expect(rendererFor("Weird")).toBe("json");
  });
  it("prefers the backend-provided target when present", () => {
    expect(
      sum("Read", { file_path: "ignored" }, "backend/path.ts").target,
    ).toBe("backend/path.ts");
  });
  it("formatDuration", () => {
    expect(formatDuration(400)).toBe("400ms");
    expect(formatDuration(4100)).toBe("4.1s");
    expect(formatDuration(40_000)).toBe("40s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(3_900_000)).toBe("1h05m");
  });
});
