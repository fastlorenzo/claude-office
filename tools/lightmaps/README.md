# Lightmaps (Blender Cycles)

Baked static lighting for the layout-invariant parts of the office: Cycles
bakes direct + indirect diffuse irradiance offline, the runtime multiplies it
by the surface albedo. The baked files are committed in
`frontend/public/lightmaps/`; the runtime consumer is
`frontend/src/engine/fx/BakedLighting.ts` + `materials/LightmapPlugin.ts`
(a `MaterialPluginBase`; Babylon's built-in `lightmapTexture` is not used: it
adds the lightmap without the albedo and double-counts lights).

Without `manifest.json`, or when a part's geometry no longer matches its hash,
the runtime keeps the realtime path for that part (clustered fixture lights,
static sun shadow map, IBL).

## Sets

| set        | parts (batchers, see `engine/bake/parts.ts`)                    | frame          | light baked in |
|------------|-----------------------------------------------------------------|----------------|----------------|
| `modules`  | the 5 ShellModule prefabs (`projEntry`, `projBay`, `projEnd`, `projDivider`, `podZone`), one atlas | module-local (thin-instance vertex data) | fixtures (incl. window portals), interior HDRI through the glazing, bounce; **no sun** (west rooms are the east ones rotated 180°, daylight differs per side: the realtime sun stays on them) |
| `lobby`    | Building `lobby`                                                | world          | fixtures, **sun**, exterior sky through the glazing, bounce |
| `entrance` | EntranceHall `entrance` (static batcher; not the lift car / doors) | world (frame-local vertex data, frame at origin) | as lobby |
| `control`  | Building `control` floor, ControlRoomShell `controlDrum`, ControlRoom `controlInt` | control-local (world vertex data minus the drum centre) | the room's own zone lights only (it is isolated from sun and fixtures at runtime) + interior HDRI + screens / LED emitters |

The hall, outer walls, empty bays and the factory change with the session
count: they stay realtime (they are only *context* in the bake: occluders,
bounce, emitters). Only non-emissive, non-alpha-blended parts get a lightmap;
glass lets light through in the bake (transparent BSDF), emissive materials
emit (`emissiveColor × emissiveIntensity`; screen canvases at 30 %).

## Pipeline

```bash
make bake-lightmaps                         # export + all sets, SAMPLES=512
SETS="lobby" SAMPLES=256 make bake-lightmaps
```

1. **Export** (`frontend/scripts/export-bake.ts`, bun, NullEngine): builds the
   6-session demo office headless (`engine/bake/bakeScene.ts`: Building,
   project rooms, pods, control room; stubbed 2D canvas and asset library),
   then `engine/bake/exportParts.ts` writes `frontend/.bake/src/<set>.json`
   (git-ignored, outside `public/` so it is never shipped): the set's parts (geometry, hash, the world matrix of one
   representative "hero" copy), every static mesh within 14 m as context
   (with all its instance matrices), the lights that reach the set, sun and
   world. Fixture lights are read back from the live `Lighting` (its KIND
   table and `configure()`), so colour / intensity / direction match runtime.
   The script rebuilds with 2 and 11 sessions and fails if a modules / lobby /
   entrance hash changes (control: warns, see below).
2. **Bake** (`tools/lightmaps/bake.py`, Blender 5.2 on the Windows host with
   OptiX via WSL interop, else a Linux Blender; always under
   `~/.local/share/claude-office-shot/.heavy.lock`):
   - Babylon (left-handed, Y up) → Blender: `(x, y, z) → (x, z, y)`; winding
     fixed per triangle against the exported normals.
   - UV2: one island per connected component (so every original vertex keeps
     exactly one UV — the vertex order and count are the runtime's). Components
     that are height fields over their mean normal (box faces, rounded-box
     faces) are planar-projected; others (cylinders, spheres) get Blender's
     conformal unwrap. Equal texel density, packed axis-aligned with a 6 px
     gap.
   - Units: Babylon PBR is radiometric, so Cycles uses point power
     `4π·I`, sun strength `I`, world strength = `environmentIntensity`; the
     spot falloff is Babylon's physical one, `2^(6.644·(cosθ−1))`, as a light
     node. A test plane matched the analytic value within 0.3 %.
   - `DIFFUSE` bake, direct + indirect, no colour pass (irradiance, no albedo),
     8 px dilation (numpy, after all passes), OIDN through the compositor's
     Denoise node, values capped at 64 (texels touching a luminaire).
   - `modules` bakes in two passes into one atlas: the shell prefabs without
     the pod furniture (it only exists in occupied bays — a vacant bay must
     not show a rug-shaped shadow), then the pod prefab inside the full room.
   - World: interior HDRI (`blender_institute`, 0.42, rotationY 0.35π) for
     modules / control; exterior HDRI (`kloofendal…puresky`, strength 1,
     clamped at 8 to drop its sun disc — the sun lamp carries the sun) for
     lobby / entrance, where the window portal fixtures (a fake sky) are left
     out. The HDRI orientation is approximate (only seen through windows).
   - Control-room zone lights (virtual fills with no luminaire, unshadowed
     at runtime) bake as 0.75 m soft sources: as points, the key light 0.65 m
     under the ops halo housing cast the ring as a hard band across the
     ceiling coffer.
3. **Output** (merged per set into `manifest.json`): `<set>.png`, `<set>_uv2.bin`.
4. **KTX2** (`frontend/scripts/encode-lightmaps.ts`, run by `bake.sh`; or
   `cd frontend && bun scripts/encode-lightmaps.ts [set ...]` after a manual
   bake): `<set>.ktx2`, UASTC quality 4 + zstd, linear, no mips, rows flipped
   (a KTX2 upload keeps the file's row order), recorded as `sets.<set>.ktx2`.
   GPU-compressed (8 bpp) instead of RGBA8: 16 → 4 MB resident per 2048² set.
   The runtime prefers it when KTX2 loads (`?lmktx2=0` forces the PNG) and
   falls back to the PNG on any transcoder / upload failure.

Re-bake whenever geometry of a set changes (hash mismatch → that part is
realtime again; `__worldStats.bakes` lists mismatches).

## Lightmap contract

`frontend/public/lightmaps/manifest.json`:

```json
{ "version": 1,
  "sets": { "<set>": {
    "image": "<set>.png", "ktx2": "<set>.ktx2", "encoding": "rgbd", "rgbdGamma": 2.2,
    "size": 2048, "gain": 1.0, "sun": false,
    "frame": "module-local | world | control-local", "origin": [x, y, z],
    "verify": "position | topology",
    "uv2": "<set>_uv2.bin", "uv2Unit": "float",
    "parts": { "<partName>": { "hash": "…", "vertexCount": 1234, "uv2Offset": 0,
                               "topoHash": "… (topology sets)", "bbox": [6 numbers] } },
    "bake": { "samples": 512, "device": "OPTIX", "seconds": 0, "denoised": true,
              "layout": "demo n=6", "date": "…" } } } }
```

- **partName** = merged mesh name (`<batcher>:<material name>`, `#n` suffix on
  duplicates), as registered by `MeshBatcher.build({ bake })`.
- **hash** (`engine/bake/hash.ts` `partHash`): SHA-1 over int32LE
  `round((p − origin)·1e4)` per x, y, z, then uint32LE indices. Colours, UVs and
  normals are not hashed.
- **verify: "topology"** (control only): the control room moves with the hall,
  and its world-space float32 vertices differ by ~1 ulp between layouts, which
  flips the 0.1 mm quantisation — so it is checked with `topoHash`
  (`topologyHash(vertexCount, indices)`) plus `bbox` (set frame, ±2 mm). For
  very small campuses (2 sessions) the floor and soffit really change: those
  two parts fall back to realtime there.
- **uv2.bin**: float32 LE, per part in manifest order, original vertex order,
  `(u, v)` per vertex; `uv2Offset` counts floats. Blender convention: v = 0 is
  the bottom row of the PNG.
- **ktx2** (optional): the same pixels as UASTC KTX2, rows flipped.
- **Image**: RGBA8 PNG, not premultiplied, Babylon RGBD with gamma 2.2:
  `linear = pow(rgb, 2.2) / a`. Encode: `m = max(r,g,b)`,
  `D = clamp(floor(max(255/m, 1))/255, 0, 1)`, `rgb = pow(c·D, 1/2.2)`, `a = D`.
  Linear irradiance factor (what the runtime multiplies by albedo × `gain`).
  Sample without mipmaps (islands are 6 px apart).
