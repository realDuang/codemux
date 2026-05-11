import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ChannelManager } from "../../../../electron/main/channels/channel-manager";
import { ChannelAdapter, type ChannelConfig, type ChannelInfo } from "../../../../electron/main/channels/channel-adapter";

import { channelLog } from "../../../../electron/main/services/logger";

// --- Mocks ---

const tmpDirBase = path.join(os.tmpdir(), "channel-mgr-test-");
let tmpDir: string;
let channelConfigDir: string;

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => {
        if (name === "userData") return tmpDir;
        return tmpDir;
    }),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  channelLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class MockChannelAdapter extends ChannelAdapter {
  readonly channelType: string;
  private status: ChannelInfo;
  
  constructor(type: string) {
    super();
    this.channelType = type;
    this.status = { type, name: type, status: "stopped" };
  }

  start = vi.fn(async (config: ChannelConfig) => {
    this.status.status = "running";
    this.status.name = config.name;
  });
  stop = vi.fn(async () => {
    this.status.status = "stopped";
  });
  getInfo = vi.fn(() => ({ ...this.status }));
  updateConfig = vi.fn(async (config: Partial<ChannelConfig>) => {
      if (config.name) this.status.name = config.name;
  });
}

describe("ChannelManager", () => {
  let manager: ChannelManager;
  let mockAdapter: MockChannelAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(tmpDirBase);
    channelConfigDir = path.join(tmpDir, "channels");
    manager = new ChannelManager();
    mockAdapter = new MockChannelAdapter("test-channel");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("registerAdapter", () => {
    it("registers adapters and warns on duplicates", () => {
      // registers an adapter and lists it
      manager.registerAdapter(mockAdapter);
      const channels = manager.listChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe("test-channel");
      expect(manager.getStatus("test-channel")).toBeDefined();

      // logs warning and replaces if already registered
      const secondAdapter = new MockChannelAdapter("test-channel");
      manager.registerAdapter(secondAdapter);
      expect(channelLog.warn).toHaveBeenCalledWith(expect.stringContaining("already registered"));
      expect(manager.getStatus("test-channel")).toBeDefined();
    });
  });

  describe("Config Persistence", () => {
    it("manages channel start/stop lifecycle and configuration persistence", async () => {
      manager.registerAdapter(mockAdapter);
      
      // startChannel() creates default config and marks as enabled
      await manager.startChannel("test-channel");
      const config = manager.getConfig("test-channel");
      expect(config?.enabled).toBe(true);

      // stopChannel() marks config as disabled and saves to disk
      await manager.stopChannel("test-channel");
      const configPath = path.join(channelConfigDir, "test-channel.json");
      expect(fs.existsSync(configPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(saved.type).toBe("test-channel");
      expect(saved.enabled).toBe(false);
      expect(mockAdapter.stop).toHaveBeenCalled();
    });

    it("loads existing configuration from disk on start", async () => {
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        const existingConfig: ChannelConfig = {
            type: "test-channel",
            name: "Custom Name",
            enabled: false,
            options: { key: "val" }
        };
        fs.writeFileSync(path.join(channelConfigDir, "test-channel.json"), JSON.stringify(existingConfig));
        manager.registerAdapter(mockAdapter);
        await manager.startChannel("test-channel");
        expect(mockAdapter.start).toHaveBeenCalledWith(expect.objectContaining({
            name: "Custom Name",
            options: { key: "val" }
        }));
        const saved = JSON.parse(fs.readFileSync(path.join(channelConfigDir, "test-channel.json"), "utf-8"));
        expect(saved.enabled).toBe(true);
    });

    it("handles configuration updates and retrieval", async () => {
        manager.registerAdapter(mockAdapter);
        
        // updateConfig() merges updates and notifies adapter
        await manager.startChannel("test-channel");
        await manager.updateConfig("test-channel", { name: "Updated Name", options: { newKey: "newVal" } });
        let saved = JSON.parse(fs.readFileSync(path.join(channelConfigDir, "test-channel.json"), "utf-8"));
        expect(saved.name).toBe("Updated Name");
        expect(saved.options.newKey).toBe("newVal");
        expect(mockAdapter.updateConfig).toHaveBeenCalled();

        // getConfig() returns in-memory config or falls back to disk
        expect(manager.getConfig("test-channel")?.name).toBe("Updated Name");
        expect(manager.getConfig("non-existent")).toBeUndefined();

        // disk fallback test
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        fs.writeFileSync(path.join(channelConfigDir, "disk-channel.json"), JSON.stringify({ type: "disk-channel", name: "Disk Name" }));
        expect(manager.getConfig("disk-channel")?.name).toBe("Disk Name");
    });
  });

  describe("Channel Lifecycle", () => {
    it("handles unknown channels and mass stop operations", async () => {
        // throws for unknown channel type in lifecycle methods
        await expect(manager.startChannel("unknown")).rejects.toThrow("not found");
        await expect(manager.stopChannel("unknown")).rejects.toThrow("not found");
        await expect(manager.updateConfig("unknown", {})).rejects.toThrow("not found");

        // stopAll() stops all running channels and handles failures
        const adapter1 = new MockChannelAdapter("c1");
        const adapter2 = new MockChannelAdapter("c2");
        const adapter3 = new MockChannelAdapter("c3");
        manager.registerAdapter(adapter1);
        manager.registerAdapter(adapter2);
        manager.registerAdapter(adapter3);
        await manager.startChannel("c1");
        await manager.startChannel("c2");
        adapter1.stop.mockRejectedValueOnce(new Error("Stop failed"));
        await manager.stopAll();
        expect(adapter1.stop).toHaveBeenCalled();
        expect(adapter2.stop).toHaveBeenCalled();
        expect(adapter3.stop).not.toHaveBeenCalled();
    });
  });

  describe("initFromConfig", () => {
    it("reconstructs state from persisted configs and injects runtime context", async () => {
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        
        // Setup persisted configs
        fs.writeFileSync(path.join(channelConfigDir, "c1.json"), JSON.stringify({ type: "c1", enabled: true, options: { existing: "val" } }));
        fs.writeFileSync(path.join(channelConfigDir, "c2.json"), JSON.stringify({ type: "c2", enabled: false, options: {} }));
        
        const a1 = new MockChannelAdapter("c1");
        const a2 = new MockChannelAdapter("c2");
        manager.registerAdapter(a1);
        manager.registerAdapter(a2);

        // injects runtime gatewayUrl and handles failures gracefully
        a1.start.mockRejectedValueOnce(new Error("Init start failed"));
        await manager.initFromConfig({ gatewayUrl: "http://gateway" });
        
        expect(a1.start).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ gatewayUrl: "http://gateway", existing: "val" })
        }));
        expect(a2.start).not.toHaveBeenCalled();
    });

    it("handles persisted configs with missing options without throwing", async () => {
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });

        fs.writeFileSync(path.join(channelConfigDir, "c1.json"), JSON.stringify({
            type: "c1",
            enabled: true,
        }));

        const a1 = new MockChannelAdapter("c1");
        manager.registerAdapter(a1);

        await expect(manager.initFromConfig({ gatewayUrl: "http://gateway" })).resolves.toBeUndefined();
        expect(a1.start).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ gatewayUrl: "http://gateway" }),
        }));
    });
  });

  describe("Runtime Options", () => {
    it("applies runtime gatewayUrl to newly created configs after startup", async () => {
      manager.registerAdapter(mockAdapter);

      manager.setRuntimeOptions({ gatewayUrl: "http://gateway" });
      await manager.startChannel("test-channel");

      expect(mockAdapter.start).toHaveBeenCalledWith(expect.objectContaining({
        options: expect.objectContaining({ gatewayUrl: "http://gateway" }),
      }));
      expect(manager.getConfig("test-channel")?.options.gatewayUrl).toBe("http://gateway");
    });

    it("keeps runtime gatewayUrl when updating a new config created after init", async () => {
      manager.registerAdapter(mockAdapter);

      await manager.initFromConfig({ gatewayUrl: "http://gateway" });
      await manager.updateConfig("test-channel", {
        options: { apiKey: "secret" },
      });

      expect(mockAdapter.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        options: expect.objectContaining({
          apiKey: "secret",
          gatewayUrl: "http://gateway",
        }),
      }));

      const configPath = path.join(channelConfigDir, "test-channel.json");
      const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(saved.options.apiKey).toBe("secret");
      expect(saved.options.gatewayUrl).toBeUndefined();
    });

    it("does not overwrite or auto-start again when a channel starts before init completes", async () => {
      if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });

      fs.writeFileSync(path.join(channelConfigDir, "test-channel.json"), JSON.stringify({
        type: "test-channel",
        name: "Persisted Name",
        enabled: true,
        options: { apiKey: "from-disk" },
      }));

      manager.registerAdapter(mockAdapter);
      manager.setRuntimeOptions({ gatewayUrl: "http://gateway" });

      await manager.startChannel("test-channel");
      expect(mockAdapter.start).toHaveBeenCalledTimes(1);

      await manager.initFromConfig({ gatewayUrl: "http://gateway" });

      expect(mockAdapter.start).toHaveBeenCalledTimes(1);
      expect(manager.getConfig("test-channel")).toEqual(expect.objectContaining({
        name: "Persisted Name",
        enabled: true,
        options: expect.objectContaining({
          apiKey: "from-disk",
          gatewayUrl: "http://gateway",
        }),
      }));
    });
  });

  describe("Configuration Filtering and Status", () => {
    it("excludes ephemeral data during save and provides access to channel status", async () => {
        manager.registerAdapter(mockAdapter);
        
        // saveConfig() strips gatewayUrl from persisted options
        await manager.updateConfig("test-channel", { 
            options: { 
                apiKey: "secret",
                gatewayUrl: "http://ephemeral" 
            } 
        });
        const configPath = path.join(channelConfigDir, "test-channel.json");
        const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        expect(saved.options.apiKey).toBe("secret");
        expect(saved.options.gatewayUrl).toBeUndefined();

        // getStatus returns adapter info or undefined
        expect(manager.getStatus("test-channel")?.type).toBe("test-channel");
        expect(manager.getStatus("unknown")).toBeUndefined();
    });
  });

  describe("logoutChannel", () => {
    class LogoutAdapter extends MockChannelAdapter {
      static CLEARED_CREDENTIALS = { apiKey: null, secret: null };
      logout = vi.fn(async () => undefined);
    }

    it("throws for unknown channel type", async () => {
      await expect(manager.logoutChannel("ghost")).rejects.toThrow("not found");
    });

    it("throws when adapter has no logout() method", async () => {
      manager.registerAdapter(mockAdapter);
      await expect(manager.logoutChannel("test-channel")).rejects.toThrow(
        "does not support logout",
      );
    });

    it("calls adapter.logout, persists CLEARED_CREDENTIALS, and disables channel", async () => {
      const adapter = new LogoutAdapter("logout-channel");
      manager.registerAdapter(adapter);
      await manager.startChannel("logout-channel");
      // give it some prior options that should be wiped
      await manager.updateConfig("logout-channel", {
        options: { apiKey: "secret-key", secret: "shh", keepMe: "x" },
      });

      await manager.logoutChannel("logout-channel");

      expect(adapter.logout).toHaveBeenCalledTimes(1);
      const config = manager.getConfig("logout-channel");
      expect(config?.enabled).toBe(false);
      expect(config?.options.apiKey).toBeNull();
      expect(config?.options.secret).toBeNull();
      // updateConfig merges options — unrelated keys are preserved
      expect(config?.options.keepMe).toBe("x");
    });

    it("falls back to {} when adapter has no CLEARED_CREDENTIALS static", async () => {
      class NoStaticLogout extends MockChannelAdapter {
        logout = vi.fn(async () => undefined);
      }
      const adapter = new NoStaticLogout("logout-empty");
      manager.registerAdapter(adapter);
      await manager.startChannel("logout-empty");
      await manager.logoutChannel("logout-empty");
      expect(adapter.logout).toHaveBeenCalled();
      expect(manager.getConfig("logout-empty")?.enabled).toBe(false);
    });
  });

  describe("auth.expired listener", () => {
    it("disables channel and merges clearOptions on auth.expired emission", async () => {
      manager.registerAdapter(mockAdapter);
      await manager.startChannel("test-channel");
      await manager.updateConfig("test-channel", {
        options: { apiKey: "old-key" },
      });

      mockAdapter.emit("auth.expired", {
        reason: "token-expired",
        clearOptions: { apiKey: null },
      });

      // Allow microtask queue to drain (handler is async/void)
      await new Promise((r) => setImmediate(r));

      const cfg = manager.getConfig("test-channel");
      expect(cfg?.enabled).toBe(false);
      expect(cfg?.options.apiKey).toBeNull();
    });

    it("uses {} when clearOptions is omitted", async () => {
      manager.registerAdapter(mockAdapter);
      await manager.startChannel("test-channel");

      mockAdapter.emit("auth.expired", { reason: "x" });
      await new Promise((r) => setImmediate(r));

      expect(manager.getConfig("test-channel")?.enabled).toBe(false);
    });
  });
});
