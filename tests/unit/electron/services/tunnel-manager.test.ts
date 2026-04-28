import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockHomedir = vi.hoisted(() => vi.fn(() => "/mock/home"));
const mockApp = vi.hoisted(() => ({
  isPackaged: false,
  getPath: vi.fn(() => "/mock/userData"),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  ChildProcess: class {},
}));

vi.mock("electron", () => ({
  app: mockApp,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    writeFileSync: mockWriteFileSync,
  },
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("os", () => ({
  default: { homedir: mockHomedir },
  homedir: mockHomedir,
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  tunnelLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks registered)
// ---------------------------------------------------------------------------

import { tunnelManager } from "../../../../electron/main/services/tunnel-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake ChildProcess built on EventEmitter with stdout/stderr emitters. */
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 12345;
}

function createMockProcess(): MockChildProcess {
  return new MockChildProcess();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TunnelManager", () => {
  let mockProcess: MockChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset singleton internal state
    (tunnelManager as any).process = null;
    (tunnelManager as any).info = { url: "", status: "stopped" };
    (tunnelManager as any).stoppedByUser = false;
    (tunnelManager as any).onUnexpectedExit = null;

    // Default: dev mode
    mockApp.isPackaged = false;

    mockProcess = createMockProcess();
    mockSpawn.mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getInfo()
  // -------------------------------------------------------------------------

  describe("getInfo()", () => {
    it("returns current info state", () => {
      const info = tunnelManager.getInfo();
      expect(info).toEqual({ url: "", status: "stopped" });
    });

    it("reflects updated info after internal change", () => {
      (tunnelManager as any).info = {
        url: "https://test.trycloudflare.com",
        status: "running",
        startTime: 1000,
      };
      const info = tunnelManager.getInfo();
      expect(info.url).toBe("https://test.trycloudflare.com");
      expect(info.status).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // setOnUnexpectedExit()
  // -------------------------------------------------------------------------

  describe("setOnUnexpectedExit()", () => {
    it("registers callback", () => {
      const cb = vi.fn();
      tunnelManager.setOnUnexpectedExit(cb);
      expect((tunnelManager as any).onUnexpectedExit).toBe(cb);
    });

    it("overwrites a previously registered callback", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      tunnelManager.setOnUnexpectedExit(cb1);
      tunnelManager.setOnUnexpectedExit(cb2);
      expect((tunnelManager as any).onUnexpectedExit).toBe(cb2);
    });
  });

  // -------------------------------------------------------------------------
  // getCloudflaredPath() (private — tested via start)
  // -------------------------------------------------------------------------

  describe("getCloudflaredPath()", () => {
    it("returns 'cloudflared' in dev mode", () => {
      mockApp.isPackaged = false;
      const result = (tunnelManager as any).getCloudflaredPath();
      expect(result).toBe("cloudflared");
    });

    it("builds platform-specific path in packaged mode", () => {
      mockApp.isPackaged = true;
      const originalResourcesPath = process.resourcesPath;
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      Object.defineProperty(process, "resourcesPath", { value: "/app/resources", configurable: true });
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "arm64", configurable: true });

      try {
        const result = (tunnelManager as any).getCloudflaredPath();
        expect(result).toContain("cloudflared");
        expect(result).toContain("darwin-arm64");
        expect(result).toBe(path.join("/app/resources", "cloudflared", "darwin-arm64", "cloudflared"));
      } finally {
        Object.defineProperty(process, "resourcesPath", { value: originalResourcesPath, configurable: true });
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });

    it("uses .exe extension on win32", () => {
      mockApp.isPackaged = true;
      const originalResourcesPath = process.resourcesPath;
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      Object.defineProperty(process, "resourcesPath", { value: "/app/resources", configurable: true });
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });

      try {
        const result = (tunnelManager as any).getCloudflaredPath();
        expect(result).toBe(path.join("/app/resources", "cloudflared", "win32-x64", "cloudflared.exe"));
      } finally {
        Object.defineProperty(process, "resourcesPath", { value: originalResourcesPath, configurable: true });
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // detectTunnelId() (private)
  // -------------------------------------------------------------------------

  describe("detectTunnelId()", () => {
    const validUuid1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const validUuid2 = "11111111-2222-3333-4444-555555555555";

    it("returns null when .cloudflared directory does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const result = (tunnelManager as any).detectTunnelId();
      expect(result).toBeNull();
    });

    it("returns null when no credential files exist", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["config.yml", "cert.pem", "random.txt"]);
      const result = (tunnelManager as any).detectTunnelId();
      expect(result).toBeNull();
    });

    it("returns UUID from a single credential file", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([`${validUuid1}.json`]);
      const result = (tunnelManager as any).detectTunnelId();
      expect(result).toBe(validUuid1);
    });

    it("returns most recently modified UUID when multiple credentials exist", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        `${validUuid1}.json`,
        `${validUuid2}.json`,
      ]);
      mockStatSync
        .mockReturnValueOnce({ mtime: new Date(1000) }) // uuid1 older
        .mockReturnValueOnce({ mtime: new Date(2000) }); // uuid2 newer

      const result = (tunnelManager as any).detectTunnelId();
      expect(result).toBe(validUuid2);
    });

    it("ignores files that do not match UUID pattern", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        "not-a-uuid.json",
        `${validUuid1}.json`,
        "config.yml",
      ]);
      const result = (tunnelManager as any).detectTunnelId();
      expect(result).toBe(validUuid1);
    });
  });

  // -------------------------------------------------------------------------
  // start() — quick tunnel
  // -------------------------------------------------------------------------

  describe("start() - quick tunnel", () => {
    it("spawns cloudflared with correct args for quick tunnel", async () => {
      const info = await tunnelManager.start(3000);

      expect(mockSpawn).toHaveBeenCalledWith("cloudflared", [
        "tunnel",
        "--url",
        "http://localhost:3000",
      ]);
      expect(info.status).toBe("starting");
    });

    it("parses URL from stdout and sets status to running", async () => {
      await tunnelManager.start(3000);

      // Simulate cloudflared outputting the URL
      mockProcess.stdout.emit(
        "data",
        Buffer.from(
          "2024-01-01 INFO | https://random-slug.trycloudflare.com connected",
        ),
      );

      const info = tunnelManager.getInfo();
      expect(info.url).toBe("https://random-slug.trycloudflare.com");
      expect(info.status).toBe("running");
    });

    it("parses URL from stderr as well", async () => {
      await tunnelManager.start(3000);

      mockProcess.stderr.emit(
        "data",
        Buffer.from(
          "https://some-tunnel.trycloudflare.com is ready",
        ),
      );

      const info = tunnelManager.getInfo();
      expect(info.url).toBe("https://some-tunnel.trycloudflare.com");
      expect(info.status).toBe("running");
    });

    it("preserves startTime when URL is parsed", async () => {
      const returned = await tunnelManager.start(3000);
      const startTime = returned.startTime;

      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://test.trycloudflare.com"),
      );

      const info = tunnelManager.getInfo();
      expect(info.startTime).toBe(startTime);
    });
  });

  // -------------------------------------------------------------------------
  // start() — named tunnel
  // -------------------------------------------------------------------------

  describe("start() - named tunnel", () => {
    const tunnelUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    beforeEach(() => {
      // detectTunnelId will find a credential file
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([`${tunnelUuid}.json`]);
    });

    it("generates config file and spawns with --config arg", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [configPath, yaml] = mockWriteFileSync.mock.calls[0];
      expect(configPath).toContain("cloudflared-config.yml");
      expect(yaml).toContain(`tunnel: ${tunnelUuid}`);
      expect(yaml).toContain("codemux.example.com");
      expect(yaml).toContain("http://localhost:3000");
      expect(yaml).toContain("http_status:404");

      expect(mockSpawn).toHaveBeenCalledWith("cloudflared", [
        "tunnel",
        "--config",
        expect.stringContaining("cloudflared-config.yml"),
        "run",
      ]);
    });

    it("sets URL from hostname (prepends https:// if missing)", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      const info = tunnelManager.getInfo();
      expect(info.url).toBe("https://codemux.example.com");
      expect(info.status).toBe("starting");
    });

    it("preserves hostname URL that already has https://", async () => {
      await tunnelManager.start(3000, {
        hostname: "https://codemux.example.com",
      });

      const info = tunnelManager.getInfo();
      expect(info.url).toBe("https://codemux.example.com");
    });

    it("strips protocol from hostname in config YAML", async () => {
      await tunnelManager.start(3000, {
        hostname: "https://codemux.example.com",
      });

      const [, yaml] = mockWriteFileSync.mock.calls[0];
      expect(yaml).toContain("hostname: codemux.example.com");
      expect(yaml).not.toContain("hostname: https://");
    });

    it("detects readiness from 'Registered tunnel connection' output", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      expect(tunnelManager.getInfo().status).toBe("starting");

      mockProcess.stderr.emit(
        "data",
        Buffer.from("Registered tunnel connection connIndex=0"),
      );

      expect(tunnelManager.getInfo().status).toBe("running");
    });

    it("detects readiness from 'Connection registered' output", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      mockProcess.stdout.emit(
        "data",
        Buffer.from("Connection registered connIndex=0"),
      );

      expect(tunnelManager.getInfo().status).toBe("running");
    });

    it("does not re-detect readiness once already running", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      // First connection message -> running
      mockProcess.stderr.emit(
        "data",
        Buffer.from("Registered tunnel connection connIndex=0"),
      );
      expect(tunnelManager.getInfo().status).toBe("running");

      // Manually set URL to something to track if info changes
      const infoBefore = tunnelManager.getInfo();

      // Second connection message should not overwrite info
      mockProcess.stderr.emit(
        "data",
        Buffer.from("Registered tunnel connection connIndex=1"),
      );

      // Status should remain running, not be re-set
      expect(tunnelManager.getInfo().status).toBe("running");
      expect(tunnelManager.getInfo().url).toBe(infoBefore.url);
    });

    it("ignores quick tunnel URLs in named tunnel output", async () => {
      await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      mockProcess.stderr.emit(
        "data",
        Buffer.from("Visit https://random.trycloudflare.com for status"),
      );

      expect(tunnelManager.getInfo().url).toBe("https://codemux.example.com");
      expect(tunnelManager.getInfo().status).toBe("starting");

      mockProcess.stderr.emit(
        "data",
        Buffer.from("Registered tunnel connection https://random.trycloudflare.com"),
      );

      expect(tunnelManager.getInfo().url).toBe("https://codemux.example.com");
      expect(tunnelManager.getInfo().status).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // start() — already running
  // -------------------------------------------------------------------------

  describe("start() - already running", () => {
    it("returns current info without spawning a new process", async () => {
      // First start
      await tunnelManager.start(3000);

      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://existing.trycloudflare.com"),
      );

      mockSpawn.mockClear();

      // Second start attempt
      const info = await tunnelManager.start(4000);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(info.url).toBe("https://existing.trycloudflare.com");
      expect(info.status).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // start() — binary not found
  // -------------------------------------------------------------------------

  describe("start() - binary not found", () => {
    it("returns error info when packaged binary does not exist", async () => {
      mockApp.isPackaged = true;
      const originalResourcesPath = process.resourcesPath;
      Object.defineProperty(process, "resourcesPath", {
        value: "/app/resources",
        configurable: true,
      });

      mockExistsSync.mockReturnValue(false);

      try {
        const info = await tunnelManager.start(3000);

        expect(info.status).toBe("error");
        expect(info.error).toContain("Cloudflared binary not found");
        expect(mockSpawn).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "resourcesPath", {
          value: originalResourcesPath,
          configurable: true,
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // start() — hostname but no credentials
  // -------------------------------------------------------------------------

  describe("start() - hostname but no credentials", () => {
    it("falls back to quick tunnel with warning when .cloudflared directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      const info = await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      expect(info.status).toBe("starting");
      expect(info.warningCode).toBe("NAMED_TUNNEL_NO_CREDENTIALS");
      expect(mockSpawn).toHaveBeenCalledWith("cloudflared", [
        "tunnel",
        "--url",
        "http://localhost:3000",
      ]);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("falls back to quick tunnel with warning when .cloudflared dir exists but has no creds", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["config.yml"]);

      const info = await tunnelManager.start(3000, { hostname: "codemux.example.com" });

      expect(info.status).toBe("starting");
      expect(info.warningCode).toBe("NAMED_TUNNEL_NO_CREDENTIALS");
      expect(mockSpawn).toHaveBeenCalledWith("cloudflared", [
        "tunnel",
        "--url",
        "http://localhost:3000",
      ]);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("preserves missing credentials warning after quick tunnel URL is parsed", async () => {
      mockExistsSync.mockReturnValue(false);

      await tunnelManager.start(3000, { hostname: "codemux.example.com" });
      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://fallback.trycloudflare.com"),
      );

      const info = tunnelManager.getInfo();
      expect(info.status).toBe("running");
      expect(info.url).toBe("https://fallback.trycloudflare.com");
      expect(info.warningCode).toBe("NAMED_TUNNEL_NO_CREDENTIALS");
    });
  });

  // -------------------------------------------------------------------------
  // close event — unexpected exit
  // -------------------------------------------------------------------------

  describe("close event - unexpected exit", () => {
    it("calls onUnexpectedExit when process exits while running", async () => {
      const unexpectedExitCb = vi.fn();
      tunnelManager.setOnUnexpectedExit(unexpectedExitCb);

      await tunnelManager.start(3000);

      // Transition to running
      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://test.trycloudflare.com"),
      );
      expect(tunnelManager.getInfo().status).toBe("running");

      // Simulate unexpected exit
      mockProcess.emit("close");

      expect(unexpectedExitCb).toHaveBeenCalledTimes(1);
      expect(tunnelManager.getInfo().status).toBe("stopped");
    });

    it("calls onUnexpectedExit when process exits while starting", async () => {
      const unexpectedExitCb = vi.fn();
      tunnelManager.setOnUnexpectedExit(unexpectedExitCb);

      await tunnelManager.start(3000);
      expect(tunnelManager.getInfo().status).toBe("starting");

      mockProcess.emit("close");

      expect(unexpectedExitCb).toHaveBeenCalledTimes(1);
    });

    it("clears process reference on unexpected exit", async () => {
      await tunnelManager.start(3000);
      expect((tunnelManager as any).process).toBeTruthy();

      mockProcess.emit("close");

      expect((tunnelManager as any).process).toBeNull();
    });

    it("does not call onUnexpectedExit when no callback is registered", async () => {
      // No callback registered — should not throw
      await tunnelManager.start(3000);
      expect(() => mockProcess.emit("close")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // close event — user stop
  // -------------------------------------------------------------------------

  describe("close event - user stop", () => {
    it("does NOT call onUnexpectedExit when stopped by user", async () => {
      const unexpectedExitCb = vi.fn();
      tunnelManager.setOnUnexpectedExit(unexpectedExitCb);

      await tunnelManager.start(3000);

      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://test.trycloudflare.com"),
      );

      // Stop sets stoppedByUser = true before the close event fires
      await tunnelManager.stop();

      // The close event may fire from proc.once("close", resolve) in stop(),
      // but onUnexpectedExit should NOT be called because stoppedByUser is true
      mockProcess.emit("close");

      expect(unexpectedExitCb).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // error event
  // -------------------------------------------------------------------------

  describe("error event", () => {
    it("sets error status with error message", async () => {
      await tunnelManager.start(3000);

      mockProcess.emit("error", new Error("spawn ENOENT"));

      const info = tunnelManager.getInfo();
      expect(info.status).toBe("error");
      expect(info.error).toBe("spawn ENOENT");
      expect(info.url).toBe("");
    });

    it("clears process reference on error", async () => {
      await tunnelManager.start(3000);
      expect((tunnelManager as any).process).toBeTruthy();

      mockProcess.emit("error", new Error("something went wrong"));

      expect((tunnelManager as any).process).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe("stop()", () => {
    it("sends SIGTERM to the running process", async () => {
      await tunnelManager.start(3000);

      const stopPromise = tunnelManager.stop();

      // Simulate process closing after SIGTERM
      mockProcess.emit("close");
      await stopPromise;

      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("sets status to stopped and clears URL", async () => {
      await tunnelManager.start(3000);

      mockProcess.stdout.emit(
        "data",
        Buffer.from("https://test.trycloudflare.com"),
      );
      expect(tunnelManager.getInfo().status).toBe("running");

      const stopPromise = tunnelManager.stop();
      mockProcess.emit("close");
      await stopPromise;

      const info = tunnelManager.getInfo();
      expect(info.status).toBe("stopped");
      expect(info.url).toBe("");
    });

    it("sets stoppedByUser flag to true", async () => {
      await tunnelManager.start(3000);

      const stopPromise = tunnelManager.stop();
      mockProcess.emit("close");
      await stopPromise;

      expect((tunnelManager as any).stoppedByUser).toBe(true);
    });

    it("clears process reference", async () => {
      await tunnelManager.start(3000);
      expect((tunnelManager as any).process).toBeTruthy();

      const stopPromise = tunnelManager.stop();
      mockProcess.emit("close");
      await stopPromise;

      expect((tunnelManager as any).process).toBeNull();
    });

    it("resolves even if kill throws (process already dead)", async () => {
      await tunnelManager.start(3000);

      mockProcess.kill.mockImplementation(() => {
        throw new Error("Process already killed");
      });

      // Should not throw
      await expect(tunnelManager.stop()).resolves.toBeUndefined();
    });

    it("resolves via timeout if process never closes", async () => {
      vi.useFakeTimers();

      await tunnelManager.start(3000);

      const stopPromise = tunnelManager.stop();

      // Advance past the 5000ms timeout
      await vi.advanceTimersByTimeAsync(5000);
      await stopPromise;

      // Should have resolved without error
      expect(tunnelManager.getInfo().status).toBe("stopped");

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // stop() — no process
  // -------------------------------------------------------------------------

  describe("stop() - no process", () => {
    it("is a no-op when no process is running", async () => {
      expect((tunnelManager as any).process).toBeNull();

      await expect(tunnelManager.stop()).resolves.toBeUndefined();

      expect(tunnelManager.getInfo().status).toBe("stopped");
    });

    it("still sets stoppedByUser flag even with no process", async () => {
      await tunnelManager.stop();
      expect((tunnelManager as any).stoppedByUser).toBe(true);
    });
  });
});
