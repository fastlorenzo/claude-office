# Lightmaps (Blender Cycles) — scaffold

Baked GI for the static building modules. **Status: partial.** Export and the
Blender bake script exist; the runtime loader (UV2 + `lightmapTexture` on the
module materials) is not wired yet, so the engine stays fully realtime:

- clustered spot lights, one per luminaire (`Lighting`, ClusteredLightContainer)
- a static, render-once whole-building daylight shadow map (ceilings occlude
  the sun, windows cast patches)
- cool daylight "portal" lights at every window, warm fixtures inside
- box-projected reflection probes on the hall / lobby / control-room floors

## Why modules

Rooms are one prefab (`frontend/src/engine/world/RoomShell.ts`): the shell and
its furniture are merged per material and drawn for every room with thin
instances. One bake of that module serves every room; the lobby, a hall
segment and the control room would be three more modules.

## Steps

1. Export the room module from a running `/world-debug` page (devtools):

   ```js
   copy(__claudeOfficeExportRoom())
   ```

   Save it as `frontend/public/assets/lightmaps/room.json` (git-ignored).

2. Bake on the Windows GPU (one Blender at a time, via the heavy lock):

   ```bash
   flock ~/.local/share/claude-office-shot/.heavy.lock \
     "/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
     --background --python "$(wslpath -w tools/lightmaps/bake.py)" -- \
     --in  "$(wslpath -w frontend/public/assets/lightmaps/room.json)" \
     --out "$(wslpath -w frontend/public/assets/lightmaps)" \
     --size 1024 --samples 256
   ```

   Output: `room_lightmap.png` (irradiance, no albedo) and `room_uv2.json`
   (per-vertex UV2 per part, original vertex order).

## Runtime integration (to do)

- `RoomShellModule`: if `/assets/lightmaps/room_uv2.json` exists, set
  `VertexBuffer.UV2Kind` on each part by name, clone the module materials once
  (`room:*`) with `lightmapTexture = room_lightmap.png`,
  `lightmapTexture.coordinatesIndex = 1`, `useLightmapAsShadowmap = false`.
- Put the fixture spot lights in `Light.LIGHTMAP_SHADOWSONLY` mode for those
  materials (or exclude them) so baked light is not counted twice; keep the
  key light's cascades for characters.
- Fall back to realtime when the files are missing (current behaviour).
