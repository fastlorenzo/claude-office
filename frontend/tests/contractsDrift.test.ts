/**
 * C6: `engine/contracts.ts` is hand-written; the backend (pydantic) is the
 * source of truth for the /ws/campus wire format. This test exports the
 * backend JSON schema (`backend/tests/export_campus_schema.py`) and compares
 * field names (wire/alias names) and string enums for every interface that
 * exists on both sides.
 *
 * Needs `uv` + the backend venv; skipped (with a warning) when unavailable.
 * A field a side intentionally lacks goes in the allow-lists below, with a reason.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface JsonSchema {
  properties?: Record<string, unknown>;
  enum?: string[];
  $defs?: Record<string, JsonSchema>;
}

const ROOT = path.resolve(__dirname, "..", "..");
const CONTRACTS = path.resolve(__dirname, "..", "src", "engine", "contracts.ts");

function loadSchema(): JsonSchema | null {
  const r = spawnSync(
    "uv",
    ["run", "python", "tests/export_campus_schema.py"],
    {
      cwd: path.join(ROOT, "backend"),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (r.error || r.status !== 0) {
    console.warn(
      "[contractsDrift] backend schema export unavailable, skipping:",
      r.error?.message ?? r.stderr.slice(0, 300),
    );
    return null;
  }
  return JSON.parse(r.stdout) as JsonSchema;
}

function tsInterfaces(): Map<string, Set<string>> {
  const src = ts.createSourceFile(
    CONTRACTS,
    readFileSync(CONTRACTS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out = new Map<string, Set<string>>();
  src.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n)) return;
    const props = new Set<string>();
    for (const m of n.members) {
      if (ts.isPropertySignature(m) && m.name) props.add(m.name.getText(src));
    }
    out.set(n.name.text, props);
  });
  return out;
}

function tsUnion(name: string): Set<string> | null {
  const src = ts.createSourceFile(
    CONTRACTS,
    readFileSync(CONTRACTS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: Set<string> | null = null;
  src.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === name) {
      const vals = new Set<string>();
      const walk = (t: ts.TypeNode): void => {
        if (ts.isUnionTypeNode(t)) t.types.forEach(walk);
        else if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
          vals.add(t.literal.text);
      };
      walk(n.type);
      found = vals;
    }
  });
  return found;
}

/** Backend fields the frontend deliberately does not declare. */
const BACKEND_ONLY: Record<string, string[]> = {};
/** Frontend fields the backend does not send (client-side extras). */
const FRONTEND_ONLY: Record<string, string[]> = {};

/** Schema def name -> contracts.ts interface name (same by default). */
const ENUMS: Record<string, string> = {
  CheckState: "CheckState",
  CheckKind: "CheckKind",
};

const schema = loadSchema();
const maybe = schema ? describe : describe.skip;

maybe("contracts.ts vs backend /ws/campus schema", () => {
  const defs: Record<string, JsonSchema> = {
    ...(schema?.$defs ?? {}),
    CampusState: schema ?? {},
  };
  const ifaces = tsInterfaces();
  const shared = Object.keys(defs).filter(
    (k) => ifaces.has(k) && defs[k].properties,
  );

  it("covers the core campus models", () => {
    for (const k of [
      "CampusState",
      "CampusSession",
      "CampusProject",
      "PullRequestInfo",
      "CampusStats",
    ]) {
      expect(shared, k).toContain(k);
    }
  });

  for (const name of shared) {
    it(`${name}: field names match`, () => {
      const be = Object.keys(defs[name].properties ?? {});
      const fe = ifaces.get(name) as Set<string>;
      const missingInFe = be.filter(
        (f) => !fe.has(f) && !(BACKEND_ONLY[name] ?? []).includes(f),
      );
      const missingInBe = [...fe].filter(
        (f) => !be.includes(f) && !(FRONTEND_ONLY[name] ?? []).includes(f),
      );
      expect({ missingInFe, missingInBe }).toEqual({
        missingInFe: [],
        missingInBe: [],
      });
    });
  }

  for (const [def, tsName] of Object.entries(ENUMS)) {
    it(`${def}: enum values match`, () => {
      const be = defs[def]?.enum;
      const fe = tsUnion(tsName);
      if (!be || !fe) return; // not an enum on one side: nothing to compare
      expect([...fe].sort()).toEqual([...be].sort());
    });
  }
});
