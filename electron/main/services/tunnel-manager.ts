import { spawn, ChildProcess } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { tunnelLog } from "./logger";

export interface TunnelConfig {
  /** Custom hostname for named tunnel (e.g. "codemux.example.com") */
  hostname?: string;
}

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

class TunnelManager {
  private process: ChildProcess | null = null;
  private info: TunnelInfo = {
    url: "",
    status: "stopped",
  };
  private stoppedByUser = false;
  private onUnexpectedExit: (() => void) | null = null;

  /** Register a callback for when cloudflared exits unexpectedly (not via stop()). */
  setOnUnexpectedExit(cb: () => void): void {
    this.onUnexpectedExit = cb;
  }

  private getCloudflaredPath(): string {
    if (!app.isPackaged) {
      return "cloudflared"; // Use system-installed cloudflared in dev mode
    }
    const resourcesPath = process.resourcesPath;
    const platform = process.platform;
    const arch = process.arch;

    const binaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
    return path.join(resourcesPath, "cloudflared", `${platform}-${arch}`, binaryName);
  }

  /**
   * Auto-detect tunnel UUID from cloudflared credential files.
   * Scans ~/.cloudflared/ for UUID.json files. Uses most recent if multiple.
   */
  private detectTunnelId(): string | null {
    const cloudflaredDir = path.join(os.homedir(), ".cloudflared");
    if (!fs.existsSync(cloudflaredDir)) return null;

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
    const credFiles = fs.readdirSync(cloudflaredDir).filter((f) => uuidPattern.test(f));

    if (credFiles.length === 0) return null;
    if (credFiles.length === 1) return credFiles[0].replace(".json", "");

    // Multiple tunnels — pick most recently created
    const withStats = credFiles.map((f) => ({
      uuid: f.replace(".json", ""),
      mtime: fs.statSync(path.join(cloudflaredDir, f)).mtime.getTime(),
    }));
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0].uuid;
  }

  async start(port: number, config?: TunnelConfig): Promise<TunnelInfo> {
    if (this.process) {
      return this.info;
    }

    const hostname = config?.hostname?.trim();
    let tunnelId: string | null = null;
    if (hostname) {
      tunnelId = this.detectTunnelId();
      if (!tunnelId) {
        tunnelLog.warn("Named tunnel hostname configured but no tunnel credentials found in ~/.cloudflared/");
      }
    }
    const isNamed = !!(hostname && tunnelId);

    this.stoppedByUser = false;
    this.info = {
      url: "",
      status: "starting",
      startTime: Date.now(),
    };

    try {
      const cloudflaredPath = this.getCloudflaredPath();

      // Check if binary exists before spawning
      if (app.isPackaged && !fs.existsSync(cloudflaredPath)) {
        throw new Error(`Cloudflared binary not found at ${cloudflaredPath}`);
      }

      const args = isNamed
        ? ["tunnel", "run", "--url", `http://localhost:${port}`, tunnelId!]
        : ["tunnel", "--url", `http://localhost:${port}`];

      this.process = spawn(cloudflaredPath, args);

      // For named tunnels, URL is known in advance but keep "starting" until
      // cloudflared confirms it's connected (observed via stdout/stderr output)
      if (isNamed) {
        this.info = {
          url: hostname!.startsWith("https://") ? hostname! : `https://${hostname}`,
          status: "starting",
          startTime: this.info.startTime,
        };
        tunnelLog.info(`Named tunnel starting (${tunnelId}): ${this.info.url}`);
      }

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        tunnelLog.info(output);

        // For quick tunnels, parse URL from stdout
        if (!isNamed) {
          const urlMatch = output.match(/https?:\/\/[\S]+\.trycloudflare\.com/);
          if (urlMatch) {
            this.info = {
              url: urlMatch[0],
              status: "running",
              startTime: this.info.startTime,
            };
            tunnelLog.info("URL Ready:", this.info.url);
          }
        } else if (this.info.status === "starting") {
          // Named tunnel: detect readiness from cloudflared output
          if (output.includes("Registered tunnel connection") || output.includes("Connection registered")) {
            this.info = { ...this.info, status: "running" };
            tunnelLog.info("Named tunnel ready:", this.info.url);
          }
        }
      };

      this.process.stdout?.on("data", handleOutput);
      this.process.stderr?.on("data", handleOutput);

      this.process.on("close", () => {
        const wasRunning = this.info.status === "running" || this.info.status === "starting";
        this.info = { url: "", status: "stopped" };
        this.process = null;

        if (wasRunning && !this.stoppedByUser) {
          tunnelLog.warn("cloudflared exited unexpectedly");
          this.onUnexpectedExit?.();
        }
      });

      this.process.on("error", (err) => {
        tunnelLog.error("Process error:", err);
        this.info = { url: "", status: "error", error: err.message };
        this.process = null;
      });

      return this.info;
    } catch (err: any) {
      this.info = { url: "", status: "error", error: err.message };
      return this.info;
    }
  }

  async stop(): Promise<void> {
    this.stoppedByUser = true;
    const proc = this.process;
    this.info = { url: "", status: "stopped" };

    if (!proc) {
      return;
    }

    this.process = null;

    // Send SIGTERM for graceful shutdown
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
      return;
    }

    // Wait for process to exit with timeout
    await Promise.race([
      new Promise<void>((resolve) => {
        proc.once("close", resolve);
        proc.once("error", resolve);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  getInfo(): TunnelInfo {
    return this.info;
  }
}

export const tunnelManager = new TunnelManager();