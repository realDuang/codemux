import readline from "node:readline";
import { parseArgs } from "node:util";
import type { PendingRequest } from "../shared/device-store-types";
import { callHost, readHostControlMetadata } from "../shared/host-control-client";
import { acquireRuntimeLock } from "../shared/runtime-lock";
import { resolveCliDataPath } from "../server/cli-commands";
import { colors } from "./utils";

export interface AuthHelperBackend {
  getAccessCode(): Promise<string>;
  listPendingRequests(): Promise<PendingRequest[]>;
  approveRequest(requestId: string): Promise<boolean>;
  denyRequest(requestId: string): Promise<boolean>;
  release?(): Promise<void>;
}

export interface AuthBackendDependencies {
  call: typeof callHost;
  readMetadata: typeof readHostControlMetadata;
  loadLegacy: () => Promise<AuthHelperBackend>;
  acquireLock: typeof acquireRuntimeLock;
}

async function loadLegacyBackend(): Promise<AuthHelperBackend> {
  // This module eagerly loads and may write .devices.json. Import it only after
  // explicit legacy selection while holding the runtime's ownership lock.
  const { deviceStore } = await import("./device-store");
  return {
    getAccessCode: async () => deviceStore.getAccessCode(),
    listPendingRequests: async () => deviceStore.listPendingRequests(),
    approveRequest: async (id) => Boolean(deviceStore.approveRequest(id)),
    denyRequest: async (id) => Boolean(deviceStore.denyRequest(id)),
  };
}

export async function createAuthHelperBackend(
  dataPath: string,
  allowLegacy: boolean,
  overrides: Partial<AuthBackendDependencies> = {},
): Promise<AuthHelperBackend> {
  const dependencies: AuthBackendDependencies = {
    call: callHost, readMetadata: readHostControlMetadata, loadLegacy: loadLegacyBackend,
    acquireLock: acquireRuntimeLock, ...overrides,
  };
  const remoteBackend = (): AuthHelperBackend => ({
    getAccessCode: () => dependencies.call<string>(dataPath, "auth:getAccessCode", []),
    listPendingRequests: () => dependencies.call<PendingRequest[]>(dataPath, "auth:getPendingRequests", []),
    approveRequest: (id) => dependencies.call<boolean>(dataPath, "auth:approveRequest", [id]),
    denyRequest: (id) => dependencies.call<boolean>(dataPath, "auth:denyRequest", [id]),
  });
  if (await dependencies.readMetadata(dataPath)) return remoteBackend();
  if (!allowLegacy) {
    throw new Error(`No running CodeMux host owns ${dataPath}. Start the server first, or use --legacy for the legacy development file.`);
  }

  // Startup and shutdown have intervals without discovery metadata while the
  // host still owns its data. The same lease excludes a second file writer.
  const lease = await dependencies.acquireLock(dataPath);
  try {
    if (await dependencies.readMetadata(dataPath)) {
      await lease.release();
      return remoteBackend();
    }
    const legacy = await dependencies.loadLegacy();
    return { ...legacy, release: () => lease.release() };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

function usage(): string {
  return `
${colors.bold}${colors.cyan}CodeMux Server Auth Helper${colors.reset}

Usage:
  bun scripts/server-auth.ts access-code [--plain]
  bun scripts/server-auth.ts access-requests [--count]
  bun scripts/server-auth.ts status

Options:
  --data-dir <path>  Select the running host's data directory
  --legacy          Use cwd/.devices.json while holding the runtime lock
  --help            Show this help

CODEMUX_DATA_DIR selects the default data directory.
CODEMUX_LEGACY_DEV=1 also enables the explicit legacy fallback.`;
}

function formatAge(createdAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function summarizeRequest(request: PendingRequest): string {
  return `${request.id}  ${request.device.name}  ${request.device.platform}/${request.device.browser}  ${request.ip}  ${formatAge(request.createdAt)}`;
}

interface AuthPrompt {
  ask(question: string): Promise<string>;
  close(): void;
}

export interface AuthHelperDependencies extends AuthBackendDependencies {
  resolveDataPath: typeof resolveCliDataPath;
  env: Readonly<NodeJS.ProcessEnv>;
  interactive: boolean;
  createPrompt: () => AuthPrompt;
  write: (message: string) => void;
  error: (message: string) => void;
}

export async function runServerAuthCli(argv: string[], overrides: Partial<AuthHelperDependencies> = {}): Promise<number> {
  const dependencies: AuthHelperDependencies = {
    call: callHost,
    readMetadata: readHostControlMetadata,
    loadLegacy: loadLegacyBackend,
    acquireLock: acquireRuntimeLock,
    resolveDataPath: resolveCliDataPath,
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    createPrompt: () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return { ask: question => new Promise(resolve => rl.question(question, resolve)), close: () => rl.close() };
    },
    write: console.log,
    error: console.error,
    ...overrides,
  };

  let backendToRelease: AuthHelperBackend | undefined;
  let exitCode = 0;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        "data-dir": { type: "string" },
        legacy: { type: "boolean" },
        plain: { type: "boolean" },
        count: { type: "boolean" },
      },
    });
    const [command = "help"] = positionals;
    if (positionals.length > 1) throw new Error("Too many command arguments.");
    if (values.help || command === "help") {
      dependencies.write(usage());
      return 0;
    }
    if (!["access-code", "access-requests", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
    if (values["data-dir"] === "") throw new Error("--data-dir must not be empty.");
    if (values.plain && command !== "access-code") throw new Error("--plain is only valid with access-code.");
    if (values.count && command !== "access-requests") throw new Error("--count is only valid with access-requests.");
    const backend = await createAuthHelperBackend(
      dependencies.resolveDataPath(values["data-dir"]),
      Boolean(values.legacy || dependencies.env.CODEMUX_LEGACY_DEV === "1"),
      dependencies,
    );
    backendToRelease = backend;

    const printAccessCode = async (plain: boolean) => {
      const code = await backend.getAccessCode();
      dependencies.write(plain ? code : `${colors.green}[ok]${colors.reset} Access code: ${colors.bold}${code}${colors.reset}`);
    };
    const printRequests = (requests: PendingRequest[]) => {
      if (requests.length === 0) {
        dependencies.write(`${colors.yellow}[!]${colors.reset} No pending requests.`);
      } else {
        dependencies.write(`${colors.green}[ok]${colors.reset} Pending requests (${requests.length}):`);
        for (const request of requests) dependencies.write(`  ${summarizeRequest(request)}`);
      }
    };

    if (command === "access-code") {
      await printAccessCode(Boolean(values.plain));
    } else if (command === "status") {
      await printAccessCode(false);
      printRequests(await backend.listPendingRequests());
    } else {
      const requests = await backend.listPendingRequests();
      if (values.count) {
        dependencies.write(String(requests.length));
      } else if (!dependencies.interactive || requests.length === 0) {
        printRequests(requests);
      } else {
        const prompt = dependencies.createPrompt();
        try {
          for (const request of requests) {
            const fresh = (await backend.listPendingRequests()).find(item => item.id === request.id && item.status === "pending");
            if (!fresh) continue;
            dependencies.write(`\n${colors.bold}Pending request${colors.reset}`);
            dependencies.write(`  ${summarizeRequest(fresh)}`);
            const answer = (await prompt.ask(`${colors.yellow}?${colors.reset} [a]pprove / [d]eny / [s]kip / [q]uit: `)).trim().toLowerCase();
            if (answer === "q" || answer === "quit") {
              dependencies.write(`${colors.yellow}[!]${colors.reset} Stopped processing pending requests.`);
              break;
            }
            let resolved: boolean;
            let action: string;
            if (["a", "approve", "y", "yes"].includes(answer)) {
              resolved = await backend.approveRequest(fresh.id);
              action = "Approved";
            } else if (["d", "deny", "n", "no"].includes(answer)) {
              resolved = await backend.denyRequest(fresh.id);
              action = "Denied";
            } else {
              dependencies.write(`${colors.yellow}[!]${colors.reset} Left request pending: ${fresh.id}`);
              continue;
            }
            dependencies.write(resolved
              ? `${colors.green}[ok]${colors.reset} ${action} request ${fresh.id} for ${fresh.device.name}.`
              : `${colors.yellow}[!]${colors.reset} Request is no longer pending: ${fresh.id}`);
          }
        } finally {
          prompt.close();
        }
      }
    }
  } catch (error) {
    dependencies.error(`${colors.red}[x]${colors.reset} ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    try {
      await backendToRelease?.release?.();
    } catch (error) {
      dependencies.error(`${colors.red}[x]${colors.reset} ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

if (import.meta.main) process.exitCode = await runServerAuthCli(process.argv.slice(2));
