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

function serverStateBase(): string {
  const xdg = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "codemux-server");
}

function projectStateRoot(): string {
  return path.join(serverStateBase(), projectHash());
}

function sanitizeInstanceName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function detectGitBranch(): string | null {
  try {
    const result = spawnSync("git", ["-C", PROJECT_ROOT, "branch", "--show-current"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    const branch = result.stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

function defaultInstanceName(): string {
  const branch = detectGitBranch();
  return sanitizeInstanceName(branch ?? "default");
}

function serverStateDir(name: string): string {
  return path.join(projectStateRoot(), name);
}

function listInstances(): string[] {
  const root = projectStateRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

function devRootFor(name: string): string {
  return path.join(PROJECT_ROOT, DEV_ISOLATED_DIR, name);
}

function devicesFileFor(name: string, isolated: boolean): string {
  if (isolated) {
    return path.join(devRootFor(name), "userData", "devices.json");
  }
  return path.join(PROJECT_ROOT, ".devices.json");
}

function writeIsolatedPortsFile(reservation: PortReservation, name: string): void {
  const devRoot = devRootFor(name);
  fs.mkdirSync(devRoot, { recursive: true });
  const data = {
    devIsolated: true,
    instance: name,
    updatedAt: new Date().toISOString(),
    portOffset: reservation.plan.portOffset,
    ports: reservation.plan.ports,
  };
  fs.writeFileSync(path.join(devRoot, "ports.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function reserveIsolatedPorts(name: string): Promise<PortReservation> {
  const devRoot = devRootFor(name);
  fs.mkdirSync(devRoot, { recursive: true });
  return allocatePortReservation(devRoot);
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
  options: Map<string, string>;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags = new Set<string>();
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--") && arg.includes("=")) {
      const idx = arg.indexOf("=");
      options.set(arg.slice(0, idx), arg.slice(idx + 1));
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (next != null && !next.startsWith("--")) {
        options.set("--name", next);
        i++;
      }
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, options };
}

function takeName(parsed: ParsedFlags): string {
  const explicit = parsed.options.get("--name");
  return explicit ? sanitizeInstanceName(explicit) : defaultInstanceName();
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
  codemux server start [--replace] [--tunnel] [--isolated] [--name <name>]
  codemux server stop [--name <name>]
  codemux server restart [--name <name>]
  codemux server status [--name <name>]
  codemux server logs [app|tunnel] [--name <name>]
  codemux server list                    List all server instances in this repo
  codemux server init                    Bootstrap Linux server dependencies

Auth admin (against the running instance):
  codemux auth access-code [--plain] [--name <name>]
  codemux auth access-requests [--count] [--name <name>]
  codemux auth status [--name <name>]

Maintenance:
  codemux setup                          Interactive engine/runtime setup
  codemux update cloudflared             Refresh bundled cloudflared binary
  codemux app restart                    Kill+respawn the local Electron dev app
  codemux test web-api                   Web-only API smoke test

Server state is per-project + per-instance-name. The instance name
defaults to the current git branch (sanitized) so different branches
in the same folder run as separate instances. Override with --name
or set CODEMUX_INSTANCE. Within an instance only one server can run
at a time. Use --isolated to pick a free port offset and run alongside
other instances/folders.
`;
}

async function runDev(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  const isolated = parsed.flags.has("--isolated");
  const web = parsed.flags.has("--web");
  const server = parsed.flags.has("--server");
  const name = takeName(parsed);

  if (web && server) {
    console.error("--web and --server are mutually exclusive");
    return 2;
  }

  if (server) {
    const serverArgs = ["start", "--foreground"];
    if (isolated) serverArgs.push("--isolated");
    serverArgs.push("--name", name);
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
    const reservation = await reserveIsolatedPorts(name);
    writeIsolatedPortsFile(reservation, name);
    process.on("exit", () => reservation.release());
    console.log(`CodeMux isolated dev instance: ${name}`);
    console.log(`CodeMux isolated dev data: ${devRootFor(name)}`);
    console.log(`CodeMux port offset: ${reservation.plan.portOffset}`);
    console.log(`CodeMux web port: ${reservation.plan.ports.web}`);
    const env = {
      ...process.env,
      ...buildPortEnv(reservation.plan.portOffset),
      CODEMUX_DEV_ISOLATED: "1",
      CODEMUX_INSTANCE: name,
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
    console.error("codemux server requires a subcommand (start, stop, restart, status, logs, list, init)");
    return 2;
  }

  if (command === "init") {
    return spawnSyncPassthrough(bashCommand(), [SERVER_INIT_SH, ...args.slice(1)]);
  }

  if (command === "list") {
    const instances = listInstances();
    if (instances.length === 0) {
      console.log(`No server instances for this repo (${projectStateRoot()})`);
      return 0;
    }
    const current = defaultInstanceName();
    console.log(`Server instances for ${PROJECT_ROOT}:`);
    for (const name of instances) {
      const dir = serverStateDir(name);
      const pidFile = path.join(dir, "dev.pid");
      let status = "stopped";
      let pid: string | null = null;
      if (fs.existsSync(pidFile)) {
        pid = fs.readFileSync(pidFile, "utf8").trim();
        try {
          process.kill(Number(pid), 0);
          status = "running";
        } catch {
          status = "stale";
        }
      }
      const offset = readPortOffsetFile(dir);
      const offsetStr = offset != null ? ` offset=${offset}` : "";
      const marker = name === current ? " (default for current branch)" : "";
      const pidStr = pid ? ` pid=${pid}` : "";
      console.log(`  ${name.padEnd(24)} ${status}${pidStr}${offsetStr}${marker}`);
    }
    return 0;
  }

  const parsed = parseFlags(args.slice(1));
  const name = process.env.CODEMUX_INSTANCE
    ? sanitizeInstanceName(process.env.CODEMUX_INSTANCE)
    : takeName(parsed);
  const stateDir = serverStateDir(name);
  fs.mkdirSync(stateDir, { recursive: true });

  const restArgs: string[] = [];
  for (let i = 0; i < parsed.positionals.length; i++) restArgs.push(parsed.positionals[i]!);
  for (const flag of parsed.flags) restArgs.push(flag);

  if (command === "start") {
    const isolatedIdx = restArgs.indexOf("--isolated");
    const isolated = isolatedIdx >= 0;
    if (isolated) restArgs.splice(isolatedIdx, 1);

    let portEnv: Record<string, string> = {};
    let releaseLock: (() => void) | null = null;
    if (isolated) {
      const reservation = await reserveIsolatedPorts(name);
      writeIsolatedPortsFile(reservation, name);
      writePortOffsetFile(stateDir, reservation.plan.portOffset);
      portEnv = {
        ...buildPortEnv(reservation.plan.portOffset),
        CODEMUX_DEV_ISOLATED: "1",
      };
      releaseLock = reservation.release;
      console.log(`CodeMux isolated server [${name}]: port offset ${reservation.plan.portOffset}, web port ${reservation.plan.ports.web}`);
    } else {
      // Reuse stored offset if a previous --isolated start of this instance
      // is being re-invoked without the flag (preserve idempotency).
      const stored = readPortOffsetFile(stateDir);
      if (stored != null && stored !== 0) {
        portEnv = { ...buildPortEnv(stored), CODEMUX_DEV_ISOLATED: "1" };
        console.log(`CodeMux server [${name}]: reusing stored port offset ${stored}`);
      } else {
        clearPortOffsetFile(stateDir);
      }
    }

    console.log(`CodeMux server instance: ${name}`);
    const env = envWithServerStateDir(stateDir, { ...portEnv, CODEMUX_INSTANCE: name });
    const code = await spawnLongRunning(bashCommand(), [SERVER_DEV_SH, "start", ...restArgs], env);
    if (releaseLock) releaseLock();
    return code;
  }

  const offset = readPortOffsetFile(stateDir);
  const env = envWithServerStateDir(stateDir, {
    ...(offset != null ? buildPortEnv(offset) : {}),
    CODEMUX_INSTANCE: name,
  });

  if (command === "stop") {
    const code = await spawnLongRunning(bashCommand(), [SERVER_DEV_SH, "stop", ...restArgs], env);
    if (offset != null) clearPortOffsetFile(stateDir);
    return code;
  }

  if (command === "restart" || command === "status" || command === "logs") {
    return spawnLongRunning(bashCommand(), [SERVER_DEV_SH, command, ...restArgs], env);
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
  // Strip --name from args before forwarding so server-auth.ts doesn't see it.
  const parsed = parseFlags(args.slice(1));
  const name = process.env.CODEMUX_INSTANCE
    ? sanitizeInstanceName(process.env.CODEMUX_INSTANCE)
    : takeName(parsed);
  const stateDir = serverStateDir(name);
  const offset = readPortOffsetFile(stateDir);
  const isolated = offset != null && offset !== 0;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEMUX_INSTANCE: name,
    CODEMUX_DEVICES_FILE: devicesFileFor(name, isolated),
  };
  if (isolated) {
    Object.assign(env, buildPortEnv(offset));
  }
  // Reconstruct args without --name=value pair.
  const cleanArgs: string[] = [command];
  for (let i = 0; i < parsed.positionals.length; i++) cleanArgs.push(parsed.positionals[i]!);
  for (const flag of parsed.flags) cleanArgs.push(flag);
  return spawnSyncPassthrough(bunCommand(), [SERVER_AUTH_TS, ...cleanArgs], env);
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

