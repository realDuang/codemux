import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

interface ExternalTunnelState {
  pid: number;
  info: TunnelInfo;
}

class TunnelManager {
  private process: ChildProcess | null = null;
  private info: TunnelInfo = {
    url: "",
    status: "stopped",
  };

  private getStateDir(): string {
    return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "codemux-server");
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

  async start(port: number): Promise<TunnelInfo> {
    if (this.process) {
      return this.info;
    }

    const externalTunnel = this.readExternalTunnelState();
    if (externalTunnel) {
      return externalTunnel.info;
    }

    this.info = {
      url: "",
      status: "starting",
      startTime: Date.now(),
    };

    try {
      this.process = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        console.log("[Tunnel]", output);

        const urlMatch = output.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
        if (urlMatch) {
          this.info = {
            url: urlMatch[0],
            status: "running",
            startTime: this.info.startTime,
          };
          console.log("[Tunnel] ✅ URL Ready:", this.info.url);
        }
      };

      this.process.stdout?.on("data", handleOutput);
      this.process.stderr?.on("data", handleOutput);

      this.process.on("close", (code) => {
        console.log("[Tunnel] Process closed with code:", code);
        this.info = {
          url: "",
          status: "stopped",
        };
        this.process = null;
      });

      this.process.on("error", (err) => {
        console.error("[Tunnel] Process error:", err);
        this.info = {
          url: "",
          status: "error",
          error: err.message,
        };
        this.process = null;
      });

      return this.info;
    } catch (error: any) {
      this.info = {
        url: "",
        status: "error",
        error: error.message,
      };
      return this.info;
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.info = {
        url: "",
        status: "stopped",
      };
      return;
    }

    const externalTunnel = this.readExternalTunnelState();
    if (externalTunnel) {
      this.killExternalTunnel(externalTunnel.pid);
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

    const externalTunnel = this.readExternalTunnelState();
    if (externalTunnel) {
      return externalTunnel.info;
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
