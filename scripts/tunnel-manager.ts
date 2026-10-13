import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { resolveServerStateDir } from "./state-dir";
import { normalizeAccessUrl } from "../shared/access-url";

export interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
  errorCode?: string;
}

export interface TunnelConfig {
  hostname?: string;
}

interface ExternalTunnelState {
  pid: number;
  info: TunnelInfo;
}

export class TunnelManager {
  private process: ChildProcess | null = null;
  private info: TunnelInfo = {
    url: "",
    status: "stopped",
  };
  private loggedStateDir = false;
  private onUnexpectedExit: (() => void) | null = null;

  setOnUnexpectedExit(callback: () => void): void {
    this.onUnexpectedExit = callback;
  }

  private getStateDir(): string {
    const envOverride = process.env.CODEMUX_SERVER_STATE_DIR;
    if (envOverride && envOverride.length > 0) {
      this.logStateDirOnce(envOverride, "CODEMUX_SERVER_STATE_DIR");
      return envOverride;
    }

    const isolated = process.env.CODEMUX_DEV_ISOLATED === "1";
    const dir = resolveServerStateDir({ repoDir: process.cwd(), isolated });
    this.logStateDirOnce(dir, isolated ? "isolated <cwd>/.codemux-dev/server" : "global <XDG_STATE_HOME>/codemux-server");
    return dir;
  }

  private logStateDirOnce(dir: string, source: string): void {
    if (this.loggedStateDir) return;
    this.loggedStateDir = true;
    console.log(`[Tunnel] External tunnel state dir resolved to ${dir} (via ${source})`);
  }

  private getExternalTunnelPidFile(): string {
    return path.join(this.getStateDir(), "tunnel.pid");
  }

  private getExternalTunnelUrlFile(): string {
    return path.join(this.getStateDir(), "tunnel-url");
  }

  private readTrimmedFile(filePath: string): string {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8").trim();
  }

  private clearExternalTunnelState(): void {
    for (const filePath of [this.getExternalTunnelPidFile(), this.getExternalTunnelUrlFile()]) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore best-effort cleanup errors
      }
    }
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killExternalTunnel(pid: number): void {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the single process when there is no separate process group.
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }

  private readExternalTunnelState(): ExternalTunnelState | null {
    const pidFile = this.getExternalTunnelPidFile();
    const rawPid = this.readTrimmedFile(pidFile);
    const url = this.readTrimmedFile(this.getExternalTunnelUrlFile());

    if (!rawPid) {
      if (url) {
        this.clearExternalTunnelState();
      }
      return null;
    }

    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isInteger(pid) || pid <= 0 || !this.isPidRunning(pid)) {
      this.clearExternalTunnelState();
      return null;
    }

    const startTime = fs.existsSync(pidFile) ? fs.statSync(pidFile).mtimeMs : undefined;

    return {
      pid,
      info: {
        url,
        status: url ? "running" : "starting",
        startTime,
      },
    };
  }

  private namedTunnelConfig(hostname: string, port: number): { path: string; url: string } {
    const url = normalizeAccessUrl(/^https?:\/\//.test(hostname) ? hostname : `https://${hostname}`);
    const parsed = new URL(url);
    if (parsed.port) throw new Error("A Cloudflare hostname cannot include a port.");
    const credentialsDir = path.join(os.homedir(), ".cloudflared");
    const credentials = fs.existsSync(credentialsDir)
      ? fs.readdirSync(credentialsDir)
        .filter(file => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(file))
        .sort((a, b) => fs.statSync(path.join(credentialsDir, b)).mtimeMs - fs.statSync(path.join(credentialsDir, a)).mtimeMs)
      : [];
    if (!credentials[0]) throw new Error("Named Tunnel credentials not found in ~/.cloudflared.");
    const configPath = path.join(this.getStateDir(), "cloudflared-config.yml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      `tunnel: ${credentials[0].slice(0, -5)}`,
      `credentials-file: ${JSON.stringify(path.join(credentialsDir, credentials[0]))}`,
      "ingress:",
      `  - hostname: ${JSON.stringify(parsed.hostname)}`,
      `    service: http://localhost:${port}`,
      "  - service: http_status:404",
      "",
    ].join("\n"));
    return { path: configPath, url: `https://${parsed.hostname}` };
  }

  async start(port: number, config?: TunnelConfig): Promise<TunnelInfo> {
    if (this.process) {
      return this.info;
    }

    // Retire the exact legacy wrapper-owned process instead of adopting an
    // ingress whose lifecycle is outside the authoritative access controller.
    await this.stop();

    this.info = {
      url: "",
      status: "starting",
      startTime: Date.now(),
    };

    try {
      const named = config?.hostname?.trim() ? this.namedTunnelConfig(config.hostname.trim(), port) : null;
      const proc = spawn("cloudflared", named
        ? ["tunnel", "--config", named.path, "run"]
        : ["tunnel", "--url", `http://localhost:${port}`]);
      this.process = proc;
      if (named) this.info = { ...this.info, url: named.url };

      const handleOutput = (data: Buffer) => {
        if (this.process !== proc) return;
        const output = data.toString();
        console.log("[Tunnel]", output);

        const urlMatch = output.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
        if (!named && urlMatch) {
          this.info = {
            url: urlMatch[0],
            status: "running",
            startTime: this.info.startTime,
          };
          console.log("[Tunnel] ✅ URL Ready:", this.info.url);
        } else if (named && /Registered tunnel connection|Connection registered/.test(output)) {
          this.info = { ...this.info, status: "running" };
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("close", (code) => {
        if (this.process !== proc) return;
        console.log("[Tunnel] Process closed with code:", code);
        this.info = {
          url: "",
          status: "stopped",
        };
        this.process = null;
        this.onUnexpectedExit?.();
      });

      proc.on("error", (err) => {
        if (this.process !== proc) return;
        console.error("[Tunnel] Process error:", err);
        this.info = {
          url: "",
          status: "error",
          error: err.message,
        };
        this.process = null;
      });

      return this.info;
    } catch (error: unknown) {
      this.info = {
        url: "",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      return this.info;
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      this.info = {
        url: "",
        status: "stopped",
      };
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(hardTimeout);
          proc.off("close", finish);
          proc.off("error", handleError);
          resolve();
        };
        const fail = (error = new Error("Cloudflare tunnel did not stop.")) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(hardTimeout);
          proc.off("close", finish);
          proc.off("error", handleError);
          this.process = proc;
          this.info = { url: "", status: "error", error: error.message };
          reject(error);
        };
        const hasExited = () => proc.exitCode !== null && proc.exitCode !== undefined ||
          proc.signalCode !== null && proc.signalCode !== undefined;
        const handleError = (error: Error) => hasExited() ? finish() : fail(error);
        const signal = (value: "SIGTERM" | "SIGKILL") => {
          try {
            if (!proc.kill(value) && hasExited()) finish();
          } catch (error) {
            if (hasExited()) finish();
            else fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const timeout = setTimeout(() => {
          if (settled) return;
          signal("SIGKILL");
        }, 5000);
        const hardTimeout = setTimeout(() => fail(), 10_000);
        proc.once("close", finish);
        proc.once("error", handleError);
        if (hasExited()) finish();
        else signal("SIGTERM");
      });
    }

    const externalTunnel = this.readExternalTunnelState();
    if (externalTunnel) {
      this.killExternalTunnel(externalTunnel.pid);
      const deadline = Date.now() + 5000;
      while (this.isPidRunning(externalTunnel.pid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (this.isPidRunning(externalTunnel.pid)) {
        process.kill(externalTunnel.pid, "SIGKILL");
        const killDeadline = Date.now() + 5000;
        while (this.isPidRunning(externalTunnel.pid) && Date.now() < killDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (this.isPidRunning(externalTunnel.pid)) throw new Error("Legacy Cloudflare tunnel did not stop.");
      }
      this.clearExternalTunnelState();
    }

    this.info = {
      url: "",
      status: "stopped",
    };
  }

  getInfo(): TunnelInfo {
    if (this.process) {
      return this.info;
    }

    if (this.info.status === "error") {
      return this.info;
    }

    return {
      url: "",
      status: "stopped",
    };
  }
}

export const tunnelManager = new TunnelManager();
