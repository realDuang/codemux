// ============================================================================
// OpenCode Server Management
//
// Standalone functions for spawning and managing the OpenCode server process.
// These have no dependency on the adapter class or its state.
// ============================================================================

import * as net from "net";
import { execFile, spawn } from "child_process";
import type { ServerOptions } from "@opencode-ai/sdk/v2";
import { openCodeLog } from "../../services/logger";

const IS_WIN = process.platform === "win32";

type StreamName = "stdout" | "stderr" | "stdin";

export function createStreamErrorHandler(
  streamName: StreamName,
  logUnexpected: (message: string, error: NodeJS.ErrnoException) => void = (message, error) => {
    openCodeLog.warn(message, error);
  },
): (error: NodeJS.ErrnoException) => void {
  return (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      return;
    }

    logUnexpected(`Unexpected ${streamName} stream error from OpenCode server process`, error);
  };
}

/**
 * Local replacement for SDK's createOpencodeServer().
 * The SDK's version uses spawn() without shell:true, which fails on Windows
 * because `opencode` is installed as `opencode.cmd` and Node's spawn without
 * shell can't resolve .cmd files.
 *
 * On non-Windows platforms this behaves identically to the SDK version.
 */
export function createOpencodeServer(options?: ServerOptions): Promise<{ url: string; close(): void }> {
  const opts = Object.assign(
    { hostname: "127.0.0.1", port: 4096, timeout: 5000 },
    options ?? {},
  );

  const args = [`serve`, `--hostname=${opts.hostname}`, `--port=${opts.port}`];
  if (opts.config?.logLevel) args.push(`--log-level=${opts.config.logLevel}`);

  // Build a clean env for the child process:
  // - Remove ELECTRON_RUN_AS_NODE which leaks from Electron/Halo and can
  //   interfere with Bun's uv_spawn when opencode tries to execute bash.
  // - Inject OPENCODE_CONFIG_CONTENT for config overlay.
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(opts.config ?? {});

  // On Windows, spawn() can't resolve .cmd files without shell:true.
  // We build the full command string to avoid the DEP0190 deprecation warning
  // (passing args array + shell:true triggers it).
  const proc = IS_WIN
    ? spawn(
        `opencode ${args.join(" ")}`,
        [],
        {
          signal: opts.signal,
          shell: true,
          env: childEnv,
        },
      )
    : spawn(`opencode`, args, {
        signal: opts.signal,
        env: childEnv,
      });

  const url = new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`Timeout waiting for server to start after ${opts.timeout}ms`));
    }, opts.timeout);

    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            reject(new Error(`Failed to parse server url from output: ${line}`));
            return;
          }
          clearTimeout(id);
          resolve(match[1]);
          return;
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    // Attach error handlers to stdio streams to prevent EPIPE from becoming
    // an uncaughtException when the child process exits before we finish
    // reading/writing. Without these, broken-pipe errors bubble up and
    // electron-log's default handler shows an error dialog to the user.
    proc.stdout?.on("error", createStreamErrorHandler("stdout"));
    proc.stderr?.on("error", createStreamErrorHandler("stderr"));
    proc.stdin?.on("error", createStreamErrorHandler("stdin"));

    proc.on("exit", (code) => {
      clearTimeout(id);
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });

    proc.on("error", (error) => {
      clearTimeout(id);
      reject(error);
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("Aborted"));
      });
    }
  });

  return url.then((resolvedUrl) => ({
    url: resolvedUrl,
    close() {
      if (IS_WIN) {
        // On Windows, proc.kill() sends SIGTERM which doesn't reliably kill
        // child processes spawned via .cmd. Use taskkill /T to kill the process tree.
        if (proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        }
      } else {
        proc.kill();
      }
    },
  }));
}

/**
 * Fetch the OpenCode CLI version string.
 */
export function fetchVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("opencode", ["--version"], { timeout: 5000, shell: IS_WIN }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const ver = stdout.trim();
      resolve(ver || undefined);
    });
  });
}

/**
 * Check if the target port is already occupied and try to kill the occupying process.
 * This handles orphaned opencode processes from previous crashes or unclean exits.
 */
export async function killOrphanedProcess(port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, "127.0.0.1");
  });

  if (!inUse) return;

  openCodeLog.warn(`Port ${port} is already in use, attempting to kill orphaned process...`);

  if (IS_WIN) {
    // On Windows, find the PID via PowerShell and kill it
    await new Promise<void>((resolve) => {
      const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`;
      execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 5000 }, (err) => {
        if (err) openCodeLog.warn("Failed to kill orphaned process:", err.message);
        resolve();
      });
    });
  } else {
    // On Unix, use fuser or lsof
    await new Promise<void>((resolve) => {
      execFile("fuser", ["-k", `${port}/tcp`], { timeout: 5000 }, (err) => {
        if (err) openCodeLog.warn("Failed to kill orphaned process:", err.message);
        resolve();
      });
    });
  }

  // Brief wait for port to be released
  await new Promise((r) => setTimeout(r, 500));
}
