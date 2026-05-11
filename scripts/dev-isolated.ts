import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AUTH_API_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_OPENCODE_PORT,
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_STANDALONE_PORT,
  MAX_PORT_OFFSET,
} from "../shared/ports";

const DEV_ISOLATED_DIR = ".codemux-dev";
const PORTS_FILE = "ports.json";
const OFFSET_STEP = 100;
const MAX_OFFSET_ATTEMPTS = Math.floor(MAX_PORT_OFFSET / OFFSET_STEP);
const LOCK_DIR = path.join(os.tmpdir(), "codemux-dev-isolated-port-locks");
const isWindows = process.platform === "win32";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PortPlan {
  portOffset: number;
  ports: {
    web: number;
    webStandalone: number;
    gateway: number;
    opencode: number;
    authApi: number;
    webhook: number;
  };
}

interface PortReservation {
  plan: PortPlan;
  release(): void;
}

const PORT_LABELS: Record<keyof PortPlan["ports"], string> = {
  web: "CODEMUX_WEB_PORT",
  webStandalone: "CODEMUX_WEB_STANDALONE_PORT",
  gateway: "CODEMUX_GATEWAY_PORT",
  opencode: "CODEMUX_OPENCODE_PORT",
  authApi: "CODEMUX_AUTH_API_PORT",
  webhook: "CODEMUX_WEBHOOK_PORT",
};

function readNumberEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const value = env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function resolvePort(envName: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const override = readNumberEnv(envName, env);
  return override ?? fallback;
}

function validatePortPlan(plan: PortPlan): void {
  const seen = new Map<number, keyof PortPlan["ports"]>();

  for (const [key, port] of Object.entries(plan.ports) as Array<[keyof PortPlan["ports"], number]>) {
    if (port < 1 || port > 65_535) {
      throw new Error(
        `${PORT_LABELS[key]} resolved to invalid port ${port}. `
        + `Check CODEMUX_PORT_OFFSET=${plan.portOffset} or override ${PORT_LABELS[key]} explicitly.`,
      );
    }

    const duplicate = seen.get(port);
    if (duplicate) {
      throw new Error(
        `${PORT_LABELS[key]} and ${PORT_LABELS[duplicate]} both resolve to port ${port}. `
        + "Set distinct CODEMUX_* port overrides.",
      );
    }
    seen.set(port, key);
  }
}

export function buildPortPlan(portOffset: number, env: NodeJS.ProcessEnv = process.env): PortPlan {
  if (portOffset < 0 || portOffset > MAX_PORT_OFFSET) {
    throw new Error(`CODEMUX_PORT_OFFSET must be between 0 and ${MAX_PORT_OFFSET}, got ${portOffset}`);
  }

  const plan = {
    portOffset,
    ports: {
      web: resolvePort("CODEMUX_WEB_PORT", DEFAULT_WEB_PORT + portOffset, env),
      webStandalone: resolvePort("CODEMUX_WEB_STANDALONE_PORT", DEFAULT_WEB_STANDALONE_PORT + portOffset, env),
      gateway: resolvePort("CODEMUX_GATEWAY_PORT", DEFAULT_GATEWAY_PORT + portOffset, env),
      opencode: resolvePort("CODEMUX_OPENCODE_PORT", DEFAULT_OPENCODE_PORT + portOffset, env),
      authApi: resolvePort("CODEMUX_AUTH_API_PORT", DEFAULT_AUTH_API_PORT + portOffset, env),
      webhook: resolvePort("CODEMUX_WEBHOOK_PORT", DEFAULT_WEBHOOK_PORT + portOffset, env),
    },
  };

  validatePortPlan(plan);
  return plan;
}

function allPorts(plan: PortPlan): number[] {
  return Object.values(plan.ports);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function unavailablePorts(plan: PortPlan): Promise<number[]> {
  const checks = await Promise.all(
    allPorts(plan).map(async (port) => ({ port, available: await isPortAvailable(port) })),
  );
  return checks.filter((check) => !check.available).map((check) => check.port);
}

function readSavedOffset(devRoot: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(devRoot, PORTS_FILE), "utf-8");
    const data = JSON.parse(raw) as { portOffset?: unknown };
    return typeof data.portOffset === "number" && data.portOffset >= 0 ? data.portOffset : undefined;
  } catch {
    return undefined;
  }
}

function candidateOffsets(): number[] {
  const offsets = Array.from({ length: MAX_OFFSET_ATTEMPTS }, (_, index) => (index + 1) * OFFSET_STEP);
  for (let i = offsets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
  }
  return offsets;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock(lockPath: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: unknown };
    if (typeof data.pid === "number" && isProcessAlive(data.pid)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function reservePlan(plan: PortPlan): PortReservation | null {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${plan.portOffset}.json`);

  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" && removeStaleLock(lockPath)) {
      fd = fs.openSync(lockPath, "wx");
    } else {
      return null;
    }
  }

  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, cwd: projectRoot, plan }, null, 2));

  let released = false;
  return {
    plan,
    release() {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    },
  };
}

async function validateReservedPorts(reservation: PortReservation): Promise<void> {
  const unavailable = await unavailablePorts(reservation.plan);
  if (unavailable.length > 0) {
    reservation.release();
    throw new Error(`Port offset ${reservation.plan.portOffset} conflicts on ports: ${unavailable.join(", ")}`);
  }
}

async function reserveCheckedPlan(plan: PortPlan): Promise<PortReservation | null> {
  const reservation = reservePlan(plan);
  if (!reservation) return null;
  await validateReservedPorts(reservation);
  return reservation;
}

export async function allocatePortReservation(devRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<PortReservation> {
  const explicitOffset = readNumberEnv("CODEMUX_PORT_OFFSET", env);
  if (explicitOffset !== undefined) {
    const plan = buildPortPlan(explicitOffset, env);
    const reservation = await reserveCheckedPlan(plan);
    if (!reservation) {
      throw new Error(`CODEMUX_PORT_OFFSET=${explicitOffset} is already reserved by another isolated dev startup`);
    }
    return reservation;
  }

  const savedOffset = readSavedOffset(devRoot);
  if (savedOffset !== undefined) {
    const plan = buildPortPlan(savedOffset, env);
    const reservation = await reserveCheckedPlan(plan);
    if (reservation) return reservation;
    throw new Error(
      `Saved isolated port offset ${savedOffset} is already reserved. `
      + "Stop the existing isolated instance, delete .codemux-dev/ports.json to reallocate, or set CODEMUX_PORT_OFFSET explicitly.",
    );
  }

  for (const offset of candidateOffsets()) {
    try {
      const reservation = await reserveCheckedPlan(buildPortPlan(offset, env));
      if (reservation) return reservation;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No available CodeMux isolated port offset found after ${MAX_OFFSET_ATTEMPTS} attempts`);
}

export async function allocatePortPlan(devRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<PortPlan> {
  const reservation = await allocatePortReservation(devRoot, env);
  reservation.release();
  return reservation.plan;
}

function writePortsFile(devRoot: string, plan: PortPlan): void {
  fs.mkdirSync(devRoot, { recursive: true });
  const data = {
    devIsolated: true,
    updatedAt: new Date().toISOString(),
    portOffset: plan.portOffset,
    ports: plan.ports,
  };
  fs.writeFileSync(path.join(devRoot, PORTS_FILE), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  const devRoot = path.join(projectRoot, DEV_ISOLATED_DIR);
  const reservation = await allocatePortReservation(devRoot);
  const { plan } = reservation;
  writePortsFile(devRoot, plan);

  process.on("exit", () => reservation.release());

  console.log(`CodeMux isolated dev data: ${devRoot}`);
  console.log(`CodeMux port offset: ${plan.portOffset}`);
  console.log(`CodeMux web port: ${plan.ports.web}`);

  const child = spawn("bun", ["run", "dev"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEMUX_DEV_ISOLATED: "1",
      CODEMUX_PORT_OFFSET: String(plan.portOffset),
    },
    stdio: "inherit",
    shell: isWindows,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("close", (code) => {
    reservation.release();
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    reservation.release();
    console.error(error);
    process.exit(1);
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
