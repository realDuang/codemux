import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { check } from "proper-lockfile";
import { callHost, readHostControlMetadata } from "../../shared/host-control-client";
import { HostControlError, type HostControlMetadata, type HostRuntimeStatus } from "../../shared/host-control-types";
import type { LocalServerState } from "../../shared/local-server-types";
import { terminateOwnedProcessTree } from "../../shared/terminate-owned-children";

export interface LocalServerSupervisorOptions {
  dataPath: string;
  cwd: string;
  entryPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  beforeStart?: () => Promise<void>;
  onNotification?: (notification: { title: string; body: string }) => void;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface OwnedChild {
  process: ChildProcess;
  processGroupPid: number | null;
  exited: boolean;
  exitDescription: string;
}

class StartCancelled extends Error {}

const EXTERNAL_RESTART_ERROR = "Restart this server using its original launcher; this desktop app does not own its launch configuration";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new StartCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new StartCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Owns only its forked host; an existing local host remains independently managed. */
export class LocalServerSupervisor {
  private state: LocalServerState = { phase: "stopped", ownership: null, pid: null, error: null };
  private readonly listeners = new Set<(state: LocalServerState) => void>();
  private owner: HostControlMetadata | null = null;
  private child: OwnedChild | null = null;
  private startPromise: Promise<LocalServerState> | null = null;
  private stopPromise: Promise<LocalServerState> | null = null;
  private launchEpoch = 0;
  private preparation: Promise<void> | null = null;
  private startController: AbortController | null = null;
  private monitor: ReturnType<typeof setTimeout> | null = null;
  private readonly pollMs: number;
  private readonly startupMs: number;
  private readonly stopMs: number;

  constructor(private readonly options: LocalServerSupervisorOptions) {
    this.pollMs = options.pollIntervalMs ?? 200;
    this.startupMs = options.startupTimeoutMs ?? 120_000;
    this.stopMs = options.stopTimeoutMs ?? 30_000;
  }

  getState(): LocalServerState { return { ...this.state }; }

  subscribe(listener: (state: LocalServerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<LocalServerState> {
    if (this.stopPromise) {
      const epoch = this.launchEpoch;
      return this.stopPromise.then(() => epoch === this.launchEpoch ? this.start() : this.getState());
    }
    if (this.startPromise) return this.startPromise;
    if (this.state.phase === "ready") return Promise.resolve(this.getState());
    this.clearMonitor();
    const controller = new AbortController();
    this.startController = controller;
    this.setState({ phase: "starting", error: null });
    const pending = this.startHost(controller.signal).catch(async (error: unknown) => {
      if (error instanceof StartCancelled) return this.getState();
      if (this.child && !this.child.exited) {
        try { await this.stopHost(true); } catch { /* Keep the original startup failure. */ }
      }
      this.setState({ phase: "error", error: error instanceof Error ? error.message : "Local server failed to start" });
      throw error;
    }).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
      if (this.startController === controller) this.startController = null;
    });
    this.startPromise = pending;
    return pending;
  }

  stop(): Promise<LocalServerState> { return this.requestStop(false); }

  async restart(): Promise<LocalServerState> {
    if (this.state.ownership === "external") throw new Error(EXTERNAL_RESTART_ERROR);
    const stopping = this.requestStop(false, false);
    const epoch = this.launchEpoch;
    await stopping;
    return epoch === this.launchEpoch ? this.start() : this.getState();
  }

  async invoke<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    if (!this.owner || this.state.phase !== "ready") throw new Error("Local server is not ready");
    if (method === "host:stop") throw new Error("Use the local server stop operation");
    return callHost<T>(this.options.dataPath, method, args, { expectedInstanceId: this.owner.instanceId });
  }

  async shutdown(): Promise<void> { await this.requestStop(true); }

  private setState(change: Partial<LocalServerState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      try { listener(this.getState()); } catch { /* A renderer listener cannot interrupt host cleanup. */ }
    }
  }

  private clearMonitor(): void {
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = null;
  }

  private delay(signal?: AbortSignal): Promise<void> {
    const promise = new Promise<void>(resolve => setTimeout(resolve, this.pollMs));
    return signal ? cancellable(promise, signal) : promise;
  }

  private async locked(): Promise<boolean> {
    try { return await check(this.options.dataPath, { stale: 30_000 }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async status(metadata: HostControlMetadata): Promise<HostRuntimeStatus> {
    const status = await callHost<HostRuntimeStatus>(this.options.dataPath, "host:status", [], {
      timeoutMs: Math.min(1_000, this.startupMs), expectedInstanceId: metadata.instanceId,
    });
    if (!status || status.pid !== metadata.pid || status.dataPath !== metadata.dataPath
      || !["starting", "ready", "stopping"].includes(status.phase)
      || typeof status.ready !== "boolean"
      || [status.desktopParentPid, status.developmentParentPid].some(pid => pid !== undefined
        && (!Number.isSafeInteger(pid) || pid < 1))) {
      throw new Error("Local server returned an invalid owner status");
    }
    return status;
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    // A cancelled start may leave a settings flush in progress; the next start joins it.
    if (!this.preparation) {
      const pending = Promise.resolve().then(() => this.options.beforeStart?.()).finally(() => {
        if (this.preparation === pending) this.preparation = null;
      });
      this.preparation = pending;
    }
    await cancellable(this.preparation, signal);
  }

  private async startHost(signal: AbortSignal): Promise<LocalServerState> {
    const deadline = Date.now() + this.startupMs;
    let prepared = false;
    let spawned = false;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new StartCancelled();
      const metadata = await cancellable(readHostControlMetadata(this.options.dataPath), signal);
      if (metadata) {
        let status: HostRuntimeStatus | null = null;
        try { status = await cancellable(this.status(metadata), signal); }
        catch (error) {
          if (error instanceof StartCancelled) throw error;
          if (!(error instanceof HostControlError)
            || !["UNAVAILABLE", "NOT_RUNNING", "INSTANCE_CHANGED"].includes(error.code)) throw error;
        }
        if (status) {
          if (this.child && metadata.pid !== this.child.process.pid) {
            // Another host can win the directory lock between discovery and fork.
            // Retire our losing child before attaching to that independent owner.
            await this.retireChild(this.child);
            this.child = null;
            continue;
          }
          // Reloads can discover a child whose desktop or development parent just died.
          const orphaned = [status.desktopParentPid, status.developmentParentPid].some(pid => pid !== undefined && !isAlive(pid));
          const exitedChild = this.child?.exited && metadata.pid === this.child.process.pid;
          if (!orphaned && !exitedChild) {
            this.owner = metadata;
            const owned = !this.child?.exited && metadata.pid === this.child?.process.pid;
            this.setState({ ownership: owned ? "owned" : "external", pid: metadata.pid });
            if (status.phase === "ready" && status.ready) {
              this.setState({ phase: "ready", error: null });
              this.scheduleMonitor();
              return this.getState();
            }
          }
          await this.delay(signal);
          continue;
        }
        if (isAlive(metadata.pid)) { await this.delay(signal); continue; }
      }
      // Missing/unavailable discovery is not proof that a data directory has no writer.
      if (await cancellable(this.locked(), signal)) { await this.delay(signal); continue; }
      if (this.child && !this.child.exited) { await this.delay(signal); continue; }
      if (spawned) throw new Error(this.child?.exitDescription ?? "Local server exited before becoming ready");
      if (!prepared) {
        await this.prepare(signal);
        prepared = true;
        continue; // Recheck ownership after asynchronous settings persistence.
      }
      if (signal.aborted) throw new StartCancelled();
      this.forkHost();
      spawned = true;
      await this.delay(signal);
    }
    throw new Error("Timed out waiting for the local server to become ready; its data directory may still be in use");
  }

  private forkHost(): void {
    const forkOptions: ForkOptions & { windowsHide: boolean } = {
      cwd: this.options.cwd, env: { ...this.options.env }, execPath: this.options.execPath,
      execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true,
      detached: process.platform !== "win32",
    };
    const child = fork(this.options.entryPath, [], forkOptions);
    const record: OwnedChild = {
      process: child,
      // Only a successful detached POSIX fork creates a group owned by this supervisor.
      processGroupPid: forkOptions.detached && child.pid && child.pid > 1
        && child.pid !== process.pid && child.pid !== process.ppid ? child.pid : null,
      exited: false,
      exitDescription: "Local server exited before becoming ready",
    };
    this.child = record;
    this.owner = null;
    this.setState({ ownership: "owned", pid: child.pid ?? null });
    child.on("message", (message: unknown) => {
      if (this.child !== record || record.exited || !message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type === "codemux.notify" && typeof value.title === "string" && typeof value.body === "string") {
        try { this.options.onNotification?.({ title: value.title, body: value.body }); } catch { /* Desktop notification failures do not stop the host. */ }
      }
    });
    const exited = (description: string) => {
      record.exited = true;
      record.exitDescription = description;
      if (this.child === record && this.state.phase === "ready" && this.state.ownership === "owned") {
        this.clearMonitor();
        this.setState({ phase: "error", error: description });
      }
    };
    child.once("error", () => exited("Local server process could not be started"));
    child.once("exit", (code, signal) => {
      if (record.processGroupPid !== null) {
        try {
          // The leader may be gone while its SDK processes still own ports or files.
          // Never derive a group from discovered metadata or the desktop's own group.
          process.kill(-record.processGroupPid, "SIGKILL");
        } catch { /* An empty group is already clean; inaccessible groups remain untouched. */ }
        record.processGroupPid = null;
      }
      exited(`Local server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    });
  }

  private requestChildStop(child: OwnedChild): void {
    if (child.exited) return;
    if (process.platform === "win32") {
      // Windows SIGTERM kills the host immediately, before it can flush or
      // stop its SDK/PTY children. Parent IPC loss uses the host's normal stop
      // path and preserves ancestry for force-cleanup if the grace period expires.
      if (child.process.connected) {
        try { child.process.disconnect(); } catch { /* Retain ownership until exit or force-cleanup. */ }
      }
    } else child.process.kill("SIGTERM");
  }

  private async retireChild(child: OwnedChild): Promise<void> {
    this.requestChildStop(child);
    const deadline = Date.now() + this.stopMs;
    while (!child.exited && Date.now() < deadline) await this.delay();
    if (!child.exited && child.process.pid) {
      terminateOwnedProcessTree(child.process.pid);
      const exitDeadline = Date.now() + 2_000;
      while (!child.exited && Date.now() < exitDeadline) await this.delay();
    }
    if (!child.exited) throw new Error("Timed out stopping the owned local server process");
  }

  private requestStop(ownedOnly: boolean, allowExternalStop = true): Promise<LocalServerState> {
    // Even a joined stop cancels launches queued by an earlier start or restart.
    this.launchEpoch++;
    if (this.stopPromise) return this.stopPromise;
    this.clearMonitor();
    this.startController?.abort();
    const starting = this.startPromise;
    this.setState({ phase: "stopping", error: null });
    const pending = (async () => {
      try { await starting; } catch { /* Startup errors must not prevent a requested stop. */ }
      return this.stopHost(ownedOnly, allowExternalStop);
    })().catch((error: unknown) => {
      this.setState({ phase: "error", error: error instanceof Error ? error.message : "Local server failed to stop" });
      throw error;
    }).finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    this.stopPromise = pending;
    return pending;
  }

  private async stopHost(ownedOnly: boolean, allowExternalStop = true): Promise<LocalServerState> {
    const child = this.child;
    const owner = this.owner;
    const owned = !!child && (!owner || owner.pid === child.process.pid);
    // Startup may discover an external owner while a restart is cancelling it.
    if (!allowExternalStop && owner && !owned) throw new Error(EXTERNAL_RESTART_ERROR);
    if (!owned && (ownedOnly || !owner)) {
      this.owner = null;
      this.setState({ phase: "stopped", ownership: null, pid: null, error: null });
      return this.getState();
    }
    if (owner && (!owned || !child.exited) && (!ownedOnly || owner.pid === child?.process.pid)) {
      try {
        await callHost(this.options.dataPath, "host:stop", [], {
          timeoutMs: Math.min(1_000, this.stopMs), expectedInstanceId: owner.instanceId,
        });
      } catch (error) {
        if (!owned) {
          if (!(error instanceof HostControlError) || !["NOT_RUNNING", "UNAVAILABLE"].includes(error.code)) throw error;
          const current = await readHostControlMetadata(this.options.dataPath);
          if ((current && (current.instanceId !== owner.instanceId || isAlive(current.pid))) || await this.locked()) throw error;
        } else {
          // An owned child may not have published its control listener yet.
          this.requestChildStop(child);
        }
      }
    } else if (owned) this.requestChildStop(child);
    const deadline = Date.now() + this.stopMs;
    while (true) {
      const metadata = await readHostControlMetadata(this.options.dataPath);
      if (metadata && ((owner && metadata.instanceId !== owner.instanceId)
        || (owned && !owner && metadata.pid !== child.process.pid))) {
        if (owned) await this.retireChild(child);
        if (ownedOnly) {
          this.child = null;
          this.owner = null;
          this.setState({ phase: "stopped", ownership: null, pid: null, error: null });
          return this.getState();
        }
        throw new Error("The local server owner changed while stopping; the replacement was left running");
      }
      const processRunning = owned ? !child.exited : !!metadata && isAlive(metadata.pid);
      if (!processRunning && !(await this.locked())) break;
      if (Date.now() >= deadline) {
        if (owned && !child.exited && child.process.pid) {
          terminateOwnedProcessTree(child.process.pid);
          // Exit is asynchronous even after a successful force-kill.
          const exitDeadline = Date.now() + 2_000;
          while (!child.exited && Date.now() < exitDeadline) await this.delay();
        }
        if ((owned && !child.exited) || await this.locked()) {
          throw new Error("Timed out stopping the local server; its data directory remains in use");
        }
        if (!owned) throw new Error("Timed out stopping the external local server; it was not force-killed");
        break;
      }
      await this.delay();
    }
    this.owner = null;
    if (this.child === child) this.child = null;
    this.setState({ phase: "stopped", ownership: null, pid: null, error: null });
    return this.getState();
  }

  private scheduleMonitor(): void {
    this.clearMonitor();
    const owner = this.owner;
    if (!owner) return;
    this.monitor = setTimeout(() => {
      this.monitor = null;
      void this.status(owner).then(status => {
        if (this.owner !== owner || this.state.phase !== "ready") return;
        if (!status.ready || status.phase !== "ready") {
          this.setState({ phase: "error", error: "Local server is no longer ready" });
        } else this.scheduleMonitor();
      }).catch(() => {
        if (this.owner === owner && this.state.phase === "ready") {
          this.setState({ phase: "error", error: "Local server is no longer available" });
        }
      });
    }, Math.max(2_000, this.pollMs));
    this.monitor.unref();
  }
}
