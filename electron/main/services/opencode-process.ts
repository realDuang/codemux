import { spawn, ChildProcess } from "child_process";
import { app } from "electron";
import path from "path";
import { EventEmitter } from "events";

interface OpenCodeStatus {
  running: boolean;
  port: number;
  pid?: number;
  startTime?: number;
  error?: string;
}

class OpenCodeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number = 4096;
  private status: OpenCodeStatus = { running: false, port: 4096 };

  private getOpencodePath(): string {
    if (!app.isPackaged) {
      return "opencode"; // Use system PATH in dev mode
    }

    const resourcesPath = process.resourcesPath;
    const platform = process.platform;
    const arch = process.arch;

    const binaryName = platform === "win32" ? "opencode.exe" : "opencode";
    return path.join(resourcesPath, "bin", `${platform}-${arch}`, binaryName);
  }

  async start(): Promise<OpenCodeStatus> {
    if (this.process) {
      return this.status;
    }

    const opencodePath = this.getOpencodePath();

    try {
      this.process = spawn(
        opencodePath,
        ["serve", "--hostname", "127.0.0.1", "--port", this.port.toString(), "--cors"],
        {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        }
      );

      this.status = {
        running: true,
        port: this.port,
        pid: this.process.pid,
        startTime: Date.now(),
      };

      this.process.stdout?.on("data", (data) => {
        console.log("[OpenCode]", data.toString());
      });

      this.process.stderr?.on("data", (data) => {
        console.error("[OpenCode Error]", data.toString());
      });

      this.process.on("close", (code) => {
        console.log("[OpenCode] Process exited with code:", code);
        this.status = { running: false, port: this.port };
        this.process = null;
        this.emit("stopped", code);
      });

      this.process.on("error", (err) => {
        console.error("[OpenCode] Process error:", err);
        this.status = { running: false, port: this.port, error: err.message };
        this.process = null;
        this.emit("error", err);
      });

      await this.waitForReady();

      return this.status;
    } catch (error: any) {
      this.status = { running: false, port: this.port, error: error.message };
      throw error;
    }
  }

  private async waitForReady(timeout: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`http://localhost:${this.port}/provider`);
        if (response.ok) {
          console.log("[OpenCode] Service is ready");
          return;
        }
      } catch {
        // Service not ready yet, keep waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("OpenCode service failed to start within timeout");
  }

  async stop(): Promise<void> {
    if (this.process) {
      // On Windows, we need to kill the process tree since we spawn with shell: true
      // On Unix, SIGTERM works normally
      if (process.platform === "win32") {
        // Use taskkill to forcefully terminate the process tree on Windows
        if (this.process.pid) {
          const { exec } = await import("child_process");
          exec(`taskkill /pid ${this.process.pid} /T /F`, (err) => {
            if (err) {
              console.error("[OpenCode] Failed to kill process:", err);
            }
          });
        }
      } else {
        this.process.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            if (process.platform === "win32") {
              // On Windows, the process should already be killed by taskkill
              // Just resolve after timeout
            } else {
              this.process.kill("SIGKILL");
            }
          }
          resolve();
        }, 5000);

        this.process?.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }
    this.status = { running: false, port: this.port };
  }

  getStatus(): OpenCodeStatus {
    return this.status;
  }

  getPort(): number {
    return this.port;
  }
}

export const opencodeProcess = new OpenCodeProcess();