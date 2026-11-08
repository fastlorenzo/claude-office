/**
 * Auto quality governor.
 *
 * With preset "auto" the governor walks AUTO_LADDER (high → medium → low, see
 * graphicsSettings.ts) from the frame time: a 2 s mean above 24 ms steps down
 * (at most one step per 3 s); below 12 ms for 20 s steps up. Other presets
 * pin the tier and the governor ignores samples. The governor only decides
 * the tier — `GraphicsController` turns it into a render plan.
 */
import type { QualitySetting } from "@/engine/contracts";
import {
  AUTO_LADDER,
  applyPreset,
  type GraphicsSettings,
} from "@/engine/fx/graphicsSettings";
import { autoStartTier, type ConcretePreset } from "@/engine/fx/fxPlan";

/** `setQuality(auto|high|medium|low)` mapped onto presets, keeping personal prefs. */
export function settingsForQuality(
  q: QualitySetting,
  current: GraphicsSettings,
): GraphicsSettings {
  return applyPreset(q === "auto" ? "auto" : q, current);
}

export class QualityGovernor {
  private index: number;
  private auto: boolean;
  private window: number[] = [];
  private windowStart = 0;
  private goodSince = 0;
  private lastChange = 0;

  constructor(
    auto: boolean,
    private readonly lowEnd: boolean,
    private readonly apply: (tier: ConcretePreset, index: number) => void,
  ) {
    this.auto = auto;
    this.index = AUTO_LADDER.indexOf(autoStartTier(lowEnd));
  }

  get tier(): ConcretePreset {
    return AUTO_LADDER[this.index];
  }

  get isAuto(): boolean {
    return this.auto;
  }

  /** Switch auto on/off; turning it on restarts from the best tier for the device. */
  setAuto(on: boolean): void {
    if (on === this.auto) return;
    this.auto = on;
    this.window = [];
    this.goodSince = 0;
    if (on) {
      this.index = AUTO_LADDER.indexOf(autoStartTier(this.lowEnd));
      this.apply(this.tier, this.index);
    }
  }

  /** Force the current tier (e.g. after the world is built). */
  start(): void {
    this.apply(this.tier, this.index);
  }

  private step(delta: 1 | -1, nowMs: number): void {
    this.index += delta;
    this.lastChange = nowMs;
    this.goodSince = 0;
    this.apply(this.tier, this.index);
  }

  /** Feed one frame time (ms). */
  sample(frameMs: number, nowMs: number): void {
    if (!this.auto) return;
    if (this.window.length === 0) this.windowStart = nowMs;
    this.window.push(frameMs);
    if (nowMs - this.windowStart < 2000) return;
    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    this.window = [];
    if (nowMs - this.lastChange < 3000) return;
    if (mean > 24 && this.index < AUTO_LADDER.length - 1) {
      this.step(1, nowMs);
    } else if (mean < 12 && this.index > 0) {
      if (!this.goodSince) this.goodSince = nowMs;
      if (nowMs - this.goodSince > 20000) this.step(-1, nowMs);
    } else {
      this.goodSince = 0;
    }
  }
}
