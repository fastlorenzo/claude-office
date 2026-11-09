/**
 * WSL bridge (Windows builds): connect Claude Code running inside WSL distros.
 *
 * For each selected distro the bundled *Linux* hook (resources/hook-linux) is
 * copied into the distro's ~/.local/share/claude-office/hook/<version>/ over
 * the \\wsl.localhost share, then `claude-office-hook install` runs inside the
 * distro (via wsl.exe) so the distro's own ~/.claude/settings.json and config
 * file are written by the same code as on the host. The distro gets this app's
 * key with --replace-api-key: this app's backend is the one enforcing it.
 *
 * The hook tags events with WSL_DISTRO_NAME; the backend maps their transcript
 * paths to the share (backend/app/core/wsl_bridge.py).
 *
 * Networking: with networkingMode=mirrored, WSL reaches Windows' 127.0.0.1 and
 * hooks use the normal loopback URL. NAT mode is reported to the UI; bridging
 * it needs a non-loopback listener and a firewall rule (not done yet).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { eventsUrlFor } from "./envfile";
import { HOOK_NAME, installArgs, parseStatus, runCli, type HookStatus } from "./hookctl";

const WSL = "wsl.exe";
// Docker Desktop's internal distros cannot run Claude Code.
const IGNORED = /^docker-desktop(-data)?$/i;
const DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type NetworkingMode = "mirrored" | "nat" | "other";

/** `wsl.exe -l -q` prints UTF-16LE (often with a BOM); return the distro names. */
export function decodeDistroList(buf: Buffer): string[] {
  const looksUtf16 = buf.length >= 2 && (buf[1] === 0 || (buf[0] === 0xff && buf[1] === 0xfe));
  const text = looksUtf16 ? buf.toString("utf16le") : buf.toString("utf8");
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, "").trim())
    .filter((l) => l && DISTRO_RE.test(l) && l.replace(/\./g, "") !== "" && !IGNORED.test(l));
}

/** networkingMode from a .wslconfig text ([wsl2] section); "nat" by default. */
export function networkingMode(wslconfig: string): NetworkingMode {
  let inWsl2 = false;
  for (const raw of wslconfig.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inWsl2 = section[1].trim().toLowerCase() === "wsl2";
      continue;
    }
    const kv = /^networkingMode\s*=\s*(\S+)$/i.exec(line);
    if (inWsl2 && kv) {
      const mode = kv[1].toLowerCase();
      return mode === "mirrored" ? "mirrored" : mode === "nat" ? "nat" : "other";
    }
  }
  return "nat";
}

export function readNetworkingMode(userProfile: string): NetworkingMode {
  try {
    return networkingMode(readFileSync(join(userProfile, ".wslconfig"), "utf8"));
  } catch {
    return "nat";
  }
}

/** Linux path of the hook inside a distro for this app version. */
export function linuxHookPath(linuxHome: string, version: string): string {
  return `${linuxHome.replace(/\/$/, "")}/.local/share/claude-office/hook/${version}/${HOOK_NAME}`;
}

/** Windows (UNC) path of a Linux path inside a distro. */
export function uncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, "\\")}`;
}

const inDistro = (distro: string, args: string[]) => ["-d", distro, "-e", ...args];

export function listDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(WSL, ["-l", "-q"], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", () => resolve([]));
    child.on("close", (code) => resolve(code === 0 ? decodeDistroList(Buffer.concat(chunks)) : []));
  });
}

async function distroHome(distro: string): Promise<string> {
  const res = await runCli(WSL, inDistro(distro, ["sh", "-c", 'printf %s "$HOME"']));
  const home = res.stdout.trim();
  if (res.code !== 0 || !home.startsWith("/")) {
    throw new Error(`${distro}: cannot read $HOME (${res.stderr.trim() || "wsl.exe failed"})`);
  }
  return home;
}

/** Copy the Linux hook bundle into the distro; returns its Linux path. */
async function deployIntoDistro(distro: string, bundle: string, version: string): Promise<string> {
  const exe = linuxHookPath(await distroHome(distro), version);
  const dir = exe.slice(0, exe.lastIndexOf("/"));
  const target = uncPath(distro, dir);
  if (version === "dev" || !existsSync(uncPath(distro, exe))) {
    rmSync(target, { recursive: true, force: true });
    cpSync(bundle, target, { recursive: true });
  }
  // File copies over the share do not carry the exec bit.
  await runCli(WSL, inDistro(distro, ["chmod", "+x", exe]));
  return exe;
}

export async function distroStatus(distro: string, version: string): Promise<HookStatus | null> {
  try {
    const exe = linuxHookPath(await distroHome(distro), version);
    return parseStatus((await runCli(WSL, inDistro(distro, [exe, "status"]))).stdout);
  } catch {
    return null;
  }
}

export async function connectDistro(
  distro: string,
  bundle: string,
  version: string,
  apiKey: string,
  port: number,
  statusline: boolean,
): Promise<HookStatus | null> {
  const exe = await deployIntoDistro(distro, bundle, version);
  const args = installArgs(exe, { apiKey, apiUrl: eventsUrlFor(port), statusline, replaceKey: true });
  const res = await runCli(WSL, inDistro(distro, [exe, ...args]), process.env, 60_000);
  if (res.code !== 0) throw new Error(`${distro}: hook install failed: ${res.stderr || res.stdout}`);
  return parseStatus(res.stdout);
}

export async function disconnectDistro(distro: string, bundle: string, version: string): Promise<void> {
  // Deploy the current hook first: the registered one may be an older
  // version's, and `uninstall` removes every Claude Office entry regardless.
  const exe = await deployIntoDistro(distro, bundle, version);
  const res = await runCli(WSL, inDistro(distro, [exe, "uninstall", "--json"]), process.env, 60_000);
  if (res.code !== 0) throw new Error(`${distro}: hook uninstall failed: ${res.stderr || res.stdout}`);
}
