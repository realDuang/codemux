import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "proper-lockfile";
import { callHost, readHostControlMetadata } from "../shared/host-control-client";
import type { HostControlMetadata } from "../shared/host-control-types";
import { resolveServerStateDir } from "./state-dir";
import { resolveNodeExecutable, ServerDevHost, type DevHostStatus } from "./server-dev-host";
import { commandExists } from "./utils";

const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolveServerStateDir({ repoDir: repoPath, isolated: process.env.CODEMUX_DEV_ISOLATED === "1" });
const startupMs = Number(process.env.CODEMUX_SERVER_START_TIMEOUT ?? "90") * 1_000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const SERVER_DEV_USAGE = `Usage:
  ./scripts/server-dev.sh start [--foreground] [--replace] [--tunnel]
  ./scripts/server-dev.sh stop
  ./scripts/server-dev.sh restart
  ./scripts/server-dev.sh status
  ./scripts/server-dev.sh logs [app|tunnel]

Runs Vite and a watched Node.js server without Electron or a display session.
Only the development host recorded in this state directory can be controlled.
Runtime source rebuilds restart the owned child; failed builds keep it running.`;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

async function owner(): Promise<HostControlMetadata | null> {
  const metadata = await readHostControlMetadata(stateDir);
  if (metadata) {
    if (isAlive(metadata.pid)) return metadata;
    if (await check(stateDir, { stale: 30_000 })) {
      throw new Error("The previous development host is still releasing its lease. Retry after its 30-second lease expires.");
    }
    // A new host will atomically replace stale discovery after taking the lease.
    return null;
  }
  // Old PID files carry no instance identity. Never turn one into signal authority.
  const legacyPid = Number(await fs.readFile(path.join(stateDir, "dev.pid"), "utf8").catch(() => ""));
  if (Number.isSafeInteger(legacyPid) && legacyPid > 1 && isAlive(legacyPid)) {
    throw new Error("A legacy development process has no private control identity. Stop it with its original launcher first.");
  }
  return null;
}

async function invoke<T>(metadata: HostControlMetadata, method: string, args: unknown[] = []): Promise<T> {
  return callHost<T>(stateDir, method, args, {
    expectedInstanceId: metadata.instanceId,
    timeoutMs: 40_000,
  });
}

async function status(metadata: HostControlMetadata): Promise<DevHostStatus> {
  const result = await invoke<DevHostStatus>(metadata, "host:status");
  if (result.pid !== metadata.pid || result.dataPath !== metadata.dataPath || typeof result.runtimeDataPath !== "string") {
    throw new Error("The development host returned an invalid identity.");
  }
  return result;
}

async function stop(metadata: HostControlMetadata): Promise<void> {
  await invoke(metadata, "host:stop");
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const current = await readHostControlMetadata(stateDir);
    if (current && current.instanceId !== metadata.instanceId) throw new Error("Another development host replaced the stopped instance; it was left running.");
    if (!current && !await check(stateDir, { stale: 30_000 })) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for the development host to stop. No unrelated process was signaled.");
}

async function printReady(metadata: HostControlMetadata): Promise<void> {
  const current = await status(metadata);
  console.log(`CodeMux dev is ready: http://localhost:${current.webPort}`);
  console.log(`  App log: ${path.join(stateDir, "dev.log")}`);
  console.log(`  Access code: ${await invoke<string>(metadata, "auth:getAccessCode")}`);
  const requests = await invoke<unknown[]>(metadata, "auth:getPendingRequests");
  console.log(`  Pending requests: ${requests.length}`);
  if (requests.length) console.log("  Review pending requests: bun run server:access-requests");
}

async function printTunnel(metadata: HostControlMetadata, wait: boolean): Promise<boolean> {
  const deadline = Date.now() + (wait ? startupMs : 0);
  do {
    const tunnel = await invoke<{ status: string; url: string; error?: string }>(metadata, "tunnel:getStatus");
    if (tunnel.status === "running" && tunnel.url) {
      await fs.writeFile(path.join(stateDir, "tunnel-url"), `${tunnel.url}\n`);
      console.log(`Tunnel is ready: ${tunnel.url}`);
      return true;
    }
    if (tunnel.status === "stopped" || tunnel.status === "error" || !wait) {
      console.log(`Cloudflare tunnel is ${tunnel.status}.${tunnel.error ? ` ${tunnel.error}` : ""}`);
      return false;
    }
    await delay(500);
  } while (Date.now() < deadline);
  console.log("Tunnel started, but its access URL was not detected yet.");
  return false;
}

async function supervise(): Promise<void> {
  const host = new ServerDevHost({
    repoPath, stateDir, nodePath: await resolveNodeExecutable(), env: process.env, startupTimeoutMs: startupMs,
    // After every cleanup operation settles, IPC loss also retires a child that
    // could not be stopped normally. Never leave Vite running after a failed stop.
    onShutdownError: error => { console.error(error); process.exit(1); },
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= host.close().catch(error => { console.error(error); process.exitCode = 1; });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.once("uncaughtException", error => { console.error(error); process.exitCode = 1; void close(); });
  process.once("unhandledRejection", error => { console.error(error); process.exitCode = 1; void close(); });
  await host.start();
}

async function startBackground(withTunnel: boolean): Promise<HostControlMetadata> {
  await resolveNodeExecutable();
  await fs.mkdir(stateDir, { recursive: true });
  const log = openSync(path.join(stateDir, "dev.log"), "w");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise"], {
      cwd: repoPath, env: process.env, detached: true,
      stdio: ["ignore", log, log], windowsHide: true,
    });
  } finally { closeSync(log); }
  let exited = false;
  let spawnError: Error | undefined;
  child.once("exit", () => { exited = true; });
  child.once("error", error => { spawnError = error; exited = true; });
  child.unref();
  const deadline = Date.now() + startupMs;
  let metadata: HostControlMetadata | null = null;
  try {
    while (Date.now() < deadline) {
      if (exited) throw spawnError ?? new Error(`Development host exited before becoming ready. See ${path.join(stateDir, "dev.log")}`);
      metadata = await readHostControlMetadata(stateDir);
      if (metadata && metadata.pid !== child.pid) {
        if (isAlive(metadata.pid)) throw new Error("Another development host won startup; it was left running.");
        metadata = null;
      }
      if (metadata) {
        const current = await status(metadata);
        if (current.ready) {
          await printReady(metadata);
          if (withTunnel) {
            await invoke(metadata, "remoteAccess:update", [{ mode: "cloudflare" }]);
            await printTunnel(metadata, true);
          }
          return metadata;
        }
        if (current.error) throw new Error(current.error);
      }
      await delay(200);
    }
    throw new Error(`Timed out waiting for CodeMux dev. See ${path.join(stateDir, "dev.log")}`);
  } catch (error) {
    if (metadata && metadata.pid === child.pid) await stop(metadata).catch(() => {});
    else if (!exited) child.kill("SIGTERM");
    throw error;
  }
}

export async function runServerDev(argv: string[]): Promise<void> {
  if (!Number.isFinite(startupMs) || startupMs <= 0) throw new Error("CODEMUX_SERVER_START_TIMEOUT must be positive.");
  const [command = "help", ...args] = argv;
  if (command === "help" || args.includes("--help") || command === "--help") { console.log(SERVER_DEV_USAGE); return; }
  if (command === "supervise") {
    if (args.length) throw new Error("supervise does not accept extra arguments.");
    await supervise();
    return;
  }
  if (command === "logs") {
    if (args.length > 1 || (args[0] && !["app", "tunnel"].includes(args[0]))) throw new Error("Use logs [app|tunnel].");
    const child = spawn("tail", ["-n", "100", "-f", path.join(stateDir, "dev.log")], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    return;
  }
  if (!["start", "stop", "restart", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === "start" ? args.some(arg => !["--foreground", "--replace", "--tunnel"].includes(arg)) : args.length) throw new Error(`Invalid arguments for ${command}. Run --help for usage.`);
  if (command === "start" && args.includes("--tunnel") && !commandExists("cloudflared")) {
    throw new Error("Missing required command: cloudflared");
  }
  if (command === "start" || command === "restart") await resolveNodeExecutable();
  const current = await owner();
  if (command === "stop") {
    if (current) await stop(current);
    console.log(current ? "Stopped managed CodeMux server processes." : "No managed CodeMux server processes were running.");
  } else if (command === "status") {
    if (!current) { console.log("CodeMux development server is not running."); return; }
    const details = await status(current);
    console.log(`CodeMux development server is ${details.phase} (runtime PID ${details.runtimePid ?? "pending"}).`);
    if (details.ready) { await printReady(current); await printTunnel(current, false); }
    else if (details.error) console.log(details.error);
  } else if (command === "restart") {
    // An explicit restart uses the invoking worktree and environment, just like
    // the original launcher. Automatic source rebuilds only replace the child.
    if (current) await stop(current);
    const replacement = await startBackground(false);
    if (await printTunnel(replacement, true)) {
      console.log("CodeMux restored its selected Cloudflare access mode.");
      console.log("Temporary quick-tunnel URLs may change when CodeMux restarts.");
    } else console.log("CodeMux restarted with its persisted remote access mode.");
  } else {
    const foreground = args.includes("--foreground");
    const withTunnel = args.includes("--tunnel");
    if (foreground && withTunnel) throw new Error("--tunnel is only supported for detached starts.");
    if (current) {
      if (!args.includes("--replace")) throw new Error("An existing development host was detected. Stop it first or use --replace.");
      await stop(current);
    }
    if (foreground) await supervise();
    else await startBackground(withTunnel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runServerDev(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
