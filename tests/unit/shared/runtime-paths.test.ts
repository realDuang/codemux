import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRuntimePaths, resolveRuntimeLogPath } from "../../../shared/runtime-paths";

describe("createRuntimePaths", () => {
  it("preserves persisted names under the supplied data root", () => {
    const root = path.resolve("runtime-data");
    const paths = createRuntimePaths({ userDataPath: root, logsPath: path.join(root, "logs") });
    expect({
      settings: paths.getSettingsPath(),
      devices: paths.getDevicesPath(),
      conversations: paths.getConversationsPath(),
      tasks: paths.getScheduledTasksPath(),
      orchestrations: paths.getOrchestrationsPath(),
      workspace: paths.getDefaultWorkspacePath(),
      tunnel: paths.getCloudflaredConfigPath(),
      worktree: paths.getWorktreeIndexPath("project-1"),
      channel: paths.getChannelConfigPath("feishu"),
      bindings: paths.getChannelBindingsPath("feishu"),
    }).toEqual({
      settings: path.join(root, "settings.json"),
      devices: path.join(root, "devices.json"),
      conversations: path.join(root, "conversations"),
      tasks: path.join(root, "scheduled-tasks.json"),
      orchestrations: path.join(root, "orchestrations.json"),
      workspace: path.join(root, "workspace"),
      tunnel: path.join(root, "cloudflared-config.yml"),
      worktree: path.join(root, "worktrees", "project-1", "index.json"),
      channel: path.join(root, "channels", "feishu.json"),
      bindings: path.join(root, "channels", "feishu-bindings.json"),
    });
  });

  it("reads host paths lazily and retains an explicit legacy device location", () => {
    let ready = false;
    let root = path.resolve("first-root");
    const devicePath = path.resolve("legacy", ".devices.json");
    const paths = createRuntimePaths({
      get userDataPath() {
        if (!ready) throw new Error("Host paths are not initialized");
        return root;
      },
      get logsPath() { return path.join(root, "logs"); },
      devicesPath: devicePath,
    });
    expect(paths.getDevicesPath()).toBe(devicePath);
    ready = true;
    expect(paths.getSettingsPath()).toBe(path.join(root, "settings.json"));
    root = path.resolve("isolated-root");
    expect(paths.getUserDataPath()).toBe(root);
    expect(paths.getSettingsPath()).toBe(path.join(root, "settings.json"));
    expect(paths.getLogsPath()).toBe(path.join(root, "logs"));
    expect(paths.getDevicesPath()).toBe(devicePath);
  });
});

describe("resolveRuntimeLogPath", () => {
  it.each([
    [true, "library"],
    [false, "host"],
  ] as const)("uses the host log policy when library default is %s", (useLibraryDefaultLogPath, directory) => {
    const config = { useLibraryDefaultLogPath, logsPath: "host" };
    expect(resolveRuntimeLogPath(config, "library")).toBe(path.join(directory, "main.log"));
    expect(resolveRuntimeLogPath(config, "library", "other.log")).toBe(path.join(directory, "other.log"));
  });

  it("does not resolve a host log directory in ordinary development", () => {
    expect(resolveRuntimeLogPath({
      useLibraryDefaultLogPath: true,
      get logsPath(): string { throw new Error("Unexpected host lookup"); },
    }, "library")).toBe(path.join("library", "main.log"));
  });
});
