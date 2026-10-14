import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  readMetadata: vi.fn(), callHost: vi.fn(), check: vi.fn(), readFile: vi.fn(),
  writeFile: vi.fn(), spawn: vi.fn(), node: vi.fn(), commandExists: vi.fn(),
}));
vi.mock("../../../shared/host-control-client", () => ({
  readHostControlMetadata: mocks.readMetadata, callHost: mocks.callHost,
}));
vi.mock("proper-lockfile", () => ({ check: mocks.check }));
vi.mock("node:fs/promises", () => ({ default: {
  readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: vi.fn(),
} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ openSync: () => 99, closeSync: vi.fn() }));
vi.mock("../../../scripts/server-dev-host", () => ({
  resolveNodeExecutable: mocks.node, ServerDevHost: class {},
}));
vi.mock("../../../scripts/state-dir", () => ({ resolveServerStateDir: () => "/test/state" }));
vi.mock("../../../scripts/utils", () => ({ commandExists: mocks.commandExists }));

import { runServerDev } from "../../../scripts/server-dev";

const metadata = { version: 1, instanceId: "fixture-owner", pid: 12345, port: 50200, dataPath: "/test/state", ownerCredential: "test-only" };
const repositoryPath = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const ready = {
  pid: metadata.pid, runtimePid: 12346, ready: true, phase: "ready",
  dataPath: "/test/state", runtimeDataPath: "/test/data", webPort: 8233, error: null,
};
let kill: ReturnType<typeof vi.spyOn>;
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  kill = vi.spyOn(process, "kill").mockReturnValue(true);
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.readMetadata.mockResolvedValue(metadata);
  mocks.check.mockResolvedValue(false);
  mocks.readFile.mockResolvedValue("");
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.node.mockResolvedValue("/explicit/node");
  mocks.commandExists.mockReturnValue(true);
  mocks.callHost.mockImplementation(async (_path: string, method: string) => {
    if (method === "host:status" || method === "dev:restart") return ready;
    if (method === "host:stop") return { stopping: true };
    if (method === "auth:getAccessCode") return "test-code";
    if (method === "auth:getPendingRequests") return [];
    if (method === "tunnel:getStatus") return { status: "running", url: "https://new-tunnel.example.test" };
    throw new Error(`Unexpected method: ${method}`);
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function expectNoSignals(): void {
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
}

describe("runServerDev", () => {
  it("stops through the exact private owner and waits for its lease release", async () => {
    mocks.readMetadata.mockResolvedValueOnce(metadata).mockResolvedValue(null);
    await runServerDev(["stop"]);
    expect(mocks.callHost).toHaveBeenCalledExactlyOnceWith("/test/state", "host:stop", [], {
      expectedInstanceId: metadata.instanceId, timeoutMs: 40_000,
    });
    expect(mocks.check).toHaveBeenCalledWith("/test/state", { stale: 30_000 });
    expectNoSignals();
  });

  it("does not signal a live legacy PID without private control identity", async () => {
    mocks.readMetadata.mockResolvedValue(null);
    mocks.readFile.mockResolvedValue("23456\n");
    await expect(runServerDev(["stop"])).rejects.toThrow("original launcher");
    expect(mocks.callHost).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectNoSignals();
  });

  it("leaves a replacement owner running when it appears during --replace", async () => {
    mocks.readMetadata.mockResolvedValueOnce(metadata).mockResolvedValue({ ...metadata, instanceId: "replacement", pid: 23456 });
    await expect(runServerDev(["start", "--replace"])).rejects.toThrow("left running");
    expect(mocks.node).toHaveBeenCalled();
    expect(mocks.callHost).toHaveBeenCalledTimes(1);
    expect(mocks.callHost.mock.calls[0][3]).toMatchObject({ expectedInstanceId: metadata.instanceId });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectNoSignals();
  });

  it("restarts the dev stack with the caller's worktree and environment and restores runtime-owned access", async () => {
    const replacement = { ...metadata, instanceId: "replacement", pid: 23456 };
    mocks.readMetadata.mockResolvedValueOnce(metadata).mockResolvedValueOnce(null).mockResolvedValue(replacement);
    mocks.spawn.mockReturnValue({ pid: replacement.pid, once: vi.fn(), unref: vi.fn(), kill: vi.fn() });
    const call = mocks.callHost.getMockImplementation()!;
    mocks.callHost.mockImplementation(async (dataPath: string, method: string, args: unknown[], options: { expectedInstanceId: string }) => {
      if (method === "host:status") return { ...ready, pid: replacement.pid, runtimePid: 23457 };
      return call(dataPath, method, args, options);
    });
    vi.stubEnv("CODEMUX_DATA_DIR", "/caller/selected-data");
    vi.stubEnv("CODEMUX_WEB_PORT", "9233");
    await runServerDev(["restart"]);
    expect(mocks.callHost).toHaveBeenCalledWith("/test/state", "host:stop", [], {
      expectedInstanceId: metadata.instanceId, timeoutMs: 40_000,
    });
    expect(mocks.callHost.mock.calls.filter(call => call[1] !== "host:stop").every(call => call[3].expectedInstanceId === replacement.instanceId)).toBe(true);
    expect(mocks.callHost.mock.calls.some(call => ["dev:restart", "tunnel:start", "remoteAccess:update"].includes(call[1]))).toBe(false);
    expect(output).toHaveBeenCalledWith("Tunnel is ready: https://new-tunnel.example.test");
    expect(output).toHaveBeenCalledWith("Temporary quick-tunnel URLs may change when CodeMux restarts.");
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [path.join(repositoryPath, "scripts/server-dev.ts"), "supervise"], expect.objectContaining({
      cwd: repositoryPath, env: expect.objectContaining({ CODEMUX_DATA_DIR: "/caller/selected-data", CODEMUX_WEB_PORT: "9233" }),
    }));
    expectNoSignals();
  });

  it("does not replace a running host when the requested tunnel dependency is absent", async () => {
    mocks.commandExists.mockReturnValue(false);
    await expect(runServerDev(["start", "--replace", "--tunnel"])).rejects.toThrow("cloudflared");
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.callHost).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["start", "restart"])("validates Node before %s replaces an existing host", async command => {
    mocks.node.mockRejectedValue(new Error("Node 24 required"));
    await expect(runServerDev(command === "start" ? [command, "--replace"] : [command])).rejects.toThrow("Node 24 required");
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.callHost).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("allows stale dead-host discovery to be replaced only after its lease expires", async () => {
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    mocks.check.mockResolvedValue(true);
    await expect(runServerDev(["status"])).rejects.toThrow("30-second lease");
    mocks.check.mockResolvedValue(false);
    await runServerDev(["status"]);
    expect(output).toHaveBeenCalledWith("CodeMux development server is not running.");
    expect(mocks.callHost).not.toHaveBeenCalled();
    expectNoSignals();
  });

  it("does not treat an inaccessible live PID as proof that its owner is gone", async () => {
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await runServerDev(["status"]);
    expect(mocks.callHost).toHaveBeenCalledWith("/test/state", "host:status", [], {
      expectedInstanceId: metadata.instanceId, timeoutMs: 40_000,
    });
    expect(mocks.check).not.toHaveBeenCalled();
    expectNoSignals();
  });

  it("rejects a status response from a different process", async () => {
    mocks.callHost.mockResolvedValue({ ...ready, pid: 23456 });
    await expect(runServerDev(["status"])).rejects.toThrow("invalid identity");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectNoSignals();
  });
});
