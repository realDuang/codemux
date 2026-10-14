import { spawn, ChildProcess } from "child_process";
import { runtimeHost } from "#runtime-host";
import path from "path";
import fs from "fs";
import os from "os";
import { tunnelLog } from "./logger";
import { getCloudflaredConfigPath } from "./app-paths";
import { getCloudflaredPath } from "../../../shared/cloudflared-path";

export interface TunnelConfig {
  /** Custom hostname for named tunnel (e.g. "codemux.example.com") */
  hostname?: string;
}

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
  errorCode?: string;
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
    return getCloudflaredPath({
      isPackaged: runtimeHost.isPackaged,
      resourcesPath: runtimeHost.resourcesPath,
      platform: process.platform,
      arch: process.arch,
    });
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

  /**
   * Generate an isolated cloudflared config file in the app data directory.
   * This prevents conflicts with system-level cloudflared that may use
   * ~/.cloudflared/config.yml with different ingress rules.
   */
  private writeNamedTunnelConfig(tunnelId: string, hostname: string, port: number): string {
    const configPath = getCloudflaredConfigPath();
    const credentialsPath = path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);

    const bareHostname = hostname.replace(/^https?:\/\//, "");
    const yaml = [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${credentialsPath}`,
      `ingress:`,
      `  - hostname: ${bareHostname}`,
      `    service: http://localhost:${port}`,
      `  - service: http_status:404`,
    ].join("\n") + "\n";

    fs.writeFileSync(configPath, yaml, "utf-8");
    tunnelLog.info(`Generated cloudflared config at ${configPath}`);
    return configPath;
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
        const error = "Named Tunnel credentials not found. CodeMux needs a ~/.cloudflared/<tunnel-id>.json credential file to start this fixed custom domain. Run cloudflared tunnel login, cloudflared tunnel create <name>, and cloudflared tunnel route dns <name> <domain>; or clear the custom domain to use a temporary quick tunnel.";
        tunnelLog.error(error);
        this.info = {
          url: "",
          status: "error",
          error,
          errorCode: "NAMED_TUNNEL_NO_CREDENTIALS",
        };
        return this.info;
      }
    }
    const isNamed = !!hostname;

    this.stoppedByUser = false;
    this.info = {
      url: "",
      status: "starting",
      startTime: Date.now(),
    };

    try {
      const cloudflaredPath = this.getCloudflaredPath();

      // Check if binary exists before spawning
      if (runtimeHost.isPackaged && !fs.existsSync(cloudflaredPath)) {
        throw new Error(`Cloudflared binary not found at ${cloudflaredPath}`);
      }

      let args: string[];
      if (isNamed) {
        // Generate an isolated config file so CodeMux's cloudflared connector
        // doesn't conflict with any system-level cloudflared using the default
        // ~/.cloudflared/config.yml with different ingress rules.
        const configPath = this.writeNamedTunnelConfig(tunnelId!, hostname!, port);
        args = ["tunnel", "--config", configPath, "run"];
      } else {
        args = ["tunnel", "--url", `http://localhost:${port}`];
      }

      const proc = spawn(cloudflaredPath, args);
      this.process = proc;

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
        if (this.process !== proc || this.stoppedByUser) return;
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

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("close", () => {
        if (this.process !== proc) return;
        const wasRunning = this.info.status === "running" || this.info.status === "starting";
        this.info = { url: "", status: "stopped" };
        this.process = null;

        if (wasRunning && !this.stoppedByUser) {
          tunnelLog.warn("cloudflared exited unexpectedly");
          this.onUnexpectedExit?.();
        }
      });

      proc.on("error", (err) => {
        if (this.process !== proc) return;
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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const hasExited = () => proc.exitCode !== null && proc.exitCode !== undefined ||
        proc.signalCode !== null && proc.signalCode !== undefined;
      const clear = () => {
        clearTimeout(terminateTimeout);
        clearTimeout(killTimeout);
        proc.off("close", finish);
        proc.off("error", handleError);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clear();
        if (this.process === proc) this.process = null;
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clear();
        this.info = { url: "", status: "error", error: error instanceof Error ? error.message : String(error) };
        // Retain ownership so a failed stop cannot authorize a second connector.
        this.process = proc;
        reject(error);
      };
      const signal = (value: "SIGTERM" | "SIGKILL") => {
        try {
          if (!proc.kill(value) && hasExited()) finish();
        } catch (error) {
          if (hasExited()) finish();
          else fail(error);
        }
      };
      const handleError = (error: Error) => {
        if (hasExited()) finish();
        else fail(error);
      };
      const terminateTimeout = setTimeout(() => signal("SIGKILL"), 5000);
      const killTimeout = setTimeout(() => fail(new Error("Cloudflare Tunnel did not stop.")), 10_000);
      proc.once("close", finish);
      proc.once("error", handleError);
      if (hasExited()) finish();
      else signal("SIGTERM");
    });
  }

  getInfo(): TunnelInfo {
    return this.info;
  }
}

export const tunnelManager = new TunnelManager();
