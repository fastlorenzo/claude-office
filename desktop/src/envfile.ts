/**
 * Reader for ~/.claude/claude-office-config.env, the file the hook reads its
 * API key / URL from (written by `claude-office-hook install`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PORT = 8000;

export function claudeConfigEnvPath(home: string): string {
  return join(home, ".claude", "claude-office-config.env");
}

/** Parse KEY=value lines (comments/blank lines skipped, surrounding quotes stripped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    out[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** The events URL hooks must use for `port`; "" means "the hook's default". */
export function eventsUrlFor(port: number): string {
  return port === DEFAULT_PORT ? "" : `http://127.0.0.1:${port}/api/v1/events`;
}
