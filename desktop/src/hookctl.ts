/**
 * Deploy and drive the bundled claude-office-hook binary.
 *
 * The bundle is copied out of the app's resources into a stable, versioned
 * per-user directory before being registered in Claude Code's settings:
 * an AppImage mounts at a random /tmp path on every launch, and a versioned
 * directory means an update never overwrites a binary Claude Code may be
 * executing (Windows locks it). `claude-office-hook install` re-points the
 * settings entries at the new version's path.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const HOOK_NAME = "claude-office-hook";
const MARKER = ".claude-office-version";

export function hookExeName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${HOOK_NAME}.exe` : HOOK_NAME;
}

/** Parent of the versioned hook directories. */
export function hookRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "claude-office", "hook");
  }
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "claude-office", "hook");
}

/**
 * Copy `bundleDir` to `<root>/<version>` unless it is already there; returns
 * the deployed executable. `version` "dev" always recopies.
 */
export function deployHook(
  bundleDir: string,
  root: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = join(root, version);
  const exe = join(target, hookExeName(platform));
  const marker = join(target, MARKER);
  const current = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (version !== "dev" && current === version && existsSync(exe)) return exe;

  const staging = `${target}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(bundleDir, staging, { recursive: true });
  writeFileSync(join(staging, MARKER), version);
  if (platform !== "win32") chmodSync(join(staging, hookExeName(platform)), 0o755);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return exe;
}

/** Remove versioned hook directories other than `keep` (best effort: a running hook may lock one). */
export function pruneHooks(root: string, keep: string): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (name === keep) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      // locked by a running hook process; retried on the next launch
    }
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin.end();
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface HookStatus {
  settings_path: string;
  installed_hooks: string[];
  missing_hooks: string[];
  hook_commands: string[];
  config_file: string;
  config_present: boolean;
  api_key_present: boolean;
  api_url: string | null;
  statusline_wrapped: boolean;
}

/** The JSON status object printed (after any progress lines) by `--json` / `status`. */
export function parseStatus(stdout: string): HookStatus | null {
  const start = stdout.indexOf("{\n");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as HookStatus;
  } catch {
    return null;
  }
}

export interface InstallOptions {
  apiKey: string;
  /** "" resets to the hook's default URL (port 8000). */
  apiUrl: string;
  statusline: boolean;
  /** Overwrite an existing key (WSL distros: this app's backend enforces its own). */
  replaceKey?: boolean;
  /**
   * WSL distros: Linux path of the Windows hook to relay through when the
   * app's loopback is unreachable (NAT networking). See hooks relay.py.
   */
  relay?: string;
}

export function installArgs(hookCmd: string, opts: InstallOptions): string[] {
  const args = ["install", "--hook-cmd", hookCmd, "--api-key", opts.apiKey];
  // One token, never a separate "" argument: wsl.exe (WSL bridge) may drop
  // empty arguments, which would make the next flag the URL.
  args.push(`--api-url=${opts.apiUrl}`);
  if (opts.replaceKey) args.push("--replace-api-key");
  if (opts.relay !== undefined) args.push(`--relay=${opts.relay}`);
  if (opts.statusline) args.push("--statusline");
  args.push("--json");
  return args;
}

/** True when the registered hooks already point at `hookCmd` with the right URL. */
export function hooksCurrent(status: HookStatus | null, hookCmd: string, apiUrl: string): boolean {
  if (!status || status.missing_hooks.length > 0) return false;
  if (status.hook_commands.length !== 1) return false;
  const registered = status.hook_commands[0].replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  return registered === hookCmd.replace(/\\/g, "/") && (status.api_url ?? "") === apiUrl;
}
