import { describe, expect, it } from "vitest";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import { buildOpsModel } from "@/engine/logic/opsModel";
import {
  lowerTiles,
  lowerWallKey,
  wallClock,
} from "@/engine/world/controlRoomWall";

/**
 * The lower wall canvases (≤ 4096 px, mipmapped) are re-uploaded whenever
 * `lowerWallKey` changes. With a static feed the key must only tick with the
 * HH:MM clock: ControlRoom.update checks the clock once a second, so any
 * seconds-dependent content would re-upload both canvases every second.
 */
describe("control-room lower wall key", () => {
  const demo = createDemoCampus(6, 20_000);
  const labels = new Map(demo.sessions.map((s) => [s.id, s.label]));
  // Start on a minute boundary so 59 one-second ticks stay in one minute.
  const t0 = Math.ceil(Date.now() / 60_000) * 60_000 + 5 * 60_000;
  const keyAt = (now: number) => {
    const m = buildOpsModel(demo.campus, demo.stats, now, labels);
    return lowerWallKey(m, wallClock(now), []);
  };

  it("re-uploads at minute granularity only on an idle feed", () => {
    // 10 minutes of the once-a-second clock check: the HH:MM clock and the
    // prompt-cache countdown alerts (whole minutes) may tick, nothing else.
    let uploads = 0;
    let last = keyAt(t0);
    let lastChangeS = -60;
    let minGap = Infinity;
    for (let s = 1; s <= 600; s++) {
      const k = keyAt(t0 + s * 1000);
      if (k !== last) {
        uploads++;
        minGap = Math.min(minGap, s - lastChangeS);
        lastChangeS = s;
      }
      last = k;
    }
    expect(uploads / 600).toBeLessThan(0.1); // per second
    expect(uploads).toBeGreaterThanOrEqual(10); // the clock does tick
    expect(minGap).toBeGreaterThan(1); // never on consecutive seconds
  });

  it("ticks once when the minute changes", () => {
    expect(keyAt(t0 + 60_000)).not.toBe(keyAt(t0));
    expect(wallClock(t0)).toMatch(/^\d\d:\d\d$/);
  });

  it("changes with the content (tiles)", () => {
    const m = buildOpsModel(demo.campus, demo.stats, t0, labels);
    const tiles = lowerTiles(m);
    const k = lowerWallKey(m, "10:00", [], tiles);
    const moreLive = {
      ...tiles,
      left: [{ ...tiles.left[0], value: "99" }, ...tiles.left.slice(1)],
    };
    expect(lowerWallKey(m, "10:00", [], moreLive)).not.toBe(k);
  });
});
