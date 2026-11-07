#!/usr/bin/env bash
# One-time (idempotent) setup of the MPFB cast toolchain, no sudo required:
#   Blender 4.5 LTS (portable) -> ~/.local/blender, MPFB2 extension, MakeHuman CC0 asset packs,
#   Quaternius UAL1 Standard (CC0) and Mesh2Motion human clips (CC0).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${MPFB_CACHE:-$HOME/.cache/mpfb}"
BLV=4.5.9
MPFB_URL='https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip'
MPFB_SHA=c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad
M2M_SHA=e0dac43002bfa85aee9a105e6e64b21047c13895   # Mesh2Motion/mesh2motion-app commit
PACKS="shirts01 pants01 shoes01 suits01 dress01 skirts01 hair01 skins01 skins02 eyebrows01 eyelashes01"
AP=https://files.makehumancommunity.org/asset_packs
export PATH="$HOME/.bun/bin:$PATH"
mkdir -p "$CACHE/packs" "$CACHE/m2m" "$CACHE/m2m_raw" "$CACHE/ual" "$HOME/.local/blender"

# 1. Blender
if [ ! -x "$HOME/.local/blender/blender-$BLV-linux-x64/blender" ]; then
  curl -fL "https://download.blender.org/release/Blender4.5/blender-$BLV-linux-x64.tar.xz" | tar -xJ -C "$HOME/.local/blender"
fi
ln -sf "$HOME/.local/blender/blender-$BLV-linux-x64/blender" "$HOME/.local/blender/blender"
BLENDER="$HOME/.local/blender/blender"; "$BLENDER" --background --version | head -1

# 2. MPFB2 extension (GPL-3.0 tool; outputs are not GPL-encumbered)
[ -f "$CACHE/mpfb.zip" ] || curl -fL -o "$CACHE/mpfb.zip" "$MPFB_URL"
echo "$MPFB_SHA  $CACHE/mpfb.zip" | sha256sum -c -
"$BLENDER" --command extension install-file -r user_default --enable "$CACHE/mpfb.zip" >/dev/null

# 3. MakeHuman CC0 assets -> MPFB user data dir
D="$HOME/.config/blender/4.5/extensions/.user/user_default/mpfb/data"; mkdir -p "$D"
[ -f "$CACHE/makehuman_system_assets_cc0.zip" ] || curl -fL -o "$CACHE/makehuman_system_assets_cc0.zip" "$AP/makehuman_system_assets/makehuman_system_assets_cc0.zip"
unzip -qo "$CACHE/makehuman_system_assets_cc0.zip" -d "$D"
for p in $PACKS; do
  [ -f "$CACHE/packs/${p}_cc0.zip" ] || curl -fL -o "$CACHE/packs/${p}_cc0.zip" "$AP/$p/${p}_cc0.zip"
  unzip -qo "$CACHE/packs/${p}_cc0.zip" -d "$D"
done

# 4. Quaternius Universal Animation Library [Standard] (CC0). itch.io "name your price" flow, scriptable:
UAL="$CACHE/ual/ual.zip"
if [ ! -f "$UAL" ]; then
  J=$(mktemp); G=https://quaternius.itch.io/universal-animation-library
  curl -fsL -c "$J" -b "$J" "$G" -o /dev/null
  curl -fsL -c "$J" -b "$J" -X POST "$G/download_url" -o /dev/null
  URL=$(curl -fsL -c "$J" -b "$J" -X POST "$G/file/17958403?source=view_game&key=" -d "" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['url'])")
  curl -fsL -o "$UAL" "$URL"; rm -f "$J"
fi
unzip -qo "$UAL" -d "$CACHE/ual"

# 5. Mesh2Motion human clips (CC0; EXT_meshopt_compression -> decompressed for Blender)
(cd "$HERE" && { [ -d node_modules ] || bun install; })
for f in greeting victory clapping head-nod idle-listening idle-a idle-subtle walk-relaxed walk-formal; do
  [ -f "$CACHE/m2m_raw/$f.glb" ] || {
    curl -fsL -o "$CACHE/m2m/$f.glb" "https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/$M2M_SHA/static/assets/human/animations/$f.glb"
    (cd "$HERE" && bun decompress.ts "$CACHE/m2m/$f.glb" "$CACHE/m2m_raw/$f.glb")
  }
done
echo "setup complete"
