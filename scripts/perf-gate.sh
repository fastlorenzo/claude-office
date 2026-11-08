#!/usr/bin/env bash
# Perf gate: draw-call budgets at the reference cameras (SwiftShader, via shot.sh).
#
#   make perf-gate            # 6 shots: 4 cameras (high) + medium + low at spawn
#   ALL=1 make perf-gate      # + gallery, drum, drum look-back (WS4 acceptance set)
#   BASE=http://localhost:3000 FRAMES=40 make perf-gate
#
# Budgets are the WS4 targets in docs/design/review-plan.md. The gate exits 1 when
# any budget is exceeded. Reads __worldStats (draws, postProcesses, screenUploads,
# textureMB when the build reports them; shown as "-" otherwise).
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

# name | budget | extra query
CASES=(
  "spawn|300|quality=high&gfx=high"
  "hall_end|350|quality=high&gfx=high&cam=0,1.65,24,0,0"
  "room_interior|350|quality=high&gfx=high&cam=5.5,1.65,8,90,3"
  "factory_floor|280|quality=high&gfx=high&cam=0,-4.35,-3,0,5"
)
if [ -n "${ALL:-}" ]; then
  CASES+=(
    "gallery|320|quality=high&gfx=high&cam=1.5,1.65,-3,0,30"
    "drum|330|quality=high&gfx=high&cam=-2.5,1.65,29.5,35,5"
    "drum_lookback|350|quality=high&gfx=high&cam=0,1.65,34,180,2"
  )
fi
# tier checks at the spawn view; budget "rel" = derived from the high result
TIERS=(
  "spawn_medium|rel|gfx=medium"
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

fail=0
high_spawn=""
medium_draws=""
for c in "${CASES[@]}"; do
  IFS='|' read -r name budget query <<<"$c"
  json="$(shoot "$name" "$query")"
  draws="$(field "$json" draws)"
  [ "$name" = spawn ] && high_spawn="$draws"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$draws" "$budget" "$(field "$json" postProcesses)" \
    "$(field "$json" screenUploads)" "$(field "$json" textureMB)" >>"$RESULTS"
done
for c in "${TIERS[@]}"; do
  IFS='|' read -r name _ query <<<"$c"
  json="$(shoot "$name" "$query")"
  draws="$(field "$json" draws)"
  case "$name" in
    spawn_medium) medium_draws="$draws"
      budget="$(python3 -c 'import sys
h=sys.argv[1]; print(int(float(h)*0.75) if h not in ("-","") else "-")' "${high_spawn:--}")" ;;
    spawn_low) budget="${medium_draws:--}" ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$draws" "$budget" "$(field "$json" postProcesses)" \
    "$(field "$json" screenUploads)" "$(field "$json" textureMB)" >>"$RESULTS"
done

printf '\n%-16s %7s %7s  %-6s %6s %12s %9s\n' camera draws budget result passes screenUploads textureMB
while IFS=$'\t' read -r name draws budget pp su tm; do
  if [ "$draws" = "-" ] || [ "$budget" = "-" ]; then res="NODATA"; fail=1
  elif [ "$draws" -le "$budget" ]; then res=ok
  else res=FAIL; fail=1; fi
  # post-process pass limits (WS4): <= 12 at high, <= 6 at medium
  limit=""
  case "$name" in spawn|hall_end|room_interior|factory_floor|gallery|drum|drum_lookback) limit=12 ;; spawn_medium) limit=6 ;; esac
  if [ -n "$limit" ] && [ "$pp" != "-" ] && [ "$pp" -gt "$limit" ]; then res="FAIL(passes>$limit)"; fail=1; fi
  printf '%-16s %7s %7s  %-6s %6s %12s %9s\n' "$name" "$draws" "$budget" "$res" "$pp" "$su" "$tm"
done <"$RESULTS"
echo
echo "screenshots + logs: $OUT"
[ "$fail" -eq 0 ] && echo "perf-gate: PASS" || echo "perf-gate: FAIL"
exit "$fail"
