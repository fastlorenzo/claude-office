import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const BANNED = [/^@babylonjs\//, /^pixi\.js$/, /^@pixi\//, /^pixi-/];

/** Matches `import x from "m"`, `export ... from "m"`, `import "m"`, `import("m")`. */
const SPEC =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveFile(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : join(dirname(from), spec);
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Walks the static + dynamic runtime import graph (type-only imports erased). */
function walk(entry: string): {
  files: Set<string>;
  bare: Map<string, string>;
} {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(SPEC)) {
      if (m[1]) continue; // `import type`
      const spec = m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const r = resolveFile(f, spec);
        if (r) stack.push(r);
      } else if (!bare.has(spec)) {
        bare.set(spec, f);
      }
    }
  }
  return { files, bare };
}

describe("/dashboard import graph", () => {
  const { files, bare } = walk(join(SRC, "app/dashboard/page.tsx"));

  it("walks the real graph", () => {
    expect(files.size).toBeGreaterThan(30);
    expect(bare.has("react")).toBe(true);
  });

  it("pulls in no WebGL renderer (@babylonjs/*, pixi.js, @pixi/react)", () => {
    const hits = [...bare].filter(([spec]) => BANNED.some((b) => b.test(spec)));
    expect(hits).toEqual([]);
  });

  it("never reaches the engine renderer or the world canvas", () => {
    const bad = [...files].filter((f) =>
      /engine\/babylon|WorldCanvas|WorldView|\/components\/game\/|pixi/i.test(
        f.slice(SRC.length),
      ),
    );
    expect(bad).toEqual([]);
  });
});
