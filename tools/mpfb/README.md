# MPFB cast (CC0 realistic office characters)

Spike: a legally clean alternative to the Rocketbox cast. 10 adults generated with MPFB2 (MakeHuman)
in headless Blender, one canonical skeleton, CC0 animation clips retargeted offline and embedded in
each GLB. Output goes to `frontend/public/assets/characters-mpfb/` (git-ignored by
`frontend/public/assets/*`); the runtime manifest is `frontend/src/engine/assets/charactersMpfb.ts`.

## Reproduce

```bash
tools/mpfb/setup.sh      # once: Blender 4.5.9, MPFB 2.0.18, CC0 asset packs, UAL, Mesh2Motion clips (~1 GB cache in ~/.cache/mpfb)
tools/mpfb/build.sh      # Blender export (3 parallel jobs, ~80 s) -> gltf-transform/sharp -> manifest.json
tools/mpfb/build.sh office_m01 office_f02   # rebuild selected characters only
blender -b --python tools/mpfb/render_qa.py -- --dir frontend/public/assets/characters-mpfb \
  --out /tmp/qa.png --clip type --seated --ids office_m01,office_f01   # QA render of the shipped GLBs
```

Needs bun (gltf-transform, sharp, meshoptimizer for decompressing the Mesh2Motion clips). No sudo.

## Pipeline

- `generate_cast.py` (one Blender process per character, deterministic, no randomness): macro sliders
  (gender/age/race/weight/muscle, `height` bisected to the target metres), MPFB `game_engine` rig +
  weights, asset loading, shape keys + clothing masks applied (hidden body parts removed), Decimate
  to a per-part triangle budget, materials rebuilt as plain Principled BSDF (glTF friendly), clip
  retargeting, GLB export (NLA tracks -> named animations).
- Retargeting (own implementation, no add-on): per frame, per bone, the source bone *direction* and
  twist are transferred in armature space to the target (handles T-pose source vs A-pose target),
  pelvis translation is scaled by leg length, FK gives the local bake. Only `Root`/`pelvis` carry
  translation tracks. The canonical skeleton has no control bones, so nothing needs removing.
- Procedural clips on the canonical rig: `type` (forearms on desk, per-finger curl wave on a seated
  base), `thinking` (hand to chin, other arm across), `raiseHand`; `idle` and the standing clips get
  straight legs/pelvis at rest height (the UAL idle is an action-game crouch).
- `optimize.ts`: hair/brows/lashes -> alphaMode MASK + double sided, roughness clamps, tints as
  baseColorFactor over a *neutralised* texture (tinted textures are converted to greyscale and
  normalised to a target mean luminance first: glTF multiplies factor x texture, so the magenta
  toigo_female_suit_2 diffuse turned f05's sage suit purple and dark-brown hair diffuses made every
  hair tint near-black), textures resized (skin 2048, others 1024, eyes/brows 512) and re-encoded WebP
  (`EXT_texture_webp`, same as the Rocketbox script), resample/dedup/prune. Meshopt NOT used (Babylon needs an
  external decoder); `--quantize` (KHR_mesh_quantization) is optional and untested in Babylon.
- Clips are embedded per character (retargeted per body), not in a shared animations.glb.

## Versions

Blender 4.5.9 LTS (download.blender.org/release/Blender4.5), MPFB 2.0.18
(extensions.blender.org, sha256 c075b3e9...a2dad), MakeHuman CC0 packs from
files.makehumancommunity.org/asset_packs (the old tuxfamily mirror redirects there), Mesh2Motion app
commit e0dac43002bf, Quaternius UAL1 [Standard] (itch.io, scriptable download in setup.sh).

## Licences

| Asset | Source | Licence |
|---|---|---|
| MPFB basemesh, targets, game_engine rig + weights | MPFB 2.0.18 data | CC0 (mesh data; the add-on code is GPL-3.0 and is not part of the output) |
| Skins: young/middleage/old_{caucasian,african,asian}_{male,female}, young_caucasian_female2 | makehuman_system_assets_cc0 | CC0 |
| Eyes low-poly + materials brown, brownlight, grey, blue, bluegreen, green | makehuman_system_assets_cc0 | CC0 |
| Eyebrows eyebrow002..010; eyelashes01/02 | makehuman_system_assets_cc0 | CC0 |
| Hair short01-04, bob02, ponytail01, long01, toigo_blunt_bob | makehuman_system_assets_cc0 / hair01_cc0 (toigo = Margaret Toigo) | CC0 |
| Clothes male_elegantsuit01, male_casualsuit01/03, female_elegantsuit01, shoes01/03/05/06 | makehuman_system_assets_cc0 | CC0 |
| Clothes toigo_male_suit_3, toigo_male_suit_tie_and_jacket, toigo_male_double-breasted_suit, toigo_female_suit, toigo_female_suit_2, toigo_female_double-breasted_suit, toigo_basic_tucked_t-shirt, toigo_wool_pants, toigo_ballet_flats, toigo_flats, toigo_stiletto_booties | suits01_cc0, shirts01_cc0, pants01_cc0, shoes01_cc0 (Margaret Toigo) | CC0 |
| Clips Idle_Loop (unused base), Walk_Formal_Loop, Sitting_Idle_Loop, Sitting_Talking_Loop, Idle_Talking_Loop | Quaternius Universal Animation Library [Standard] | CC0 |
| Clips greeting, victory, clapping, head-nod, idle-listening, idle-a, idle-subtle, walk-relaxed, walk-formal | Mesh2Motion/mesh2motion-app static/assets/human/animations (LICENSE-CC0) | CC0 |
| type, thinking, raiseHand | authored here | CC0 |

Per-asset author/licence strings read from the .mhclo/.mhmat headers are written into
`manifest.json` (`avatars[].licenses`). Only packs whose listing says CC0 are installed
(shirts01, pants01, shoes01, suits01, dress01, skirts01, hair01, skins01/02, eyebrows01, eyelashes01
and the system assets); the CC-BY packs (shirts02/03, pants02/03, shoes02/03, hair02/03, ...) are not.
