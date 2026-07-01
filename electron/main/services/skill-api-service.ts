import type {
  EngineType,
  SkillDeleteRequest,
  SkillDiagnostic,
  SkillListRequest,
  SkillListResponse,
  SkillRefreshRequest,
  SkillSetEnabledRequest,
} from "../../../src/types/unified";
import {
  skillRegistryService,
  SkillRegistryService,
  type SkillConflict,
} from "./skill-registry-service";
import {
  skillProjectionService,
  type SkillProjectionProvider,
} from "./skill-projection-service";

export interface SkillApiProvider {
  listSkills(request: SkillListRequest): Promise<SkillListResponse>;
  setSkillEnabled(request: SkillSetEnabledRequest, engineTypes?: EngineType[]): Promise<SkillListResponse>;
  deleteSkill(request: SkillDeleteRequest, engineTypes?: EngineType[]): Promise<SkillListResponse>;
  refreshSkills(request: SkillRefreshRequest, engineTypes?: EngineType[]): Promise<SkillListResponse>;
}

export interface SkillApiServiceOptions {
  registry?: SkillRegistryService;
  projection?: SkillProjectionProvider;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertWorkspaceDirectory(workspaceDirectory: string | undefined): string {
  if (!workspaceDirectory || typeof workspaceDirectory !== "string") {
    throw codedError("WORKSPACE_REQUIRED", "workspaceDirectory is required");
  }
  return workspaceDirectory;
}

function isDiscoveryConflict(conflict: SkillConflict): boolean {
  return conflict.reason === "discovery-path-conflict";
}

export class SkillApiService implements SkillApiProvider {
  private readonly registry: SkillRegistryService;
  private readonly projection: SkillProjectionProvider;

  constructor(options: SkillApiServiceOptions = {}) {
    this.registry = options.registry ?? skillRegistryService;
    this.projection = options.projection ?? skillProjectionService;
  }

  async listSkills(request: SkillListRequest): Promise<SkillListResponse> {
    const workspaceDirectory = assertWorkspaceDirectory(request.workspaceDirectory);
    return this.createListResponse(workspaceDirectory, []);
  }

  async setSkillEnabled(
    request: SkillSetEnabledRequest,
    engineTypes: EngineType[] = [],
  ): Promise<SkillListResponse> {
    const workspaceDirectory = assertWorkspaceDirectory(request.workspaceDirectory);
    await this.registry.setSkillEnabled(request.scope, request.name, request.enabled, workspaceDirectory);
    return this.refreshSkills({ workspaceDirectory }, engineTypes);
  }

  async deleteSkill(
    request: SkillDeleteRequest,
    engineTypes: EngineType[] = [],
  ): Promise<SkillListResponse> {
    const workspaceDirectory = assertWorkspaceDirectory(request.workspaceDirectory);
    await this.registry.deleteSkill(request.scope, request.name, workspaceDirectory);
    return this.refreshSkills({ workspaceDirectory }, engineTypes);
  }

  async refreshSkills(
    request: SkillRefreshRequest,
    engineTypes: EngineType[] = [],
  ): Promise<SkillListResponse> {
    const workspaceDirectory = assertWorkspaceDirectory(request.workspaceDirectory);
    const diagnostics: SkillDiagnostic[] = [];
    const requestedEngineTypes = request.engineTypes ?? engineTypes;
    const targetEngineTypes = [...new Set(requestedEngineTypes)]
      .filter((engineType) => this.projection.getStrategy(engineType) !== "unsupported");

    if (targetEngineTypes.length === 0) {
      const effectiveSet = await this.registry.buildEffectiveSkillSet(workspaceDirectory);
      diagnostics.push(...this.diagnosticsFromConflicts(effectiveSet.conflicts));
      return this.createListResponse(workspaceDirectory, diagnostics);
    }

    const seenDiagnostics = new Set<string>();
    for (const engineType of targetEngineTypes) {
      const result = await this.projection.prepareForEngine(engineType, workspaceDirectory);
      for (const diagnostic of this.diagnosticsFromConflicts(result.conflicts, engineType)) {
        const key = `${diagnostic.engineType ?? ""}:${diagnostic.skillName ?? ""}:${diagnostic.code}:${JSON.stringify(diagnostic.params ?? {})}`;
        if (seenDiagnostics.has(key)) continue;
        seenDiagnostics.add(key);
        diagnostics.push(diagnostic);
      }
    }

    return this.createListResponse(workspaceDirectory, diagnostics);
  }

  private async createListResponse(
    workspaceDirectory: string,
    diagnostics: SkillDiagnostic[],
  ): Promise<SkillListResponse> {
    const snapshot = await this.registry.listSkillSummaries(workspaceDirectory);
    return {
      ...snapshot,
      diagnostics,
    };
  }

  private diagnosticsFromConflicts(
    conflicts: SkillConflict[],
    engineType?: EngineType,
  ): SkillDiagnostic[] {
    return conflicts.map((conflict): SkillDiagnostic => {
      if (isDiscoveryConflict(conflict)) {
        return {
          severity: "warning",
          code: "exposure-conflict",
          skillName: conflict.name,
          engineType,
          params: {
            name: conflict.name,
            path: conflict.path,
          },
          action: {
            kind: "open-path",
            path: conflict.path,
          },
        };
      }

      return {
        severity: "error",
        code: "engine-exposure-failed",
        skillName: conflict.name,
        params: {
          name: conflict.name,
          reason: conflict.reason,
        },
      };
    });
  }
}

export const skillApiService = new SkillApiService();
