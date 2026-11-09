/** Persistent desktop settings (userData/config.json). */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_PORT } from "./envfile";

export interface AppConfig {
  /** Key the backend enforces; adopted from the hook config when one exists. */
  apiKey: string;
  /** Last port used; reused when free so the hooks' URL stays stable. */
  port: number;
  /** The user connected Claude Code (hooks are kept pointed at this app). */
  connected: boolean;
  statusline: boolean;
  /** WSL distros the user connected (Windows only). */
  wslDistros: string[];
  /**
   * "<version>:<port>" the WSL distros' hooks were last installed for. Checking
   * a distro means booting its VM, so launches re-point them only when this
   * changes.
   */
  wslSyncedFor: string;
  closeToTray: boolean;
  onboarded: boolean;
  /**
   * WebGL policy. "auto": ignore Chromium's GPU blocklist (it disables WebGL
   * entirely on e.g. WSLg's d3d12 driver, and the office is a WebGL scene);
   * "software": SwiftShader WebGL (slow but always works); "default": plain
   * Chromium behaviour.
   */
  gpu: GpuMode;
}

export type GpuMode = "auto" | "software" | "default";

export function defaultConfig(platform: NodeJS.Platform = process.platform): AppConfig {
  return {
    apiKey: randomBytes(32).toString("base64url"),
    port: DEFAULT_PORT,
    connected: false,
    statusline: false,
    wslDistros: [],
    wslSyncedFor: "",
    // GNOME hides tray icons without an extension, so a hidden window could be
    // unreachable there: only Windows closes to tray by default.
    closeToTray: platform === "win32",
    onboarded: false,
    gpu: "auto",
  };
}

export function loadConfig(path: string): AppConfig {
  const base = defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

export function saveConfig(path: string, cfg: AppConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Chromium switches for a GPU mode (applied before app ready). */
export function gpuSwitches(mode: GpuMode): string[] {
  if (mode === "auto") return ["ignore-gpu-blocklist"];
  if (mode === "software") return ["disable-gpu", "enable-unsafe-swiftshader"];
  return [];
}
