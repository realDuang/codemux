import { spawn, spawnSync } from "child_process";
import * as path from "path";
import { colors } from "./utils";

const isWindows = process.platform === "win32";
const projectRoot = path.resolve(import.meta.dirname, "..");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Find all codemux dev-related process PIDs (node.exe + electron.exe)
function findDevProcessPids(): number[] {
  try {
    if (isWindows) {
      // WQL filter at WMI level limits to node/electron only (fast),
      // then client-side filter for 'codemux' in command line
      const result = spawnSync("powershell", [
        "-NoProfile", "-Command",
        [
          `$selfPid = ${process.pid}`,
          `Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'electron.exe'" |`,
          `  Where-Object { $_.ProcessId -ne $selfPid -and $_.CommandLine -and $_.CommandLine -match 'codemux' } |`,
          `  Select-Object -ExpandProperty ProcessId`,
        ].join("\n"),
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });

      if (result.status !== 0 || !result.stdout.trim()) return [];
      return result.stdout.trim().split(/\r?\n/).map(Number).filter(n => !isNaN(n) && n > 0);
    } else {
      const result = spawnSync("pgrep", ["-f", "electron-vite.*dev"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (result.status !== 0 || !result.stdout.trim()) return [];
      return result.stdout.trim().split(/\n/).map(Number).filter(n => !isNaN(n) && n !== process.pid);
    }
  } catch {
    return [];
  }
}

// Fast PID liveness check using tasklist (no WMI overhead)
function isProcessAlive(pid: number): boolean {
  try {
    if (isWindows) {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
      });
      return result.stdout?.includes(String(pid)) ?? false;
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

// Kill processes by PID (only if alive)
function killProcesses(pids: number[]): void {
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    try {
      if (isWindows) {
        // /T kills the process tree, /F forces termination
        spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "pipe" });
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      // Process may have already exited
    }
  }
}

// Wait until specific PIDs are dead (uses tasklist, not CIM re-query)
function waitForExit(pids: number[], maxWaitMs = 10000): boolean {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const alive = pids.filter(pid => isProcessAlive(pid));
    if (alive.length === 0) return true;
    sleepSync(1000);
  }
  return !pids.some(pid => isProcessAlive(pid));
}

// Start dev server in detached mode
function startDevServer(): void {
  const child = spawn("npm", ["run", "dev"], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    shell: isWindows,
  });

  child.unref();
}

function main() {
  console.log(`\n${colors.cyan}> CodeMux Dev Restart${colors.reset}\n`);

  // Step 1: Find existing dev processes
  const pids = findDevProcessPids();

  if (pids.length === 0) {
    console.log(`${colors.yellow}[!] No running dev processes found${colors.reset}`);
  } else {
    // Verify PIDs are actually alive (filter out stale WMI entries)
    const alivePids = pids.filter(pid => isProcessAlive(pid));
    if (alivePids.length === 0) {
      console.log(`${colors.yellow}[!] Found PIDs ${pids.join(", ")} in WMI but none are alive (stale data)${colors.reset}`);
    } else {
      console.log(`${colors.cyan}[*] Found dev processes: ${alivePids.join(", ")}${colors.reset}`);

      // Step 2: Kill processes
      console.log(`${colors.cyan}[*] Stopping dev server...${colors.reset}`);
      killProcesses(alivePids);

      // Step 3: Wait for exit (checks actual liveness, not CIM re-query)
      const exited = waitForExit(alivePids);
      if (exited) {
        console.log(`${colors.green}[ok] Dev server stopped${colors.reset}`);
      } else {
        const remaining = alivePids.filter(pid => isProcessAlive(pid));
        if (remaining.length > 0) {
          console.log(`${colors.red}[x] Some processes did not exit: ${remaining.join(", ")}${colors.reset}`);
          process.exit(1);
        }
        console.log(`${colors.green}[ok] Dev server stopped${colors.reset}`);
      }
    }
  }

  // Step 4: Start dev server
  console.log(`${colors.cyan}[*] Starting dev server...${colors.reset}`);
  startDevServer();
  console.log(`${colors.green}[ok] Dev server started (detached)${colors.reset}`);
  console.log(`${colors.dim}    The dev server is running in the background.${colors.reset}\n`);
}

main();
