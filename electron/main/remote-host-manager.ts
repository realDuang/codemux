import { BrowserWindow, shell } from "electron";
import { createHash } from "node:crypto";
import { getDirectHostUrl, type RemoteHostInput, type RemoteHostState, type SavedRemoteHost } from "../../shared/remote-hosts";
import { RemoteHostStore } from "./services/remote-host-store";
import { SshConnection } from "./services/ssh-connection";

interface ActiveHost {
  host: SavedRemoteHost;
  window?: BrowserWindow;
  ssh?: SshConnection;
  pending?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  retries: number;
  cancelled: boolean;
}

/** An edited destination must never receive a previous host's browser credentials. */
export function remoteHostPartition(host: SavedRemoteHost): string {
  const identity = createHash("sha256").update(JSON.stringify(host.connection)).digest("hex").slice(0, 20);
  return `persist:remote-host-${host.id}-${identity}`;
}

export function isRemoteHostNavigationAllowed(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

/** Remote pages use the Web API, with no access to the local desktop preload. */
export function remoteHostWindowOptions(host: SavedRemoteHost): Electron.BrowserWindowConstructorOptions {
  return {
    title: `${host.name} — CodeMux`, width: 1280, height: 800, minWidth: 720, minHeight: 540,
    show: false, autoHideMenuBar: true,
    webPreferences: {
      partition: remoteHostPartition(host), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true,
    },
  };
}

export class RemoteHostManager {
  private active = new Map<string, ActiveHost>();
  private states = new Map<string, Pick<RemoteHostState, "status" | "error">>();
  private closing = false;

  constructor(private store: RemoteHostStore, private onChange: (hosts: RemoteHostState[]) => void) {}

  list(): RemoteHostState[] {
    return this.store.list().map(host => ({ ...host, ...this.states.get(host.id), status: this.states.get(host.id)?.status ?? "disconnected" }));
  }

  async save(input: RemoteHostInput, id?: string): Promise<SavedRemoteHost> {
    if (this.closing) throw new Error("CodeMux is shutting down");
    if (id) await this.disconnect(id);
    const host = this.store.save(input, id);
    this.publish(host.id, "disconnected");
    return host;
  }

  connect(id: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error("CodeMux is shutting down"));
    const current = this.active.get(id);
    if (current && !current.cancelled) {
      if (current.pending) return current.pending;
      if (current.window && !current.window.isDestroyed()) {
        current.window.show();
        current.window.focus();
        if (!current.retry) return Promise.resolve();
        clearTimeout(current.retry);
        current.retry = undefined;
        return this.reconnect(current);
      }
    }
    const host = this.store.get(id);
    if (!host) return Promise.reject(new Error("Host not found"));
    const entry: ActiveHost = { host, retries: 0, cancelled: false };
    this.active.set(id, entry);
    const pending = this.open(entry);
    entry.pending = pending;
    void pending.finally(() => { if (entry.pending === pending) entry.pending = undefined; }).catch(() => {});
    return pending;
  }

  private isCurrent(entry: ActiveHost): boolean {
    return !entry.cancelled && !this.closing && this.active.get(entry.host.id) === entry;
  }

  private async startSsh(entry: ActiveHost): Promise<string> {
    if (!this.isCurrent(entry)) throw new Error("Connection cancelled");
    const connection = entry.host.connection;
    if (connection.type !== "ssh") throw new Error("SSH connection required");
    const ssh = new SshConnection({
      address: connection.address, remotePort: connection.remotePort, preferredLocalPort: entry.host.localPort,
      onClose: error => {
        if (!this.isCurrent(entry) || entry.ssh !== ssh || !entry.window) return;
        this.publish(entry.host.id, "error", error || "SSH connection closed");
        this.scheduleReconnect(entry);
      },
    });
    entry.ssh = ssh;
    const result = await ssh.start();
    if (!this.isCurrent(entry)) {
      await ssh.stop();
      throw new Error("Connection cancelled");
    }
    entry.host = this.store.setLocalPort(entry.host.id, result.localPort);
    return result.url;
  }

  private async open(entry: ActiveHost): Promise<void> {
    this.publish(entry.host.id, "connecting");
    try {
      const origin = entry.host.connection.type === "direct"
        ? getDirectHostUrl(entry.host.connection)
        : await this.startSsh(entry);
      if (!this.isCurrent(entry)) throw new Error("Connection cancelled");
      const win = new BrowserWindow(remoteHostWindowOptions(entry.host));
      entry.window = win;
      const allowedOrigin = new URL(origin).origin;
      const openExternal = (url: string) => {
        try {
          if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {});
        } catch { /* Ignore malformed links from remote content. */ }
      };
      win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
      win.webContents.on("will-navigate", (event, url) => {
        if (!isRemoteHostNavigationAllowed(url, allowedOrigin)) { event.preventDefault(); openExternal(url); }
      });
      win.webContents.on("will-redirect", (event, url) => {
        if (!isRemoteHostNavigationAllowed(url, allowedOrigin)) event.preventDefault();
      });
      win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      win.on("closed", () => {
        if (this.isCurrent(entry)) void this.disconnect(entry.host.id);
      });
      // Probe through this Chromium session so system proxy and TLS behavior match navigation.
      const response = await win.webContents.session.fetch(new URL("/api/remote-access/status", origin).href, {
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      const result: unknown = response.ok ? await response.json() : null;
      if (!result || typeof result !== "object" || !("mode" in result) || !["off", "custom", "cloudflare"].includes(String(result.mode))) {
        throw new Error("The address did not respond as a CodeMux server");
      }
      if (entry.host.connection.type === "direct" && result.mode === "off" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
        throw new Error("Enable direct access on the remote CodeMux host first");
      }
      if (!this.isCurrent(entry)) throw new Error("Connection cancelled");
      let httpFailure = false;
      win.webContents.on("did-navigate", (_event, _url, code) => {
        if (code >= 400) httpFailure = true;
      });
      await win.loadURL(new URL("/?connect=1", origin).href);
      if (httpFailure) throw new Error("The CodeMux host rejected this address. Check its direct access settings.");
      if (!this.isCurrent(entry)) throw new Error("Connection cancelled");
      this.publish(entry.host.id, "connected");
      win.show();
    } catch (error) {
      const current = this.isCurrent(entry);
      await this.release(entry);
      if (current && !this.active.has(entry.host.id) && !this.closing) {
        this.publish(entry.host.id, "error", error instanceof Error ? error.message : "Connection failed");
      }
      throw error;
    }
  }

  private scheduleReconnect(entry: ActiveHost): void {
    if (!this.isCurrent(entry) || entry.retry) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.retries++, 5));
    entry.retry = setTimeout(() => {
      entry.retry = undefined;
      void this.reconnect(entry).catch(() => {});
    }, delay);
  }

  private async reconnect(entry: ActiveHost): Promise<void> {
    if (!this.isCurrent(entry)) return;
    this.publish(entry.host.id, "connecting");
    try {
      const previous = entry.ssh;
      await previous?.stop();
      if (!this.isCurrent(entry)) return;
      entry.ssh = undefined;
      await this.startSsh(entry);
      if (this.isCurrent(entry)) {
        entry.retries = 0;
        this.publish(entry.host.id, "connected");
      }
    } catch (error) {
      if (this.isCurrent(entry)) {
        this.publish(entry.host.id, "error", error instanceof Error ? error.message : "SSH reconnect failed");
        this.scheduleReconnect(entry);
      }
      throw error;
    }
  }

  private async release(entry: ActiveHost): Promise<void> {
    entry.cancelled = true;
    if (entry.retry) clearTimeout(entry.retry);
    if (this.active.get(entry.host.id) === entry) this.active.delete(entry.host.id);
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
    await entry.ssh?.stop();
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (entry) await this.release(entry);
    this.publish(id, "disconnected");
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.store.remove(id);
    this.states.delete(id);
    this.onChange(this.list());
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.active.values()].map(async entry => {
      await this.release(entry);
      this.publish(entry.host.id, "disconnected");
    }));
  }

  /** An installer failure can return control to the still-running desktop. */
  resume(): void { this.closing = false; }

  private publish(id: string, status: RemoteHostState["status"], error?: string): void {
    this.states.set(id, { status, ...(error ? { error } : {}) });
    this.onChange(this.list());
  }
}
