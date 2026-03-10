import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ChannelManager } from "../../electron/main/channels/channel-manager";
import { ChannelAdapter, type ChannelConfig, type ChannelInfo } from "../../electron/main/channels/channel-adapter";

import { channelLog } from "../../electron/main/services/logger";

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

vi.mock("../../electron/main/services/logger", () => ({
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
    channelConfigDir = path.join(tmpDir, ".channels");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    
    manager = new ChannelManager();
    mockAdapter = new MockChannelAdapter("test-channel");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Adapter Registration", () => {
    it("registers an adapter and lists it", () => {
      manager.registerAdapter(mockAdapter);
      const channels = manager.listChannels();
      
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe("test-channel");
      expect(manager.getStatus("test-channel")).toBeDefined();
    });

    it("logs warning and replaces if already registered", () => {
        manager.registerAdapter(mockAdapter);
        const secondAdapter = new MockChannelAdapter("test-channel");
        manager.registerAdapter(secondAdapter);

        expect(channelLog.warn).toHaveBeenCalledWith(expect.stringContaining("already registered"));
        expect(manager.getStatus("test-channel")).toBeDefined();
    });
  });

  describe("Config Persistence", () => {
    it("startChannel() creates default config and marks as enabled", async () => {
      manager.registerAdapter(mockAdapter);
      await manager.startChannel("test-channel");
      
      const config = manager.getConfig("test-channel");
      expect(config?.enabled).toBe(true);
      
      // Toggle to verify persistence logic
      await manager.stopChannel("test-channel");
      const configPath = path.join(channelConfigDir, "test-channel.json");
      expect(fs.existsSync(configPath)).toBe(true);
      
      const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(saved.type).toBe("test-channel");
      expect(saved.enabled).toBe(false);
    });

    it("startChannel() loads existing config from disk", async () => {
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
        
        // Should mark as enabled on disk
        const saved = JSON.parse(fs.readFileSync(path.join(channelConfigDir, "test-channel.json"), "utf-8"));
        expect(saved.enabled).toBe(true);
    });

    it("stopChannel() marks config as disabled and saves to disk", async () => {
        manager.registerAdapter(mockAdapter);
        await manager.startChannel("test-channel"); // starts and enables
        await manager.stopChannel("test-channel");

        const saved = JSON.parse(fs.readFileSync(path.join(channelConfigDir, "test-channel.json"), "utf-8"));
        expect(saved.enabled).toBe(false);
        expect(mockAdapter.stop).toHaveBeenCalled();
    });

    it("updateConfig() merges updates and notifies adapter", async () => {
        manager.registerAdapter(mockAdapter);
        await manager.startChannel("test-channel");
        
        await manager.updateConfig("test-channel", { name: "Updated Name", options: { newKey: "newVal" } });

        const saved = JSON.parse(fs.readFileSync(path.join(channelConfigDir, "test-channel.json"), "utf-8"));
        expect(saved.name).toBe("Updated Name");
        expect(saved.options.newKey).toBe("newVal");
        expect(mockAdapter.updateConfig).toHaveBeenCalled();
    });

    it("getConfig() returns in-memory config or falls back to disk", async () => {
        manager.registerAdapter(mockAdapter);
        
        // Before start, check fallback to disk
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        fs.writeFileSync(path.join(channelConfigDir, "test-channel.json"), JSON.stringify({ type: "test-channel", name: "Disk Name" }));
        
        expect(manager.getConfig("test-channel")?.name).toBe("Disk Name");

        await manager.startChannel("test-channel");
        expect(manager.getConfig("test-channel")?.type).toBe("test-channel");
        
        expect(manager.getConfig("non-existent")).toBeUndefined();
    });
  });

  describe("Channel Lifecycle", () => {
    it("throws for unknown channel type in lifecycle methods", async () => {
        await expect(manager.startChannel("unknown")).rejects.toThrow("not found");
        await expect(manager.stopChannel("unknown")).rejects.toThrow("not found");
        await expect(manager.updateConfig("unknown", {})).rejects.toThrow("not found");
    });

    it("stopAll() stops all running channels and handles failures", async () => {
        const adapter1 = new MockChannelAdapter("c1");
        const adapter2 = new MockChannelAdapter("c2");
        const adapter3 = new MockChannelAdapter("c3");
        
        manager.registerAdapter(adapter1);
        manager.registerAdapter(adapter2);
        manager.registerAdapter(adapter3);

        await manager.startChannel("c1");
        await manager.startChannel("c2");
        // c3 is stopped

        // Mock failure for c1
        adapter1.stop.mockRejectedValueOnce(new Error("Stop failed"));

        await manager.stopAll();

        expect(adapter1.stop).toHaveBeenCalled();
        expect(adapter2.stop).toHaveBeenCalled();
        expect(adapter3.stop).not.toHaveBeenCalled(); // was already stopped
    });
  });

  describe("Init from Config", () => {
    it("loads persisted configs and auto-starts enabled channels", async () => {
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        
        fs.writeFileSync(path.join(channelConfigDir, "c1.json"), JSON.stringify({ type: "c1", enabled: true, options: {} }));
        fs.writeFileSync(path.join(channelConfigDir, "c2.json"), JSON.stringify({ type: "c2", enabled: false, options: {} }));

        const a1 = new MockChannelAdapter("c1");
        const a2 = new MockChannelAdapter("c2");
        manager.registerAdapter(a1);
        manager.registerAdapter(a2);

        await manager.initFromConfig();

        expect(a1.start).toHaveBeenCalled();
        expect(a2.start).not.toHaveBeenCalled();
    });

    it("injects runtime gatewayUrl and handles failures gracefully", async () => {
        if (!fs.existsSync(channelConfigDir)) fs.mkdirSync(channelConfigDir, { recursive: true });
        fs.writeFileSync(path.join(channelConfigDir, "c1.json"), JSON.stringify({ type: "c1", enabled: true, options: { existing: "val" } }));

        const a1 = new MockChannelAdapter("c1");
        manager.registerAdapter(a1);
        
        a1.start.mockRejectedValueOnce(new Error("Init start failed"));

        await manager.initFromConfig({ gatewayUrl: "http://gateway" });

        expect(a1.start).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ gatewayUrl: "http://gateway", existing: "val" })
        }));
    });
  });

  describe("Config Exclusion of gatewayUrl", () => {
    it("saveConfig() strips gatewayUrl from persisted options", async () => {
        manager.registerAdapter(mockAdapter);
        
        // We trigger saveConfig via updateConfig with a gatewayUrl in options
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
    });
  });

  describe("getStatus", () => {
      it("returns adapter info or undefined", () => {
          manager.registerAdapter(mockAdapter);
          expect(manager.getStatus("test-channel")?.type).toBe("test-channel");
          expect(manager.getStatus("unknown")).toBeUndefined();
      });
  });
});
