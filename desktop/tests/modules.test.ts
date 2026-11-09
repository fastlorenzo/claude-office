import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, gpuSwitches, loadConfig, saveConfig } from "../src/appconfig";
import { linuxAutostartEntry } from "../src/autostart";
import { eventsUrlFor, parseEnvFile } from "../src/envfile";
import {
  deployHook,
  hookRoot,
  hooksCurrent,
  installArgs,
  parseStatus,
  pruneHooks,
  type HookStatus,
} from "../src/hookctl";
import { resolvePaths } from "../src/paths";
import { choosePort, findFreePort, isPortFree } from "../src/ports";
import { Sidecar } from "../src/sidecar";

const tmp = () => mkdtempSync(join(tmpdir(), "co-desktop-"));

describe("envfile", () => {
  test("parses quoted values, skips comments", () => {
    expect(
      parseEnvFile('# c\nCLAUDE_OFFICE_API_KEY="abc"\r\nCLAUDE_OFFICE_DEBUG=1\nbad\nX=\'y=z\'\n'),
    ).toEqual({ CLAUDE_OFFICE_API_KEY: "abc", CLAUDE_OFFICE_DEBUG: "1", X: "y=z" });
  });
  test("default port maps to the hook's default URL", () => {
    expect(eventsUrlFor(8000)).toBe("");
    expect(eventsUrlFor(8123)).toBe("http://127.0.0.1:8123/api/v1/events");
  });
});

describe("ports", () => {
  test("busy preferred port falls back to a free one", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const busy = (srv.address() as { port: number }).port;
    expect(await isPortFree(busy)).toBe(false);
    const chosen = await choosePort(busy);
    expect(chosen).not.toBe(busy);
    expect(await isPortFree(chosen)).toBe(true);
    srv.close();
  });
});

describe("appconfig", () => {
  test("round trip, defaults merged, file is private", () => {
    const path = join(tmp(), "sub", "config.json");
    expect(loadConfig(path).port).toBe(8000);
    const cfg = { ...defaultConfig("linux"), connected: true };
    saveConfig(path, cfg);
    expect(loadConfig(path)).toEqual(cfg);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(defaultConfig("linux").closeToTray).toBe(false);
    expect(defaultConfig("win32").closeToTray).toBe(true);
  });
});

describe("hookctl", () => {
  test("hook root per platform", () => {
    expect(hookRoot("linux", {}, "/home/u")).toBe("/home/u/.local/share/claude-office/hook");
    expect(hookRoot("linux", { XDG_DATA_HOME: "/x" }, "/home/u")).toBe("/x/claude-office/hook");
    expect(hookRoot("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\U")).toContain("claude-office");
  });

  test("deploy copies once per version, prunes old versions", () => {
    const dir = tmp();
    const bundle = join(dir, "bundle");
    mkdirSync(join(bundle, "_internal"), { recursive: true });
    writeFileSync(join(bundle, "claude-office-hook"), "v1");
    writeFileSync(join(bundle, "_internal", "lib"), "x");
    const root = join(dir, "root");
    const exe = deployHook(bundle, root, "1.0.0", "linux");
    expect(readFileSync(exe, "utf8")).toBe("v1");
    expect(statSync(exe).mode & 0o111).not.toBe(0);
    writeFileSync(join(bundle, "claude-office-hook"), "v1-changed");
    deployHook(bundle, root, "1.0.0", "linux");
    expect(readFileSync(exe, "utf8")).toBe("v1"); // same version: not recopied
    const exe2 = deployHook(bundle, root, "1.1.0", "linux");
    pruneHooks(root, "1.1.0");
    expect(existsSync(exe)).toBe(false);
    expect(readFileSync(exe2, "utf8")).toBe("v1-changed");
  });

  const status = (over: Partial<HookStatus> = {}): HookStatus => ({
    settings_path: "/s",
    installed_hooks: ["Stop"],
    missing_hooks: [],
    hook_commands: ["/h/claude-office-hook"],
    config_file: "/c",
    config_present: true,
    api_key_present: true,
    api_url: null,
    statusline_wrapped: false,
    ...over,
  });

  test("hooksCurrent compares path (quotes, slashes) and URL", () => {
    expect(hooksCurrent(status(), "/h/claude-office-hook", "")).toBe(true);
    expect(hooksCurrent(status(), "/other/claude-office-hook", "")).toBe(false);
    expect(hooksCurrent(status(), "/h/claude-office-hook", "http://127.0.0.1:9/api/v1/events")).toBe(false);
    expect(hooksCurrent(status({ missing_hooks: ["Stop"] }), "/h/claude-office-hook", "")).toBe(false);
    expect(
      hooksCurrent(
        status({ hook_commands: ['"C:/A B/claude-office-hook.exe"'] }),
        "C:\\A B\\claude-office-hook.exe",
        "",
      ),
    ).toBe(true);
    expect(hooksCurrent(null, "/h", "")).toBe(false);
  });

  test("installArgs and parseStatus", () => {
    expect(installArgs("/h", { apiKey: "k", apiUrl: "", statusline: true, replaceKey: true })).toEqual([
      "install", "--hook-cmd", "/h", "--api-key", "k", "--api-url=", "--replace-api-key", "--statusline", "--json",
    ]);
    expect(installArgs("/h", { apiKey: "k", apiUrl: "", statusline: false, relay: "/mnt/c/A B/h.exe" })).toEqual([
      "install", "--hook-cmd", "/h", "--api-key", "k", "--api-url=", "--relay=/mnt/c/A B/h.exe", "--json",
    ]);
    const out = `  [Add] Stop\nSettings saved.\n${JSON.stringify(status(), null, 2)}\n`;
    expect(parseStatus(out)?.hook_commands).toEqual(["/h/claude-office-hook"]);
    expect(parseStatus("garbage")).toBeNull();
  });
});

test("autostart entry quotes paths with spaces", () => {
  expect(linuxAutostartEntry("/opt/Claude Office/claude-office")).toContain(
    'Exec="/opt/Claude Office/claude-office" --hidden',
  );
  expect(linuxAutostartEntry("/home/u/Claude.AppImage")).toContain("Exec=/home/u/Claude.AppImage --hidden");
});

test("paths: packaged vs dev", () => {
  const p = resolvePaths(true, "/r", "/app", "win32");
  expect(p.server).toBe(join("/r", "server", "claude-office-server.exe"));
  expect(p.hookLinuxBundle).toBe(join("/r", "hook-linux"));
  const d = resolvePaths(false, "/r", "/repo/desktop", "linux", {});
  expect(d.server).toBe(join("/repo", "packaging", "dist", "claude-office-server", "claude-office-server"));
  expect(d.staticDir).toBe(join("/repo", "frontend", "out"));
  expect(d.hookLinuxBundle).toBeNull();
});

// A stand-in for claude-office-server: serves /health and exits on stdin EOF.
const FAKE_SERVER = `
const http = require("http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const srv = http.createServer((q, s) => { s.statusCode = q.url === "/health" ? 200 : 404; s.end("ok"); });
srv.listen(port, "127.0.0.1");
if (process.env.CRASH_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.CRASH_AFTER_MS));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

describe("sidecar", () => {
  async function make(env: Record<string, string> = {}) {
    const dir = tmp();
    const script = join(dir, "fake.js");
    writeFileSync(script, FAKE_SERVER);
    const port = await findFreePort();
    return new Sidecar({
      command: process.execPath,
      args: [script, "--port", String(port)],
      env: { ...process.env, ...env },
      cwd: dir,
      logFile: join(dir, "logs", "server.log"),
      healthUrl: `http://127.0.0.1:${port}/health`,
      startTimeoutMs: 10_000,
    });
  }

  test("starts healthy and stops via stdin EOF", async () => {
    const sc = await make();
    await sc.start();
    expect(sc.running).toBe(true);
    await sc.stop();
    expect(sc.running).toBe(false);
  });

  test("restarts after an unexpected exit", async () => {
    const sc = await make({ CRASH_AFTER_MS: "1500" });
    await sc.start();
    const restarted = new Promise<void>((r) => sc.once("restarted", () => r()));
    await restarted;
    expect(sc.running).toBe(true);
    await sc.stop();
  }, 15_000);
});

test("sidecar creates a missing cwd and reports spawn errors", async () => {
  const dir = tmp();
  const sc = new Sidecar({
    command: join(dir, "does-not-exist"),
    args: [],
    env: process.env,
    cwd: join(dir, "data", "nested"),
    logFile: join(dir, "logs", "server.log"),
    healthUrl: "http://127.0.0.1:9/health",
    startTimeoutMs: 3000,
  });
  await expect(sc.start()).rejects.toThrow(/could not start|exited during startup/);
  expect(existsSync(join(dir, "data", "nested"))).toBe(true);
});

test("gpu switches", () => {
  expect(gpuSwitches("auto")).toEqual(["ignore-gpu-blocklist"]);
  expect(gpuSwitches("software")).toContain("enable-unsafe-swiftshader");
  expect(gpuSwitches("default")).toEqual([]);
});
