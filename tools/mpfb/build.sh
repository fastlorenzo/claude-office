#!/usr/bin/env bash
# Build the MPFB cast: Blender export -> gltf-transform optimisation -> manifest.json
# usage: tools/mpfb/build.sh [id ...]      (no ids = whole cast)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BLENDER="${BLENDER:-$HOME/.local/blender/blender}"
OUT="${OUT:-$ROOT/frontend/public/assets/characters-mpfb}"
RAW="${RAW:-$OUT/raw}"
JOBS="${JOBS:-3}"
export PATH="$HOME/.bun/bin:$PATH"

mkdir -p "$RAW"
if [ ! -d "$HERE/node_modules" ]; then (cd "$HERE" && bun install); fi

if [ "$#" -gt 0 ]; then IDS="$*"; else IDS="$("$BLENDER" -b --python "$HERE/generate_cast.py" -- --list 2>/dev/null | grep '^office_')"; fi

# one Blender process per character (deterministic, isolated, parallel)
printf '%s\n' $IDS | xargs -P "$JOBS" -I{} sh -c \
  "'$BLENDER' -b --python '$HERE/generate_cast.py' -- --id {} --out '$RAW' > '$RAW/{}.log' 2>&1 || { echo 'FAILED {}'; tail -20 '$RAW/{}.log'; exit 255; }"

(cd "$HERE" && bun optimize.ts "$RAW" "$OUT")
echo "done -> $OUT"
