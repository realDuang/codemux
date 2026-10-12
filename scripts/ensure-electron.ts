import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveElectron(): string | null {
  try {
    return require("electron") as string;
  } catch {
    return null;
  }
}

function runElectronInstall(): void {
  const installScript = require.resolve("electron/install.js");
  const result = spawnSync(process.execPath, [installScript], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "",
    },
  });

  if (result.status !== 0) {
    throw new Error(`electron/install.js failed with exit code ${result.status ?? "unknown"}`);
  }
}

if (!resolveElectron()) {
  console.log("[ensure-electron] Electron binary missing; running electron/install.js");
  runElectronInstall();
}

const electronPath = resolveElectron();
if (!electronPath) {
  throw new Error("Electron failed to install correctly after repair");
}

console.log(`[ensure-electron] Electron binary ready: ${electronPath}`);
