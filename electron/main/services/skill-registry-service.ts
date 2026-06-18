import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  getGlobalSkillsPath,
  getSkillEffectiveRootsPath,
} from "./app-paths";
import { loadSettings, skillLog, type ScopedLogger } from "./logger";

export type SkillScope = "builtin" | "global" | "project";

export interface SkillRecord {
  name: string;
  scope: SkillScope;
  rootPath: string;
  skillPath: string;
  skillFilePath: string;
}

export interface EffectiveSkillRecord extends SkillRecord {
  linkPath: string;
}

export interface EffectiveSkillSet {
  workspaceDirectory: string;
  effectiveRoot: string;
  skills: EffectiveSkillRecord[];
  conflicts: SkillConflict[];
}

export interface SkillConflict {
  name: string;
  path: string;
  reason: string;
}

export interface SkillRegistryServiceOptions {
  builtinSkillsRoot?: string;
  globalSkillsRoot?: string;
  effectiveRootsRoot?: string;
  loadSettings?: () => Record<string, unknown>;
  logger?: ScopedLogger;
}

const PROJECT_SKILLS_RELATIVE_PATH = [".codemux", "skills"];
const PROJECT_SKILLS_CONFIG_RELATIVE_PATH = [".codemux", "skills.json"];
const SKILL_FILE_NAME = "SKILL.md";

function workspaceKey(directory: string): string {
  const normalized = path.resolve(directory);
  const hash = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 12);
  const baseName = path.basename(normalized).replace(/[^a-zA-Z0-9._-]/g, "-") || "workspace";
  return `${baseName}-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readDisabledSkills(settings: Record<string, unknown>): Set<string> {
  const skillsSettings = isRecord(settings.skills) ? settings.skills : {};
  const disabled = settings.disabled ?? settings.disabledSkills ?? skillsSettings.disabled ?? skillsSettings.disabledSkills;
  if (!Array.isArray(disabled)) return new Set();
  return new Set(disabled.filter((name): name is string => typeof name === "string" && name.length > 0));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string, logger: ScopedLogger): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to read skill config ${filePath}: ${message}`);
    }
    return {};
  }
}

function linkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

export class SkillRegistryService {
  private readonly builtinSkillsRoot: string;
  private readonly globalSkillsRoot: string;
  private readonly effectiveRootsRoot: string;
  private readonly settingsLoader: () => Record<string, unknown>;
  private readonly logger: ScopedLogger;

  constructor(options: SkillRegistryServiceOptions = {}) {
    this.builtinSkillsRoot = options.builtinSkillsRoot ?? path.join(process.resourcesPath ?? process.cwd(), "skills");
    this.globalSkillsRoot = options.globalSkillsRoot ?? getGlobalSkillsPath();
    this.effectiveRootsRoot = options.effectiveRootsRoot ?? getSkillEffectiveRootsPath();
    this.settingsLoader = options.loadSettings ?? loadSettings;
    this.logger = options.logger ?? skillLog;
  }

  getRootPath(scope: SkillScope, workspaceDirectory?: string): string {
    switch (scope) {
      case "builtin":
        return this.builtinSkillsRoot;
      case "global":
        return this.globalSkillsRoot;
      case "project":
        if (!workspaceDirectory) {
          throw new Error("workspaceDirectory is required for project-scoped skills");
        }
        return path.join(workspaceDirectory, ...PROJECT_SKILLS_RELATIVE_PATH);
    }
  }

  getEffectiveRoot(workspaceDirectory: string): string {
    return path.join(this.effectiveRootsRoot, workspaceKey(workspaceDirectory));
  }

  async listSkillRoots(workspaceDirectory: string): Promise<Array<{ scope: SkillScope; path: string }>> {
    return [
      { scope: "builtin", path: this.builtinSkillsRoot },
      { scope: "global", path: this.globalSkillsRoot },
      { scope: "project", path: this.getRootPath("project", workspaceDirectory) },
    ];
  }

  async listSkills(workspaceDirectory: string): Promise<SkillRecord[]> {
    const roots = await this.listSkillRoots(workspaceDirectory);
    const skills: SkillRecord[] = [];
    for (const root of roots) {
      skills.push(...await this.scanRoot(root.scope, root.path));
    }
    return skills;
  }

  async buildEffectiveSkillSet(workspaceDirectory: string): Promise<EffectiveSkillSet> {
    const resolvedWorkspace = path.resolve(workspaceDirectory);
    const settings = this.settingsLoader();
    const disabled = readDisabledSkills(settings);
    const projectSettings = await readJsonFile(path.join(resolvedWorkspace, ...PROJECT_SKILLS_CONFIG_RELATIVE_PATH), this.logger);
    const projectDisabled = readDisabledSkills(projectSettings);
    for (const name of projectDisabled) disabled.add(name);

    const allSkills = await this.listSkills(resolvedWorkspace);
    const selected = this.selectEffectiveSkills(allSkills, disabled);
    const effectiveRoot = this.getEffectiveRoot(resolvedWorkspace);
    const conflicts: SkillConflict[] = [];

    await fs.rm(effectiveRoot, { recursive: true, force: true });
    await fs.mkdir(effectiveRoot, { recursive: true });
    await fs.writeFile(path.join(effectiveRoot, ".codemux-managed"), "This directory is managed by CodeMux.\n", "utf8");

    const effectiveSkills: EffectiveSkillRecord[] = [];
    for (const skill of selected) {
      const linkPath = path.join(effectiveRoot, skill.name);
      try {
        await fs.symlink(path.resolve(skill.skillPath), linkPath, linkType());
        effectiveSkills.push({ ...skill, linkPath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to expose skill ${skill.name} in effective root: ${message}`);
        conflicts.push({ name: skill.name, path: linkPath, reason: `link-failed: ${message}` });
      }
    }

    return {
      workspaceDirectory: resolvedWorkspace,
      effectiveRoot,
      skills: effectiveSkills,
      conflicts,
    };
  }

  async deleteSkill(scope: Exclude<SkillScope, "builtin">, name: string, workspaceDirectory?: string): Promise<void> {
    this.validateSkillName(name);
    const root = this.getRootPath(scope, workspaceDirectory);
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }

  private async scanRoot(scope: SkillScope, rootPath: string): Promise<SkillRecord[]> {
    if (!await pathExists(rootPath)) return [];

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to scan skill root ${rootPath}: ${message}`);
      return [];
    }

    const skills: SkillRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (!this.isValidSkillName(name)) {
        this.logger.warn(`Ignoring invalid skill directory name ${name} in ${rootPath}`);
        continue;
      }

      const skillPath = path.join(rootPath, name);
      const skillFilePath = path.join(skillPath, SKILL_FILE_NAME);
      if (!await pathExists(skillFilePath)) continue;

      skills.push({
        name,
        scope,
        rootPath,
        skillPath,
        skillFilePath,
      });
    }
    return skills;
  }

  private selectEffectiveSkills(skills: SkillRecord[], disabled: Set<string>): SkillRecord[] {
    const priority: Record<SkillScope, number> = {
      builtin: 0,
      global: 1,
      project: 2,
    };
    const selected = new Map<string, SkillRecord>();
    for (const skill of skills) {
      if (disabled.has(skill.name)) continue;
      const existing = selected.get(skill.name);
      if (!existing || priority[skill.scope] > priority[existing.scope]) {
        selected.set(skill.name, skill);
      }
    }
    return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private validateSkillName(name: string): void {
    if (!this.isValidSkillName(name)) {
      throw new Error(`Invalid skill name: ${name}`);
    }
  }

  private isValidSkillName(name: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
  }
}

export const skillRegistryService = new SkillRegistryService();
