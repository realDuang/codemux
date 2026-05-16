import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR_NAME = "codemux-server";
const DEV_ISOLATED_DIR = ".codemux-dev";
const DEV_ISOLATED_SERVER_SUBDIR = "server";

export interface BaseOptions {
  /** Environment overrides, primarily for testability. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override `os.homedir()`, primarily for testability. */
  homedir?: string;
}

export interface ServerStateDirOptions extends BaseOptions {
  /** Absolute path to the repository root. */
  repoDir: string;
  /**
   * If true, return the per-repo isolated server state dir
   * (`<repoDir>/.codemux-dev/server/`). If false or omitted, return the
   * machine-global state dir (`<XDG_STATE_HOME>/codemux-server/`) so the
   * single-instance `bun run server:up` flow stays observable from any
   * worktree.
   */
  isolated?: boolean;
}

function resolveHome(options: BaseOptions): string {
  if (options.env?.HOME && options.env.HOME.length > 0) return options.env.HOME;
  if (options.homedir) return options.homedir;
  return os.homedir();
}

/**
 * Machine-global server state root: `<XDG_STATE_HOME or ~/.local/state>/codemux-server`.
 *
 * Used by the default (non-isolated) `server:up` flow so the server presents
 * single-instance semantics across worktrees: starting it in one worktree and
 * checking its status from another both hit the same set of pid/log/url files.
 */
export function getGlobalServerStateRoot(options: BaseOptions = {}): string {
  const env = options.env ?? process.env;
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(resolveHome(options), ".local", "state");
  return path.join(base, SERVER_DIR_NAME);
}

/**
 * Per-repo isolated server state dir: `<repoDir>/.codemux-dev/server`.
 *
 * Used by the `server:dev:isolated` flow (via `dev-isolated.ts --server`),
 * which mirrors `dev:isolated`'s "every worktree is its own world" semantics
 * to the headless server. Lives under the same `.codemux-dev/` root as
 * userData/sessionData/logs/ports.json so a single `git clean -fdx`-style
 * gesture wipes the whole isolated instance.
 */
export function getIsolatedServerStateDir(repoDir: string): string {
  return path.join(path.resolve(repoDir), DEV_ISOLATED_DIR, DEV_ISOLATED_SERVER_SUBDIR);
}

/**
 * Resolve the server's state directory based on the mode.
 *
 * Single source of truth for `scripts/server-dev.sh` (via its CLI entry
 * point) and `scripts/tunnel-manager.ts` (which imports the function
 * directly). Nothing else should hard-code the path.
 */
export function resolveServerStateDir(options: ServerStateDirOptions): string {
  if (options.isolated) {
    return getIsolatedServerStateDir(options.repoDir);
  }
  return getGlobalServerStateRoot(options);
}

/**
 * Read the isolated flag from a CLI args list, an env bag, or both.
 * - Explicit `--isolated` / `--global` flags win.
 * - Otherwise, `CODEMUX_DEV_ISOLATED === "1"` decides.
 */
export function readIsolatedFromArgsAndEnv(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.includes("--isolated")) return true;
  if (args.includes("--global")) return false;
  return env.CODEMUX_DEV_ISOLATED === "1";
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const repoDir = positional[0] ?? process.cwd();
  const isolated = readIsolatedFromArgsAndEnv(args, process.env);
  process.stdout.write(resolveServerStateDir({ repoDir, isolated }));
}
