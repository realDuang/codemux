import { spawn, ChildProcess } from "child_process";

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
      // Start cloudflared tunnel
      this.process = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);

      // Listen to output to get tunnel URL (cloudflared outputs to stderr)
      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        console.log("[Tunnel]", output);

        // Match cloudflared output URL
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
    }
    this.info = {
      url: "",
      status: "stopped",
    };
  }

  getInfo(): TunnelInfo {
    return this.info;
  }
}

export const tunnelManager = new TunnelManager();
