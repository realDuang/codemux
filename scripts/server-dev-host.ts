import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build, createServer, type Rollup, type ViteDevServer } from "vite";
import { LocalServerSupervisor } from "../electron/main/local-server-supervisor";
import { resolveServerRuntimeConfig } from "../server/runtime-config";
import { startHostControlServer, type HostControlServer } from "../shared/host-control-server";
import type { HostRuntimeStatus } from "../shared/host-control-types";
import { acquireRuntimeLock, type RuntimeLock } from "../shared/runtime-lock";

const execFileAsync = promisify(execFile);

export async function resolveNodeExecutable(): Promise<string> {
  const { stdout } = await execFileAsync("node", ["-p", "JSON.stringify({version:process.versions.node,path:process.execPath})"], {
    timeout: 10_000,
    windowsHide: true,
  });
  const value = JSON.parse(stdout) as { version: string; path: string };
  if (Number(value.version.split(".")[0]) < 24 || !path.isAbsolute(value.path)) {
    throw new Error("CodeMux Server requires Node.js 24 or newer on PATH.");
  }
  return value.path;
}

export function createDevRuntimeEnvironment(env: NodeJS.ProcessEnv, stateDir: string): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    CODEMUX_LEGACY_DEV: "1",
    CODEMUX_SERVER_MODE: "1",
    CODEMUX_DISABLE_COPILOT_DBUS: "1",
    CODEMUX_RUNTIME_WEB_MODE: "dev-proxy",
    CODEMUX_DEV_PARENT_PID: String(process.pid),
    CODEMUX_SERVER_STATE_DIR: stateDir,
  };
  delete runtimeEnv.ELECTRON_RUN_AS_NODE;
  delete runtimeEnv.CODEMUX_DESKTOP_HOST;
  delete runtimeEnv.CODEMUX_DESKTOP_PARENT_PID;
  delete runtimeEnv.CODEMUX_SHARED_DEV_DEVICE_STORE;
  return runtimeEnv;
}

export interface DevHostStatus extends HostRuntimeStatus {
  runtimePid: number | null;
  runtimeDataPath: string;
  repoPath: string;
  error: string | null;
}

export interface ServerDevHostOptions {
  repoPath: string;
  stateDir: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  onShutdownError?: (error: unknown) => void;
}

/** Vite watches source while the existing supervisor owns exactly one Node child. */
export class ServerDevHost {
  private readonly runtime: LocalServerSupervisor;
  private readonly dataPath: string;
  private web: ViteDevServer | undefined;
  private watcher: Rollup.RollupWatcher | undefined;
  private control: HostControlServer | undefined;
  private lease: RuntimeLock | undefined;
  private stopping = false;
  private closePromise: Promise<void> | undefined;
  private initialization: Promise<void> | undefined;
  private reloadPromise: Promise<void> | undefined;
  private revision = 0;
  private appliedRevision = 0;
  private hasStarted = false;
  private webPort: number | null = null;
  private error: string | null = null;

  constructor(private readonly options: ServerDevHostOptions) {
    const env = createDevRuntimeEnvironment(options.env, options.stateDir);
    this.dataPath = resolveServerRuntimeConfig({
      env, cwd: options.repoPath, home: os.homedir(), platform: process.platform, appPath: options.repoPath,
    }).userDataPath;
    if (path.resolve(options.stateDir) === path.resolve(this.dataPath)) {
      throw new Error("The development state directory must differ from the runtime data directory.");
    }
    this.runtime = new LocalServerSupervisor({
      dataPath: this.dataPath,
      cwd: options.repoPath,
      entryPath: path.join(options.repoPath, "out/server/index.mjs"),
      execPath: options.nodePath,
      env,
      startupTimeoutMs: options.startupTimeoutMs,
      // The runtime has its own 30-second shutdown deadline; allow it to finish first.
      stopTimeoutMs: 35_000,
    });
  }

  getStatus(): DevHostStatus {
    const state = this.runtime.getState();
    const ready = !this.stopping && state.phase === "ready" && state.ownership === "owned";
    return {
      pid: process.pid,
      phase: this.stopping ? "stopping" : ready ? "ready" : "starting",
      ready,
      dataPath: this.control?.dataPath ?? this.options.stateDir,
      webPort: this.webPort,
      gatewayUrl: null,
      runtimePid: state.pid,
      runtimeDataPath: this.dataPath,
      repoPath: this.options.repoPath,
      error: this.error ?? state.error,
    };
  }

  start(): Promise<void> {
    this.initialization ??= this.initialize();
    return this.initialization.catch(async error => {
      await this.close();
      throw error;
    });
  }

  private async initialize(): Promise<void> {
    this.lease = await acquireRuntimeLock(this.options.stateDir, {
      onCompromised: error => {
        console.error(error.message);
        // Child IPC loss triggers its normal shutdown, without writing supervisor state.
        process.exit(1);
      },
    });
    this.control = await startHostControlServer({
      dataPath: this.lease.dataPath,
      getStatus: () => this.getStatus(),
      stop: () => this.close(),
      invoke: (method, args) => this.invoke(method, args),
    });
    this.web = await createServer({
      configFile: path.join(this.options.repoPath, "vite.server-dev.config.ts"),
      clearScreen: false,
    });
    if (this.stopping) return;
    await this.web.listen();
    const address = this.web.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("The development web server did not listen.");
    this.webPort = address.port;
    const watcher = await build({
      root: this.options.repoPath,
      configFile: path.join(this.options.repoPath, "vite.server.config.ts"),
      clearScreen: false,
      build: {
        watch: {},
        // A failed rebuild must leave every lazy chunk of the live child available.
        emptyOutDir: false,
      },
    });
    if (!("on" in watcher)) throw new Error("The server build did not create a source watcher.");
    this.watcher = watcher;
    if (this.stopping) return;
    watcher.on("event", event => {
      if (event.code === "ERROR") {
        this.error = event.error.message;
        const context = this.runtime.getState().phase === "ready" ? "the previous runtime remains active" : "waiting for a successful rebuild";
        console.error(`Server build failed; ${context}: ${event.error.message}`);
      } else if (event.code === "BUNDLE_END") {
        void event.result.close().then(() => this.reload()).catch(error => this.reportError(error));
      }
    });
  }

  private reportError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    console.error(this.error);
  }

  private reload(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.revision++;
    if (this.reloadPromise) return this.reloadPromise;
    const pending = (async () => {
      while (!this.stopping && this.appliedRevision < this.revision) {
        const revision = this.revision;
        const state = this.hasStarted ? await this.runtime.restart() : await this.runtime.start();
        if (this.stopping) return;
        if (state.ownership !== "owned") {
          await this.runtime.shutdown();
          throw new Error("Another launcher owns this data directory. Stop it using its original launcher first.");
        }
        this.hasStarted = true;
        this.appliedRevision = revision;
        this.error = null;
        await fs.writeFile(path.join(this.options.stateDir, "dev.pid"), `${state.pid}\n`);
        await fs.writeFile(path.join(this.options.stateDir, "local-url"), `http://localhost:${this.webPort}\n`);
        console.log(`CodeMux dev is ready: http://localhost:${this.webPort}`);
      }
    })().catch(error => this.reportError(error)).finally(() => {
      if (this.reloadPromise === pending) this.reloadPromise = undefined;
    });
    this.reloadPromise = pending;
    return pending;
  }

  private async invoke(method: string, args: unknown[] = []): Promise<unknown> {
    if (this.stopping) throw new Error("The development server is stopping.");
    const allowed = ["auth:getAccessCode", "auth:getPendingRequests", "remoteAccess:getStatus", "remoteAccess:update", "tunnel:getStatus"];
    if (!allowed.includes(method)) throw new Error("Unsupported development control method.");
    if (this.runtime.getState().ownership !== "owned") throw new Error("The development runtime is not owned by this launcher.");
    return this.runtime.invoke(method, args);
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= (async () => {
      // Cancel a queued start immediately, including while Rollup is still rebuilding.
      const shutdown = this.runtime.shutdown();
      void shutdown.catch(() => {});
      await this.initialization?.catch(() => {});
      const errors: unknown[] = [];
      const settle = async (operations: Array<Promise<unknown>>) => {
        for (const result of await Promise.allSettled(operations)) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      };
      await settle([
        shutdown,
        Promise.resolve().then(() => this.watcher?.close()),
        Promise.resolve().then(() => this.reloadPromise),
        Promise.resolve().then(() => this.web?.close()),
      ]);
      await settle([Promise.resolve().then(() => this.control?.close())]);
      if (this.lease) {
        await settle(["dev.pid", "local-url", "tunnel-url"].map(name => fs.rm(path.join(this.options.stateDir, name), { force: true })));
        await settle([this.lease.release()]);
      }
      if (errors.length) throw errors[0];
    })().catch(error => {
      this.options.onShutdownError?.(error);
      throw error;
    });
    return this.closePromise;
  }
}
