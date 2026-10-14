#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { repairNodePtyPermissions } from "./prepare-native";

interface SourceManifest {
  name: string;
  version: string;
  description?: string;
  author?: unknown;
  repository?: unknown;
  license?: string;
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface PackageCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureOutput?: boolean;
}

export interface PackServerOptions {
  repositoryRoot: string;
  /** Parent directory; each package gets a version/platform/architecture subdirectory. */
  outputDirectory?: string;
  platform?: string;
  arch?: string;
  nodeExecutable?: string;
  bunExecutable?: string;
  runCommand?: (command: PackageCommand) => Promise<string>;
}

async function runCommand(options: PackageCommand): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (options.captureOutput) output += chunk;
      else process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveResult(output);
      else reject(new Error(`${options.command} failed (${signal ?? code}).`));
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function assertNativePackageTarget(platform: string, arch: string): void {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported server package target: ${platform}-${arch}.`);
  }
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`Build ${platform}-${arch} on that target OS and architecture; host node_modules cannot be cross-packaged.`);
  }
}

export function createServerManifest(source: SourceManifest) {
  return {
    name: "codemux-server",
    version: source.version,
    private: true,
    type: "module",
    description: source.description,
    author: source.author,
    repository: source.repository,
    license: source.license,
    main: "out/server/index.mjs",
    engines: { node: ">=24" },
    scripts: { start: "node out/server/index.mjs", ctl: "node out/server/cli.mjs" },
    dependencies: source.dependencies,
    ...(source.optionalDependencies ? { optionalDependencies: source.optionalDependencies } : {}),
  };
}

const NATIVE_CHECK = `
const { createRequire } = require('node:module');
const { join, dirname } = require('node:path');
const { existsSync, accessSync, constants } = require('node:fs');
const root = process.cwd();
const load = createRequire(join(root, 'package.json'));
load('node-pty');
load('@parcel/watcher');
const executable = process.platform === 'win32' ? '.exe' : '';
const copilotPackage = '@github/copilot-' + process.platform + '-' + process.arch;
const copilotCandidates = [
  join(root, 'node_modules', copilotPackage, 'copilot' + executable),
  join(root, 'node_modules', '@github/copilot/node_modules', copilotPackage, 'copilot' + executable),
];
const copilot = copilotCandidates.find(existsSync);
if (!copilot) throw new Error('The target Copilot native executable is missing. Keep optional dependencies enabled.');
accessSync(copilot, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
const claudePackage = '@anthropic-ai/claude-agent-sdk-' + process.platform + '-' + process.arch;
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const claudePackages = musl ? [claudePackage + '-musl', claudePackage] : [claudePackage];
let claude;
for (const name of claudePackages) {
  try { claude = join(dirname(load.resolve(name + '/package.json')), 'claude' + executable); break; }
  catch {}
}
if (!claude) throw new Error('The target Claude native executable is missing. Keep optional dependencies enabled.');
accessSync(claude, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch }));
`;

/** Build a ready-to-run directory from frozen target-native production dependencies. */
export async function packServer(options: PackServerOptions): Promise<string> {
  const root = resolve(options.repositoryRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertNativePackageTarget(platform, arch);
  const manifestText = await readFile(join(root, "package.json"), "utf8");
  const source = JSON.parse(manifestText) as SourceManifest;
  if (!source.version || !/^[\w.+-]+$/.test(source.version) || !source.dependencies?.["node-pty"]) {
    throw new Error("The repository package manifest is not a valid CodeMux server source.");
  }
  const lock = await readFile(join(root, "bun.lock"));
  for (const file of ["out/server/index.mjs", "out/server/cli.mjs", "out/web/index.html"]) {
    if (!(await lstat(join(root, file)).catch(() => undefined))?.isFile()) {
      throw new Error(`Missing built artifact ${file}. Run bun run build:server-app first.`);
    }
  }

  const output = resolve(options.outputDirectory ?? join(root, "release"));
  const destination = join(output, `codemux-server-${source.version}-${platform}-${arch}`);
  if (await exists(destination)) throw new Error(`Package destination already exists: ${destination}`);
  const command = options.runCommand ?? runCommand;
  const node = options.nodeExecutable ?? "node";
  const bun = options.bunExecutable ?? "bun";
  const env = { ...process.env };
  // Desktop build flags must not produce an Electron ABI or foreign-architecture addon.
  for (const key of [
    "ELECTRON_RUN_AS_NODE", "npm_config_runtime", "npm_config_target", "npm_config_arch",
    "npm_config_target_arch", "npm_config_platform", "npm_config_target_platform", "npm_config_disturl", "npm_config_nodedir",
  ]) delete env[key];
  const runtime = JSON.parse(await command({
    command: node,
    args: ["-p", "JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})"],
    cwd: root, env, captureOutput: true,
  })) as { node: string; platform: string; arch: string };
  if (Number(runtime.node.split(".")[0]) < 24 || runtime.platform !== platform || runtime.arch !== arch) {
    throw new Error(`Server packaging requires Node 24 or newer for ${platform}-${arch}.`);
  }

  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, ".codemux-server-"));
  try {
    await mkdir(join(staging, "scripts"));
    await writeFile(join(staging, "package.json"), manifestText);
    await writeFile(join(staging, "bun.lock"), lock);
    await cp(join(root, "scripts/prepare-native.ts"), join(staging, "scripts/prepare-native.ts"));
    // Keep the source manifest intact until frozen installation completes. Its root
    // postinstall only prepares native helpers; no desktop dependencies are installed.
    await command({ command: bun, args: ["install", "--production", "--frozen-lockfile", "--backend=copyfile"], cwd: staging, env });
    if (await exists(join(staging, "node_modules/electron"))) {
      throw new Error("The server production payload unexpectedly contains Electron.");
    }
    await repairNodePtyPermissions(staging);
    await command({ command: node, args: ["-e", NATIVE_CHECK], cwd: staging, env, captureOutput: true });
    await mkdir(join(staging, "out"));
    // Finish each copy before cleanup can run; an early Promise.all rejection
    // would leave other copies racing the removal of this private staging tree.
    await cp(join(root, "out/server"), join(staging, "out/server"), { recursive: true });
    await cp(join(root, "out/web"), join(staging, "out/web"), { recursive: true });
    await writeFile(join(staging, "package.json"), `${JSON.stringify(createServerManifest(source), null, 2)}\n`);
    await writeFile(join(staging, "README.md"), `# CodeMux Server ${source.version}\n\n`
        + `Built for ${platform}-${arch} with Node ${runtime.node}. Requires Node 24 or newer and this platform's native system libraries.\n\n`
        + "Dependencies are installed from the source lockfile; run this directory directly without an additional install.\n\n"
        + "```sh\nnode out/server/index.mjs\nnode out/server/cli.mjs status\n```\n\n"
        + "Use --data-dir to select an existing CodeMux data directory. Keep that directory outside this installation. Stop the owner before replacing or rolling back this package, and reuse the same data directory.\n\n"
        + "OpenCode, Codex, Git, and optional cloudflared use the existing system PATH. Claude and Copilot native packages are included. Engine authentication stays in the user's existing configuration.\n\n"
        + `Source bun.lock SHA-256: ${createHash("sha256").update(lock).digest("hex")}\n`);
    // The delivered package is already installed. The original lock's development
    // workspace no longer matches its intentionally smaller runtime manifest.
    await rm(join(staging, "bun.lock"));
    await rm(join(staging, "scripts"), { recursive: true });
    if (await exists(destination)) throw new Error(`Package destination already exists: ${destination}`);
    await rename(staging, destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    output: { type: "string" }, platform: { type: "string" }, arch: { type: "string" },
  } });
  if (values.help) {
    console.log("Usage: bun scripts/pack-server.ts [--output <parent-directory>] [--platform <os>] [--arch <architecture>]\nBuild on the target OS/architecture after bun run build:server-app. Requires Node 24+, Bun, and native build tools on Linux.");
  } else {
    const destination = await packServer({
      repositoryRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      outputDirectory: values.output,
      platform: values.platform ?? process.env.TARGET_PLATFORM,
      arch: values.arch ?? process.env.TARGET_ARCH,
    });
    console.log(`Server package ready: ${destination}`);
  }
}
