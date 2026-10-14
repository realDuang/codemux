import os from "node:os";
import { parseArgs } from "node:util";
import { callHost, readHostControlMetadata } from "../shared/host-control-client";
import { resolveServerRuntimeConfig, type ServerRuntimeConfigOptions } from "./runtime-config";

export const HOST_CLI_USAGE = `Usage: node out/server/cli.mjs [--data-dir <path>] <command>

Manage the running CodeMux host that owns the selected data directory.

  status                              Show runtime status (safe while stopped)
  stop                                Stop the running host
  access-code [--plain]                Show the current access code
  pending [--count]                    List pending access requests
  approve <request-id>                 Approve a pending device
  deny <request-id>                    Deny a pending device
  remote-access get                   Show remote access status
  remote-access update --args <json>   Apply a remote access object patch
  settings get                        Read host settings
  settings patch --args <json>         Apply a settings object patch
  channels list                       List messaging channels
  channels status|get <type>           Read channel status or configuration
  channels update <type> --args <json>  Apply a channel configuration patch
  channels start|stop <type>           Start or stop a channel
  channels logout weixin-ilink         Log out the Weixin channel
  call <method> [--args <json-array>]   Invoke another local host operation
  help                                Show this help

Uses the server's platform data directory or CODEMUX_DATA_DIR by default.
Commands contact the running owner; they never modify data files directly.
Secret configuration values are redacted from command output.`;

export interface HostCliCommand {
  kind: "help" | "status" | "call";
  dataDir?: string;
  method?: string;
  args: unknown[];
  output?: "plain" | "count";
}

function parseJson(text: string | undefined, array: boolean): unknown[] | Record<string, unknown> {
  if (text === undefined) {
    if (array) return [];
    throw new Error("This command requires --args with a JSON object.");
  }
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in --args.");
  }
  if (array ? !Array.isArray(result) : !result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`--args must be a JSON ${array ? "array" : "object"}.`);
  }
  return result as unknown[] | Record<string, unknown>;
}

export function parseHostCliCommand(argv: string[]): HostCliCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "data-dir": { type: "string" },
      args: { type: "string" },
      plain: { type: "boolean" },
      count: { type: "boolean" },
    },
  });
  if (values["data-dir"] === "") throw new Error("--data-dir must not be empty.");
  const base = { dataDir: values["data-dir"], args: [] };
  if (values.help) return { ...base, kind: "help" };
  const [command = "help", action, target, ...extra] = positionals;
  if (extra.length) throw new Error("Too many command arguments.");

  const expectArguments = (count: number) => {
    if (positionals.length !== count) throw new Error(`Invalid arguments for ${command}. Run help for usage.`);
  };
  if (values.plain && command !== "access-code") throw new Error("--plain is only valid with access-code.");
  if (values.count && command !== "pending") throw new Error("--count is only valid with pending.");
  const usesJson = command === "call" || action === "update" || (command === "settings" && action === "patch");
  if (values.args !== undefined && !usesJson) throw new Error("--args is not valid for this command.");

  const operation = (method: string, args: unknown[] = []): HostCliCommand => ({ ...base, kind: "call", method, args });
  switch (command) {
    case "help":
      if (positionals.length > 1) throw new Error("Run help without additional arguments.");
      return { ...base, kind: "help" };
    case "status":
      expectArguments(1);
      return { ...base, kind: "status", method: "host:status" };
    case "stop":
      expectArguments(1);
      return operation("host:stop");
    case "access-code":
      expectArguments(1);
      return { ...operation("auth:getAccessCode"), output: values.plain ? "plain" : undefined };
    case "pending":
      expectArguments(1);
      return { ...operation("auth:getPendingRequests"), output: values.count ? "count" : undefined };
    case "approve":
    case "deny":
      expectArguments(2);
      return operation(command === "approve" ? "auth:approveRequest" : "auth:denyRequest", [action]);
    case "remote-access":
      expectArguments(2);
      if (action === "get") return operation("remoteAccess:getStatus");
      if (action === "update") return operation("remoteAccess:update", [parseJson(values.args, false)]);
      break;
    case "settings":
      expectArguments(2);
      if (action === "get") return operation("settings:load");
      if (action === "patch") return operation("settings:save", [parseJson(values.args, false)]);
      break;
    case "channels": {
      expectArguments(action === "list" ? 2 : 3);
      if (action === "list") return operation("channel:list");
      if (action === "logout") {
        if (target !== "weixin-ilink") throw new Error("Channel logout is available for weixin-ilink.");
        return operation("channel:weixin-ilink:logout");
      }
      const methods: Record<string, string> = {
        status: "channel:getStatus", get: "channel:getConfig", update: "channel:updateConfig",
        start: "channel:start", stop: "channel:stop",
      };
      if (action && Object.hasOwn(methods, action)) {
        return operation(methods[action], action === "update" ? [target, parseJson(values.args, false)] : [target]);
      }
      break;
    }
    case "call":
      expectArguments(2);
      return operation(action, parseJson(values.args, true) as unknown[]);
  }
  throw new Error(`Unknown command: ${positionals.join(" ")}. Run help for usage.`);
}

export function resolveCliDataPath(dataDir?: string, options?: ServerRuntimeConfigOptions): string {
  const runtimeOptions = options ?? {
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    platform: process.platform,
    appPath: process.cwd(),
  };
  return resolveServerRuntimeConfig({
    ...runtimeOptions,
    env: { ...runtimeOptions.env, ...(dataDir !== undefined ? { CODEMUX_DATA_DIR: dataDir } : {}) },
  }).userDataPath;
}

/** Keep CLI output safe even for the generic call command and nested channel arrays. */
export function redactCliOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCliOutput);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  const configured: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (/secret|password|token|aeskey|credential/i.test(key) && typeof child === "string") {
      output[key] = "";
      if (child) configured.push(key);
    } else {
      output[key] = redactCliOutput(child);
    }
  }
  if (configured.length) {
    const existing = Array.isArray(output.secretsConfigured) ? output.secretsConfigured : [];
    output.secretsConfigured = [...new Set([...existing, ...configured])];
  }
  return output;
}

export interface HostCliDependencies {
  call: typeof callHost;
  readMetadata: typeof readHostControlMetadata;
  resolveDataPath: typeof resolveCliDataPath;
  write: (message: string) => void;
  error: (message: string) => void;
}

export async function runHostCli(argv: string[], overrides: Partial<HostCliDependencies> = {}): Promise<number> {
  const dependencies: HostCliDependencies = {
    call: callHost, readMetadata: readHostControlMetadata, resolveDataPath: resolveCliDataPath,
    write: console.log, error: console.error, ...overrides,
  };
  try {
    const command = parseHostCliCommand(argv);
    if (command.kind === "help") {
      dependencies.write(HOST_CLI_USAGE);
      return 0;
    }
    const dataPath = dependencies.resolveDataPath(command.dataDir);
    if (command.kind === "status" && !await dependencies.readMetadata(dataPath)) {
      dependencies.write(JSON.stringify({ running: false, state: "stopped", dataPath }, null, 2));
      return 0;
    }
    const result = await dependencies.call(dataPath, command.method!, command.args);
    if (command.output === "plain") {
      if (typeof result !== "string") throw new Error("The host returned an invalid access code response.");
      dependencies.write(result);
    } else if (command.output === "count") {
      if (!Array.isArray(result)) throw new Error("The host returned an invalid pending requests response.");
      dependencies.write(String(result.length));
    } else {
      dependencies.write(JSON.stringify(redactCliOutput(result ?? null), null, 2));
    }
    return 0;
  } catch (error) {
    dependencies.error(`CodeMux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
