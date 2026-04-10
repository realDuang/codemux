import { EventEmitter } from "events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, createInterfaceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createInterfaceMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("readline", () => ({
  createInterface: createInterfaceMock,
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  codexLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { codexLog } from "../../../../../electron/main/services/logger";
import { CodexJsonRpcClient } from "../../../../../electron/main/engines/codex/jsonrpc-client";

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
    pid: number;
  };

  proc.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn(),
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 1234;

  return proc;
}

function createMockReadline() {
  return Object.assign(new EventEmitter(), {
    close: vi.fn(),
  });
}

describe("CodexJsonRpcClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects requests immediately when stdin is not writable", async () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    (client as any).proc = {
      stdin: {
        writable: false,
      },
    };

    await expect(client.request("initialize", {})).rejects.toThrow("Cannot write to Codex stdin: not writable");
  });

  it("preserves string request ids when responding to server requests", () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const write = vi.fn();
    (client as any).proc = {
      stdin: {
        writable: true,
        write,
      },
    };

    client.respond("req-7", { ok: true });
    client.respondError("req-8", -32000, "Denied", { reason: "user" });

    expect(write).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({ jsonrpc: "2.0", id: "req-7", result: { ok: true } })}\n`,
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({ jsonrpc: "2.0", id: "req-8", error: { code: -32000, message: "Denied", data: { reason: "user" } } })}\n`,
    );
  });

  it("routes server requests and notifications from stdout lines", () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const onRequest = vi.fn();
    const onNotification = vi.fn();
    client.on("request", onRequest);
    client.on("notification", onNotification);

    (client as any).handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: "server-1",
      method: "item/tool/call",
      params: { tool: "demo" },
    }));
    (client as any).handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread-1" },
    }));

    expect(onRequest).toHaveBeenCalledWith("server-1", "item/tool/call", { tool: "demo" });
    expect(onNotification).toHaveBeenCalledWith("turn/started", { threadId: "thread-1" });
  });

  it("resolves and rejects pending requests using the exact response id", () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const resolve = vi.fn();
    const reject = vi.fn();
    const okTimer = setTimeout(() => undefined, 10_000);
    const errTimer = setTimeout(() => undefined, 10_000);

    (client as any).pendingRequests.set("req-ok", { resolve, reject, timer: okTimer });
    (client as any).pendingRequests.set(2, { resolve, reject, timer: errTimer });

    (client as any).handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: "req-ok",
      result: { ok: true },
    }));
    (client as any).handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "Boom" },
    }));

    expect(resolve).toHaveBeenCalledWith({ ok: true });
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: "Boom (code: -32603)" }));
    expect((client as any).pendingRequests.size).toBe(0);
  });

  it("times out requests and removes them from the pending map", async () => {
    vi.useFakeTimers();

    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    (client as any).proc = {
      stdin: {
        writable: true,
        write: vi.fn(),
      },
    };

    const pending = client.request("initialize", {}, 50);
    const assertion = expect(pending).rejects.toThrow("Request initialize (id=1) timed out after 50ms");
    await vi.advanceTimersByTimeAsync(51);

    await assertion;
    expect((client as any).pendingRequests.size).toBe(0);
  });

  it("starts the Codex child process, wires stdio listeners, and rejects pending work on exit", async () => {
    const proc = createMockProcess();
    const rl = createMockReadline();
    spawnMock.mockReturnValue(proc);
    createInterfaceMock.mockReturnValue(rl);

    const client = new CodexJsonRpcClient({
      cliPath: "codex",
      args: ["app-server"],
      env: { FOO: "bar" },
    });
    const onExit = vi.fn();
    client.on("exit", onExit);

    await client.start();
    await client.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("codex", ["app-server"], expect.objectContaining({
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }));
    expect((spawnMock.mock.calls[0]?.[2] as any).env.FOO).toBe("bar");
    expect((spawnMock.mock.calls[0]?.[2] as any).env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(createInterfaceMock).toHaveBeenCalledWith({ input: proc.stdout });
    expect(client.running).toBe(true);

    const pending = client.request("initialize", {});
    expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"method":"initialize"'));

    proc.emit("exit", 1, "SIGTERM");

    await expect(pending).rejects.toThrow("Codex process exited (code=1, signal=SIGTERM)");
    expect(onExit).toHaveBeenCalledWith(1, "SIGTERM");
    expect(client.running).toBe(false);
  });

  it("rejects pending requests and emits a client error when the child process errors", async () => {
    const proc = createMockProcess();
    const rl = createMockReadline();
    spawnMock.mockReturnValue(proc);
    createInterfaceMock.mockReturnValue(rl);

    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const onError = vi.fn();
    client.on("error", onError);

    await client.start();
    const pending = client.request("slowCall", {});
    const error = new Error("spawn failed");

    proc.emit("error", error);

    await expect(pending).rejects.toThrow("spawn failed");
    expect(onError).toHaveBeenCalledWith(error);
    expect(client.running).toBe(false);
  });

  it("stops the process with SIGTERM, closes readline, and rejects active requests", async () => {
    const proc = createMockProcess();
    const rl = createMockReadline();
    spawnMock.mockReturnValue(proc);
    createInterfaceMock.mockReturnValue(rl);

    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    await client.start();
    const pending = client.request("slowCall", {});

    const stopPromise = client.stop();

    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    proc.emit("exit", 0, null);

    await stopPromise;
    await expect(pending).rejects.toThrow("Client stopped");
    expect((client as any).proc).toBeNull();
    expect(client.running).toBe(false);
  });

  it("emits an error when notifications cannot be written and ignores blank or non-JSON lines", () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const onError = vi.fn();
    const onNotification = vi.fn();
    client.on("error", onError);
    client.on("notification", onNotification);

    (client as any).proc = {
      stdin: {
        writable: true,
        write: vi.fn(() => {
          throw new Error("write failed");
        }),
      },
    };

    client.notify("initialized", { ok: true });
    (client as any).handleLine("   ");
    (client as any).handleLine("not-json");

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "write failed" }));
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("redacts payload contents in debug logs for outbound and inbound JSON-RPC messages", () => {
    const client = new CodexJsonRpcClient({ cliPath: "codex", args: ["app-server"] });
    const write = vi.fn();
    (client as any).proc = {
      stdin: {
        writable: true,
        write,
      },
    };

    (client as any).writeMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "turn/start",
      params: {
        input: [{ type: "text", text: "super secret prompt" }],
        diff: "secret diff",
        cwd: "/repo",
      },
    });
    (client as any).handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: "secret output",
        diff: "private diff",
      },
    }));

    expect(write).toHaveBeenCalledTimes(1);
    expect(codexLog.debug).toHaveBeenCalledWith("[→ Codex] request method=turn/start id=7 keys=input,diff,cwd");
    expect(codexLog.debug).toHaveBeenCalledWith("[← Codex] response id=7 keys=content,diff");
    expect(codexLog.debug).not.toHaveBeenCalledWith(expect.stringContaining("super secret prompt"));
    expect(codexLog.debug).not.toHaveBeenCalledWith(expect.stringContaining("secret diff"));
    expect(codexLog.debug).not.toHaveBeenCalledWith(expect.stringContaining("secret output"));
  });
});
