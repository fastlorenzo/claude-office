/**
 * "Open at login". Electron's setLoginItemSettings covers Windows (and macOS);
 * on Linux we write an XDG autostart entry ourselves. For an AppImage the
 * stable path is $APPIMAGE (process.execPath points into the temp mount).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function linuxAutostartPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "autostart", "claude-office.desktop");
}

export function linuxAutostartEntry(execPath: string): string {
  const quoted = /[\s"'\\$`]/.test(execPath) ? `"${execPath.replace(/(["\\$`])/g, "\\$1")}"` : execPath;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Claude Office",
    `Exec=${quoted} --hidden`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function setLinuxAutostart(
  enabled: boolean,
  execPath: string,
  env: NodeJS.ProcessEnv,
  home: string,
): void {
  const path = linuxAutostartPath(env, home);
  if (enabled) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, linuxAutostartEntry(execPath));
  } else {
    rmSync(path, { force: true });
  }
}

export function linuxAutostartEnabled(env: NodeJS.ProcessEnv, home: string): boolean {
  return existsSync(linuxAutostartPath(env, home));
}
