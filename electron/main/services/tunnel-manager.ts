import { spawn, ChildProcess } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { tunnelLog } from "./logger";

export interface TunnelConfig {
  /** Named tunnel name (from `cloudflared tunnel create <name>`) */
  tunnelName?: string;
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

  async start(port: number, config?: TunnelConfig): Promise<TunnelInfo> {
    if (this.process) {
      return this.info;
    }

    const isNamed = !!(config?.tunnelName && config?.hostname);
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
        ? ["tunnel", "run", "--url", `http://localhost:${port}`, config!.tunnelName!]
        : ["tunnel", "--url", `http://localhost:${port}`];

      this.process = spawn(cloudflaredPath, args);

      // For named tunnels, URL is known in advance
      if (isNamed) {
        const hostname = config!.hostname!;
        this.info = {
          url: hostname.startsWith("https://") ? hostname : `https://${hostname}`,
          status: "running",
          startTime: this.info.startTime,
        };
        tunnelLog.info(`Named tunnel started: ${this.info.url}`);
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
        }

        // Detect named tunnel connection established
        if (isNamed && output.includes("Registered tunnel connection")) {
          tunnelLog.info("Named tunnel connection confirmed");
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