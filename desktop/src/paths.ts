/** Where the bundled pieces live: packaged resources, or the repo in development. */
import { join } from "node:path";

export interface BundlePaths {
  /** Frozen backend executable. */
  server: string;
  /** Native hook onedir bundle (copied to a stable dir before registering). */
  hookBundle: string;
  /** Linux hook bundle for WSL distros (Windows builds only), else null. */
  hookLinuxBundle: string | null;
  /** Frontend static export. */
  staticDir: string;
}

const exe = (name: string, platform: NodeJS.Platform) =>
  platform === "win32" ? `${name}.exe` : name;

export function resolvePaths(
  isPackaged: boolean,
  resourcesPath: string,
  appPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BundlePaths {
  if (isPackaged) {
    return {
      server: join(resourcesPath, "server", exe("claude-office-server", platform)),
      hookBundle: join(resourcesPath, "hook"),
      hookLinuxBundle: platform === "win32" ? join(resourcesPath, "hook-linux") : null,
      staticDir: join(resourcesPath, "static"),
    };
  }
  // `make desktop`: run against `make -C packaging all` + the frontend export.
  const repo = join(appPath, "..");
  const dist = join(repo, "packaging", "dist");
  return {
    server: join(dist, "claude-office-server", exe("claude-office-server", platform)),
    hookBundle: join(dist, "claude-office-hook"),
    hookLinuxBundle: env.CLAUDE_OFFICE_HOOK_LINUX_BUNDLE || null,
    staticDir: env.CLAUDE_OFFICE_STATIC_DIR || join(repo, "frontend", "out"),
  };
}
