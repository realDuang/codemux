import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHost, readHostControlMetadata } from "../../../shared/host-control-client";
import { startHostControlServer, type HostControlServer, type HostControlServerOptions } from "../../../shared/host-control-server";
import { HOST_CONTROL_FILENAME, type HostControlMetadata, type HostRuntimeStatus } from "../../../shared/host-control-types";

let directory: string;
let hosts: HostControlServer[];
let listeners: Server[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-host-control-"));
  hosts = [];
  listeners = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.allSettled(hosts.map(host => host.close()));
  await Promise.all(listeners.map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await fs.rm(directory, { recursive: true, force: true });
});

function status(dataPath = directory): HostRuntimeStatus {
  return {
    pid: process.pid, phase: "ready", ready: true, dataPath,
    webPort: 8233, gatewayUrl: "ws://127.0.0.1:8233/ws",
  };
}

async function start(options: Partial<HostControlServerOptions> = {}): Promise<HostControlServer> {
  const host = await startHostControlServer({
    dataPath: directory, invoke: () => undefined, getStatus: () => status(), stop: () => {}, ...options,
  });
  hosts.push(host);
  return host;
}

async function metadata(dataPath = directory): Promise<HostControlMetadata> {
  const value = await readHostControlMetadata(dataPath);
  if (!value) throw new Error("Missing test host metadata");
  return value;
}

describe("expected host ownership", () => {
  it("does not invoke a replacement owner when the caller pins another instance", async () => {
    const invoke = vi.fn();
    const stop = vi.fn();
    await start({ invoke, stop });
    await expect(callHost(directory, "host:stop", [], { expectedInstanceId: randomUUID() }))
      .rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(await callHost(directory, "host:status")).toMatchObject({ ready: true });
  });
});

async function request(
  data: HostControlMetadata,
  body: unknown,
  options: { headers?: Record<string, string>; pathname?: string; method?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${data.port}${options.pathname ?? "/control"}`, {
    method: options.method ?? "POST",
    headers: { Authorization: `Bearer ${data.ownerCredential}`, "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

async function writeMetadata(value: unknown): Promise<void> {
  await fs.writeFile(path.join(directory, HOST_CONTROL_FILENAME), JSON.stringify(value), { mode: 0o600 });
}

async function fakeListener(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<HostControlMetadata> {
  const server = http.createServer(handler);
  listeners.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener port");
  const value: HostControlMetadata = {
    version: 1, instanceId: randomUUID(), pid: process.pid, port: address.port,
    dataPath: await fs.realpath(directory), ownerCredential: "a".repeat(64),
  };
  await writeMetadata(value);
  return value;
}

describe("startHostControlServer", () => {
  it("publishes private canonical metadata and exposes only nonsecret listener information", async () => {
    const dataPath = path.join(directory, "data");
    const aliasPath = path.join(directory, "alias");
    await fs.mkdir(dataPath);
    await fs.symlink(dataPath, aliasPath, "junction");
    const host = await start({ dataPath: aliasPath });
    const saved = await metadata(aliasPath);

    expect(saved).toMatchObject({ version: 1, pid: process.pid, dataPath: await fs.realpath(dataPath), instanceId: host.instanceId, port: host.port });
    expect(saved.ownerCredential).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(host).sort()).toEqual(["close", "dataPath", "instanceId", "port"]);
    expect(await fs.readdir(dataPath)).toEqual([HOST_CONTROL_FILENAME]);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(dataPath, HOST_CONTROL_FILENAME))).mode & 0o777).toBe(0o600);
    }
  });

  it("dispatches owner calls and returns status without placing credentials in responses", async () => {
    const invoke = vi.fn((method: string, args?: unknown[]) => method === "settings:load" ? { locale: args?.[0] } : undefined);
    await start({ invoke });
    const saved = await metadata();

    await expect(callHost(directory, "settings:load", ["en"])).resolves.toEqual({ locale: "en" });
    await expect(callHost(directory, "settings:save", ["locale", "zh"])).resolves.toBeUndefined();
    await expect(callHost(directory, "host:status")).resolves.toEqual(status());
    expect(invoke.mock.calls).toEqual([["settings:load", ["en"]], ["settings:save", ["locale", "zh"]]]);
    const response = await request(saved, { method: "host:status" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(saved.ownerCredential);
  });

  it.each([
    { authorization: "" },
    { authorization: "Bearer device.jwt.token" },
    { authorization: `Bearer ${"0".repeat(64)}` },
    { "x-forwarded-for": "203.0.113.2" },
    { "x-real-ip": "203.0.113.2" },
    { forwarded: "for=203.0.113.2;host=localhost" },
    { "x-forwarded-host": "remote.example" },
    { origin: "https://remote.example" },
    { origin: "null" },
  ])("rejects an unauthenticated or remotely forwarded owner call: %j", async (headers) => {
    const invoke = vi.fn();
    const stop = vi.fn();
    await start({ invoke, stop });
    const response = await request(await metadata(), { method: "host:stop" }, { headers });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a remote Host authority and duplicated authorization headers", async () => {
    const invoke = vi.fn();
    await start({ invoke });
    const saved = await metadata();
    for (const headers of [
      { Host: "remote.example", Authorization: `Bearer ${saved.ownerCredential}` },
      { Authorization: [`Bearer ${saved.ownerCredential}`, `Bearer ${saved.ownerCredential}`] },
    ]) {
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = http.request({
          hostname: "127.0.0.1", port: saved.port, path: "/control", method: "POST", headers,
        }, incoming => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        });
        outgoing.once("error", reject);
        outgoing.end(JSON.stringify({ method: "settings:load" }));
      });
      expect(code).toBe(401);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects URL and body credentials and never invokes malformed requests", async () => {
    const invoke = vi.fn();
    await start({ invoke });
    const saved = await metadata();
    const query = await request(saved, { method: "settings:load" }, { pathname: `/control?token=${saved.ownerCredential}` });
    expect(query.status).toBe(404);
    for (const body of [
      null, [], { method: "settings:load", args: {} },
      { method: "settings:load", ownerCredential: saved.ownerCredential },
      { method: "", args: [] }, { method: "x".repeat(129) },
    ]) {
      const response = await request(saved, body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(saved.ownerCredential);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns bounded controller errors without triggering unknown actions or exposing credentials", async () => {
    const action = vi.fn();
    let secret = "";
    await start({ invoke(method) {
      if (method === "known") return action();
      throw new Error(`Unknown method\n${secret}${"x".repeat(800)}`);
    } });
    secret = (await metadata()).ownerCredential;

    const response = await request(await metadata(), { method: "__proto__" });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toHaveLength(512);
    expect(body.error).not.toContain(secret);
    expect(body.error).not.toContain("\n");
    expect(action).not.toHaveBeenCalled();
  });

  it("acknowledges stop before shutdown closes the listener and removes metadata", async () => {
    let finishShutdown!: () => void;
    const shutdown = new Promise<void>(resolve => { finishShutdown = resolve; });
    const stop = vi.fn(async () => {
      await host.close();
      finishShutdown();
    });
    const host = await start({ stop });

    await expect(callHost(directory, "host:stop")).resolves.toEqual({ stopping: true });
    await shutdown;

    expect(stop).toHaveBeenCalledOnce();
    expect(await readHostControlMetadata(directory)).toBeNull();
  });

  it("rotates owner credentials on every start and rejects a previous owner's token", async () => {
    const first = await start();
    const previous = await metadata();
    await first.close();
    await start();
    const current = await metadata();

    expect(current.instanceId).not.toBe(previous.instanceId);
    expect(current.ownerCredential).not.toBe(previous.ownerCredential);
    const response = await request(current, { method: "host:status" }, { headers: { authorization: `Bearer ${previous.ownerCredential}` } });
    expect(response.status).toBe(401);
    await expect(callHost(directory, "host:status")).resolves.toEqual(status());
  });

  it("does not leave a temporary credential file or open listener when metadata publication fails", async () => {
    await fs.mkdir(path.join(directory, HOST_CONTROL_FILENAME));

    await expect(start()).rejects.toBeDefined();

    expect(await fs.readdir(directory)).toEqual([HOST_CONTROL_FILENAME]);
  });
});

describe("HostControlServer.close", () => {
  it("closes once and preserves a replacement owner's metadata", async () => {
    const host = await start();
    const replacement = { ...await metadata(), instanceId: randomUUID(), ownerCredential: "b".repeat(64) };
    await writeMetadata(replacement);

    const closed = host.close();
    expect(host.close()).toBe(closed);
    await closed;

    expect(await metadata()).toEqual(replacement);
    await expect(callHost(directory, "host:status")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("waits for an invoked operation after its client disconnects", async () => {
    let finishOperation!: () => void;
    const operation = new Promise<void>(resolve => { finishOperation = resolve; });
    let invocationStarted!: () => void;
    const started = new Promise<void>(resolve => { invocationStarted = resolve; });
    const host = await start({ invoke: async () => {
      invocationStarted();
      await operation;
      return "saved";
    } });
    const controller = new AbortController();
    const response = request(await metadata(), { method: "settings:save" }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(response).rejects.toBeDefined();
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      expect(await readHostControlMetadata(directory)).not.toBeNull();
    } finally {
      finishOperation();
      await closing;
    }
    expect(await readHostControlMetadata(directory)).toBeNull();
  });

  it("rejects a body completed after shutdown begins without invoking the controller", async () => {
    const invoke = vi.fn();
    const host = await start({ invoke });
    const saved = await metadata();
    const body = JSON.stringify({ method: "settings:save", args: ["locale", "en"] });
    const outgoing = http.request({
      hostname: "127.0.0.1", port: saved.port, path: "/control", method: "POST",
      headers: { Authorization: `Bearer ${saved.ownerCredential}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    });
    const connected = new Promise<void>(resolve => outgoing.once("socket", socket => socket.once("connect", resolve)));
    const response = new Promise<number | undefined>((resolve, reject) => {
      outgoing.once("response", incoming => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming.statusCode));
      });
      outgoing.once("error", reject);
    });
    outgoing.write(body.slice(0, 1));
    await connected;
    // Allow the accepted request to enter its body reader before closing admission.
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const closed = host.close();
    outgoing.end(body.slice(1));

    expect(await response).toBe(503);
    await closed;
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("readHostControlMetadata", () => {
  it("returns null for missing state without creating directories or settings", async () => {
    const missing = path.join(directory, "missing");

    expect(await readHostControlMetadata(missing)).toBeNull();
    expect(await readHostControlMetadata(directory)).toBeNull();
    await expect(callHost(missing, "host:status")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([
    { version: 2 }, { instanceId: "not-a-uuid" }, { pid: 0 }, { pid: 1.2 },
    { port: 0 }, { port: 65_536 }, { port: "1234" },
    { dataPath: "/another/data/directory" }, { ownerCredential: "device.jwt.token" },
  ])("fails closed for invalid metadata: %j", async (invalid) => {
    await start();
    await writeMetadata({ ...await metadata(), ...invalid });

    await expect(readHostControlMetadata(directory)).rejects.toMatchObject({ code: "INVALID_METADATA" });
    await expect(callHost(directory, "host:status")).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });

  it("fails closed for malformed, oversized and unreadable discovery files", async () => {
    const filename = path.join(directory, HOST_CONTROL_FILENAME);
    for (const data of ["{", "x".repeat(16_385)]) {
      await fs.writeFile(filename, data);
      await expect(readHostControlMetadata(directory)).rejects.toMatchObject({ code: "INVALID_METADATA" });
    }
    await fs.unlink(filename);
    await fs.mkdir(filename);
    await expect(readHostControlMetadata(directory)).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });
});

describe("callHost", () => {
  function useControlledTimeouts() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Node's native AbortSignal.timeout does not use the global fake timers.
    return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
  }

  it("waits for channel startup after its 30-second connection fallback", async () => {
    let invocationStarted!: () => void;
    const started = new Promise<void>(resolve => { invocationStarted = resolve; });
    let finishStartup!: () => void;
    await start({ invoke: async () => {
      invocationStarted();
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 30_010);
        finishStartup = () => { clearTimeout(timer); resolve(); };
      });
      return { connected: true };
    } });
    const timeouts = useControlledTimeouts();
    let settled = false;
    const response = callHost(directory, "channel:start", ["feishu"])
      .then(value => ({ value }), error => ({ error }))
      .finally(() => { settled = true; });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(await response).toEqual({ value: { connected: true } });
      expect(timeouts).toHaveBeenCalledWith(120_000);
    } finally {
      finishStartup();
      await response;
    }
  });

  it.each([
    { method: "settings:load", timeoutMs: undefined, deadline: 30_000 },
    { method: "channel:start", timeoutMs: undefined, deadline: 120_000 },
    { method: "channel:start", timeoutMs: 250, deadline: 250 },
    { method: "settings:load", timeoutMs: 250, deadline: 250 },
  ])("bounds $method by $deadline ms with timeout override $timeoutMs", async ({ method, timeoutMs, deadline }) => {
    let invocationStarted!: () => void;
    const started = new Promise<void>(resolve => { invocationStarted = resolve; });
    let finishOperation!: () => void;
    const operation = new Promise<void>(resolve => { finishOperation = resolve; });
    await start({ invoke: async () => {
      invocationStarted();
      await operation;
    } });
    const timeouts = useControlledTimeouts();
    let settled = false;
    const response = callHost(directory, method, [], { timeoutMs }).finally(() => { settled = true; });
    const result = expect(response).rejects.toMatchObject({ code: "UNAVAILABLE" });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(timeouts).toHaveBeenCalledWith(deadline);
    } finally {
      finishOperation();
    }
  });

  it("constructs a loopback URL and sends owner credentials only in the authorization header", async () => {
    let observed: { url?: string; authorization?: string; host?: string; body: string } | undefined;
    const saved = await fakeListener((req, res) => {
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => {
        observed = { url: req.url, authorization: req.headers.authorization, host: req.headers.host, body };
        res.end(JSON.stringify({ result: ["en"] }));
      });
    });

    await expect(callHost(directory, "settings:load", [])).resolves.toEqual(["en"]);

    expect(observed).toEqual({
      url: "/control", authorization: `Bearer ${saved.ownerCredential}`, host: `127.0.0.1:${saved.port}`,
      body: '{"method":"settings:load","args":[]}',
    });
  });

  it("never follows redirects carrying the owner's authorization", async () => {
    let targetReached = false;
    await fakeListener((req, res) => {
      if (req.url === "/control") {
        res.writeHead(302, { Location: "/redirected" });
      } else {
        targetReached = true;
      }
      res.end();
    });

    await expect(callHost(directory, "host:status")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(targetReached).toBe(false);
  });

  it("applies its timeout to the full response body", async () => {
    await fakeListener((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"result":');
    });

    await expect(callHost(directory, "host:status", [], { timeoutMs: 30 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it.each([
    [401, { error: "Unauthorized" }, "UNAUTHORIZED"],
    [400, { error: "Unknown method" }, "REQUEST_FAILED"],
    [500, {}, "REQUEST_FAILED"],
    [200, null, "REQUEST_FAILED"],
  ])("classifies status %i without falling back to another host", async (code, body, expected) => {
    await fakeListener((_req, res) => {
      res.writeHead(code);
      res.end(JSON.stringify(body));
    });

    await expect(callHost(directory, "host:status")).rejects.toMatchObject({ code: expected });
  });
});
