import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AUTH_API_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_OPENCODE_PORT,
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_STANDALONE_PORT,
} from "../shared/ports";

const DEV_ISOLATED_DIR = ".codemux-dev";
const PORTS_FILE = "ports.json";
const OFFSET_STEP = 100;
const MAX_OFFSET_ATTEMPTS = 100;
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

function readNumberEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const value = env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function resolvePort(envName: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const override = readNumberEnv(envName, env);
  if (override === undefined || override < 1 || override > 65_535) return fallback;
  return override;
}

export function buildPortPlan(portOffset: number, env: NodeJS.ProcessEnv = process.env): PortPlan {
  return {
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
}

function uniquePorts(plan: PortPlan): number[] {
  return Array.from(new Set(Object.values(plan.ports)));
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
    uniquePorts(plan).map(async (port) => ({ port, available: await isPortAvailable(port) })),
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
  return Array.from({ length: MAX_OFFSET_ATTEMPTS }, (_, index) => (index + 1) * OFFSET_STEP);
}

export async function allocatePortPlan(devRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<PortPlan> {
  const explicitOffset = readNumberEnv("CODEMUX_PORT_OFFSET", env);
  if (explicitOffset !== undefined) {
    if (explicitOffset < 0) {
      throw new Error(`CODEMUX_PORT_OFFSET must be >= 0, got ${explicitOffset}`);
    }
    const plan = buildPortPlan(explicitOffset, env);
    const unavailable = await unavailablePorts(plan);
    if (unavailable.length > 0) {
      throw new Error(`CODEMUX_PORT_OFFSET=${explicitOffset} conflicts on ports: ${unavailable.join(", ")}`);
    }
    return plan;
  }

  const savedOffset = readSavedOffset(devRoot);
  if (savedOffset !== undefined) {
    const plan = buildPortPlan(savedOffset, env);
    const unavailable = await unavailablePorts(plan);
    if (unavailable.length === 0) return plan;
    throw new Error(
      `Saved isolated port offset ${savedOffset} conflicts on ports: ${unavailable.join(", ")}. `
      + "This worktree may already have a running isolated dev instance.",
    );
  }

  for (const offset of candidateOffsets()) {
    const plan = buildPortPlan(offset, env);
    if ((await unavailablePorts(plan)).length === 0) {
      return plan;
    }
  }

  throw new Error(`No available CodeMux isolated port offset found after ${MAX_OFFSET_ATTEMPTS} attempts`);
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
  const plan = await allocatePortPlan(devRoot);
  writePortsFile(devRoot, plan);

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
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
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
