import { join } from "path";
import { describe, expect, it } from "vitest";
import { getCopilotCliCandidates, unpackCopilotCliPath } from "../../../../../electron/main/engines/copilot/cli-path";

describe("unpackCopilotCliPath", () => {
  it("redirects a packaged executable to its unpacked sibling", () => {
    const archivePath = join("/resources", "app.asar", "node_modules", "@github", "copilot-darwin-arm64", "copilot");
    const unpackedPath = join("/resources", "app.asar.unpacked", "node_modules", "@github", "copilot-darwin-arm64", "copilot");

    expect(unpackCopilotCliPath(archivePath)).toBe(unpackedPath);
    expect(unpackCopilotCliPath(unpackedPath)).toBe(unpackedPath);
  });

  it.each([
    join("/project", "node_modules", "@github", "copilot-linux-x64", "copilot"),
    join("/resources", "app.asar.backup", "copilot"),
    join("/resources", "app.asar"),
  ])("keeps non-archive executable paths unchanged: %s", (binaryPath) => {
    expect(unpackCopilotCliPath(binaryPath)).toBe(binaryPath);
  });
});

describe("getCopilotCliCandidates", () => {
  it.each([
    ["darwin", "arm64", "@github/copilot-darwin-arm64", "copilot"],
    ["linux", "x64", "@github/copilot-linux-x64", "copilot"],
    ["win32", "x64", "@github/copilot-win32-x64", "copilot.exe"],
  ] as const)("retains packaged and development candidate order for %s-%s", (platform, arch, packageName, binaryName) => {
    const appPath = join("/resources", "app.asar");

    expect(getCopilotCliCandidates(appPath, platform, arch)).toEqual([
      join("/resources", "app.asar.unpacked", "node_modules", "@github", "copilot", "node_modules", packageName, binaryName),
      join("/resources", "app.asar.unpacked", "node_modules", packageName, binaryName),
      join(appPath, "node_modules", packageName, binaryName),
      join(appPath, "node_modules", "@github", "copilot", "node_modules", packageName, binaryName),
    ]);
  });

  it("retains the application directory for a development checkout", () => {
    const appPath = join("/workspace", "codemux");
    const candidates = getCopilotCliCandidates(appPath, "linux", "arm64");

    expect(candidates).toEqual([
      join("/workspace", "app.asar.unpacked", "node_modules", "@github", "copilot", "node_modules", "@github/copilot-linux-arm64", "copilot"),
      join("/workspace", "app.asar.unpacked", "node_modules", "@github/copilot-linux-arm64", "copilot"),
      join(appPath, "node_modules", "@github/copilot-linux-arm64", "copilot"),
      join(appPath, "node_modules", "@github", "copilot", "node_modules", "@github/copilot-linux-arm64", "copilot"),
    ]);
  });
});
