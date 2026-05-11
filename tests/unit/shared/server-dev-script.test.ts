import { describe, it, expect } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_SCRIPT = path.join(process.cwd(), "scripts", "server-dev.sh");

const FAKE_BUN = `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "dev" ]; then
  echo "http://localhost:8233/"
  trap 'exit 0' TERM INT
  while true; do
    sleep 1
  done
elif [ "\${1:-}" = "scripts/server-auth.ts" ] && [ "\${2:-}" = "access-code" ]; then
  if [ "\${3:-}" = "--plain" ]; then
    echo "123456"
  else
    echo "[ok] Access code: 123456"
  fi
elif [ "\${1:-}" = "scripts/server-auth.ts" ] && [ "\${2:-}" = "access-requests" ]; then
  if [ "\${3:-}" = "--count" ]; then
    echo "0"
  else
    echo "[!] No pending requests."
  fi
else
  echo "Unexpected bun args: $*" >&2
  exit 1
fi
`;

const FAKE_DBUS_RUN_SESSION = `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "--" ]; then
  shift
fi

exec "$@"
`;

const FAKE_XVFB_RUN = `#!/usr/bin/env bash
set -euo pipefail

while [ "$#" -gt 0 ]; do
  case "$1" in
    --auto-servernum|--listen-tcp)
      shift
      ;;
    --server-args=*|--server-num=*|-s|-n)
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

exec "$@"
`;

const FAKE_CLOUDFLARED = `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "tunnel" ] && [ "\${2:-}" = "--url" ]; then
  echo "2024-01-01 INFO | https://same-tunnel.trycloudflare.com connected"
  trap 'exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

echo "Unexpected cloudflared args: $*" >&2
exit 1
`;

const FAKE_CURL = `#!/usr/bin/env bash
exit 1
`;

interface TestRepo {
  env: NodeJS.ProcessEnv;
  root: string;
  scriptPath: string;
  stateDir: string;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function createTestRepo(): Promise<TestRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "codemux-server-dev-"));
  const home = path.join(root, "home");
  const bunBin = path.join(home, ".bun", "bin");
  const stateDir = path.join(root, "state", "codemux-server");
  const scriptPath = path.join(root, "scripts", "server-dev.sh");

  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(bunBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await copyFile(SOURCE_SCRIPT, scriptPath);
  await chmod(scriptPath, 0o755);

  await writeExecutable(path.join(bunBin, "bun"), FAKE_BUN);
  await writeExecutable(path.join(bunBin, "dbus-run-session"), FAKE_DBUS_RUN_SESSION);
  await writeExecutable(path.join(bunBin, "xvfb-run"), FAKE_XVFB_RUN);
  await writeExecutable(path.join(bunBin, "cloudflared"), FAKE_CLOUDFLARED);
  await writeExecutable(path.join(bunBin, "curl"), FAKE_CURL);

  return {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bunBin}:${process.env.PATH ?? ""}`,
      XDG_STATE_HOME: path.join(root, "state"),
      CODEMUX_SERVER_START_TIMEOUT: "10",
    },
    root,
    scriptPath,
    stateDir,
  };
}

async function runServerScript(repo: TestRepo, ...args: string[]) {
  return execFileAsync("bash", [repo.scriptPath, ...args], {
    cwd: repo.root,
    env: repo.env,
    timeout: 20_000,
  });
}

async function readStateFile(repo: TestRepo, fileName: string): Promise<string> {
  return (await readFile(path.join(repo.stateDir, fileName), "utf8")).trim();
}

function isPidRunning(pidText: string): boolean {
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidOrGroup(pidText: string | null): void {
  if (!pidText) {
    return;
  }

  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the process itself.
    }

    try {
      process.kill(pid, signal);
      return;
    } catch {
      // Process may already be gone.
    }
  }
}

async function cleanupRepo(repo: TestRepo): Promise<void> {
  try {
    await runServerScript(repo, "stop");
  } catch {
    // Best-effort cleanup below handles leftover processes.
  }

  const pidFiles = ["dev.pid", "tunnel.pid"] as const;
  for (const fileName of pidFiles) {
    const filePath = path.join(repo.stateDir, fileName);
    if (existsSync(filePath)) {
      killPidOrGroup(await readStateFile(repo, fileName));
    }
  }

  await rm(repo.root, { recursive: true, force: true });
}

describe("scripts/server-dev.sh", () => {
  it(
    "restarts the managed app without rotating the managed quick tunnel",
    async () => {
      const repo = await createTestRepo();
      try {
        const startResult = await runServerScript(repo, "start", "--replace", "--tunnel");
        expect(startResult.stdout).toContain("Tunnel is ready: https://same-tunnel.trycloudflare.com");

        const initialAppPid = await readStateFile(repo, "dev.pid");
        const initialTunnelPid = await readStateFile(repo, "tunnel.pid");
        const initialTunnelUrl = await readStateFile(repo, "tunnel-url");

        expect(isPidRunning(initialAppPid)).toBe(true);
        expect(isPidRunning(initialTunnelPid)).toBe(true);
        expect(initialTunnelUrl).toBe("https://same-tunnel.trycloudflare.com");

        const restartResult = await runServerScript(repo, "restart");
        const restartedAppPid = await readStateFile(repo, "dev.pid");
        const restartedTunnelPid = await readStateFile(repo, "tunnel.pid");
        const restartedTunnelUrl = await readStateFile(repo, "tunnel-url");

        expect(restartResult.stdout).toContain("Preserved managed Cloudflare tunnel.");
        expect(restartResult.stdout).toContain("Public URL should stay the same");
        expect(restartedAppPid).not.toBe(initialAppPid);
        expect(restartedTunnelPid).toBe(initialTunnelPid);
        expect(restartedTunnelUrl).toBe(initialTunnelUrl);
        expect(isPidRunning(restartedAppPid)).toBe(true);
        expect(isPidRunning(restartedTunnelPid)).toBe(true);
      } finally {
        await cleanupRepo(repo);
      }
    },
    20_000,
  );

  it(
    "restarts cleanly when no managed tunnel is running",
    async () => {
      const repo = await createTestRepo();
      try {
        const startResult = await runServerScript(repo, "start", "--replace");
        expect(startResult.stdout).toContain("CodeMux dev is ready: http://localhost:8233");

        const initialAppPid = await readStateFile(repo, "dev.pid");
        expect(isPidRunning(initialAppPid)).toBe(true);

        const restartResult = await runServerScript(repo, "restart");
        const restartedAppPid = await readStateFile(repo, "dev.pid");

        expect(restartResult.stdout).toContain("No managed Cloudflare tunnel was running.");
        expect(restartedAppPid).not.toBe(initialAppPid);
        expect(isPidRunning(restartedAppPid)).toBe(true);
      } finally {
        await cleanupRepo(repo);
      }
    },
    20_000,
  );
});
