// ============================================================================
// Channel Manager — Lifecycle management for channel adapters
// Handles registration, start/stop, config persistence, and status reporting.
// ============================================================================

import fs from "fs";
import path from "path";
import { app } from "electron";
import { channelLog } from "../services/logger";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelInfo,
} from "./channel-adapter";

// --- Config persistence helpers ---

function getChannelConfigDir(): string {
  if (!app.isPackaged) {
    return path.join(process.cwd(), ".channels");
  }
  return path.join(app.getPath("userData"), "channels");
}

function loadConfig(channelType: string): ChannelConfig | null {
  const dir = getChannelConfigDir();
  const filePath = path.join(dir, `${channelType}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ChannelConfig;
  } catch {
    return null;
  }
}

function saveConfig(config: ChannelConfig): void {
  const dir = getChannelConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${config.type}.json`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// --- Channel Manager ---

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private configs = new Map<string, ChannelConfig>();

  /** Register a channel adapter (does not start it) */
  registerAdapter(adapter: ChannelAdapter): void {
    const type = adapter.channelType;
    if (this.adapters.has(type)) {
      channelLog.warn(`Channel adapter '${type}' already registered, replacing`);
    }
    this.adapters.set(type, adapter);
    channelLog.info(`Registered channel adapter: ${type}`);
  }

  /** Load persisted config and auto-start enabled channels */
  async initFromConfig(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      const config = loadConfig(type);
      if (config) {
        this.configs.set(type, config);
        if (config.enabled) {
          channelLog.info(`Auto-starting enabled channel: ${type}`);
          try {
            await adapter.start(config);
          } catch (err) {
            channelLog.error(`Failed to auto-start channel '${type}':`, err);
          }
        }
      }
    }
  }

  /** Start a channel by type */
  async startChannel(type: string): Promise<void> {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Channel adapter '${type}' not found`);
    }

    let config = this.configs.get(type);
    if (!config) {
      // Load from disk or create default
      config = loadConfig(type) ?? {
        type,
        name: type,
        enabled: true,
        options: {},
      };
      this.configs.set(type, config);
    }

    channelLog.info(`Starting channel: ${type}`);
    await adapter.start(config);

    // Mark as enabled in config
    if (!config.enabled) {
      config.enabled = true;
      saveConfig(config);
    }
  }

  /** Stop a channel by type */
  async stopChannel(type: string): Promise<void> {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Channel adapter '${type}' not found`);
    }

    channelLog.info(`Stopping channel: ${type}`);
    await adapter.stop();

    // Mark as disabled in config
    const config = this.configs.get(type);
    if (config && config.enabled) {
      config.enabled = false;
      saveConfig(config);
    }
  }

  /** List all registered channels with status */
  listChannels(): ChannelInfo[] {
    const result: ChannelInfo[] = [];
    for (const adapter of this.adapters.values()) {
      result.push(adapter.getInfo());
    }
    return result;
  }

  /** Get config for a channel */
  getConfig(type: string): ChannelConfig | undefined {
    return this.configs.get(type) ?? loadConfig(type) ?? undefined;
  }

  /** Update channel config and optionally restart */
  async updateConfig(type: string, updates: Partial<ChannelConfig>): Promise<void> {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Channel adapter '${type}' not found`);
    }

    let config = this.configs.get(type);
    if (!config) {
      config = loadConfig(type) ?? {
        type,
        name: type,
        enabled: false,
        options: {},
      };
    }

    // Merge updates
    if (updates.name !== undefined) config.name = updates.name;
    if (updates.enabled !== undefined) config.enabled = updates.enabled;
    if (updates.options !== undefined) {
      config.options = { ...config.options, ...updates.options };
    }

    this.configs.set(type, config);
    saveConfig(config);

    // Notify adapter of config change (may trigger restart)
    await adapter.updateConfig(config);

    channelLog.info(`Updated config for channel: ${type}`);
  }

  /** Get status for a specific channel */
  getStatus(type: string): ChannelInfo | undefined {
    const adapter = this.adapters.get(type);
    return adapter?.getInfo();
  }

  /** Stop all channels (for app shutdown) */
  async stopAll(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [type, adapter] of this.adapters) {
      const info = adapter.getInfo();
      if (info.status === "running" || info.status === "starting") {
        channelLog.info(`Stopping channel on shutdown: ${type}`);
        stopPromises.push(
          adapter.stop().catch((err) => {
            channelLog.error(`Error stopping channel '${type}' during shutdown:`, err);
          }),
        );
      }
    }
    await Promise.all(stopPromises);
  }
}
