import { EventEmitter } from "node:events";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), existsSync: vi.fn(() => false), readdirSync: vi.fn(),
  statSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(),
  homedir: vi.fn(() => "/test-home"),
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("fs", () => ({ default: mocks }));
vi.mock("os", () => ({ default: { homedir: mocks.homedir } }));

import { TunnelManager } from "../../../scripts/tunnel-manager";

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((signal: string) => {
      if (signal === "SIGKILL") {
        proc.signalCode = signal;
        queueMicrotask(() => proc.emit("close"));
      }
      return true;
    }),
  });
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
  vi.stubEnv("CODEMUX_SERVER_STATE_DIR", "/test-state");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("TunnelManager", () => {
  it("does not complete shutdown until the owned connector actually exits", async () => {
    vi.useFakeTimers();
    const proc = fakeProcess();
    mocks.spawn.mockReturnValue(proc);
    const manager = new TunnelManager();
    await manager.start(9000);
    let stopped = false;
    const stopping = manager.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(stopped).toBe(true);
    expect(manager.getInfo()).toEqual({ status: "stopped", url: "" });
  });

  it("ignores output and close events from the retired connector after a restart", async () => {
    const oldProc = fakeProcess();
    const newProc = fakeProcess();
    mocks.spawn.mockReturnValueOnce(oldProc).mockReturnValueOnce(newProc);
    const manager = new TunnelManager();
    await manager.start(9000);
    const stopping = manager.stop();
    oldProc.emit("close");
    await stopping;
    await manager.start(9000);
    newProc.stderr.emit("data", Buffer.from("https://new-entry.trycloudflare.com"));
    oldProc.stderr.emit("data", Buffer.from("https://old-entry.trycloudflare.com"));
    oldProc.emit("close");
    expect(manager.getInfo().url).toBe("https://new-entry.trycloudflare.com");
    const finalStop = manager.stop();
    newProc.emit("close");
    await finalStop;
  });

  it("passes the saved hostname through an isolated named-tunnel config to cloudflared", async () => {
    const credential = "12345678-1234-1234-1234-123456789abc.json";
    const credentialsDir = path.join(mocks.homedir(), ".cloudflared");
    const configPath = path.join("/test-state", "cloudflared-config.yml");
    mocks.existsSync.mockImplementation(file => file === credentialsDir);
    mocks.readdirSync.mockReturnValue([credential]);
    const proc = fakeProcess();
    mocks.spawn.mockReturnValue(proc);
    const manager = new TunnelManager();
    const info = await manager.start(9000, { hostname: "codemux.example.test" });
    expect(mocks.spawn).toHaveBeenCalledWith("cloudflared", [
      "tunnel", "--config", configPath, "run",
    ]);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(configPath, expect.stringContaining('hostname: "codemux.example.test"'));
    expect(mocks.writeFileSync).toHaveBeenCalledWith(configPath, expect.stringContaining("service: http://localhost:9000"));
    expect(info).toMatchObject({ status: "starting", url: "https://codemux.example.test" });
    proc.stderr.emit("data", Buffer.from("Registered tunnel connection"));
    expect(manager.getInfo()).toMatchObject({ status: "running", url: "https://codemux.example.test" });
    const stopping = manager.stop();
    proc.emit("close");
    await stopping;
  });
});
