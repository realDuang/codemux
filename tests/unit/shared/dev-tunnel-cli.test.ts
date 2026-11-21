import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
import { runDevTunnelCommand } from "../../../shared/dev-tunnel-cli";

class Process extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 123456;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => { this.finish(1); return true; });
  finish(code: number) { this.exitCode = code; this.emit("close", code); }
}

function fixture() {
  const child = new Process();
  mocks.spawn.mockReturnValue(child);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    child.finish(1);
    callback(null);
  });
  return child;
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("runDevTunnelCommand", () => {
  it("keeps stderr diagnostics out of structured stdout", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["user", "show", "--json"], { signal: new AbortController().signal });
    child.stderr.emit("data", Buffer.from("A diagnostic from the CLI\n"));
    child.stdout.emit("data", Buffer.from('{"status":"Logged in"}'));
    child.finish(0);
    expect(JSON.parse(await running)).toEqual({ status: "Logged in" });
  });

  it("terminates device-code fallback instead of returning or logging its challenge", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["user", "login", "--use-browser-auth"], { signal: new AbortController().signal, login: true });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_LOGIN_REQUIRED" });
    child.stderr.emit("data", Buffer.from("Falling back to device code authentication. SECRET-CODE"));
    await failed;
    expect(child.exitCode).not.toBeNull();
    if (process.platform === "win32") {
      const encoded = mocks.spawn.mock.calls[0][1].at(-1);
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      expect(script).toContain("--use-browser-auth");
      expect(script).toContain("Start-Process");
      expect(script).not.toContain("--use-device-code-auth");
      expect(mocks.execFile.mock.calls[0][1]).toEqual(["/PID", "123456", "/T", "/F"]);
    }
  });

  it("cancels only the owned CLI process", async () => {
    const child = fixture();
    const abort = new AbortController();
    const running = runDevTunnelCommand("devtunnel", ["host", "codemux-test"], { signal: abort.signal, timeout: 0 });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_CANCELLED" });
    abort.abort();
    await failed;
    expect(child.exitCode).not.toBeNull();
  });

  it.runIf(process.platform === "win32")("reports failed process termination instead of hanging or silently succeeding", async () => {
    fixture();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("Access denied")));
    const abort = new AbortController();
    const running = runDevTunnelCommand("devtunnel", ["host", "codemux-test"], { signal: abort.signal, timeout: 0 });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_STOP_FAILED" });
    abort.abort();
    await failed;
  });

  it("redacts raw CLI failure output and times out stalled commands", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["show", "codemux-test"], { signal: new AbortController().signal });
    child.stderr.emit("data", Buffer.from("Request failed: Authorization: SECRET-TOKEN"));
    child.finish(1);
    await expect(running).rejects.toThrow("Dev Tunnels command failed.");
    vi.useFakeTimers();
    fixture();
    const stalled = runDevTunnelCommand("devtunnel", ["list"], { signal: new AbortController().signal, timeout: 100 });
    const failed = expect(stalled).rejects.toMatchObject({ code: "DEVTUNNEL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
  });
});
