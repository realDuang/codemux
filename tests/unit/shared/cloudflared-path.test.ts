import path from "path";
import { describe, expect, it } from "vitest";
import { getCloudflaredPath } from "../../../shared/cloudflared-path";

describe("getCloudflaredPath", () => {
  it.each(["darwin", "linux", "win32"] as const)("uses PATH in development on %s", (platform) => {
    expect(getCloudflaredPath({ isPackaged: false, resourcesPath: "", platform, arch: "x64" })).toBe("cloudflared");
  });

  it.each([
    ["darwin", "arm64", "cloudflared"],
    ["linux", "x64", "cloudflared"],
    ["win32", "x64", "cloudflared.exe"],
  ] as const)("uses the packaged resource binary on %s-%s", (platform, arch, binaryName) => {
    expect(getCloudflaredPath({ isPackaged: true, resourcesPath: "/resources", platform, arch }))
      .toBe(path.join("/resources", "cloudflared", `${platform}-${arch}`, binaryName));
  });
});
