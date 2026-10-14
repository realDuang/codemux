import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseHostCliCommand, redactCliOutput, resolveCliDataPath, runHostCli,
  type HostCliDependencies,
} from "../../../server/cli-commands";
import {
  createAuthHelperBackend, runServerAuthCli,
  type AuthHelperBackend, type AuthHelperDependencies,
} from "../../../scripts/server-auth";
import { HostControlError, readHostControlMetadata } from "../../../shared/host-control-client";
import { startHostControlServer } from "../../../shared/host-control-server";
import { HOST_CONTROL_FILENAME, type HostControlMetadata } from "../../../shared/host-control-types";
import type { PendingRequest } from "../../../shared/device-store-types";
import { acquireRuntimeLock } from "../../../shared/runtime-lock";

const pending: PendingRequest = {
  id: "request-1", device: { name: "Test Phone", platform: "iOS", browser: "Safari" },
  ip: "192.0.2.1", status: "pending", createdAt: Date.now(),
};
const metadata: HostControlMetadata = {
  version: 1, instanceId: "00000000-0000-0000-0000-000000000000", pid: 123,
  port: 12345, dataPath: "/fixture/data", ownerCredential: "a".repeat(64),
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-host-cli-"));
  directories.push(directory);
  return directory;
}

function cliDependencies(result: unknown = { success: true }) {
  const call = vi.fn(async () => result);
  const readMetadata = vi.fn(async () => metadata as HostControlMetadata | null);
  const write = vi.fn();
  const error = vi.fn();
  const dependencies: HostCliDependencies = {
    call: call as HostCliDependencies["call"], readMetadata,
    resolveDataPath: (dataDir) => dataDir ?? "/fixture/data", write, error,
  };
  return { call, readMetadata, write, error, dependencies };
}

function authDependencies(result: unknown = "123456") {
  const mocks = cliDependencies(result);
  const legacy: AuthHelperBackend = {
    getAccessCode: vi.fn(async () => "654321"),
    listPendingRequests: vi.fn(async () => [pending]),
    approveRequest: vi.fn(async () => true),
    denyRequest: vi.fn(async () => true),
  };
  const loadLegacy = vi.fn(async () => legacy);
  const release = vi.fn(async () => {});
  const acquireLock = vi.fn(async () => ({ dataPath: "/fixture/data", release }));
  const prompt = { ask: vi.fn(async () => "approve"), close: vi.fn() };
  const dependencies: AuthHelperDependencies = {
    ...mocks.dependencies, loadLegacy, acquireLock, env: {}, interactive: false,
    createPrompt: vi.fn(() => prompt),
  };
  return { ...mocks, legacy, loadLegacy, acquireLock, release, prompt, dependencies };
}

describe("parseHostCliCommand", () => {
  it.each([
    [["stop"], "host:stop", []],
    [["access-code"], "auth:getAccessCode", []],
    [["pending"], "auth:getPendingRequests", []],
    [["approve", "request-1"], "auth:approveRequest", ["request-1"]],
    [["deny", "request-1"], "auth:denyRequest", ["request-1"]],
    [["remote-access", "get"], "remoteAccess:getStatus", []],
    [["remote-access", "update", "--args", '{"mode":"none"}'], "remoteAccess:update", [{ mode: "none" }]],
    [["settings", "get"], "settings:load", []],
    [["settings", "patch", "--args", '{"theme":"dark"}'], "settings:save", [{ theme: "dark" }]],
    [["channels", "list"], "channel:list", []],
    [["channels", "status", "feishu"], "channel:getStatus", ["feishu"]],
    [["channels", "get", "feishu"], "channel:getConfig", ["feishu"]],
    [["channels", "update", "feishu", "--args", '{"appSecret":""}'], "channel:updateConfig", ["feishu", { appSecret: "" }]],
    [["channels", "start", "feishu"], "channel:start", ["feishu"]],
    [["channels", "stop", "feishu"], "channel:stop", ["feishu"]],
    [["channels", "logout", "weixin-ilink"], "channel:weixin-ilink:logout", []],
    [["call", "task:list", "--args", '["project-1"]'], "task:list", ["project-1"]],
  ] as [string[], string, unknown[]][])("maps %j to the existing host operation", (argv, method, args) => {
    expect(parseHostCliCommand(argv)).toMatchObject({ kind: "call", method, args });
  });

  it.each([
    ["approve"], ["status", "extra"], ["channels", "get"], ["channels", "logout", "feishu"],
    ["settings", "patch"], ["settings", "patch", "--args", "[]"],
    ["call", "task:list", "--args", "{}"], ["settings", "patch", "--args", "{bad"],
    ["status", "--plain"], ["stop", "--count"], ["pending", "--args", "[]"],
    ["status", "--data-dir", ""], ["channels", "constructor", "feishu"], ["unknown"], ["--unknown"],
  ])("rejects invalid command arguments %j", (...argv) => {
    expect(() => parseHostCliCommand(argv)).toThrow();
  });

  it("accepts a global data directory before or after the command", () => {
    expect(parseHostCliCommand(["--data-dir", "/isolated", "status"])).toEqual(parseHostCliCommand(["status", "--data-dir", "/isolated"]));
    expect(parseHostCliCommand([]).kind).toBe("help");
    expect(parseHostCliCommand(["channels", "--help"]).kind).toBe("help");
  });
});

describe("resolveCliDataPath", () => {
  it("uses server path rules and resolves explicit relative overrides", () => {
    const options = { env: {}, cwd: "/work", home: "/home/test", platform: "linux" as const, appPath: "/install" };
    expect(resolveCliDataPath(undefined, options)).toBe("/home/test/.config/codemux");
    expect(resolveCliDataPath("state", options)).toBe("/work/state");
    expect(resolveCliDataPath(undefined, { ...options, env: { CODEMUX_DEV_ISOLATED: "1" } })).toBe("/work/.codemux-dev/userData");
  });
});

describe("redactCliOutput", () => {
  it("redacts nested channel credentials without mutating configuration or clearing intent", () => {
    const config = { appId: "visible", appSecret: "secret-value", password: "", peers: [{ accessToken: "token-value", name: "visible" }], nested: { encodingAESKey: "key-value" } };
    const result = redactCliOutput(config);
    expect(result).toEqual({
      appId: "visible", appSecret: "", password: "", secretsConfigured: ["appSecret"],
      peers: [{ accessToken: "", name: "visible", secretsConfigured: ["accessToken"] }],
      nested: { encodingAESKey: "", secretsConfigured: ["encodingAESKey"] },
    });
    expect(config.appSecret).toBe("secret-value");
    expect(JSON.stringify(redactCliOutput(metadata))).not.toContain(metadata.ownerCredential);
  });
});

describe("runHostCli", () => {
  it("reports a stopped runtime without creating the selected data directory", async () => {
    const parent = await temporaryDirectory();
    const dataDir = path.join(parent, "absent");
    const write = vi.fn();
    expect(await runHostCli(["status", "--data-dir", dataDir], { write })).toBe(0);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ running: false, state: "stopped", dataPath: dataDir });
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("does not discover or call a host for help or invalid commands", async () => {
    const mocks = cliDependencies();
    expect(await runHostCli(["help"], mocks.dependencies)).toBe(0);
    expect(await runHostCli(["approve"], mocks.dependencies)).toBe(1);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.readMetadata).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("returns failure when published runtime control cannot be reached", async () => {
    const mocks = cliDependencies();
    mocks.call.mockRejectedValue(new HostControlError("UNAVAILABLE", "Host unavailable"));
    expect(await runHostCli(["status"], mocks.dependencies)).toBe(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("CodeMux: Host unavailable");
  });

  it.each([
    { argv: ["access-code", "--plain"], result: "123456", output: "123456" },
    { argv: ["pending", "--count"], result: [pending], output: "1" },
  ])("preserves machine-readable output for $argv", async ({ argv, result, output }) => {
    const mocks = cliDependencies(result);
    expect(await runHostCli(argv, mocks.dependencies)).toBe(0);
    expect(mocks.write).toHaveBeenCalledWith(output);
  });

  it("redacts generic channel configuration calls and transmits patches unchanged", async () => {
    const mocks = cliDependencies({ appSecret: "test-only-secret", appId: "visible" });
    expect(await runHostCli(["call", "channel:getConfig", "--args", '["feishu"]'], mocks.dependencies)).toBe(0);
    expect(mocks.write.mock.calls[0][0]).not.toContain("test-only-secret");
    expect(await runHostCli(["channels", "update", "feishu", "--args", '{"appSecret":""}'], mocks.dependencies)).toBe(0);
    expect(mocks.call).toHaveBeenLastCalledWith("/fixture/data", "channel:updateConfig", ["feishu", { appSecret: "" }]);
  });

  it("contacts a real isolated owner for status, settings, and stop without disclosing discovery credentials", async () => {
    const dataPath = await temporaryDirectory();
    const invoke = vi.fn(async () => ({ theme: "dark", appSecret: "test-only-secret" }));
    const stop = vi.fn();
    const server = await startHostControlServer({
      dataPath, invoke, stop,
      getStatus: () => ({ pid: process.pid, phase: "ready", ready: true, dataPath, webPort: 8233, gatewayUrl: "ws://127.0.0.1:8233/ws" }),
    });
    try {
      const write = vi.fn();
      const error = vi.fn();
      expect(await runHostCli(["--data-dir", dataPath, "status"], { write, error })).toBe(0);
      expect(JSON.parse(write.mock.calls[0][0]).phase).toBe("ready");
      expect(await runHostCli(["--data-dir", dataPath, "settings", "get"], { write, error })).toBe(0);
      expect(invoke).toHaveBeenCalledWith("settings:load", []);
      const { ownerCredential } = JSON.parse(await fs.readFile(path.join(dataPath, HOST_CONTROL_FILENAME), "utf8"));
      expect(JSON.stringify(write.mock.calls)).not.toContain(ownerCredential);
      expect(JSON.stringify(write.mock.calls)).not.toContain("test-only-secret");
      expect(await runHostCli(["--data-dir", dataPath, "stop"], { write, error })).toBe(0);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(error).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("createAuthHelperBackend", () => {
  it("selects the published owner even when legacy access is enabled", async () => {
    const mocks = authDependencies();
    const backend = await createAuthHelperBackend("/fixture/data", true, mocks.dependencies);
    expect(await backend.getAccessCode()).toBe("123456");
    expect(mocks.call).toHaveBeenCalledWith("/fixture/data", "auth:getAccessCode", []);
    expect(mocks.loadLegacy).not.toHaveBeenCalled();
  });

  it("never falls back to direct writes after an owner connection error", async () => {
    const mocks = authDependencies();
    mocks.call.mockRejectedValue(new HostControlError("UNAVAILABLE", "Host unavailable"));
    const backend = await createAuthHelperBackend("/fixture/data", true, mocks.dependencies);
    await expect(backend.approveRequest("request-1")).rejects.toThrow("Host unavailable");
    expect(mocks.loadLegacy).not.toHaveBeenCalled();
    expect(mocks.legacy.approveRequest).not.toHaveBeenCalled();
  });

  it("requires explicit legacy selection when owner metadata is absent", async () => {
    const mocks = authDependencies();
    mocks.readMetadata.mockResolvedValue(null);
    await expect(createAuthHelperBackend("/fixture/data", false, mocks.dependencies)).rejects.toThrow("No running CodeMux host");
    expect(mocks.loadLegacy).not.toHaveBeenCalled();
    const backend = await createAuthHelperBackend("/fixture/data", true, mocks.dependencies);
    expect(await backend.getAccessCode()).toBe("654321");
    expect(mocks.loadLegacy).toHaveBeenCalledOnce();
    expect(mocks.acquireLock).toHaveBeenCalledWith("/fixture/data");
    expect(mocks.readMetadata).toHaveBeenCalledTimes(3);
    expect(mocks.release).not.toHaveBeenCalled();
    await backend.release?.();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not import the legacy store when a runtime owns the directory without metadata", async () => {
    const dataPath = await temporaryDirectory();
    const legacyFile = path.join(dataPath, ".devices.json");
    const lease = await acquireRuntimeLock(dataPath);
    const loadLegacy = vi.fn(async () => {
      await fs.writeFile(legacyFile, "unexpected legacy write");
      return authDependencies().legacy;
    });
    try {
      await expect(createAuthHelperBackend(dataPath, true, { loadLegacy })).rejects.toMatchObject({ code: "ELOCKED" });
      expect(loadLegacy).not.toHaveBeenCalled();
      await expect(fs.stat(legacyFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(dataPath, HOST_CONTROL_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await lease.release();
    }
  });

  it("rechecks discovery after acquiring the lease and contacts a newly published owner", async () => {
    const mocks = authDependencies();
    mocks.readMetadata.mockResolvedValueOnce(null).mockResolvedValueOnce(metadata);
    const backend = await createAuthHelperBackend("/fixture/data", true, mocks.dependencies);
    expect(await backend.getAccessCode()).toBe("123456");
    expect(mocks.acquireLock).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.loadLegacy).not.toHaveBeenCalled();
  });

  it.each(["discovery", "import"])("releases the lease after a %s failure", async (stage) => {
    const mocks = authDependencies();
    mocks.readMetadata.mockResolvedValue(null);
    if (stage === "discovery") {
      mocks.readMetadata.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Discovery failed"));
    } else {
      mocks.loadLegacy.mockRejectedValueOnce(new Error("Legacy import failed"));
    }
    await expect(createAuthHelperBackend("/fixture/data", true, mocks.dependencies)).rejects.toThrow("failed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects corrupt discovery data without importing or modifying the legacy store", async () => {
    const dataPath = await temporaryDirectory();
    await fs.writeFile(path.join(dataPath, HOST_CONTROL_FILENAME), "invalid metadata");
    const legacyFile = path.join(dataPath, ".devices.json");
    await fs.writeFile(legacyFile, "legacy fixture");
    const loadLegacy = vi.fn();
    await expect(createAuthHelperBackend(dataPath, true, { loadLegacy })).rejects.toThrow("metadata");
    expect(loadLegacy).not.toHaveBeenCalled();
    expect(await fs.readFile(legacyFile, "utf8")).toBe("legacy fixture");
  });
});

describe("runServerAuthCli", () => {
  it.each([
    { argv: ["access-code", "--plain"], result: "123456", output: "123456" },
    { argv: ["access-requests", "--count"], result: [pending], output: "1" },
  ])("preserves legacy machine-readable output for $argv through the owner", async ({ argv, result, output }) => {
    const mocks = authDependencies(result);
    expect(await runServerAuthCli(argv, mocks.dependencies)).toBe(0);
    expect(mocks.write).toHaveBeenCalledWith(output);
    expect(mocks.loadLegacy).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ["access-code", "--plain", "--legacy"], env: {} },
    { argv: ["access-code", "--plain"], env: { CODEMUX_LEGACY_DEV: "1" } },
  ])("accepts explicit legacy compatibility via $argv and $env", async ({ argv, env }) => {
    const mocks = authDependencies();
    mocks.readMetadata.mockResolvedValue(null);
    expect(await runServerAuthCli(argv, { ...mocks.dependencies, env })).toBe(0);
    expect(mocks.write).toHaveBeenCalledWith("654321");
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("holds the legacy lease through an interactive session and releases it after approval fails", async () => {
    const dataPath = await temporaryDirectory();
    const mocks = authDependencies();
    mocks.prompt.ask.mockImplementation(async () => {
      await expect(acquireRuntimeLock(dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
      return "approve";
    });
    vi.mocked(mocks.legacy.approveRequest).mockRejectedValue(new Error("Approval failed"));
    expect(await runServerAuthCli(["access-requests", "--legacy", "--data-dir", dataPath], {
      ...mocks.dependencies,
      readMetadata: readHostControlMetadata,
      acquireLock: acquireRuntimeLock,
      interactive: true,
    })).toBe(1);
    expect(mocks.prompt.close).toHaveBeenCalledOnce();
    const nextLease = await acquireRuntimeLock(dataPath);
    await nextLease.release();
  });

  it.each([
    { answer: "approve", method: "auth:approveRequest", action: "Approved" },
    { answer: "deny", method: "auth:denyRequest", action: "Denied" },
  ])("retains TTY $action device display while the controller returns a boolean", async ({ answer, method, action }) => {
    const mocks = authDependencies();
    mocks.call.mockImplementation(async (_dataPath?: unknown, calledMethod?: unknown) => calledMethod === "auth:getPendingRequests" ? [pending] : true);
    mocks.prompt.ask.mockResolvedValue(answer);
    expect(await runServerAuthCli(["access-requests"], { ...mocks.dependencies, interactive: true })).toBe(0);
    expect(mocks.call).toHaveBeenCalledWith("/fixture/data", method, [pending.id]);
    expect(mocks.write.mock.calls.map(call => call[0]).join("\n")).toContain(`${action} request request-1 for Test Phone.`);
    expect(mocks.prompt.close).toHaveBeenCalledOnce();
  });

  it("retains status text and does not resolve requests in a noninteractive terminal", async () => {
    const mocks = authDependencies();
    mocks.call.mockImplementation(async (_dataPath?: unknown, method?: unknown) => method === "auth:getAccessCode" ? "123456" : [pending]);
    expect(await runServerAuthCli(["status"], mocks.dependencies)).toBe(0);
    const output = mocks.write.mock.calls.map(call => call[0]).join("\n");
    expect(output).toContain("Access code:");
    expect(output).toContain("Pending requests (1):");
    expect(output).toContain("Test Phone");
    expect(mocks.dependencies.createPrompt).not.toHaveBeenCalled();
  });

  it("does not initialize storage for help, invalid input, or a missing owner", async () => {
    const dataPath = path.join(await temporaryDirectory(), "absent");
    const write = vi.fn();
    const error = vi.fn();
    expect(await runServerAuthCli(["help", "--data-dir", dataPath], { write, error })).toBe(0);
    expect(await runServerAuthCli(["unknown", "--data-dir", dataPath], { write, error })).toBe(1);
    expect(await runServerAuthCli(["access-code", "--data-dir", dataPath], { write, error, env: {} })).toBe(1);
    await expect(fs.stat(dataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
