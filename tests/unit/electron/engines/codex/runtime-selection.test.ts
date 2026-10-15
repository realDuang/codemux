import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeResolver, parseDesktopCodexProcessPaths } from "../../../../../electron/main/engines/codex/runtime-selection";
import { normalizeCodexRuntimeVersion, readCodexRolloutMetadata } from "../../../../../electron/main/engines/codex/rollout-reader";
import { resolveCodexCliPath, resolveCodexCliVersion } from "../../../../../electron/main/engines/codex/config";

vi.mock("../../../../../electron/main/engines/codex/config", () => ({ resolveCodexCliPath: vi.fn(), resolveCodexCliVersion: vi.fn() }));

const id = "01a13ed7-4a99-7d30-8b50-2d1b2df28866";
let home: string;
let path: string;
let cli: string;
let previous: string;

async function writeMetadata(version: unknown, payloadId = id) {
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: payloadId, cli_version: version, originator: "Codex Desktop", source: "vscode" } }) + "\n");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codemux-runtime-selection-"));
  path = join(home, "sessions", "2026", "10", "15", `rollout-2026-10-15T17-14-19-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  cli = join(home, "codex-current");
  previous = join(home, "codex-previous");
  await Promise.all([writeFile(cli, ""), writeFile(previous, ""), writeMetadata("0.162.1")]);
  cli = await realpath(cli);
  previous = await realpath(previous);
  vi.mocked(resolveCodexCliPath).mockReturnValue(cli);
  vi.mocked(resolveCodexCliVersion).mockImplementation(value => value === cli ? "codex-cli 0.162.1" : value === previous ? "codex-cli 0.154.0" : undefined);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("CodexRuntimeResolver.resolve", () => {
  it("uses the default installed CLI for a new ordinary thread", async () => {
    expect(await new CodexRuntimeResolver({ codexHome: home }).resolve()).toEqual({ cliPath: cli, version: "0.162.1", source: "cli" });
  });

  it("selects the exact original runtime in either version direction", async () => {
    const resolver = new CodexRuntimeResolver({ codexHome: home, cliPaths: [previous] });
    expect((await resolver.resolve(id, { id, path })).version).toBe("0.162.1");
    await writeMetadata("0.154.0");
    expect(await resolver.resolve(id, { id, path })).toEqual({ cliPath: previous, version: "0.154.0", source: "configured" });
  });

  it("keeps unmatched history read-only without falling back to the default runtime", async () => {
    await writeMetadata("0.100.0");
    await expect(new CodexRuntimeResolver({ codexHome: home }).resolve(id, { id, path })).rejects.toMatchObject({
      code: "CODEX_RUNTIME_INCOMPATIBLE", threadId: id, requiredVersion: "0.100.0",
    });
  });

  it("reads metadata through the provided catalog and refuses an unverified runtime", async () => {
    const readThreadMetadata = vi.fn(async () => ({ id, path }));
    const resolver = new CodexRuntimeResolver({ codexHome: home, readThreadMetadata });
    expect((await resolver.resolve(id)).version).toBe("0.162.1");
    expect(readThreadMetadata).toHaveBeenCalledWith(id);
    await writeMetadata(null);
    await expect(resolver.resolve(id)).rejects.toMatchObject({ code: "CODEX_RUNTIME_INCOMPATIBLE", requiredVersion: undefined });
  });

  it("discovers an exact retained standalone version outside PATH", async () => {
    await writeMetadata("0.154.0");
    const binary = join(home, "packages", "standalone", "releases", "0.154.0-test-platform", "bin", process.platform === "win32" ? "codex.exe" : "codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "");
    const canonical = await realpath(binary);
    vi.mocked(resolveCodexCliVersion).mockImplementation(value => value === canonical ? "codex-cli 0.154.0" : "codex-cli 0.162.1");
    expect((await new CodexRuntimeResolver({ codexHome: home }).resolve(id, { id, path })).cliPath).toBe(canonical);
  });
});

describe("readCodexRolloutMetadata", () => {
  it("returns only verified runtime and origin metadata", async () => {
    expect(await readCodexRolloutMetadata(id, { id, path }, home)).toEqual({ threadId: id, cliVersion: "0.162.1", originator: "Codex Desktop", source: "vscode" });
    await writeMetadata("0.162.1", "another-thread");
    expect(await readCodexRolloutMetadata(id, { id, path }, home)).toBeUndefined();
    expect(await readCodexRolloutMetadata(id, { id, path: join(home, "other.jsonl") }, home)).toBeUndefined();
  });

  it("refuses malformed, partial, or oversized first records", async () => {
    for (const content of ["invalid\n", '{"type":"session_meta"}', "x".repeat(1024 * 1024) + "\n"]) {
      await writeFile(path, content);
      expect(await readCodexRolloutMetadata(id, { id, path }, home)).toBeUndefined();
    }
  });
});

describe("parseDesktopCodexProcessPaths", () => {
  it("accepts only direct executable children of the official macOS application", () => {
    expect(parseDesktopCodexProcessPaths([
      "  10 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      "  11 10 /usr/local/bin/codex",
      "  12 11 /other/bin/codex",
      "  13 1 /Applications/CodeMux.app/Contents/MacOS/CodeMux",
      "  14 13 /different/bin/codex",
      "  15 10 /bin/node",
      "  16 1 /Users/me/Applications/Codex.app/Contents/MacOS/Codex",
      "  17 16 /path with spaces/codex",
    ].join("\n"))).toEqual(["/usr/local/bin/codex", "/path with spaces/codex"]);
  });
});

describe("normalizeCodexRuntimeVersion", () => {
  it("accepts exact native and CLI versions without treating arbitrary output as a version", () => {
    expect(normalizeCodexRuntimeVersion("codex-cli 0.162.1")).toBe("0.162.1");
    expect(normalizeCodexRuntimeVersion("0.162.1-alpha.2")).toBe("0.162.1-alpha.2");
    for (const value of [undefined, "latest", "0.162", "0.162.1 extra", "0.162.1\nother"]) expect(normalizeCodexRuntimeVersion(value)).toBeUndefined();
  });
});
