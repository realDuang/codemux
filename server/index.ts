import { parseArgs } from "node:util";
import { configureServerRuntimeEnvironment, serverRuntimeRole } from "./runtime-role";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    port: { type: "string" },
    "data-dir": { type: "string" },
    "logs-dir": { type: "string" },
    "devices-file": { type: "string" },
    "app-dir": { type: "string" },
    "legacy-dev": { type: "boolean" },
  },
});

if (values.help) {
  console.log(`Usage: node out/server/index.mjs [options]

Run the complete CodeMux server without Electron or a display session.

  --port <port>          HTTP and WebSocket port (default: 8233)
  --data-dir <path>      Existing or new CodeMux user data directory
  --logs-dir <path>      Override the log directory
  --devices-file <path>  Preserve an existing device identity file
  --app-dir <path>       Installation root containing out/web
  --legacy-dev          Preserve the legacy cwd/.devices.json identity path
  --help                Show this help

Stop with SIGINT or SIGTERM. Only one host may own a data directory.`);
} else {
  configureServerRuntimeEnvironment(serverRuntimeRole, process.env, process.platform);
  const overrides = {
    CODEMUX_WEB_PORT: values.port,
    CODEMUX_DATA_DIR: values["data-dir"],
    CODEMUX_LOGS_DIR: values["logs-dir"],
    CODEMUX_DEVICES_FILE: values["devices-file"],
    CODEMUX_APP_PATH: values["app-dir"],
    CODEMUX_LEGACY_DEV: values["legacy-dev"] ? "1" : undefined,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[name] = value;
  }

  // Services read paths/settings during import; apply the CLI configuration first.
  const { startServer } = await import("./bootstrap");
  await startServer();
}
