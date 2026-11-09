#!/usr/bin/env bash
# Perf gate: draw-call budgets at the reference cameras (SwiftShader, via shot.sh).
#
#   make perf-gate            # 6 shots: 4 cameras (high) + medium + low at spawn
#   ALL=1 make perf-gate      # + gallery, drum, drum look-back (WS4 acceptance set)
#   BASE=http://localhost:3000 FRAMES=40 make perf-gate
#
# Budgets: the WS4 targets in docs/design/review-plan.md, tightened after the
# photoreal pass (WS-E: lightmaps on, SSAO / its G-buffer gone) to the measured
# draws + ~5 %. The gate exits 1 when any budget or post-process limit is
# exceeded, when the lightmaps are not active (__worldStats.bakes.active
# empty: every budget assumes them), or when resident texture memory at high
# exceeds TEX_MB_MAX (WS-J: the lowest measured figure + ~5 %, after the
# bake-aware shadow maps and the KTX2 lightmaps; the WS5 target is
# TEX_MB_TARGET, printed as a note until the generated canvases shrink).
# Reads __worldStats (draws, postProcesses, screenUploads, textureMB, bakes,
# gpuMs; "-" when absent).
# Always runs under the machine-wide heavy lock and only ever calls shot.sh.
set -euo pipefail

SHOT_DIR="${SHOT_DIR:-$HOME/.local/share/claude-office-shot}"
if [ -z "${GATE_LOCKED:-}" ]; then
  export GATE_LOCKED=1
  exec flock "$SHOT_DIR/.heavy.lock" "$0" "$@"
fi

BASE="${BASE:-http://localhost:3000}"
FRAMES="${FRAMES:-40}"
OUT="${OUT:-$SHOT_DIR/out/perf-gate}"
mkdir -p "$OUT"
COMMON="n=6&demoFactory=1&shot=1"
# post-process limit at high; resident texture MB limit at high (hard) and
# the WS5 target (note only)
PP_HIGH="${PP_HIGH:-8}"
TEX_MB_MAX="${TEX_MB_MAX:-575}"
TEX_MB_TARGET="${TEX_MB_TARGET:-300}"

# name | budget | extra query
CASES=(
  "spawn|270|quality=high&gfx=high"
  # z=24.05, not 24: z=24 sits exactly on a bay boundary plane and SwiftShader
  # mis-orders depth there (a hidden roof upstand pokes through the hall ceiling).
  "hall_end|250|quality=high&gfx=high&cam=0,1.65,24.05,0,0"
  "room_interior|285|quality=high&gfx=high&cam=5.5,1.65,8,90,3"
  "factory_floor|250|quality=high&gfx=high&cam=0,-4.35,-3,0,5"
)
if [ -n "${ALL:-}" ]; then
  CASES+=(
    "gallery|275|quality=high&gfx=high&cam=1.5,1.65,-3,0,30"
    "drum|185|quality=high&gfx=high&cam=-2.5,1.65,29.5,35,5"
    "drum_lookback|280|quality=high&gfx=high&cam=0,1.65,34,180,2"
  )
fi
# tier checks at the spawn view. medium: absolute (WS-E: with SSAO gone at
# high, medium is no longer >= 25 % below high: 218 vs 256 draws); low: <= the
# measured medium draws ("rel").
TIERS=(
  "spawn_medium|230|gfx=medium"
  "spawn_low|rel|gfx=low"
)

RESULTS="$OUT/results.tsv"
: > "$RESULTS"

shoot() { # name query -> prints stats json (or empty). Retries with more frames
  # when the sample is unsettled (active == 0: stats taken before the first real frame).
  local name="$1" query="$2" log="$OUT/$1.log" f json
  for f in "$FRAMES" $((FRAMES * 3)) $((FRAMES * 6)); do
    "$SHOT_DIR/shot.sh" "$BASE/world-debug?$COMMON&$query&frames=$f" "$OUT/$name.png" "$f" >"$log" 2>&1 || true
    json="$(sed -n 's/^stats //p' "$log" | tail -1)"
    if python3 -c 'import json,sys
d=json.loads(sys.argv[1] or "{}"); sys.exit(0 if d.get("active",0) > 0 else 1)' "$json"; then break; fi
  done
  echo "$json"
}

field() { # json key -> value or "-"
  python3 -c 'import json,sys
d=json.loads(sys.argv[1] or "{}"); v=d.get(sys.argv[2]); print("-" if v is None else v)' "$1" "$2"
}

bakes() { # json -> "+"-joined __worldStats.bakes.active, or "none"
  python3 -c 'import json,sys
d=json.loads(sys.argv[1] or "{}"); a=(d.get("bakes") or {}).get("active") or []
print("+".join(a) if a else "none")' "$1"
}

# A frame that re-renders the render-once targets (reflection probes, the
# static sun map) reports several times the normal draws: re-shoot once when a
# camera is over budget and keep the lower sample.
measure() { # name query budget -> json
  local name="$1" query="$2" budget="$3" json d json2 d2
  json="$(shoot "$name" "$query")"
  d="$(field "$json" draws)"
  if [ "$budget" != "-" ] && [ "$d" != "-" ] && [ "$d" -gt "$budget" ]; then
    json2="$(shoot "$name" "$query")"
    d2="$(field "$json2" draws)"
    if [ "$d2" != "-" ] && [ "$d2" -lt "$d" ]; then json="$json2"; fi
  fi
  echo "$json"
}

row() { # name budget json
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$(field "$3" draws)" "$2" "$(field "$3" postProcesses)" \
    "$(field "$3" screenUploads)" "$(field "$3" textureMB)" "$(bakes "$3")" "$(field "$3" gpuMs)" >>"$RESULTS"
}

fail=0
medium_draws=""
for c in "${CASES[@]}"; do
  IFS='|' read -r name budget query <<<"$c"
  json="$(measure "$name" "$query" "$budget")"
  row "$name" "$budget" "$json"
done
for c in "${TIERS[@]}"; do
  IFS='|' read -r name budget query <<<"$c"
  [ "$budget" = rel ] && budget="${medium_draws:--}"
  json="$(measure "$name" "$query" "$budget")"
  [ "$name" = spawn_medium ] && medium_draws="$(field "$json" draws)"
  row "$name" "$budget" "$json"
done

printf '\n%-16s %7s %7s  %-18s %6s %12s %9s  %s\n' camera draws budget result passes screenUploads textureMB bakes
nobakes=0
texover=""
while IFS=$'\t' read -r name draws budget pp su tm bk gpu; do
  if [ "$draws" = "-" ] || [ "$budget" = "-" ]; then res="NODATA"; fail=1
  elif [ "$draws" -le "$budget" ]; then res=ok
  else res=FAIL; fail=1; fi
  # post-process limits: <= PP_HIGH at high (WS-E: 7 measured with the
  # lightmaps, SSAO gone), <= 6 at medium
  limit=""
  case "$name" in spawn|hall_end|room_interior|factory_floor|gallery|drum|drum_lookback) limit="$PP_HIGH" ;; spawn_medium) limit=6 ;; esac
  if [ -n "$limit" ] && [ "$pp" != "-" ] && [ "$pp" -gt "$limit" ]; then res="FAIL(passes>$limit)"; fail=1; fi
  # every budget assumes the lightmaps (bakes.active non-empty)
  if [ "$bk" = "none" ] || [ "$bk" = "-" ]; then res="FAIL(no bakes)"; fail=1; nobakes=1; fi
  # resident texture memory at high (the tier checks run other texture tiers)
  case "$name" in spawn_medium|spawn_low) ;; *)
    if [ "$tm" = "-" ]; then res="NODATA(textureMB)"; fail=1
    elif python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) > float(sys.argv[2]) else 1)' "$tm" "$TEX_MB_MAX"; then
      tm="$tm!"; texover=1; res="FAIL(textureMB>$TEX_MB_MAX)"; fail=1; fi ;;
  esac
  printf '%-16s %7s %7s  %-18s %6s %12s %9s  %s\n' "$name" "$draws" "$budget" "$res" "$pp" "$su" "$tm" "$bk"
done <"$RESULTS"
if [ "$nobakes" = 1 ]; then
  echo
  echo "perf-gate: lightmaps NOT active (__worldStats.bakes.active is empty): the budgets assume"
  echo "  the baked sets. Check frontend/public/lightmaps/manifest.json exists, the browser console"
  echo "  '[bake]' warning (hash mismatch -> re-run 'make bake-lightmaps'), and that ?bakes=0 is not set."
fi
echo
if [ -n "$texover" ]; then
  echo "perf-gate: textureMB above $TEX_MB_MAX at high (marked '!'): a texture / render target grew."
  echo "  ?drawdbg=1 lists the largest textures (__worldStats.texTop / texBy)."
fi
echo "perf-gate: note: textureMB is gated at $TEX_MB_MAX MB (high); the WS5 target is $TEX_MB_TARGET MB, not met"
echo "  yet (generated canvases / screens and post-process targets dominate: ?drawdbg=1 texBy)."

echo
echo "screenshots + logs: $OUT"
[ "$fail" -eq 0 ] && echo "perf-gate: PASS" || echo "perf-gate: FAIL"
exit "$fail"
