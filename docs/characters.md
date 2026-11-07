# 3D characters: casts and bring-your-own packs

The 3D office draws every Claude Code session as a room: the main agent is the boss at the
boss desk and each subagent sits at a desk. Characters come from one of three packs, chosen by
the **Character cast** setting (Graphics menu, key `O`, or Settings → Graphics):

| Cast | Boss | Subagents | Notes |
|---|---|---|---|
| `mixed` (default) | Rocketbox | MPFB | Rocketbox has the better face for the close-up hero; MPFB brings seated typing with finger motion and more diverse people. |
| `rocketbox` | Rocketbox | Rocketbox | Microsoft Rocketbox avatars (MIT), `bun run characters`. |
| `mpfb` | MPFB | MPFB | MakeHuman / MPFB2 cast (CC0), built by `tools/mpfb/build.sh`. |
| `custom` | your pack | your pack | GLBs you drop into `frontend/public/assets/characters-custom/`. |

Missing packs fall back in order (custom → MPFB → Rocketbox → procedural mannequin), so the
office always renders, including in CI where no assets are downloaded. Changing the setting swaps
the characters live. Each character's look is picked from its session and agent id, so it stays
the same across reloads.

All three packs live under `frontend/public/assets/`, which git ignores. **Never commit character
assets.**

## Bring your own characters

### 1. Export

Any rigged, humanoid glTF 2.0 binary (`.glb`) works. The rig must use one of the supported
bone-naming schemes:

| `skeleton` | Bone names | Typical source |
|---|---|---|
| `cc` | `CC_Base_Hip`, `CC_Base_L_Upperarm`, ... | Character Creator 4/5, iClone, ActorCore |
| `unreal` (alias `metahuman`) | `pelvis`, `spine_01`, `upperarm_l`, ... | UE4/UE5 mannequin, MetaHuman body |
| `mixamo` | `mixamorig:Hips`, `mixamorig:LeftArm`, ... | Mixamo auto-rigger, many marketplace rigs |
| `mpfb` | `pelvis`, `spine_01`, ... (MPFB `game_engine` rig) | MakeHuman / MPFB2 |
| `rocketbox` | `Bip01 Pelvis`, ... | Microsoft Rocketbox, 3ds Max Biped |

**Character Creator (CC4/CC5)**

1. Export as **FBX**, target **Blender** or **Unreal**, with *Embed Textures* on, in the
   **T-pose** or **A-pose** (either works, see [Limits](#retargeting-limits)). Leave facial
   morphs off unless you need them, because they add size.
2. Convert FBX to glTF in Blender 4.x: *File → Import → FBX* (Automatic Bone Orientation **off**),
   then *File → Export → glTF 2.0 (.glb)* with *Apply Modifiers*, *+Y Up* and *Animation* on
   if you also export clips.
3. Optimise it with gltf-transform (no install needed):

   ```bash
   npx @gltf-transform/cli resize   maya.glb maya.glb --width 2048 --height 2048   # body/face 2048, others 1024
   npx @gltf-transform/cli webp     maya.glb maya.glb --quality 85                 # EXT_texture_webp
   npx @gltf-transform/cli simplify maya.glb maya.glb --ratio 0.5 --error 0.001    # only if over budget
   npx @gltf-transform/cli dedup    maya.glb maya.glb
   npx @gltf-transform/cli prune    maya.glb maya.glb
   npx @gltf-transform/cli inspect  maya.glb                                       # check tris / texture sizes
   ```

   Don't use Draco or meshopt compression, because the app doesn't ship their decoders.

**MetaHuman**: export the body and face from Unreal (*Asset Actions → Export* to FBX, or with the
MetaHuman DCC export), merge them in Blender, keep the `pelvis`/`spine_01`/... body skeleton, then
follow steps 2–3 and set `"skeleton": "unreal"`. Reduce the face's LOD before export: LOD0 is far
over budget.

**Budgets** (per character, the office shows up to 16 skinned people at once):

- **20–40k triangles** (the MPFB cast is about 19k, Rocketbox about 7k). The ActorHub LOD
  system swaps people farther than about 16 m for impostors, so a budget near the top end is fine
  for a handful of characters.
- Textures: 2048² for body/face, 1024² for clothes and hair, 512² for eyes/brows; WebP.
- Up to 4 bone influences per vertex, ideally under 100 joints. Alpha-tested (MASK) hair cards
  render best; alpha-blended hair sorts poorly.

### 2. Manifest

Put the GLBs (subfolders are fine) and a `manifest.json` in
`frontend/public/assets/characters-custom/`:

```json
{
  "version": 1,
  "characters": [
    {
      "id": "maya",
      "file": "maya.glb",
      "heightM": 1.68,
      "gender": "f",
      "role": "boss",
      "skeleton": "cc",
      "clips": { "idle": "Idle_Loop", "walk": "Walk_Loop" },
      "animations": ["office-mixamo"]
    },
    { "id": "theo", "file": "people/theo.glb", "heightM": 1.81, "gender": "m", "skeleton": "unreal" }
  ],
  "animations": [
    {
      "id": "office-mixamo",
      "file": "anims/office_mixamo.glb",
      "skeleton": "mixamo",
      "clips": { "sit": "Sitting Idle", "type": "Typing", "wave": "Waving" }
    }
  ]
}
```

Character fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id (letters, digits, `-`, `_`, `.`). |
| `file` | yes | GLB path relative to the pack folder. |
| `heightM` | yes | Standing height in metres (1.2–2.3). Used for seating and walk speed. |
| `skeleton` | yes | `cc`, `unreal`/`metahuman`, `mixamo`, `mpfb` or `rocketbox`. |
| `gender` | no | `m`, `f` or `x` (picks the MPFB clip donor; default `x`). |
| `role` | no | `boss`, `agent` or `any` (default). Bosses are picked from `boss`, agents from `agent`, then from `any`. |
| `clips` | no | Office clip → animation name embedded in this GLB. |
| `animations` | no | Ids of shared animation sets to search for missing clips. |
| `scale` | no | Uniform scale, for example `0.01` for a centimetre export (default 1). |
| `yawOffsetDeg` | no | Extra yaw if the model doesn't face +Z. |
| `sitPelvisHeightM`, `sitPelvisBackM` | no | Seated pelvis height above the origin and offset behind it. They default from the clip source. |
| `boneMap` | no | Canonical bone → your bone name, for rigs with non-standard names. For example: `{ "pelvis": "Hips_JNT" }`. |
| `headBone` | no | Bone the nameplate follows. |

Office clips: `idle`, `idleSubtle`, `walk`, `sitIdle` (alias `sit`), `type`, `thinking`, `talk`,
`sitTalk`, `wave`, `cheer`, `clap`, `nod`, `listen`, `raiseHand`. A character needs `idle`, `walk`,
`sitIdle` and `type` from some source, or the cast falls back to the next pack. Top-level
`"borrowMpfb": false` turns off borrowing.

Clip lookup order per clip: the character's own GLB → its shared animation sets (in order) → the
**MPFB cast** (retargeted), if it's installed. That means a CC or MetaHuman export with no
animations at all still sits, types, waves and walks.

The validator (`frontend/src/engine/assets/customPack.ts`, unit-tested) rejects bad manifests
with a readable list in the browser console, and the app falls back to MPFB.

### Retargeting limits

Clips from another skeleton are baked at load time (`frontend/src/engine/characters/retarget.ts`).
For each mapped bone, it copies the world-space rotation away from the rest pose. A rest-pose
alignment step points each bone like the donor's rest bone, so T-pose and A-pose rigs both work.
The hips translation is scaled by the hips height. Limits:

- Bones are matched by name. Twist, face, breast and cloth bones aren't driven; they follow
  their parents.
- No IK: with very different proportions, feet can slide a little and the typing hands may hover
  above or sink into the desk. Tune `sitPelvisHeightM` / `sitPelvisBackM` or embed your own `type`
  clip.
- Assumes uniform scale on armature nodes, and a rest pose with palms down (T) or palms in (A).
  Exotic rest poses need their own clips.
- The donor clips are the MPFB cast's: business-casual motion, not a mocap library.

## Licensing

- **Rocketbox**: MIT (Microsoft). **MPFB cast**: CC0 assets (MPFB add-on is GPL-3.0 but not part
  of the output); see `tools/mpfb/README.md`.
- **Custom packs are yours to license.** Character Creator content is governed by Reallusion's
  EULA and content licences (export rights depend on your CC edition and the content packs you
  own). **The MetaHuman EULA restricts using MetaHumans outside Unreal Engine.** Check the current
  terms yourself before exporting a MetaHuman to glTF for this app.
- Keep them local: `frontend/public/assets/` is git-ignored, and `make build-static` copies
  `public/` into the backend's static folder, so don't publish a build that contains a pack you may
  not redistribute.

## Implementation map

| File | Role |
|---|---|
| `frontend/src/engine/characters/CastRig.ts` | Per-actor wrapper. It resolves the pack from cast + role and swaps rigs live without popping. |
| `frontend/src/engine/characters/characterPacks.ts` | Per-scene registry: pack probes, container/clip caches, rig specs, retarget glue. |
| `frontend/src/engine/characters/GltfRig.ts` | Spec-driven skinned rig: per-actor clone with its own skeleton, upper/lower clip layers, 0.25 s cross-fades, seat placement. |
| `frontend/src/engine/characters/castPlan.ts` | Pure: fallback chains, deterministic picks. |
| `frontend/src/engine/characters/boneMaps.ts` | Pure: bone-name schemes → canonical (MPFB) names. |
| `frontend/src/engine/characters/retarget.ts` | Pure: quaternion retarget/bake. |
| `frontend/src/engine/assets/customPack.ts` | Pure: manifest types, validator, clip resolution. |
