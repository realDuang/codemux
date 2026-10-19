import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { normalizeRemoteHostInput, parseSshAddress } from "../../../shared/remote-hosts";
import { terminateOwnedProcessTree } from "../../../shared/terminate-owned-children";

export interface SshConnectionOptions {
  address: string;
  remotePort: number;
  preferredLocalPort?: number;
  startupTimeoutMs?: number;
  onClose?: (error?: string) => void;
}

export interface SshConnectionEndpoint {
  url: string;
  localPort: number;
}

interface OwnedSshProcess {
  child: ChildProcess;
  groupPid: number | null;
  exited: boolean;
  failed: boolean;
  error: string;
  stderr: string;
  closed: Promise<void>;
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function sshError(stderr: string, fallback: string): string {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(stderr)) {
    return "SSH host key verification failed. Verify this host with SSH in your terminal first.";
  }
  if (/permission denied|no supported authentication methods|sign_and_send_pubkey|Load key|no mutual signature/i.test(stderr)) {
    return "SSH authentication failed. Configure an SSH key or agent for this host, then reconnect.";
  }
  if (/address already in use|cannot listen to port|could not request local forwarding/i.test(stderr)) {
    return "The saved local SSH port is already in use. Release that port and reconnect.";
  }
  if (/could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) {
    return "The SSH host could not be resolved. Check the address or SSH config alias.";
  }
  if (/connection refused/i.test(stderr)) return "The SSH server refused the connection. Check its address and port.";
  if (/connection timed out|operation timed out|no route to host|network is unreachable/i.test(stderr)) {
    return "The SSH host could not be reached. Check your network and host address.";
  }
  return fallback;
}

async function reservePort(preferred?: number): Promise<number> {
  const bind = (port: number) => new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local SSH port."));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  try { return await bind(preferred ?? 0); }
  catch (error) {
    if (preferred !== undefined && ["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error("The saved local SSH port is unavailable. Release that port and reconnect.", { cause: error });
    }
    throw new Error("Could not allocate a local SSH port.", { cause: error });
  }
}

function isListening(port: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    if (signal.aborted) abort();
  });
}

/** Owns one foreground OpenSSH process and its loopback-only forwarding socket. */
export class SshConnection {
  private readonly options: SshConnectionOptions;
  private process: OwnedSshProcess | null = null;
  private endpoint: SshConnectionEndpoint | null = null;
  private starting: Promise<SshConnectionEndpoint> | null = null;
  private stopping: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private intentionallyClosing = false;

  constructor(options: SshConnectionOptions) {
    normalizeRemoteHostInput({ connection: { type: "ssh", address: options.address, remotePort: options.remotePort } });
    if (options.preferredLocalPort !== undefined && (!Number.isInteger(options.preferredLocalPort) || options.preferredLocalPort < 1 || options.preferredLocalPort > 65_535)) {
      throw new Error("Local port must be between 1 and 65535.");
    }
    if (options.startupTimeoutMs !== undefined && (!Number.isFinite(options.startupTimeoutMs) || options.startupTimeoutMs <= 0)) {
      throw new Error("SSH startup timeout must be positive.");
    }
    this.options = { ...options };
  }

  start(): Promise<SshConnectionEndpoint> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.process && !this.process.exited) {
      if (this.endpoint && !this.intentionallyClosing) return Promise.resolve({ ...this.endpoint });
      return Promise.reject(new Error("The previous SSH process has not stopped. Close CodeMux before reconnecting."));
    }
    this.intentionallyClosing = false;
    const controller = new AbortController();
    this.controller = controller;
    const pending = this.launch(controller.signal).catch(async (error: unknown) => {
      await this.retireProcess();
      throw error;
    }).finally(() => {
      if (this.starting === pending) this.starting = null;
      if (this.controller === controller) this.controller = null;
    });
    this.starting = pending;
    return pending;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.intentionallyClosing = true;
    this.controller?.abort();
    const starting = this.starting;
    const pending = (async () => {
      try { await starting; } catch { /* A cancelled connection still needs process cleanup. */ }
      await this.retireProcess();
      this.endpoint = null;
    })().finally(() => { if (this.stopping === pending) this.stopping = null; });
    this.stopping = pending;
    return pending;
  }

  private async launch(signal: AbortSignal): Promise<SshConnectionEndpoint> {
    const address = parseSshAddress(this.options.address);
    const localPort = await reservePort(this.options.preferredLocalPort);
    this.options.preferredLocalPort = localPort;
    if (signal.aborted) throw new Error("SSH connection cancelled.");
    const timeoutMs = this.options.startupTimeoutMs ?? 20_000;
    const args = [
      "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      // The connection owns its SSH lifetime even when the user's config enables multiplexing.
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForkAfterAuthentication=no",
      "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${this.options.remotePort}`,
      ...(address.port === undefined ? [] : ["-p", String(address.port)]),
      "--", address.destination,
    ];
    let child: ChildProcess;
    try {
      child = spawn("ssh", args, {
        shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
      });
    } catch { throw new Error("OpenSSH could not be started. Install the SSH client and try again."); }
    let resolveClosed!: () => void;
    const record: OwnedSshProcess = {
      child, groupPid: process.platform !== "win32" && child.pid && child.pid > 1 && child.pid !== process.pid && child.pid !== process.ppid ? child.pid : null,
      exited: false, failed: false, error: "SSH connection closed.", stderr: "",
      closed: new Promise(resolve => { resolveClosed = resolve; }),
    };
    this.process = record;
    child.stderr?.on("data", (data: Buffer | string) => {
      // Never send SSH banners, key paths, or arbitrary command output to the renderer.
      record.stderr = (record.stderr + data.toString()).slice(-8192);
    });
    const closed = (fallback: string) => {
      if (record.exited) return;
      record.exited = true;
      record.error = sshError(record.stderr, fallback);
      this.signalProcess(record, "SIGKILL");
      resolveClosed();
      if (this.process === record && this.endpoint) {
        this.endpoint = null;
        if (!this.intentionallyClosing) {
          try { this.options.onClose?.(record.error); } catch { /* Listener errors cannot retain a dead SSH process. */ }
        }
      }
    };
    child.on("error", () => {
      if (record.exited || record.failed) return;
      const error = "OpenSSH could not be started. Install the SSH client and try again.";
      if (!child.pid) closed(error);
      else {
        record.failed = true;
        record.error = error;
        this.signalProcess(record, "SIGTERM");
      }
    });
    child.once("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      closed(exitSignal ? "SSH connection was interrupted." : `SSH connection closed${code === null ? "" : ` (exit code ${code})`}.`);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("SSH connection cancelled.");
      if (record.exited || record.failed) throw new Error(record.error);
      if (await isListening(localPort, signal)) {
        // Allow an ExitOnForwardFailure from a raced port claim to arrive before publishing readiness.
        await delay(50);
        if (signal.aborted) throw new Error("SSH connection cancelled.");
        if (record.exited || record.failed) throw new Error(record.error);
        this.endpoint = { url: `http://127.0.0.1:${localPort}`, localPort };
        return { ...this.endpoint };
      }
      await Promise.race([delay(100), record.closed]);
    }
    throw new Error("SSH connection timed out. Check the host, SSH credentials, and network.");
  }

  private signalProcess(record: OwnedSshProcess, signal: NodeJS.Signals): void {
    if (record.groupPid !== null) {
      try { process.kill(-record.groupPid, signal); } catch { /* The owned process group may already have exited. */ }
      if (signal === "SIGKILL") record.groupPid = null;
    }
    if (!record.exited) {
      if (process.platform === "win32" && record.child.pid) terminateOwnedProcessTree(record.child.pid);
      try { record.child.kill(signal); } catch { /* The child may have exited between checks. */ }
    }
  }

  private async retireProcess(): Promise<void> {
    const record = this.process;
    if (!record) return;
    if (!record.exited) {
      this.signalProcess(record, "SIGTERM");
      await Promise.race([record.closed, delay(1000)]);
      if (!record.exited) {
        this.signalProcess(record, "SIGKILL");
        await Promise.race([record.closed, delay(1000)]);
      }
    }
    if (!record.exited) throw new Error("The SSH process did not stop. Close CodeMux before reconnecting.");
    if (this.process === record) this.process = null;
    this.endpoint = null;
  }
}
