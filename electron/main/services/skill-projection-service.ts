import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EngineType } from "../../../src/types/unified";
import {
  getSkillProjectionManifestsPath,
} from "./app-paths";
import {
  skillRegistryService,
  SkillRegistryService,
  type EffectiveSkillSet,
  type SkillConflict,
} from "./skill-registry-service";
import { skillLog, type ScopedLogger } from "./logger";

export type SkillLoadStrategy =
  | "pass-root-directory"
  | "link-into-discovery-dir"
  | "unsupported";

export interface SkillProjectionResult {
  engineType: EngineType;
  workspaceDirectory: string;
  strategy: SkillLoadStrategy;
  effectiveRoot: string | null;
  skillDirectories: string[];
  projectedRoot: string | null;
  skillNames: string[];
  conflicts: SkillConflict[];
}

export interface SkillProjectionProvider {
  prepareForEngine(engineType: EngineType, workspaceDirectory: string): Promise<SkillProjectionResult>;
  getStrategy(engineType: EngineType): SkillLoadStrategy;
}

export interface SkillProjectionServiceOptions {
  registry?: SkillRegistryService;
  manifestsRoot?: string;
  logger?: ScopedLogger;
}

interface ManagedLinkEntry {
  name: string;
  linkPath: string;
  targetPath: string;
}

interface ProjectionManifest {
  version: 1;
  engineType: EngineType;
  workspaceDirectory: string;
  projectedRoot: string;
  entries: ManagedLinkEntry[];
}

function normalizePathForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function manifestKey(engineType: EngineType, workspaceDirectory: string): string {
  const normalized = path.resolve(workspaceDirectory);
  const hash = createHash("sha256").update(`${engineType}:${normalized.toLowerCase()}`).digest("hex").slice(0, 16);
  return `${engineType}-${hash}.json`;
}

function linkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

function getLoadDirectories(engineType: EngineType, effectiveSet: EffectiveSkillSet): string[] {
  if (effectiveSet.skills.length === 0) return [];
  switch (engineType) {
    case "copilot":
    case "codex":
      return [effectiveSet.effectiveRoot];
    default:
      return [];
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SkillProjectionService implements SkillProjectionProvider {
  private readonly registry: SkillRegistryService;
  private readonly manifestsRoot: string;
  private readonly logger: ScopedLogger;

  constructor(options: SkillProjectionServiceOptions = {}) {
    this.registry = options.registry ?? skillRegistryService;
    this.manifestsRoot = options.manifestsRoot ?? getSkillProjectionManifestsPath();
    this.logger = options.logger ?? skillLog;
  }

  getStrategy(engineType: EngineType): SkillLoadStrategy {
    switch (engineType) {
      case "copilot":
      case "codex":
        return "pass-root-directory";
      case "claude":
      case "opencode":
        return "link-into-discovery-dir";
      default:
        return "unsupported";
    }
  }

  async prepareForEngine(engineType: EngineType, workspaceDirectory: string): Promise<SkillProjectionResult> {
    const strategy = this.getStrategy(engineType);
    if (strategy === "unsupported") {
      return {
        engineType,
        workspaceDirectory: path.resolve(workspaceDirectory),
        strategy,
        effectiveRoot: null,
        skillDirectories: [],
        projectedRoot: null,
        skillNames: [],
        conflicts: [],
      };
    }

    const effectiveSet = await this.registry.buildEffectiveSkillSet(workspaceDirectory);
    if (strategy === "pass-root-directory") {
      return {
        engineType,
        workspaceDirectory: effectiveSet.workspaceDirectory,
        strategy,
        effectiveRoot: effectiveSet.effectiveRoot,
        skillDirectories: getLoadDirectories(engineType, effectiveSet),
        projectedRoot: null,
        skillNames: effectiveSet.skills.map((skill) => skill.name),
        conflicts: effectiveSet.conflicts,
      };
    }

    const projectedRoot = this.getDiscoveryRoot(engineType, effectiveSet.workspaceDirectory);
    const bridgeConflicts = await this.projectIntoDiscoveryRoot(engineType, effectiveSet, projectedRoot);
    return {
      engineType,
      workspaceDirectory: effectiveSet.workspaceDirectory,
      strategy,
      effectiveRoot: effectiveSet.effectiveRoot,
      skillDirectories: [],
      projectedRoot,
      skillNames: effectiveSet.skills.map((skill) => skill.name),
      conflicts: [...effectiveSet.conflicts, ...bridgeConflicts],
    };
  }

  getDiscoveryRoot(engineType: EngineType, workspaceDirectory: string): string | null {
    switch (engineType) {
      case "claude":
        return path.join(workspaceDirectory, ".claude", "skills");
      case "opencode":
        return path.join(workspaceDirectory, ".opencode", "skills");
      default:
        return null;
    }
  }

  private async projectIntoDiscoveryRoot(
    engineType: EngineType,
    effectiveSet: EffectiveSkillSet,
    projectedRoot: string | null,
  ): Promise<SkillConflict[]> {
    if (!projectedRoot) return [];

    await fs.mkdir(projectedRoot, { recursive: true });
    const manifestPath = this.getManifestPath(engineType, effectiveSet.workspaceDirectory);
    const previous = await readJsonFile<ProjectionManifest>(manifestPath);
    const previousEntries = new Map((previous?.entries ?? []).map((entry) => [entry.name, entry]));
    const desiredEntries: ManagedLinkEntry[] = effectiveSet.skills.map((skill) => ({
      name: skill.name,
      linkPath: path.join(projectedRoot, skill.name),
      targetPath: skill.linkPath,
    }));
    const desiredNames = new Set(desiredEntries.map((entry) => entry.name));
    const conflicts: SkillConflict[] = [];

    for (const entry of previous?.entries ?? []) {
      if (desiredNames.has(entry.name)) continue;
      await this.removeManagedLink(entry);
    }

    for (const entry of desiredEntries) {
      const previousEntry = previousEntries.get(entry.name);
      const created = await this.ensureManagedLink(entry, previousEntry);
      if (!created) {
        conflicts.push({
          name: entry.name,
          path: entry.linkPath,
          reason: "discovery-path-conflict",
        });
      }
    }

    const manifest: ProjectionManifest = {
      version: 1,
      engineType,
      workspaceDirectory: effectiveSet.workspaceDirectory,
      projectedRoot,
      entries: desiredEntries.filter((entry) => !conflicts.some((conflict) => samePath(conflict.path, entry.linkPath))),
    };
    await this.writeManifest(manifestPath, manifest);
    await this.updateGitExclude(engineType, effectiveSet.workspaceDirectory, manifest.entries.map((entry) => entry.linkPath));
    return conflicts;
  }

  private async ensureManagedLink(entry: ManagedLinkEntry, previousEntry?: ManagedLinkEntry): Promise<boolean> {
    if (await this.linkPointsTo(entry.linkPath, entry.targetPath)) return true;

    if (previousEntry && await this.linkPointsTo(previousEntry.linkPath, previousEntry.targetPath)) {
      await fs.rm(previousEntry.linkPath, { recursive: true, force: true });
    } else if (await pathExists(entry.linkPath)) {
      this.logger.warn(`Skill projection conflict at ${entry.linkPath}; leaving existing path untouched.`);
      return false;
    }

    try {
      await fs.symlink(path.resolve(entry.targetPath), entry.linkPath, linkType());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to create skill projection ${entry.linkPath}: ${message}`);
      return false;
    }
  }

  private async removeManagedLink(entry: ManagedLinkEntry): Promise<void> {
    if (!await this.linkPointsTo(entry.linkPath, entry.targetPath)) return;
    await fs.rm(entry.linkPath, { recursive: true, force: true });
  }

  private async linkPointsTo(linkPath: string, targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(linkPath);
      if (!stat.isSymbolicLink()) return false;
      const rawTarget = await fs.readlink(linkPath);
      const resolvedTarget = path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(path.dirname(linkPath), rawTarget);
      return samePath(resolvedTarget, targetPath);
    } catch {
      return false;
    }
  }

  private getManifestPath(engineType: EngineType, workspaceDirectory: string): string {
    return path.join(this.manifestsRoot, manifestKey(engineType, workspaceDirectory));
  }

  private async writeManifest(manifestPath: string, manifest: ProjectionManifest): Promise<void> {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const tmpPath = `${manifestPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(tmpPath, manifestPath);
  }

  private async updateGitExclude(engineType: EngineType, workspaceDirectory: string, linkPaths: string[]): Promise<void> {
    const gitContext = await this.resolveGitContext(workspaceDirectory);
    if (!gitContext) return;

    const excludePath = path.join(gitContext.infoPath, "exclude");
    const markerId = manifestKey(engineType, workspaceDirectory).replace(/\.json$/, "");
    const beginMarker = `# CodeMux managed skill projections begin ${markerId}`;
    const endMarker = `# CodeMux managed skill projections end ${markerId}`;
    const patterns = linkPaths
      .map((linkPath) => path.relative(gitContext.workTreeRoot, linkPath).replaceAll("\\", "/"))
      .filter((relativePath) => relativePath && !relativePath.startsWith(".."))
      .map((relativePath) => `/${relativePath}`);

    try {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      let current = "";
      try {
        current = await fs.readFile(excludePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const blockPattern = new RegExp(
        `${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\r?\\n?`,
        "g",
      );
      const nextBlock = patterns.length > 0
        ? `${beginMarker}\n${patterns.join("\n")}\n${endMarker}\n`
        : "";
      const withoutOldBlock = current.replace(blockPattern, "");
      const needsSeparator = withoutOldBlock.length > 0 && !withoutOldBlock.endsWith("\n");
      const next = `${withoutOldBlock}${needsSeparator && nextBlock ? "\n" : ""}${nextBlock}`;
      if (next !== current) {
        await fs.writeFile(excludePath, next, "utf8");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to update Git exclude for skill projections in ${workspaceDirectory}: ${message}`);
    }
  }

  private async resolveGitContext(startDirectory: string): Promise<{ infoPath: string; workTreeRoot: string } | null> {
    let current = path.resolve(startDirectory);
    while (true) {
      const dotGitPath = path.join(current, ".git");
      try {
        const stat = await fs.lstat(dotGitPath);
        if (stat.isDirectory()) return { infoPath: path.join(dotGitPath, "info"), workTreeRoot: current };
        if (stat.isFile()) {
          const raw = await fs.readFile(dotGitPath, "utf8");
          const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
          if (!match) return null;
          const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(current, match[1]);
          return { infoPath: path.join(gitDir, "info"), workTreeRoot: current };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export const skillProjectionService = new SkillProjectionService();
