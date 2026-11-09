#!/usr/bin/env bash
# Export the bake sources headless, then bake every lightmap set with Blender
# Cycles (tools/lightmaps/README.md). Prefers the Windows host's Blender
# (GPU, via WSL interop); falls back to a Linux Blender (BLENDER=..., `blender`
# on PATH, or ~/.local/blender/blender-4.5.9-linux-x64/blender).
#
#   SAMPLES=512 SETS="modules lobby entrance control" tools/lightmaps/bake.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SAMPLES=${SAMPLES:-512}
SETS=${SETS:-"modules lobby entrance control"}
OUT="$ROOT/frontend/public/lightmaps"
SRC="$ROOT/frontend/.bake/src"
LOCK="$HOME/.local/share/claude-office-shot/.heavy.lock"
WIN_BLENDER="/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"

heavy() {
  if [ -d "$(dirname "$LOCK")" ] && command -v flock >/dev/null; then
    flock "$LOCK" "$@"
  else
    "$@"
  fi
}

# shellcheck disable=SC2086
(cd "$ROOT/frontend" && bun scripts/export-bake.ts $SETS)

if [ -x "$WIN_BLENDER" ] && command -v wslpath >/dev/null; then
  BL="$WIN_BLENDER"
  p() { wslpath -w "$1"; }
else
  BL=${BLENDER:-$(command -v blender || echo "$HOME/.local/blender/blender-4.5.9-linux-x64/blender")}
  p() { echo "$1"; }
fi
echo "[bake-lightmaps] blender: $BL"
LOG=$(mktemp -t bake-lightmaps.XXXXXX)
trap 'rm -f "$LOG"' EXIT
for set in $SETS; do
  status=0
  heavy "$BL" --background --factory-startup \
    --python "$(p "$ROOT/tools/lightmaps/bake.py")" -- \
    --in "$(p "$SRC/$set.json")" \
    --out "$(p "$OUT")" \
    --public "$(p "$ROOT/frontend/public")" \
    --samples "$SAMPLES" >"$LOG" 2>&1 || status=$?
  grep -E '^\[bake\]|Error|Traceback' "$LOG" || true
  if [ "$status" -ne 0 ] || ! grep -q "^\[bake\] $set: wrote" "$LOG"; then
    echo "[bake-lightmaps] $set failed (exit $status)" >&2
    exit 1
  fi
done
ls -la "$OUT"
