import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => path.join(os.tmpdir(), "codemux-test", name)),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  loadSettings: vi.fn(() => ({})),
  skillLog: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  },
}));

import { SkillRegistryService } from "../../../../electron/main/services/skill-registry-service";
import { SkillProjectionService } from "../../../../electron/main/services/skill-projection-service";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createSkill(root: string, name: string, content = "body"): Promise<string> {
  const skillPath = path.join(root, name);
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), `---\ndescription: ${name}\n---\n${content}\n`, "utf8");
  return skillPath;
}

function normalize(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readResolvedLink(linkPath: string): Promise<string> {
  const raw = await fs.readlink(linkPath);
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(linkPath), raw);
}

describe("skill services", () => {
  let tempRoot: string;
  let builtinRoot: string;
  let globalRoot: string;
  let effectiveRoot: string;
  let manifestsRoot: string;
  let workspace: string;
  let settings: Record<string, unknown>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-skills-"));
    builtinRoot = path.join(tempRoot, "builtin");
    globalRoot = path.join(tempRoot, "global");
    effectiveRoot = path.join(tempRoot, "effective");
    manifestsRoot = path.join(tempRoot, "manifests");
    workspace = path.join(tempRoot, "workspace");
    settings = {};
    await fs.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function createRegistry(): SkillRegistryService {
    return new SkillRegistryService({
      builtinSkillsRoot: builtinRoot,
      globalSkillsRoot: globalRoot,
      effectiveRootsRoot: effectiveRoot,
      loadSettings: () => settings,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        verbose: vi.fn(),
        debug: vi.fn(),
        silly: vi.fn(),
      },
    });
  }

  describe("SkillRegistryService.buildEffectiveSkillSet", () => {
    it("uses project skills before global and builtin skills with the same name", async () => {
      await createSkill(builtinRoot, "alpha", "builtin");
      await createSkill(globalRoot, "alpha", "global");
      const projectSkill = await createSkill(path.join(workspace, ".codemux", "skills"), "alpha", "project");

      const effective = await createRegistry().buildEffectiveSkillSet(workspace);

      expect(effective.skills.map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["alpha:project"]);
      expect(normalize(await readResolvedLink(path.join(effective.effectiveRoot, "alpha")))).toBe(normalize(projectSkill));
    });

    it("filters disabled skills without deleting the real skill directory", async () => {
      const realSkill = await createSkill(globalRoot, "alpha");
      settings = { skills: { disabled: ["alpha"] } };

      const effective = await createRegistry().buildEffectiveSkillSet(workspace);

      expect(effective.skills).toEqual([]);
      expect(await pathExists(realSkill)).toBe(true);
      expect(await pathExists(path.join(effective.effectiveRoot, "alpha"))).toBe(false);
    });

    it("reads disabled skills from the project skills config", async () => {
      await createSkill(globalRoot, "alpha");
      await fs.mkdir(path.join(workspace, ".codemux"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".codemux", "skills.json"),
        JSON.stringify({ disabled: ["alpha"] }),
        "utf8",
      );

      const effective = await createRegistry().buildEffectiveSkillSet(workspace);

      expect(effective.skills).toEqual([]);
    });

    it("deletes only the selected real skill scope", async () => {
      const registry = createRegistry();
      const globalSkill = await createSkill(globalRoot, "alpha");
      const projectSkill = await createSkill(path.join(workspace, ".codemux", "skills"), "alpha");

      await registry.deleteSkill("project", "alpha", workspace);

      expect(await pathExists(projectSkill)).toBe(false);
      expect(await pathExists(globalSkill)).toBe(true);
      const effective = await registry.buildEffectiveSkillSet(workspace);
      expect(effective.skills.map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["alpha:global"]);
    });
  });

  describe("SkillProjectionService.prepareForEngine", () => {
    it("returns an effective root for engines that accept custom skill roots", async () => {
      await createSkill(globalRoot, "alpha");
      const projection = new SkillProjectionService({
        registry: createRegistry(),
        manifestsRoot,
      });

      const result = await projection.prepareForEngine("copilot", workspace);

      expect(result.strategy).toBe("pass-root-directory");
      expect(result.effectiveRoot).toBeTruthy();
      expect(result.projectedRoot).toBeNull();
      expect(result.skillNames).toEqual(["alpha"]);
      expect(await pathExists(path.join(result.effectiveRoot!, "alpha"))).toBe(true);
    });

    it("does not overwrite unmanaged discovery-directory conflicts", async () => {
      await createSkill(globalRoot, "alpha");
      const conflictPath = path.join(workspace, ".opencode", "skills", "alpha");
      await fs.mkdir(conflictPath, { recursive: true });
      const projection = new SkillProjectionService({
        registry: createRegistry(),
        manifestsRoot,
      });

      const result = await projection.prepareForEngine("opencode", workspace);

      expect(result.strategy).toBe("link-into-discovery-dir");
      expect(result.conflicts).toEqual([
        expect.objectContaining({ name: "alpha", path: conflictPath, reason: "discovery-path-conflict" }),
      ]);
      expect((await fs.lstat(conflictPath)).isSymbolicLink()).toBe(false);
    });

    it("removes only manifest-managed links when a skill is disabled", async () => {
      const realSkill = await createSkill(globalRoot, "alpha");
      const registry = createRegistry();
      const projection = new SkillProjectionService({
        registry,
        manifestsRoot,
      });

      const enabled = await projection.prepareForEngine("claude", workspace);
      const projectedPath = path.join(enabled.projectedRoot!, "alpha");
      expect((await fs.lstat(projectedPath)).isSymbolicLink()).toBe(true);

      settings = { skills: { disabled: ["alpha"] } };
      const disabled = await projection.prepareForEngine("claude", workspace);

      expect(disabled.skillNames).toEqual([]);
      expect(await pathExists(projectedPath)).toBe(false);
      expect(await pathExists(realSkill)).toBe(true);
    });

    it("maintains a Git exclude block for managed discovery links", async () => {
      await createSkill(globalRoot, "alpha");
      await fs.mkdir(path.join(workspace, ".git", "info"), { recursive: true });
      const registry = createRegistry();
      const projection = new SkillProjectionService({
        registry,
        manifestsRoot,
      });

      await projection.prepareForEngine("opencode", workspace);
      const excludePath = path.join(workspace, ".git", "info", "exclude");
      const enabledExclude = await fs.readFile(excludePath, "utf8");
      expect(enabledExclude).toContain("CodeMux managed skill projections begin opencode-");
      expect(enabledExclude).toContain("/.opencode/skills/alpha");

      settings = { skills: { disabled: ["alpha"] } };
      await projection.prepareForEngine("opencode", workspace);

      const disabledExclude = await fs.readFile(excludePath, "utf8");
      expect(disabledExclude).not.toContain("/.opencode/skills/alpha");
    });
  });
});
