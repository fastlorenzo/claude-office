/**
 * Claude Office desktop shell.
 *
 * Starts the frozen backend on loopback with an explicit API key, shows the
 * office (same-origin static export served by the backend, key delivered via
 * the existing ?token= intake), and manages the Claude Code hooks through the
 * bundled `claude-office-hook install|uninstall|status`.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { gpuSwitches, loadConfig, saveConfig, type AppConfig, type GpuMode } from "./appconfig";
import { linuxAutostartEnabled, setLinuxAutostart } from "./autostart";
import { claudeConfigEnvPath, eventsUrlFor, readEnvFile } from "./envfile";
import {
  deployHook,
  hookRoot,
  hooksCurrent,
  installArgs,
  parseStatus,
  pruneHooks,
  runCli,
  type HookStatus,
} from "./hookctl";
import { resolvePaths } from "./paths";
import { choosePort } from "./ports";
import { Sidecar } from "./sidecar";
import { connectDistro, disconnectDistro, listDistros, readNetworkingMode } from "./wsl";

// Smoke mode (CI / local verification): isolated profile, load the office,
// write a screenshot + report to CLAUDE_OFFICE_DESKTOP_SMOKE, then quit.
const SMOKE_OUT = process.env.CLAUDE_OFFICE_DESKTOP_SMOKE || "";
if (process.env.CLAUDE_OFFICE_DESKTOP_USER_DATA) {
  app.setPath("userData", process.env.CLAUDE_OFFICE_DESKTOP_USER_DATA);
}

const HOME = homedir();
const USER_DATA = app.getPath("userData");
const CONFIG_PATH = join(USER_DATA, "config.json");
const LOG_DIR = join(USER_DATA, "logs");
const DATA_DIR = join(USER_DATA, "data");
const ICON = join(__dirname, "..", "build", "icon.png");
const VERSION = app.isPackaged ? app.getVersion() : "dev";
const PATHS = resolvePaths(app.isPackaged, process.resourcesPath, app.getAppPath());
const START_HIDDEN = process.argv.includes("--hidden");

let cfg: AppConfig = loadConfig(CONFIG_PATH);

// GPU policy must be set before the app is ready. CLAUDE_OFFICE_DESKTOP_GPU
// overrides the saved mode (troubleshooting / smoke runs).
const GPU_MODE = (process.env.CLAUDE_OFFICE_DESKTOP_GPU as GpuMode | undefined) || cfg.gpu;
for (const sw of gpuSwitches(GPU_MODE)) app.commandLine.appendSwitch(sw);
let sidecar: Sidecar | null = null;
let officeWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const persist = () => saveConfig(CONFIG_PATH, cfg);
const officeUrl = () => `http://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(cfg.apiKey)}`;
const origin = () => `http://127.0.0.1:${cfg.port}`;

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * The key hooks send must be the key the backend enforces. Adopt the one in
 * ~/.claude/claude-office-config.env when present (`install` never replaces
 * an existing key there), otherwise keep ours.
 */
function adoptHookKey(): boolean {
  const fileKey = readEnvFile(claudeConfigEnvPath(HOME)).CLAUDE_OFFICE_API_KEY;
  if (fileKey && fileKey !== cfg.apiKey) {
    cfg.apiKey = fileKey;
    persist();
    return true;
  }
  return false;
}

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_OFFICE_API_KEY: cfg.apiKey,
    CLAUDE_OFFICE_DATA_DIR: DATA_DIR,
    CLAUDE_OFFICE_STATIC_DIR: PATHS.staticDir,
    SERVE_STATIC: "1",
    LOG_RICH_TRACEBACKS: "0",
    PYTHONUNBUFFERED: "1",
  };
}

async function startBackend(): Promise<void> {
  if (!existsSync(PATHS.server)) {
    throw new Error(`backend not found at ${PATHS.server} (run \`make -C packaging all\`)`);
  }
  cfg.port = await choosePort(cfg.port);
  persist();
  sidecar = new Sidecar({
    command: PATHS.server,
    args: ["--port", String(cfg.port), "--exit-on-stdin-close"],
    env: serverEnv(),
    cwd: DATA_DIR,
    logFile: join(LOG_DIR, "server.log"),
    healthUrl: `${origin()}/health`,
  });
  sidecar.on("restarted", () => officeWindow?.reload());
  sidecar.on("fatal", (err: Error) => {
    dialog.showErrorBox("Claude Office backend stopped", err.message);
  });
  await sidecar.start();
}

async function restartBackendWithKey(): Promise<void> {
  await sidecar?.restart(serverEnv());
  officeWindow?.loadURL(officeUrl());
}

// ---------------------------------------------------------------------------
// Claude Code hooks
// ---------------------------------------------------------------------------

function deployedHook(): string {
  const root = hookRoot(process.platform, process.env, HOME);
  const exe = deployHook(PATHS.hookBundle, root, VERSION);
  pruneHooks(root, VERSION);
  return exe;
}

async function hookStatus(hookExe: string | null): Promise<HookStatus | null> {
  const exe = hookExe ?? join(PATHS.hookBundle, process.platform === "win32" ? "claude-office-hook.exe" : "claude-office-hook");
  if (!existsSync(exe)) return null;
  return parseStatus((await runCli(exe, ["status"])).stdout);
}

/** Register (or re-point) the hooks at this app's binary, key and port. */
async function connectNative(statusline: boolean): Promise<HookStatus | null> {
  const exe = deployedHook();
  const res = await runCli(
    exe,
    installArgs(exe, { apiKey: cfg.apiKey, apiUrl: eventsUrlFor(cfg.port), statusline }),
  );
  if (res.code !== 0) throw new Error(`hook install failed: ${res.stderr || res.stdout}`);
  if (adoptHookKey()) await restartBackendWithKey();
  return parseStatus(res.stdout);
}

// ---------------------------------------------------------------------------
// WSL distros (Windows builds)
// ---------------------------------------------------------------------------

const wslAvailable = () =>
  process.platform === "win32" && !!PATHS.hookLinuxBundle && existsSync(PATHS.hookLinuxBundle);
const wslSyncKey = () => `${VERSION}:${cfg.port}`;

/**
 * Bring the connected distros in line with `wanted`: connect new ones (and
 * re-point existing ones), disconnect dropped ones. Returns per-distro errors;
 * cfg.wslDistros keeps only the distros that are actually connected.
 */
async function syncDistros(wanted: string[], statusline: boolean): Promise<string[]> {
  if (!wslAvailable() || !PATHS.hookLinuxBundle) return [];
  const bundle = PATHS.hookLinuxBundle;
  const errors: string[] = [];
  const connected = new Set(cfg.wslDistros);
  for (const distro of cfg.wslDistros.filter((d) => !wanted.includes(d))) {
    try {
      await disconnectDistro(distro, bundle, VERSION);
      connected.delete(distro);
    } catch (err) {
      errors.push(String((err as Error).message ?? err));
    }
  }
  for (const distro of wanted) {
    try {
      await connectDistro(distro, bundle, VERSION, cfg.apiKey, cfg.port, statusline);
      connected.add(distro);
    } catch (err) {
      errors.push(String((err as Error).message ?? err));
    }
  }
  cfg.wslDistros = [...connected].sort();
  if (errors.length === 0) cfg.wslSyncedFor = wslSyncKey();
  persist();
  return errors;
}

/** On launch: keep hooks pointed at this version/port when the user connected before. */
async function ensureHooks(): Promise<void> {
  if (!cfg.connected) return;
  try {
    const exe = deployedHook();
    if (!hooksCurrent(await hookStatus(exe), exe, eventsUrlFor(cfg.port))) {
      await connectNative(cfg.statusline);
    }
  } catch (err) {
    console.error("ensureHooks:", err);
  }
  if (cfg.wslDistros.length > 0 && cfg.wslSyncedFor !== wslSyncKey()) {
    const errors = await syncDistros(cfg.wslDistros, cfg.statusline);
    if (errors.length) console.error("ensureHooks (WSL):", errors.join("; "));
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function lockDown(win: BrowserWindow, allowedOrigin: () => string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(allowedOrigin())) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

function showOffice(): void {
  if (officeWindow) {
    officeWindow.show();
    officeWindow.focus();
    return;
  }
  officeWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Claude Office",
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d12",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockDown(officeWindow, origin);
  officeWindow.on("close", (event) => {
    if (!quitting && cfg.closeToTray && tray) {
      event.preventDefault();
      officeWindow?.hide();
    }
  });
  officeWindow.on("closed", () => {
    officeWindow = null;
    if (!cfg.closeToTray || !tray) app.quit();
  });
  void officeWindow.loadURL(officeUrl());
}

function showSetup(): void {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 620,
    height: 720,
    title: "Claude Office — Integrations",
    icon: ICON,
    autoHideMenuBar: true,
    resizable: true,
    parent: officeWindow ?? undefined,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(setupWindow, () => "file://");
  setupWindow.on("closed", () => (setupWindow = null));
  void setupWindow.loadFile(join(__dirname, "..", "setup", "setup.html"));
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Office",
      submenu: [
        { label: "Integrations…", click: showSetup },
        { label: "Open logs folder", click: () => void shell.openPath(LOG_DIR) },
        { label: "Open data folder", click: () => void shell.openPath(USER_DATA) },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  } catch {
    tray = null; // no tray support: closing the window quits
    return;
  }
  tray.setToolTip("Claude Office");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open office", click: showOffice },
      { label: "Integrations…", click: showSetup },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showOffice);
}

// ---------------------------------------------------------------------------
// IPC (setup window)
// ---------------------------------------------------------------------------

function openAtLogin(): boolean {
  if (process.platform === "linux") return linuxAutostartEnabled(process.env, HOME);
  return app.getLoginItemSettings().openAtLogin;
}

function registerIpc(): void {
  ipcMain.handle("co:status", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    port: cfg.port,
    connected: cfg.connected,
    statusline: cfg.statusline,
    closeToTray: cfg.closeToTray,
    openAtLogin: openAtLogin(),
    claudeDirFound: existsSync(join(HOME, ".claude")),
    hooks: await hookStatus(null),
    wslDistros: cfg.wslDistros,
    // Connected state comes from config: probing a distro would boot its VM.
    wsl: wslAvailable()
      ? {
          available: true,
          mirrored: readNetworkingMode(process.env.USERPROFILE || HOME) === "mirrored",
          distros: (await listDistros()).map((name) => ({
            name,
            connected: cfg.wslDistros.includes(name),
          })),
        }
      : { available: false, mirrored: false, distros: [] },
  }));

  ipcMain.handle("co:connect", async (_e, opts: { statusline: boolean; wslDistros: string[] }) => {
    const statusline = Boolean(opts.statusline);
    const status = await connectNative(statusline);
    cfg = { ...cfg, connected: true, statusline, onboarded: true };
    persist();
    const wanted = Array.isArray(opts.wslDistros) ? opts.wslDistros.map(String) : [];
    const errors = await syncDistros(wanted, statusline);
    if (errors.length) throw new Error(`Connected here, but not in WSL: ${errors.join("; ")}`);
    return status;
  });

  ipcMain.handle("co:disconnect", async () => {
    const res = await runCli(deployedHook(), ["uninstall", "--json"]);
    cfg = { ...cfg, connected: false, onboarded: true };
    persist();
    const errors = await syncDistros([], cfg.statusline);
    if (errors.length) throw new Error(`Disconnected here, but not in WSL: ${errors.join("; ")}`);
    if (res.code !== 0) throw new Error(`hook uninstall failed: ${res.stderr || res.stdout}`);
    return parseStatus(res.stdout);
  });

  ipcMain.handle("co:set-prefs", (_e, prefs: { openAtLogin?: boolean; closeToTray?: boolean }) => {
    if (typeof prefs.closeToTray === "boolean") {
      cfg.closeToTray = prefs.closeToTray;
      persist();
    }
    if (typeof prefs.openAtLogin === "boolean") {
      if (process.platform === "linux") {
        setLinuxAutostart(prefs.openAtLogin, process.env.APPIMAGE || process.execPath, process.env, HOME);
      } else {
        app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin, args: ["--hidden"] });
      }
    }
  });

  ipcMain.handle("co:open-logs", () => shell.openPath(LOG_DIR));
  ipcMain.handle("co:open-office", () => {
    cfg.onboarded = true;
    persist();
    setupWindow?.close();
    showOffice();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function checkForUpdates(): Promise<void> {
  // electron-updater handles NSIS and AppImage; .deb installs update via apt/dpkg.
  if (!app.isPackaged || (process.platform === "linux" && !process.env.APPIMAGE)) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.error("update check failed:", err);
  }
}

async function runSmoke(outDir: string): Promise<void> {
  const consoleErrors: string[] = [];
  showOffice();
  const win = officeWindow as BrowserWindow | null;
  if (!win) return app.exit(2);
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") consoleErrors.push(details.message.slice(0, 300));
  });
  const settleMs = Number(process.env.CLAUDE_OFFICE_DESKTOP_SMOKE_SETTLE_MS || 20000);
  await new Promise<void>((r) => win.webContents.once("did-finish-load", () => r()));
  await new Promise((r) => setTimeout(r, settleMs));
  const webgl = (await win.webContents.executeJavaScript(
    `(() => { const c = document.createElement("canvas"); const gl = c.getContext("webgl2");
      if (!gl) return null; const d = gl.getExtension("WEBGL_debug_renderer_info");
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`,
  )) as string | null;
  // End-to-end: connect Claude Code (deploy + register the hook), fire one
  // event through the deployed hook like Claude Code would, read it back.
  let e2e: Record<string, unknown> | null = null;
  if (process.env.CLAUDE_OFFICE_DESKTOP_SMOKE_CONNECT === "1") {
    const status = await connectNative(false);
    const exe = deployedHook();
    const { spawnSync } = await import("node:child_process");
    const payload = JSON.stringify({ session_id: "desktop-smoke", hook_event_name: "SessionStart", cwd: HOME });
    const hookRun = spawnSync(exe, ["session_start"], { input: payload, timeout: 10_000 });
    const sessions = await fetch(`${origin()}/api/v1/sessions`, { headers: { "X-API-Key": cfg.apiKey } });
    const body = await sessions.text();
    e2e = {
      hookExe: exe,
      missingHooks: status?.missing_hooks,
      hookCommands: status?.hook_commands,
      hookExit: hookRun.status,
      sessionsStatus: sessions.status,
      sessionSeen: body.includes("desktop-smoke"),
    };
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "office.png"), (await win.webContents.capturePage()).toPNG());
  const report = {
    url: win.webContents.getURL().replace(/token=[^&]+/, "token=…"),
    title: win.getTitle(),
    port: cfg.port,
    gpuMode: GPU_MODE,
    webgl2Renderer: webgl,
    gpuFeatures: app.getGPUFeatureStatus(),
    consoleErrors,
    e2e,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showOffice);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (event) => {
    if (sidecar?.running) {
      event.preventDefault();
      void sidecar.stop().finally(() => app.exit(0));
    }
  });
  app.on("window-all-closed", () => {
    if (!cfg.closeToTray || !tray) app.quit();
  });

  void app.whenReady().then(async () => {
    buildMenu();
    registerIpc();
    adoptHookKey();
    try {
      await startBackend();
    } catch (err) {
      console.error("startup failed:", err);
      if (!SMOKE_OUT) {
        dialog.showErrorBox("Claude Office could not start", String((err as Error).message ?? err));
      }
      app.exit(1);
      return;
    }
    buildTray();
    await ensureHooks();
    if (SMOKE_OUT) {
      void runSmoke(SMOKE_OUT);
      return;
    }
    if (!START_HIDDEN) showOffice();
    if (!cfg.onboarded) showSetup();
    void checkForUpdates();
  });
}
