/**
 * Headless lightmap export (tools/lightmaps): builds the 6-session demo
 * office under NullEngine and writes one bake source per set to
 * public/lightmaps/src/<set>.json (git-ignored) for tools/lightmaps/bake.py.
 *
 *   bun scripts/export-bake.ts [--n 6] [--out public/lightmaps/src] [set ...]
 *
 * Also checks that every exported part hash is layout-invariant (rebuilds
 * with 2 and 11 sessions) and fails if one is not.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBakeScene, demoBuildingLayout } from "@/engine/bake/bakeScene";
import {
  asFixturePoints,
  BAKE_SET_NAMES,
  exportSet,
  fixtureLights,
  hashSet,
  type BakeSetName,
} from "@/engine/bake/exportParts";
import { topologyHash } from "@/engine/bake/hash";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const n = Number(opt("--n", "6"));
const out = opt(
  "--out",
  join(import.meta.dir, "..", "public", "lightmaps", "src"),
);
const sets = (argv.length ? argv : BAKE_SET_NAMES) as BakeSetName[];

const t0 = performance.now();
const s = buildBakeScene(demoBuildingLayout(n));
const fixtures = asFixturePoints(s.fixtures);
const lights = fixtureLights(s.lighting, s.scene, fixtures);
mkdirSync(out, { recursive: true });
const ref = new Map<string, string>();
for (const set of sets) {
  const e = exportSet(
    {
      scene: s.scene,
      lighting: s.lighting,
      layout: s.layout,
      fixtures,
      lights,
      label: `demo n=${n}`,
    },
    set,
  );
  for (const t of e.targets) ref.set(`${set}|${t.name}`, t.topoHash ?? t.hash);
  const json = JSON.stringify(e);
  writeFileSync(join(out, `${set}.json`), json);
  console.log(
    `[export-bake] ${set}: ${e.targets.length} parts, ${Object.keys(e.meshes).length} meshes, ` +
      `${e.instances.reduce((a, i) => a + i.matrices.length, 0)} copies, ${e.lights.length} lights, ` +
      `${(json.length / 1e6).toFixed(1)} MB`,
  );
}
s.dispose();

// Layout invariance: the same parts must hash the same for other campuses.
let bad = 0;
for (const m of [2, 11]) {
  const o = buildBakeScene(demoBuildingLayout(m));
  for (const set of sets) {
    const topo = set === "control";
    for (const p of hashSet(o.scene, set, o.layout)) {
      const mesh = o.scene.getMeshByName(p.name);
      const h = topo
        ? topologyHash(p.vertexCount, mesh?.getIndices() ?? [])
        : p.hash;
      const want = ref.get(`${set}|${p.name}`);
      if (want !== h) {
        // Control moves with the hall and its neck follows small layouts:
        // the runtime falls back per part there; anything else is a bug.
        if (!topo) bad += 1;
        console.warn(
          `[export-bake] n=${m}: ${set} part ${p.name} ${want ? "hash differs" : "is new"}${topo ? " (control: realtime fallback for this layout)" : ""}`,
        );
      }
    }
  }
  o.dispose();
}
console.log(
  `[export-bake] done in ${Math.round(performance.now() - t0)} ms → ${out}`,
);
if (bad) process.exit(1);
