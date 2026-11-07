/**
 * Lazy Havok loader. The wasm is fetched as an ArrayBuffer and handed to the
 * Emscripten factory (`wasmBinary`) so neither the bundler's `import.meta.url`
 * handling nor the dev server's wasm MIME type matters. Memoised: every world
 * shares one Havok instance; a failure is cached too (callers fall back to
 * `moveWithCollisions`), but `resetHavok()` allows a retry.
 */
import { HavokPlugin } from "@/engine/babylon";

let havokPromise: Promise<unknown> | null = null;

async function loadHavokModule(): Promise<unknown> {
  const [mod, wasmBinary] = await Promise.all([
    import("@babylonjs/havok"),
    fetch("/havok/HavokPhysics.wasm").then((r) => {
      if (!r.ok) throw new Error(`HavokPhysics.wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const factory = mod.default as unknown as (opts: {
    wasmBinary: ArrayBuffer;
  }) => Promise<unknown>;
  return factory({ wasmBinary });
}

/** Resolves to a fresh HavokPlugin (one per scene) backed by the shared wasm module. */
export async function loadHavok(): Promise<HavokPlugin> {
  if (!havokPromise) havokPromise = loadHavokModule();
  const hk = await havokPromise;
  return new HavokPlugin(true, hk);
}

export function resetHavok(): void {
  havokPromise = null;
}
