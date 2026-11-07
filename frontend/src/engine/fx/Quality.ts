/**
 * Quality tiers + auto governor.
 *
 * Levels (0 = best):
 *   0  high: SSAO2, MSAA 4x, 2048 cascaded shadows, glow, bloom, scale 1
 *   1  high without SSAO
 *   2  low: FXAA, 1024 shadows, glow, bloom
 *   3  low: no shadows, no glow, hardware scaling 1.5
 * "high"/"low" pin the level (0 / 2). "auto" starts at 0 (2 on mobile or
 * ≤ 4 cores) and moves with hysteresis: a 2 s mean frame time above 24 ms
 * steps down; below 12 ms for 20 s steps up.
 */
import type { QualitySetting, QualityTier } from "@/engine/contracts";

export interface QualityLevel {
  ssao: boolean;
  msaa: boolean;
  shadows: number; // 0 = off, else map size
  glow: boolean;
  bloom: boolean;
  scaling: number; // extra hardware scaling on top of the device ratio (1 = native)
  /** Cap on devicePixelRatio honoured by this level. */
  maxDpr: number;
  /** Anisotropic filtering for tiled surface textures. */
  anisotropy: number;
  pointLights: boolean;
}

export const LEVELS: QualityLevel[] = [
  {
    ssao: true,
    msaa: true,
    shadows: 2048,
    glow: true,
    bloom: true,
    scaling: 1,
    maxDpr: 2,
    anisotropy: 16,
    pointLights: true,
  },
  {
    ssao: false,
    msaa: true,
    shadows: 2048,
    glow: true,
    bloom: true,
    scaling: 1,
    maxDpr: 2,
    anisotropy: 16,
    pointLights: true,
  },
  {
    ssao: false,
    msaa: false,
    shadows: 1024,
    glow: true,
    bloom: true,
    scaling: 1,
    maxDpr: 1,
    anisotropy: 8,
    pointLights: true,
  },
  {
    ssao: false,
    msaa: false,
    shadows: 0,
    glow: false,
    bloom: true,
    scaling: 1.5,
    maxDpr: 1,
    anisotropy: 8,
    pointLights: false,
  },
];

export function tierOf(level: number): QualityTier {
  return level <= 1 ? "high" : "low";
}

export class QualityGovernor {
  private level = 0;
  private setting: QualitySetting;
  private window: number[] = [];
  private windowStart = 0;
  private goodSince = 0;
  private lastChange = 0;

  constructor(
    setting: QualitySetting,
    private readonly lowEnd: boolean,
    private readonly apply: (level: QualityLevel, index: number) => void,
  ) {
    this.setting = setting;
    this.level = this.initialLevel();
  }

  private initialLevel(): number {
    if (this.setting === "high") return 0;
    if (this.setting === "low") return 2;
    return this.lowEnd ? 2 : 0;
  }

  /** Force the current level (e.g. after the world is built). */
  start(): void {
    this.apply(LEVELS[this.level], this.level);
  }

  get tier(): QualityTier {
    return tierOf(this.level);
  }

  get index(): number {
    return this.level;
  }

  setSetting(q: QualitySetting): void {
    this.setting = q;
    this.level = this.initialLevel();
    this.window = [];
    this.goodSince = 0;
    this.apply(LEVELS[this.level], this.level);
  }

  /** Feed one frame time (ms). */
  sample(frameMs: number, nowMs: number): void {
    if (this.setting !== "auto") return;
    if (this.window.length === 0) this.windowStart = nowMs;
    this.window.push(frameMs);
    if (nowMs - this.windowStart < 2000) return;
    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    this.window = [];
    if (nowMs - this.lastChange < 3000) return;
    if (mean > 24 && this.level < LEVELS.length - 1) {
      this.level += 1;
      this.lastChange = nowMs;
      this.goodSince = 0;
      this.apply(LEVELS[this.level], this.level);
    } else if (mean < 12 && this.level > 0) {
      if (!this.goodSince) this.goodSince = nowMs;
      if (nowMs - this.goodSince > 20000) {
        this.level -= 1;
        this.lastChange = nowMs;
        this.goodSince = 0;
        this.apply(LEVELS[this.level], this.level);
      }
    } else {
      this.goodSince = 0;
    }
  }
}
