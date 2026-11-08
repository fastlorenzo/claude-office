#!/usr/bin/env bash
# Walk gate: scripted player walks (world-debug ?walk=) must end where the
# colliders say they should (WS2 acceptance in docs/design/review-plan.md).
#
#   make walk-gate
#   BASE=http://localhost:3000 make walk-gate
#
# Each walk is one shot.sh call; __worldStats.walk gives done/reached/feet/log.
# Exits 1 when any walk ends on the wrong floor or position. Runs under the
# machine-wide heavy lock and only ever calls shot.sh.
set -euo pipefail

SHOT_DIR="${SHOT_DIR:-$HOME/.local/share/claude-office-shot}"
if [ -z "${GATE_LOCKED:-}" ]; then
  export GATE_LOCKED=1
  exec flock "$SHOT_DIR/.heavy.lock" "$0" "$@"
fi

BASE="${BASE:-http://localhost:3000}"
OUT="${OUT:-$SHOT_DIR/out/walk-gate}"
mkdir -p "$OUT"
# no shot=1: shot.mjs treats title "ready" as done and would not wait for the walk
# (it waits for __worldShotReady, which the walk sets when finished).
COMMON="n=6&demoFactory=1&gfx=low&quality=low"

# name | walk | python predicate over (x,y,z,reached,miny,maxy) -> bool
WALKS=(
  "end_wall_west|8,0,1.5,180;8,-2|abs(z-0.1)<0.5 and abs(y)<0.15 and reached==0"
  "end_wall_far|8,0,22.5,0;8,27|miny>-0.3 and abs(y)<0.15 and reached==0"
  # Lanes run along x: walk across them (+z) from the corridor between lanes
  # 8.4 and 10.8; feet stop within 0.4 m of the belt edge (10.33).
  "factory_conveyor|19.25,-6,9.6,0;19.25,13|reached==0 and abs(z-10.0)<0.3 and abs(y+6)<0.5"
  # Around the supervisor platform (its back rail is a wall at z 34.3) and up
  # the tier's inner ramp. Feet read the deck (0.25) + the controller's hover
  # (~0.05 moving, ~0.105 standing); the floor reads <= 0.11.
  "control_tier|0,0,30,0;2.9,33;2.9,37;0,38.6;0,40.3|reached==4 and 0.27<y<0.42"
  # Along the wall to the east stair foot, up both flights to the reception.
  "entrance_stair|9.4,-6,-5.5,90;12.35,-5.5;12.35,-10.3;12.35,-11.25;10.85,-11.25;10.85,-6.2;10.85,-5.5|reached==6 and abs(y)<0.25 and z>-6.0"
  "forecourt|0,-6,-20,180;0,-56|z<=-55"
  # WS3: over the west feeder crossover (deck 2 m above the floor, 33.7°
  # flights) and back down into the central strip beyond it.
  "crossover|-4.8,-6,-2.6,0;-4.8,2.4;-4.8,7.4;-4.8,8.5|reached==3 and maxy>-4.6 and abs(y+6)<0.2 and z>8"
)

check() { # json predicate -> prints "x y z reached done RESULT"
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
raw, pred = sys.argv[1], sys.argv[2]
try:
    w = json.loads(raw or "{}").get("walk")
except Exception:
    w = None
if not w:
    print("- - - - - NODATA"); sys.exit(0)
log = w.get("log") or []
pts = [tuple(map(float, s.split(","))) for s in ([l for l in log if "," in l and not l.startswith("end")] or [])]
feet = w["feet"][0] if w.get("feet") else None
x, y, z = (float(v) for v in (feet or "0,0,0").split(","))
miny = min([p[1] for p in pts] + [y])
maxy = max([p[1] for p in pts] + [y])
reached = w.get("reached", -1)
# A walk blocked by a wall never finishes within the sampling window on
# SwiftShader (40 s of sim time); treat a position that moved < 0.15 m over
# the last 4 log samples (2 s; a capsule pressed against a wall jitters a
# few cm sideways), away from the start pose, as "stuck" = settled.
start = tuple(float(v) for v in sys.argv[3].split(",")[:3])
moved = max(abs(a - b) for a, b in zip((x, y, z), start)) > 0.05
tail = pts[-4:]
span = max((max(abs(p[i] - q[i]) for i in range(3)) for p in tail for q in tail), default=0.0)
stuck = len(tail) >= 4 and span < 0.15 and moved
settled = bool(w.get("done")) or stuck
ok = settled and bool(eval(pred, {"abs": abs}, dict(x=x, y=y, z=z, reached=reached, miny=miny, maxy=maxy)))
print(f"{x:.2f} {y:.2f} {z:.2f} {reached}/{w.get('of')} {'yes' if w.get('done') else ('stuck' if stuck else 'unsettled')} {'ok' if ok else 'FAIL'}")
PY
}

# Warm-up load: the first page after an idle dev server compiles and bakes
# for minutes (readyMs > 140 s under load), which left the first walk only
# ~1 s of sim time before shot.sh's hard timeout.
"$SHOT_DIR/shot.sh" "$BASE/world-debug?$COMMON&shot=1&frames=5" "$OUT/warmup.png" 5 >"$OUT/warmup.log" 2>&1 || true

fail=0
printf '\n%-18s %8s %8s %8s %8s %5s  %s\n' walk x y z reached done result
for c in "${WALKS[@]}"; do
  IFS='|' read -r name walk pred <<<"$c"
  log="$OUT/$name.log"
  "$SHOT_DIR/shot.sh" "$BASE/world-debug?$COMMON&walk=$walk" "$OUT/$name.png" 20 >"$log" 2>&1 || true
  json="$(sed -n 's/^stats //p' "$log" | tail -1)"
  read -r x y z reached done res <<<"$(check "$json" "$pred" "${walk%%;*}")"
  printf '%-18s %8s %8s %8s %8s %5s  %s\n' "$name" "$x" "$y" "$z" "$reached" "$done" "$res"
  [ "$res" = ok ] || fail=1
done
echo
echo "screenshots + logs: $OUT"
[ "$fail" -eq 0 ] && echo "walk-gate: PASS" || echo "walk-gate: FAIL"
exit "$fail"
