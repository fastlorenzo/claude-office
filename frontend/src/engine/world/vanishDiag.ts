/**
 * "Why is this building part not drawn?" — runtime diagnostic for the
 * vanishing-shell reports (floors / walls / roof missing while furniture,
 * characters and the control room still draw).
 *
 *   window.__worldDebug.vanish()   (also Ctrl+Shift+V: logged as a table)
 *
 * For every main-shell, control-room and dock mesh it reports what Babylon
 * would need to draw it this frame: enabled (with parents) / visible, in the
 * active list, material ready (per submesh: effect, compile error, the
 * lights the shader binds and whether each is ready), frozen, thin-instance
 * count + buffer validity, world bounds, and which gate last called
 * setEnabled on it (or on the ancestor that switched it off) and when.
 *
 * Gate attribution: `installEnableTracking()` wraps Node.prototype.setEnabled
 * once (a WeakMap write per call); gates run their toggles inside
 * `asGate(name, fn)`. Untagged toggles of shell meshes keep a short stack.
 */
import { Node, type AbstractMesh, type Scene } from "@/engine/babylon";
import { blockingTextures } from "@/engine/materials/readiness";
import { staleLights } from "@/engine/materials/staleEffects";
import {
  currentGate,
  enableRecords,
  type EnableRecord,
} from "@/engine/world/gateTrace";

export type ShellGroup = "main" | "control" | "dock";

/** Main building shell = everything static of the office / factory building. */
const MAIN =
  /^(shell|outer|empty|lobby|entrance|factory|projEntry|projBay|projEnd|projDivider|podZone):/;
const CONTROL = /^(control|controlDrum|controlInt):/;
const DOCK = /^dock:/;

export function shellGroupOf(name: string): ShellGroup | null {
  if (CONTROL.test(name)) return "control";
  if (DOCK.test(name)) return "dock";
  if (MAIN.test(name)) return "main";
  return null;
}

// ---------------------------------------------------------------------------
// setEnabled attribution
// ---------------------------------------------------------------------------

type Toggle = (this: Node, v: boolean) => void;
interface Wrappable {
  setEnabled: Toggle;
  __vanishWrapped?: boolean;
}

/** Wrap Node.prototype.setEnabled once (idempotent, all scenes; cheap). */
export function installEnableTracking(): void {
  const proto = Node.prototype as unknown as Wrappable;
  if (proto.__vanishWrapped) return;
  const orig = proto.setEnabled;
  proto.setEnabled = function (this: Node, v: boolean) {
    // Only real switches are recorded (Babylon ignores same-value calls).
    if (this.isEnabled(false) === v) return orig.call(this, v);
    const current = currentGate();
    const rec: EnableRecord = {
      gate: current ?? "other",
      on: v,
      at: performance.now(),
    };
    if (!current && shellGroupOf(this.name))
      rec.stack = new Error().stack?.split("\n").slice(2, 6).join(" < ");
    enableRecords.set(this, rec);
    return orig.call(this, v);
  };
  proto.__vanishWrapped = true;
}

/** Last toggle of `node`, or of the nearest ancestor that is switched off. */
export function lastEnable(
  node: Node,
): (EnableRecord & { node: string }) | null {
  let n: Node | null = node;
  let first: (EnableRecord & { node: string }) | null = null;
  while (n) {
    const r = enableRecords.get(n);
    if (r) {
      const hit = { ...r, node: n.name };
      if (!n.isEnabled(false)) return hit; // the one holding it off
      first ??= hit;
    }
    n = n.parent;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface VanishRow {
  name: string;
  group: ShellGroup;
  enabled: boolean;
  selfEnabled: boolean;
  visible: boolean;
  active: boolean;
  material: string;
  matReady: boolean | null;
  frozen: boolean | null;
  thin: number | null;
  thinBufOk: boolean | null;
  /** [minX, minY, minZ, maxX, maxY, maxZ] world. */
  bbox: number[];
  last: string | null;
  /** Lights the material binds (first maxSimultaneousLights), "!" = not ready. */
  lights: string[];
  /** Why it cannot draw (empty = drawable). */
  why: string[];
}

export interface VanishGroupStats {
  total: number;
  drawable: number;
  off: number;
  invisible: number;
  notActive: number;
  notReady: number;
  noInstances: number;
  /** Frozen effect compiled for another light set: WebGL rejects the draws. */
  stale: number;
}

export interface VanishReport {
  at: number;
  camera: { x: number; y: number; z: number; name: string };
  groups: Record<ShellGroup, VanishGroupStats>;
  /** Problem rows first (max 80), then a sample of healthy ones per group. */
  rows: VanishRow[];
  /** Every row (unsorted). */
  all: VanishRow[];
  /** Material compile errors seen on shell meshes (first line each). */
  errors: string[];
}

interface SubMeshLike {
  getMaterial(): unknown;
  effect?: {
    isReady(): boolean;
    getCompilationError?(): string;
  } | null;
}

interface LightLike {
  name: string;
  areLightTexturesReady?(): boolean;
  _isReady?(): boolean;
}

interface ThinStore {
  matrixBuffer?: { getBuffer(): unknown } | null;
  matrixData?: Float32Array | null;
}

function lightReady(l: LightLike): boolean {
  try {
    if (l.areLightTexturesReady && !l.areLightTexturesReady()) return false;
    if (l._isReady && !l._isReady()) return false;
  } catch {
    return false;
  }
  return true;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Build the report (cheap: ~100 meshes; runs material readiness checks). */
export function vanishReport(
  scene: Scene,
  extra?: (m: AbstractMesh) => string[],
): VanishReport {
  const now = performance.now();
  const active = new Set<AbstractMesh>();
  const list = scene.getActiveMeshes();
  for (let i = 0; i < list.length; i++) active.add(list.data[i]);
  const empty = (): VanishGroupStats => ({
    total: 0,
    drawable: 0,
    off: 0,
    invisible: 0,
    notActive: 0,
    notReady: 0,
    noInstances: 0,
    stale: 0,
  });
  const groups: Record<ShellGroup, VanishGroupStats> = {
    main: empty(),
    control: empty(),
    dock: empty(),
  };
  const bad: VanishRow[] = [];
  const good: VanishRow[] = [];
  const errors = new Set<string>();
  const engine = scene.getEngine();
  const pass = engine.currentRenderPassId;
  engine.currentRenderPassId = scene.activeCamera?.renderPassId ?? pass;
  try {
    for (const m of scene.meshes) {
      const group = shellGroupOf(m.name);
      if (!group || m.isDisposed()) continue;
      const g = groups[group];
      g.total += 1;
      const why: string[] = [];
      const enabled = m.isEnabled(true);
      const selfEnabled = m.isEnabled(false);
      if (!enabled) {
        why.push(selfEnabled ? "parentOff" : "off");
        g.off += 1;
      }
      if (!m.isVisible || m.visibility <= 0) {
        why.push("invisible");
        g.invisible += 1;
      }
      const mm = m as unknown as {
        hasThinInstances?: boolean;
        thinInstanceCount?: number;
        _thinInstanceDataStorage?: ThinStore;
        getTotalVertices?(): number;
      };
      let thin: number | null = null;
      let thinBufOk: boolean | null = null;
      if (mm.hasThinInstances) {
        thin = mm.thinInstanceCount ?? 0;
        const st = mm._thinInstanceDataStorage;
        thinBufOk =
          !!st?.matrixData &&
          st.matrixData.length >= thin * 16 &&
          !!st.matrixBuffer?.getBuffer();
        if (thin === 0) {
          why.push("0 instances");
          g.noInstances += 1;
        } else if (!thinBufOk) why.push("thinBuffer");
      }
      if ((mm.getTotalVertices?.() ?? 1) === 0) why.push("noVertices");
      const isActive = active.has(m);
      if (enabled && m.isVisible && !isActive) {
        why.push("notActive");
        g.notActive += 1;
      }
      const mat = m.material;
      let matReady: boolean | null = null;
      const lights: string[] = [];
      if (mat) {
        const subs = (m.subMeshes ?? []) as unknown as SubMeshLike[];
        matReady = true;
        const inst = !!mm.hasThinInstances;
        for (const sub of subs) {
          let ok: boolean;
          try {
            ok = (mat as unknown as { _storeEffectOnSubMeshes?: boolean })
              ._storeEffectOnSubMeshes
              ? mat.isReadyForSubMesh(
                  m,
                  sub as unknown as Parameters<typeof mat.isReadyForSubMesh>[1],
                  inst,
                )
              : mat.isReady(m, inst);
          } catch (e) {
            ok = false;
            why.push(`isReady threw: ${String(e).slice(0, 80)}`);
          }
          if (!ok) matReady = false;
          const st = staleLights(
            m,
            mat,
            sub.effect as unknown as { defines?: string } | null,
          );
          if (st && !why.some((w) => w.startsWith("staleEffect"))) {
            why.push(`staleEffect(${st})`);
            g.stale += 1;
          }
          const err = sub.effect?.getCompilationError?.();
          if (err) {
            why.push("compileError");
            errors.add(`${mat.name}: ${err.split("\n")[0].slice(0, 160)}`);
          }
        }
        if (!matReady) {
          why.push("matNotReady");
          g.notReady += 1;
          const tex = blockingTextures(mat).map((t) => t.name || "?");
          if (tex.length) why.push(`tex:${tex.slice(0, 3).join(",")}`);
        }
        const max =
          (mat as unknown as { maxSimultaneousLights?: number })
            .maxSimultaneousLights ?? 4;
        const disabled = (mat as unknown as { disableLighting?: boolean })
          .disableLighting;
        if (!disabled)
          for (const l of (m.lightSources as unknown as LightLike[]).slice(
            0,
            max,
          )) {
            const ok = lightReady(l);
            lights.push(ok ? l.name : `!${l.name}`);
            if (!ok) why.push(`light:${l.name}`);
          }
      }
      if (extra) why.push(...extra(m));
      const b = m.getBoundingInfo().boundingBox;
      const last = lastEnable(m);
      const row: VanishRow = {
        name: m.name,
        group,
        enabled,
        selfEnabled,
        visible: m.isVisible,
        active: isActive,
        material: mat?.name ?? "-",
        matReady,
        frozen: mat ? mat.isFrozen : null,
        thin,
        thinBufOk,
        bbox: [
          r1(b.minimumWorld.x),
          r1(b.minimumWorld.y),
          r1(b.minimumWorld.z),
          r1(b.maximumWorld.x),
          r1(b.maximumWorld.y),
          r1(b.maximumWorld.z),
        ],
        last: last
          ? `${last.gate}:${last.on ? "on" : "off"}@${last.node} ${Math.round((now - last.at) / 100) / 10}s ago${last.stack ? ` [${last.stack}]` : ""}`
          : null,
        lights,
        why,
      };
      // Not in the active list only because the camera does not look at
      // it is normal: it is not a fault on its own.
      const fault = why.some((w) => w !== "notActive");
      if (fault) bad.push(row);
      else {
        g.drawable += 1;
        good.push(row);
      }
    }
  } finally {
    engine.currentRenderPassId = pass;
  }
  const sample: VanishRow[] = [];
  for (const grp of ["main", "control", "dock"] as const)
    sample.push(...good.filter((r) => r.group === grp).slice(0, 3));
  const cam = scene.activeCamera;
  const p = cam?.globalPosition;
  return {
    at: Math.round(now),
    camera: {
      x: r1(p?.x ?? 0),
      y: r1(p?.y ?? 0),
      z: r1(p?.z ?? 0),
      name: cam?.name ?? "-",
    },
    groups,
    rows: [...bad.slice(0, 80), ...sample],
    all: [...bad, ...good],
    errors: [...errors].slice(0, 10),
  };
}

/** Short one-line summary per group (stats overlay / screenshot logs). */
export function vanishSummary(r: VanishReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, g] of Object.entries(r.groups))
    out[k] =
      `${g.drawable}/${g.total} ok` +
      (g.off ? ` off${g.off}` : "") +
      (g.invisible ? ` inv${g.invisible}` : "") +
      (g.notReady ? ` notReady${g.notReady}` : "") +
      (g.noInstances ? ` noInst${g.noInstances}` : "") +
      (g.stale ? ` STALE${g.stale}` : "");
  return out;
}
