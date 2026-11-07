/**
 * Pure helpers for floating labels / bubbles (no Babylon).
 */

/** Labels fully visible up to FADE_START, gone at FADE_END (metres). */
export const LABEL_FADE_START = 9;
export const LABEL_FADE_END = 12;

export function labelFade(distance: number): { alpha: number; scale: number } {
  const t = Math.min(
    1,
    Math.max(
      0,
      (distance - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START),
    ),
  );
  const alpha = 1 - t * t * (3 - 2 * t);
  const scale = Math.min(1.1, Math.max(0.72, 1.18 - distance * 0.04));
  return { alpha, scale };
}

/** Approximate bubble box size (px at 1080p) and hold time for a text. */
export function bubbleLayout(text: string): {
  width: number;
  height: number;
  lines: number;
  holdSec: number;
} {
  const CHAR_W = 7.4; // ~15 px Inter average advance
  const PAD_X = 24;
  const LINE_H = 20;
  const maxInner = 260;
  const natural = [...text].length * CHAR_W;
  const inner = Math.min(maxInner, Math.max(70, natural));
  const lines = Math.max(1, Math.ceil(natural / inner));
  const width = Math.round(inner + PAD_X + (lines > 1 ? 10 : 6));
  const height = Math.round(lines * LINE_H + 14);
  const holdSec = Math.min(9, 3.5 + text.length * 0.06);
  return { width, height, lines, holdSec };
}
