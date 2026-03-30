import { describe, it, expect, vi } from "vitest";

const getDefaultWorkspacePathMock = vi.fn(() => "/tmp/workspace");
const getDefaultEngineFromSettingsMock = vi.fn(() => "copilot");

vi.mock("../../../../electron/main/services/default-workspace", () => ({
  getDefaultWorkspacePath: getDefaultWorkspacePathMock,
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  getDefaultEngineFromSettings: getDefaultEngineFromSettingsMock,
}));

const { resolveProjectRef } = await import("../../../../electron/main/channels/project-ref-utils");

describe("project-ref-utils", () => {
  it("refreshes default-workspace project refs from the current default engine", () => {
    const resolved = resolveProjectRef({
      directory: "/tmp/workspace",
      engineType: "opencode",
      projectId: "dir-/tmp/workspace",
    });

    expect(resolved.engineType).toBe("copilot");
  });

  it("normalizes slashes when matching the default workspace directory", () => {
    const resolved = resolveProjectRef({
      directory: "\\tmp\\workspace",
      engineType: "opencode",
      projectId: "dir-/tmp/workspace",
    });

    expect(resolved.engineType).toBe("copilot");
  });

  it("leaves non-default projects unchanged", () => {
    const project = {
      directory: "/tmp/project-a",
      engineType: "opencode",
      projectId: "dir-/tmp/project-a",
    } as const;

    expect(resolveProjectRef(project)).toEqual(project);
  });
});
