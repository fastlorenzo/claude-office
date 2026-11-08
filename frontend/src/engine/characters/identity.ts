/**
 * Deterministic per-character appearance + short state labels (pure).
 */

import type { AgentState, BossState } from "@/types";
import type { HairStyle } from "./mannequinGeometry";

export const CLAUDE_ORANGE = "#D97757";

const SKIN = ["#F2CBA8", "#E3B08B", "#C98E66", "#A86E4C", "#7D5137", "#5E3C29"];
const HAIR = [
  "#2A1C13",
  "#151515",
  "#5B3A21",
  "#8A5A2E",
  "#C49A5F",
  "#6E6A66",
  "#3B2618",
];
const TROUSERS = ["#2C3038", "#262D3B", "#34343A", "#2F3230"];
const SHOES = ["#1E1B1A", "#3B2A20", "#24262B"];

/** FNV-1a 32-bit hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable 0..1 seed for an id. */
export function seed01(id: string): number {
  return (hashString(id) % 100000) / 100000;
}

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  trousers: string;
  shoes: string;
}

export function pickAppearance(id: string, boss: boolean): Appearance {
  if (boss) {
    return {
      skin: SKIN[1],
      hair: HAIR[0],
      hairStyle: 0,
      trousers: TROUSERS[0],
      shoes: SHOES[0],
    };
  }
  const h = hashString(id);
  const pick = <T>(arr: readonly T[], shift: number): T =>
    arr[(h >>> shift) % arr.length];
  return {
    skin: pick(SKIN, 0),
    hair: pick(HAIR, 5),
    hairStyle: ((h >>> 11) % 3) as HairStyle,
    trousers: pick(TROUSERS, 15),
    shoes: pick(SHOES, 19),
  };
}

const AGENT_LABEL: Record<AgentState, string> = {
  arriving: "arriving",
  reporting: "reporting",
  walking_to_desk: "to desk",
  working: "working",
  thinking: "thinking…",
  waiting_permission: "needs you",
  completed: "done ✓",
  waiting: "waiting",
  reporting_done: "reporting",
  leaving: "leaving",
  in_elevator: "arriving",
  idle: "idle",
};

const BOSS_LABEL: Record<BossState, string> = {
  idle: "idle",
  phone_ringing: "incoming",
  on_phone: "on call",
  receiving: "reading",
  working: "working",
  delegating: "delegating",
  waiting_permission: "needs you",
  reviewing: "reviewing",
  completing: "wrapping up",
};

export function agentStateLabel(state: AgentState): string {
  return AGENT_LABEL[state] ?? state;
}

export function bossStateLabel(state: BossState): string {
  return BOSS_LABEL[state] ?? state;
}

/** #rrggbb → [r, g, b] in 0..1 (sRGB). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB channel → linear. */
export function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Multiply an sRGB hex colour by k (0..n) and return #rrggbb. */
export function shadeHex(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v * k)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`;
}
