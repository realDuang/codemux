import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  getGlobalSkillsPath,
  getSkillEffectiveRootsPath,
} from "./app-paths";
import { loadSettings, saveSettings, skillLog, type ScopedLogger } from "./logger";
import type {
  SkillMutableScope,
  SkillScope as UnifiedSkillScope,
  SkillScopedInstance,
  SkillSummary,
} from "../../../src/types/unified";

export type SkillScope = UnifiedSkillScope;

export interface SkillRecord {
  name: string;
  scope: SkillScope;
  rootPath: string;
  skillPath: string;
  skillFilePath: string;
  description?: string;
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
  saveSettings?: (patch: Record<string, unknown>) => void;
  logger?: ScopedLogger;
}

const PROJECT_SKILLS_RELATIVE_PATH = [".codemux", "skills"];
const PROJECT_SKILLS_CONFIG_RELATIVE_PATH = [".codemux", "skills.json"];
const SKILL_FILE_NAME = "SKILL.md";
const SKILL_SCOPE_PRIORITY: Record<SkillScope, number> = {
  builtin: 0,
  global: 1,
  project: 2,
};
const SKILL_SCOPE_DISPLAY_ORDER: SkillScope[] = ["project", "global", "builtin"];

function workspaceKey(directory: string): string {
  const normalized = path.resolve(directory);
  const hash = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 12);
  const baseName = path.basename(normalized).replace(/[^a-zA-Z0-9._-]/g, "-") || "workspace";
  return `${baseName}-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addDisabledSkillNames(value: unknown, disabled: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const name of value) {
    if (typeof name === "string" && name.length > 0) {
      disabled.add(name);
    }
  }
}

function readDisabledSkills(settings: Record<string, unknown>): Set<string> {
  const skillsSettings = isRecord(settings.skills) ? settings.skills : {};
  const disabled = new Set<string>();
  addDisabledSkillNames(settings.disabled, disabled);
  addDisabledSkillNames(settings.disabledSkills, disabled);
  addDisabledSkillNames(skillsSettings.disabled, disabled);
  addDisabledSkillNames(skillsSettings.disabledSkills, disabled);
  return disabled;
}

function sortedSkillNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
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

async function writeJsonFile(filePath: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readSkillDescription(skillFilePath: string, logger: ScopedLogger): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(skillFilePath, "utf8");
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const description = frontmatter?.[1].match(/^description:\s*(.+)$/m);
    return description ? parseYamlScalar(description[1]) : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to read skill description ${skillFilePath}: ${message}`);
    return undefined;
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
  private readonly settingsSaver: (patch: Record<string, unknown>) => void;
  private readonly logger: ScopedLogger;

  constructor(options: SkillRegistryServiceOptions = {}) {
    this.builtinSkillsRoot = options.builtinSkillsRoot ?? path.join(process.resourcesPath ?? process.cwd(), "skills");
    this.globalSkillsRoot = options.globalSkillsRoot ?? getGlobalSkillsPath();
    this.effectiveRootsRoot = options.effectiveRootsRoot ?? getSkillEffectiveRootsPath();
    this.settingsLoader = options.loadSettings ?? loadSettings;
    this.settingsSaver = options.saveSettings ?? saveSettings;
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
    const disabled = await this.loadDisabledSkillSets(resolvedWorkspace);

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

  async deleteSkill(scope: SkillScope, name: string, workspaceDirectory?: string): Promise<void> {
    this.validateSkillName(name);
    if (scope === "builtin") {
      throw Object.assign(new Error("Builtin skills cannot be deleted"), { code: "BUILTIN_SKILL_READONLY" });
    }
    if (scope === "project" && !workspaceDirectory) {
      throw new Error("workspaceDirectory is required for project-scoped skills");
    }
    const root = this.getRootPath(scope, workspaceDirectory);
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }

  async setSkillEnabled(
    scope: SkillMutableScope,
    name: string,
    enabled: boolean,
    workspaceDirectory?: string,
  ): Promise<void> {
    this.validateSkillName(name);
    if (scope !== "global" && scope !== "project") {
      throw Object.assign(new Error(`Invalid mutable skill scope: ${scope}`), { code: "INVALID_SKILL_SCOPE" });
    }
    if (scope === "project" && !workspaceDirectory) {
      throw new Error("workspaceDirectory is required for project skill settings");
    }

    if (scope === "global") {
      const settings = this.settingsLoader();
      const disabled = readDisabledSkills(settings);
      if (enabled) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }
      const disabledNames = sortedSkillNames(disabled);
      this.settingsSaver({
        disabled: disabledNames,
        disabledSkills: disabledNames,
        skills: {
          disabled: disabledNames,
          disabledSkills: disabledNames,
        },
      });
      return;
    }

    const configPath = path.join(path.resolve(workspaceDirectory!), ...PROJECT_SKILLS_CONFIG_RELATIVE_PATH);
    const config = await readJsonFile(configPath, this.logger);
    const disabled = readDisabledSkills(config);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    const disabledNames = sortedSkillNames(disabled);
    await writeJsonFile(configPath, {
      ...config,
      disabled: disabledNames,
      disabledSkills: disabledNames,
      skills: {
        ...(isRecord(config.skills) ? config.skills : {}),
        disabled: disabledNames,
        disabledSkills: disabledNames,
      },
    });
  }

  async listSkillSummaries(workspaceDirectory: string): Promise<{
    workspaceDirectory: string;
    effectiveRoot: string;
    skills: SkillSummary[];
  }> {
    const resolvedWorkspace = path.resolve(workspaceDirectory);
    const disabled = await this.loadDisabledSkillSets(resolvedWorkspace);
    const allSkills = await this.listSkills(resolvedWorkspace);
    const selectedByName = new Map(
      this.selectEffectiveSkills(allSkills, disabled).map((skill) => [skill.name, skill]),
    );
    const skillsByName = new Map<string, SkillRecord[]>();
    for (const skill of allSkills) {
      const existing = skillsByName.get(skill.name) ?? [];
      existing.push(skill);
      skillsByName.set(skill.name, existing);
    }

    const skills = [...skillsByName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, records]) => {
        records.sort((a, b) => SKILL_SCOPE_DISPLAY_ORDER.indexOf(a.scope) - SKILL_SCOPE_DISPLAY_ORDER.indexOf(b.scope));
        const effective = selectedByName.get(name);
        const disabledAt = [
          disabled.project.has(name) ? { scope: "project" as const } : undefined,
          disabled.global.has(name) ? { scope: "global" as const } : undefined,
        ].filter((entry): entry is { scope: SkillMutableScope } => !!entry);
        const scopes: SkillScopedInstance[] = records.map((record) => {
          const instance: SkillScopedInstance = {
            scope: record.scope,
            description: record.description,
            path: record.skillPath,
          };
          if (effective && record.scope === effective.scope) {
            const shadows = records
              .filter((candidate) =>
                !this.isDisabledSkillRecord(candidate, disabled)
                && SKILL_SCOPE_PRIORITY[candidate.scope] < SKILL_SCOPE_PRIORITY[record.scope])
              .map((candidate) => candidate.scope);
            if (shadows.length > 0) {
              instance.shadows = shadows;
            }
          } else if (
            effective
            && !this.isDisabledSkillRecord(record, disabled)
            && SKILL_SCOPE_PRIORITY[effective.scope] > SKILL_SCOPE_PRIORITY[record.scope]
          ) {
            instance.shadowedBy = effective.scope;
          }
          return instance;
        });

        const summary: SkillSummary = {
          name,
          description: effective?.description ?? records.find((record) => record.description)?.description,
          enabled: !!effective,
          effectiveScope: effective?.scope ?? null,
          scopes,
        };
        if (disabledAt.length > 0) {
          summary.disabledAt = disabledAt;
        }
        return summary;
      });

    return {
      workspaceDirectory: resolvedWorkspace,
      effectiveRoot: this.getEffectiveRoot(resolvedWorkspace),
      skills,
    };
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
        description: await readSkillDescription(skillFilePath, this.logger),
      });
    }
    return skills;
  }

  private selectEffectiveSkills(
    skills: SkillRecord[],
    disabled: { global: Set<string>; project: Set<string> },
  ): SkillRecord[] {
    const selected = new Map<string, SkillRecord>();
    for (const skill of skills) {
      if (this.isDisabledSkillRecord(skill, disabled)) continue;
      const existing = selected.get(skill.name);
      if (!existing || SKILL_SCOPE_PRIORITY[skill.scope] > SKILL_SCOPE_PRIORITY[existing.scope]) {
        selected.set(skill.name, skill);
      }
    }
    return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private isDisabledSkillRecord(
    skill: SkillRecord,
    disabled: { global: Set<string>; project: Set<string> },
  ): boolean {
    if (skill.scope === "project") {
      return disabled.project.has(skill.name);
    }
    if (skill.scope === "global") {
      return disabled.global.has(skill.name);
    }
    return false;
  }

  private async loadDisabledSkillSets(workspaceDirectory: string): Promise<{
    global: Set<string>;
    project: Set<string>;
  }> {
    const global = readDisabledSkills(this.settingsLoader());
    const projectSettings = await readJsonFile(path.join(workspaceDirectory, ...PROJECT_SKILLS_CONFIG_RELATIVE_PATH), this.logger);
    const project = readDisabledSkills(projectSettings);
    return {
      global,
      project,
    };
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
