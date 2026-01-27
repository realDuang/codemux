import { spawn, ChildProcess } from "child_process";
import { app } from "electron";
import path from "path";

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

  async start(port: number): Promise<TunnelInfo> {
    if (this.process) {
      return this.info;
    }

    this.info = {
      url: "",
      status: "starting",
      startTime: Date.now(),
    };

    try {
      const cloudflaredPath = this.getCloudflaredPath();
      this.process = spawn(cloudflaredPath, ["tunnel", "--url", `http://localhost:${port}`], {
        shell: process.platform === "win32",
      });

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        console.log("[Tunnel]", output);

        const urlMatch = output.match(/https?:\/\/[\S]+\.trycloudflare\.com/);
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

      this.process.on("close", () => {
        this.info = { url: "", status: "stopped" };
        this.process = null;
      });

      this.process.on("error", (err) => {
        console.error("[Tunnel] Process error:", err);
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
    if (this.process) {
      // On Windows, we need to kill the process tree since we spawn with shell: true
      if (process.platform === "win32") {
        if (this.process.pid) {
          const { exec } = await import("child_process");
          exec(`taskkill /pid ${this.process.pid} /T /F`, (err) => {
            if (err) {
              console.error("[Tunnel] Failed to kill process:", err);
            }
          });
        }
      } else {
        this.process.kill();
      }
      this.process = null;
    }
    this.info = { url: "", status: "stopped" };
  }

  getInfo(): TunnelInfo {
    return this.info;
  }
}

export const tunnelManager = new TunnelManager();