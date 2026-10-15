import { execFileSync } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveCodexCliPath, resolveCodexCliVersion } from "./config";
import { normalizeCodexRuntimeVersion, readCodexRolloutMetadata } from "./rollout-reader";

export interface CodexRuntimeIdentity {
  cliPath: string;
  version: string;
  source: "cli" | "desktop" | "configured";
}

export interface CodexRuntimeResolverOptions {
  codexHome?: string;
  /** Additional installed executables, never downloaded or rewritten here. */
  cliPaths?: string[];
  preferDesktop?: boolean;
  readThreadMetadata?: (threadId: string) => Promise<Record<string, unknown>>;
}

export class CodexRuntimeCompatibilityError extends Error {
  readonly code = "CODEX_RUNTIME_INCOMPATIBLE";
  constructor(readonly threadId: string, readonly requiredVersion?: string) {
    super(requiredVersion
      ? `This Codex conversation requires CLI ${requiredVersion}. Install that exact version or continue in its existing execution client. Its history remains readable.`
      : "The original Codex runtime version could not be verified. Continue in its existing execution client; CodeMux will keep the history read-only.");
    this.name = "CodexRuntimeCompatibilityError";
  }
}

/** Resolve an existing thread before acquiring its writer; never guess across versions. */
export class CodexRuntimeResolver {
  constructor(private readonly options: CodexRuntimeResolverOptions = {}) {}

  async resolve(threadId?: string, suppliedMetadata?: Record<string, unknown>): Promise<CodexRuntimeIdentity> {
    let requiredVersion: string | undefined;
    if (threadId) {
      const metadata = suppliedMetadata ?? await this.options.readThreadMetadata?.(threadId);
      requiredVersion = metadata && (await readCodexRolloutMetadata(threadId, metadata, this.options.codexHome))?.cliVersion;
      if (!requiredVersion) throw new CodexRuntimeCompatibilityError(threadId);
    }
    const candidates = await this.candidates();
    const inspected = new Set<string>();
    for (const candidate of candidates) {
      let cliPath: string;
      try { cliPath = await realpath(candidate.cliPath); } catch { continue; }
      if (inspected.has(cliPath)) continue;
      inspected.add(cliPath);
      const version = normalizeCodexRuntimeVersion(resolveCodexCliVersion(cliPath));
      if (version && (!requiredVersion || requiredVersion === version)) return { ...candidate, cliPath, version };
    }
    if (threadId) throw new CodexRuntimeCompatibilityError(threadId, requiredVersion);
    throw new Error("Codex CLI not found. Install `codex` and ensure it is in PATH.");
  }

  private async candidates(): Promise<Array<Omit<CodexRuntimeIdentity, "version">>> {
    const candidates: Array<Omit<CodexRuntimeIdentity, "version">> = [];
    const add = (cliPath: string | undefined, source: CodexRuntimeIdentity["source"]) => {
      if (cliPath && isAbsolute(cliPath)) candidates.push({ cliPath, source });
    };
    const desktop = this.options.preferDesktop ? detectRunningDesktopCodexPaths() : [];
    for (const path of desktop) add(path, "desktop");
    for (const path of this.options.cliPaths ?? []) add(path, "configured");
    add(resolveCodexCliPath(), "cli");
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (directory && isAbsolute(directory)) add(join(directory, name), "cli");
    }
    // The standalone installer retains immutable versioned runtimes here.
    const releases = join(this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "packages", "standalone", "releases");
    try {
      const entries = (await readdir(releases, { withFileTypes: true })).filter(entry => entry.isDirectory()).slice(0, 100);
      for (const entry of entries) add(join(releases, entry.name, "bin", name), "cli");
    } catch { /* Standalone releases are optional. */ }
    if (process.platform === "darwin") {
      for (const app of ["Codex", "ChatGPT"]) {
        for (const root of ["/Applications", join(homedir(), "Applications")]) {
          add(join(root, `${app}.app`, "Contents", "Resources", "codex-cli", "bin", "codex"), "desktop");
          add(join(root, `${app}.app`, "Contents", "Resources", "codex"), "desktop");
        }
      }
    }
    return candidates;
  }
}

/** Read executable ancestry only, never command arguments or application settings. */
export function detectRunningDesktopCodexPaths(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const output = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,comm="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDesktopCodexProcessPaths(output);
  } catch { return []; }
}

export function parseDesktopCodexProcessPaths(output: string): string[] {
  const processes = output.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: match[1], parent: match[2], executable: match[3] }] : [];
  });
  const desktopIds = new Set(processes.filter(entry => /\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(entry.executable)).map(entry => entry.pid));
  return [...new Set(processes.filter(entry => desktopIds.has(entry.parent) && /\/codex$/.test(entry.executable)).map(entry => entry.executable))];
}
