#!/usr/bin/env bun
/**
 * codemux - unified CLI for development, server, and admin commands.
 *
 * Usage: codemux <group> <command> [flags]
 *
 * Run `codemux help` for the full command list.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allocatePortReservation, type PortReservation } from "./dev-isolated";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const IS_WINDOWS = process.platform === "win32";

const SERVER_DEV_SH = path.join(SCRIPT_DIR, "server-dev.sh");
const SERVER_INIT_SH = path.join(SCRIPT_DIR, "server-init.sh");
const SERVER_AUTH_TS = path.join(SCRIPT_DIR, "server-auth.ts");
const SETUP_TS = path.join(SCRIPT_DIR, "setup.ts");
const START_TS = path.join(SCRIPT_DIR, "start.ts");
const RESTART_TS = path.join(SCRIPT_DIR, "restart.ts");
const UPDATE_CLOUDFLARED_TS = path.join(SCRIPT_DIR, "update-cloudflared.ts");
const TEST_WEB_API_TS = path.join(SCRIPT_DIR, "test-web-api.ts");
const DEV_ISOLATED_DIR = ".codemux-dev";

function projectHash(): string {
  return createHash("sha1").update(PROJECT_ROOT).digest("hex").slice(0, 12);
}

function projectSlug(): string {
  const base = path.basename(PROJECT_ROOT)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "repo";
  return `${base}-${projectHash()}`;
}

function serverStateBase(): string {
  const xdg = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "codemux-server");
}

function serverStateDir(): string {
  return path.join(serverStateBase(), projectSlug());
}

function readPortOffsetFile(stateDir: string): number | null {
  const file = path.join(stateDir, "port-offset");
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function writePortOffsetFile(stateDir: string, offset: number): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "port-offset"), `${offset}\n`, "utf8");
}

function clearPortOffsetFile(stateDir: string): void {
  const file = path.join(stateDir, "port-offset");
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function buildPortEnv(offset: number): Record<string, string> {
  const env: Record<string, string> = {
    CODEMUX_PORT_OFFSET: String(offset),
  };
  if (offset !== 0) env.CODEMUX_DEV_ISOLATED = "1";
  return env;
}

function devRoot(): string {
  return path.join(PROJECT_ROOT, DEV_ISOLATED_DIR);
}

function devicesFile(isolated: boolean): string {
  if (isolated) {
    return path.join(devRoot(), "userData", "devices.json");
  }
  return path.join(PROJECT_ROOT, ".devices.json");
}

function writeIsolatedPortsFile(reservation: PortReservation): void {
  const root = devRoot();
  fs.mkdirSync(root, { recursive: true });
  const data = {
    devIsolated: true,
    updatedAt: new Date().toISOString(),
    portOffset: reservation.plan.portOffset,
    ports: reservation.plan.ports,
  };
  fs.writeFileSync(path.join(root, "ports.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function reserveIsolatedPorts(): Promise<PortReservation> {
  const root = devRoot();
  fs.mkdirSync(root, { recursive: true });
  return allocatePortReservation(root);
}

function spawnSyncPassthrough(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: PROJECT_ROOT,
    env,
    shell: IS_WINDOWS && (command.endsWith(".sh") || command.endsWith(".bash")),
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? (result.signal ? 1 : 0);
}

function spawnLongRunning(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: PROJECT_ROOT,
      env,
      shell: IS_WINDOWS && (command.endsWith(".sh") || command.endsWith(".bash")),
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function bashCommand(): string {
  return IS_WINDOWS ? "bash.exe" : "bash";
}

function bunCommand(): string {
  return IS_WINDOWS ? "bun.exe" : "bun";
}

function envWithServerStateDir(stateDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    CODEMUX_SERVER_STATE_DIR: stateDir,
  };
}

interface ParsedFlags {
  flags: Set<string>;
  positionals: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (arg.startsWith("--")) flags.add(arg);
    else positionals.push(arg);
  }
  return { flags, positionals };
}

function helpText(): string {
  return `codemux - unified CLI

Usage: codemux <group> <command> [flags]

Development modes:
  codemux dev                            Electron desktop dev
  codemux dev --isolated                 Electron dev with per-folder ports/data
  codemux dev --web                      Standalone web dev (no Electron)
  codemux dev --server                   Headless foreground server (Linux Xvfb)
  codemux dev --server --isolated        Headless foreground server, isolated

Daemonized server lifecycle:
  codemux server start [--replace] [--tunnel] [--isolated]
  codemux server stop
  codemux server restart
  codemux server status
  codemux server logs [app|tunnel]
  codemux server init                    Bootstrap Linux server dependencies

Auth admin (against the running instance):
  codemux auth access-code [--plain]
  codemux auth access-requests [--count]
  codemux auth status

Maintenance:
  codemux setup                          Interactive engine/runtime setup
  codemux update cloudflared             Refresh bundled cloudflared binary
  codemux app restart                    Kill+respawn the local Electron dev app
  codemux test web-api                   Web-only API smoke test

Server state is per-folder (sha1 of the repo path). Within a single
folder only one server can run at a time. To run multiple instances
in parallel, create separate worktrees with \`git worktree add\` so
each instance lives in its own folder. Use --isolated to pick a free
port offset and run alongside a non-isolated instance from another
folder.
`;
}

async function runDev(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  const isolated = parsed.flags.has("--isolated");
  const web = parsed.flags.has("--web");
  const server = parsed.flags.has("--server");

  if (web && server) {
    console.error("--web and --server are mutually exclusive");
    return 2;
  }

  if (server) {
    const serverArgs = ["start", "--foreground"];
    if (isolated) serverArgs.push("--isolated");
    return runServer(serverArgs);
  }

  if (web) {
    if (isolated) {
      console.error("--isolated is not currently supported with --web; run `codemux dev --isolated` for an isolated Electron instance.");
      return 2;
    }
    return spawnSyncPassthrough(bunCommand(), [START_TS]);
  }

  if (isolated) {
    const reservation = await reserveIsolatedPorts();
    writeIsolatedPortsFile(reservation);
    process.on("exit", () => reservation.release());
    console.log(`CodeMux isolated dev data: ${devRoot()}`);
    console.log(`CodeMux port offset: ${reservation.plan.portOffset}`);
    console.log(`CodeMux web port: ${reservation.plan.ports.web}`);
    const env = {
      ...process.env,
      ...buildPortEnv(reservation.plan.portOffset),
      CODEMUX_DEV_ISOLATED: "1",
    } as NodeJS.ProcessEnv;
    const code = await spawnLongRunning(bunCommand(), ["x", "electron-vite", "dev"], env);
    reservation.release();
    return code;
  }

  return spawnSyncPassthrough(bunCommand(), ["x", "electron-vite", "dev"]);
}

async function runServer(args: string[]): Promise<number> {
  const command = args[0];
  if (!command) {
    console.error("codemux server requires a subcommand (start, stop, restart, status, logs, init)");
    return 2;
  }

  if (command === "init") {
    return spawnSyncPassthrough(bashCommand(), [SERVER_INIT_SH, ...args.slice(1)]);
  }

  const stateDir = serverStateDir();
  fs.mkdirSync(stateDir, { recursive: true });

  if (command === "start") {
    const rest = args.slice(1);
    const isolatedIdx = rest.indexOf("--isolated");
    const isolated = isolatedIdx >= 0;
    if (isolated) rest.splice(isolatedIdx, 1);

    let portEnv: Record<string, string> = {};
    let releaseLock: (() => void) | null = null;
    if (isolated) {
      const reservation = await reserveIsolatedPorts();
      writeIsolatedPortsFile(reservation);
      writePortOffsetFile(stateDir, reservation.plan.portOffset);
      portEnv = {
        ...buildPortEnv(reservation.plan.portOffset),
        CODEMUX_DEV_ISOLATED: "1",
      };
      releaseLock = reservation.release;
      console.log(`CodeMux isolated server: port offset ${reservation.plan.portOffset}, web port ${reservation.plan.ports.web}`);
    } else {
      // Reuse stored offset if a previous --isolated start is being
      // re-invoked without the flag (preserve idempotency).
      const stored = readPortOffsetFile(stateDir);
      if (stored != null && stored !== 0) {
        portEnv = { ...buildPortEnv(stored), CODEMUX_DEV_ISOLATED: "1" };
        console.log(`CodeMux server: reusing stored port offset ${stored}`);
      } else {
        clearPortOffsetFile(stateDir);
      }
    }

    const env = envWithServerStateDir(stateDir, portEnv);
    const code = await spawnLongRunning(bashCommand(), [SERVER_DEV_SH, "start", ...rest], env);
    if (releaseLock) releaseLock();
    return code;
  }

  // For stop/restart/status/logs, restore offset env from state if present so
  // subprocess auth checks/health probes hit the right ports.
  const offset = readPortOffsetFile(stateDir);
  const env = envWithServerStateDir(stateDir, offset != null ? buildPortEnv(offset) : {});

  if (command === "stop") {
    const code = await spawnLongRunning(bashCommand(), [SERVER_DEV_SH, "stop", ...args.slice(1)], env);
    if (offset != null) clearPortOffsetFile(stateDir);
    return code;
  }

  if (command === "restart" || command === "status" || command === "logs") {
    return spawnLongRunning(bashCommand(), [SERVER_DEV_SH, command, ...args.slice(1)], env);
  }

  console.error(`Unknown server subcommand: ${command}`);
  return 2;
}

function runAuth(args: string[]): number {
  const command = args[0];
  if (!command) {
    console.error("codemux auth requires a subcommand (access-code, access-requests, status)");
    return 2;
  }
  // Point server-auth.ts at the right devices.json based on the running
  // server's isolation state (so isolated servers' auth state is reachable
  // without the user knowing the path).
  const stateDir = serverStateDir();
  const offset = readPortOffsetFile(stateDir);
  const isolated = offset != null && offset !== 0;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEMUX_DEVICES_FILE: devicesFile(isolated),
  };
  if (isolated) {
    Object.assign(env, buildPortEnv(offset));
  }
  return spawnSyncPassthrough(bunCommand(), [SERVER_AUTH_TS, ...args], env);
}

function runSetup(args: string[]): number {
  return spawnSyncPassthrough(bunCommand(), [SETUP_TS, ...args]);
}

function runUpdate(args: string[]): number {
  const target = args[0];
  if (target === "cloudflared") {
    return spawnSyncPassthrough(bunCommand(), [UPDATE_CLOUDFLARED_TS, ...args.slice(1)]);
  }
  console.error(`codemux update: unknown target "${target ?? ""}". Supported: cloudflared`);
  return 2;
}

function runApp(args: string[]): number {
  const sub = args[0];
  if (sub === "restart") {
    return spawnSyncPassthrough(bunCommand(), [RESTART_TS, ...args.slice(1)]);
  }
  console.error(`codemux app: unknown subcommand "${sub ?? ""}". Supported: restart`);
  return 2;
}

function runTest(args: string[]): number {
  const sub = args[0];
  if (sub === "web-api") {
    return spawnSyncPassthrough(bunCommand(), [TEST_WEB_API_TS, ...args.slice(1)]);
  }
  console.error(`codemux test: unknown subcommand "${sub ?? ""}". Supported: web-api`);
  return 2;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const group = argv[0];
  const rest = argv.slice(1);

  if (!group || group === "help" || group === "-h" || group === "--help") {
    process.stdout.write(helpText());
    process.exit(group ? 0 : 1);
  }

  let code: number;
  switch (group) {
    case "dev":
      code = await runDev(rest);
      break;
    case "server":
      code = await runServer(rest);
      break;
    case "auth":
      code = runAuth(rest);
      break;
    case "setup":
      code = runSetup(rest);
      break;
    case "update":
      code = runUpdate(rest);
      break;
    case "app":
      code = runApp(rest);
      break;
    case "test":
      code = runTest(rest);
      break;
    default:
      console.error(`Unknown command group: ${group}`);
      console.error("Run `codemux help` for usage.");
      code = 2;
  }
  process.exit(code);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

