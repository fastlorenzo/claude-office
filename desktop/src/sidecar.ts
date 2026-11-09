/**
 * Supervisor for the frozen backend (claude-office-server).
 *
 * The server gets `--exit-on-stdin-close`: we hold the write end of its stdin,
 * so if this process dies the server sees EOF and exits instead of keeping the
 * port bound. Unexpected exits are restarted with backoff; repeated crashes
 * emit "fatal" so the UI can show the log.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { get } from "node:http";
import { dirname } from "node:path";

export interface SidecarOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFile: string;
  healthUrl: string;
  startTimeoutMs?: number;
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export function healthy(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function rotate(logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  if (existsSync(logFile) && statSync(logFile).size > LOG_ROTATE_BYTES) {
    renameSync(logFile, `${logFile}.1`);
  }
}

export class Sidecar extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts: number[] = [];

  constructor(private opts: SidecarOptions) {
    super();
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Spawn and resolve once /health answers; rejects on timeout or early exit. */
  async start(): Promise<void> {
    this.stopping = false;
    rotate(this.opts.logFile);
    mkdirSync(this.opts.cwd, { recursive: true }); // first run: the data dir does not exist yet
    const fd = openSync(this.opts.logFile, "a");
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", fd, fd],
      windowsHide: true,
    });
    closeSync(fd);
    this.child = child;
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      if (this.child === child) this.child = null;
      if (!this.stopping) this.onCrash(code, signal);
    });
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
      this.emit("log", `spawn error: ${err}`);
    });

    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`could not start ${this.opts.command}: ${spawnError}`);
      if (exited) throw new Error(`server exited during startup (see ${this.opts.logFile})`);
      if (await healthy(this.opts.healthUrl)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.stop();
    throw new Error(`server did not become healthy in time (see ${this.opts.logFile})`);
  }

  /** Graceful stop: close stdin, wait, then kill. */
  async stop(graceMs = 6000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const done = new Promise<void>((r) => child.once("exit", () => r()));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), graceMs);
    await done;
    clearTimeout(timer);
  }

  async restart(env?: NodeJS.ProcessEnv): Promise<void> {
    await this.stop();
    if (env) this.opts = { ...this.opts, env };
    await this.start();
  }

  private onCrash(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    this.emit("log", `server exited unexpectedly (code ${code}, signal ${signal})`);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.emit("fatal", new Error(`server keeps crashing (see ${this.opts.logFile})`));
      return;
    }
    this.restarts.push(now);
    const delay = 1000 * 2 ** (this.restarts.length - 1);
    setTimeout(() => {
      if (this.stopping) return;
      this.start().then(
        () => this.emit("restarted"),
        (err: Error) => this.emit("log", `restart failed: ${err.message}`),
      );
    }, delay);
  }
}
