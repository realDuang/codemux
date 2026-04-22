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
import type { WebhookServer } from "./webhook-server";

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

  // Exclude ephemeral runtime data (gatewayUrl) from persisted config
  const configToSave = { ...config };
  if (configToSave.options) {
    const { gatewayUrl: _, ...persistentOptions } = configToSave.options as Record<string, unknown>;
    configToSave.options = persistentOptions;
  }

  fs.writeFileSync(tmpPath, JSON.stringify(configToSave, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// --- Channel Manager ---

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private configs = new Map<string, ChannelConfig>();
  private webhookServer: WebhookServer | null = null;
  private runtimeOptions: { gatewayUrl?: string } = {};

  setRuntimeOptions(runtimeOptions: { gatewayUrl?: string }): void {
    this.runtimeOptions = {
      ...this.runtimeOptions,
      ...runtimeOptions,
    };

    for (const config of this.configs.values()) {
      this.applyRuntimeOptions(config);
    }
  }

  private applyRuntimeOptions(config: ChannelConfig): ChannelConfig {
    config.options = { ...(config.options ?? {}) };

    if (this.runtimeOptions.gatewayUrl) {
      config.options.gatewayUrl = this.runtimeOptions.gatewayUrl;
    }

    return config;
  }

  /** Set the shared WebhookServer instance for adapters that need HTTP endpoints */
  setWebhookServer(server: WebhookServer): void {
    this.webhookServer = server;
    // Inject into all already-registered adapters that support it
    for (const adapter of this.adapters.values()) {
      this.injectWebhookServer(adapter);
    }
  }

  /** Register a channel adapter (does not start it) */
  registerAdapter(adapter: ChannelAdapter): void {
    const type = adapter.channelType;
    if (this.adapters.has(type)) {
      channelLog.warn(`Channel adapter '${type}' already registered, replacing`);
    }
    this.adapters.set(type, adapter);
    // Inject webhook server if available
    if (this.webhookServer) {
      this.injectWebhookServer(adapter);
    }
    // When a platform invalidates our auth, persist the credential wipe and
    // mark the channel disabled so it doesn't auto-restart on next launch.
    adapter.on("auth.expired", (payload) => {
      void this.handleAuthExpired(type, payload?.clearOptions);
    });
    channelLog.info(`Registered channel adapter: ${type}`);
  }

  private async handleAuthExpired(
    type: string,
    clearOptions?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.updateConfig(type, {
        enabled: false,
        options: clearOptions ?? {},
      });
      channelLog.info(`Persisted auth-expired wipe for channel: ${type}`);
    } catch (err) {
      channelLog.error(`Failed to persist auth-expired wipe for '${type}':`, err);
    }
  }

  /** Inject WebhookServer into adapters that have a setWebhookServer method */
  private injectWebhookServer(adapter: ChannelAdapter): void {
    if (this.webhookServer && typeof (adapter as any).setWebhookServer === "function") {
      (adapter as any).setWebhookServer(this.webhookServer);
    }
  }

  /** Load persisted config and auto-start enabled channels */
  async initFromConfig(runtimeOptions?: { gatewayUrl?: string }): Promise<void> {
    this.setRuntimeOptions(runtimeOptions ?? {});

    for (const [type, adapter] of this.adapters) {
      const diskConfig = loadConfig(type);
      const existingConfig = this.configs.get(type);
      let config = existingConfig ?? diskConfig;

      if (existingConfig && diskConfig) {
        config = {
          ...diskConfig,
          ...existingConfig,
          options: {
            ...(diskConfig.options ?? {}),
            ...(existingConfig.options ?? {}),
          },
        };
      }

      if (config) {
        this.applyRuntimeOptions(config);
        this.configs.set(type, config);
        if (config.enabled && adapter.getInfo().status === "stopped") {
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

    // Always reload from disk and merge with in-memory config
    const diskConfig = loadConfig(type);
    let config = this.configs.get(type);
    if (!config) {
      config = diskConfig ?? {
        type,
        name: type,
        enabled: true,
        options: {},
      };
    } else if (diskConfig) {
      // Merge: disk as base, in-memory overrides (preserves disk-only fields like tenantId)
      config.options = {
        ...(diskConfig.options ?? {}),
        ...(config.options ?? {}),
      };
    }
    this.applyRuntimeOptions(config);
    this.configs.set(type, config);

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
      const info = adapter.getInfo();
      info.webhookMeta = adapter.getWebhookMeta();
      result.push(info);
    }
    return result;
  }

  /** Get config for a channel */
  getConfig(type: string): ChannelConfig | undefined {
    const config = this.configs.get(type) ?? loadConfig(type) ?? undefined;
    return config ? this.applyRuntimeOptions(config) : undefined;
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
      config.options = {
        ...(config.options ?? {}),
        ...updates.options,
      };
    }

    this.applyRuntimeOptions(config);
    this.configs.set(type, config);
    saveConfig(config);

    // Notify adapter of config change (may trigger restart)
    await adapter.updateConfig(config);

    channelLog.info(`Updated config for channel: ${type}`);
  }

  /** Get status for a specific channel */
  getStatus(type: string): ChannelInfo | undefined {
    const adapter = this.adapters.get(type);
    if (!adapter) return undefined;
    const info = adapter.getInfo();
    info.webhookMeta = adapter.getWebhookMeta();
    return info;
  }

  /**
   * Log out of a channel that supports it (currently WeChat iLink). Drops
   * persisted bindings, wipes the credential fields advertised by the adapter,
   * and marks the channel disabled. Throws if the adapter doesn't expose a
   * `logout()` method.
   */
  async logoutChannel(type: string): Promise<void> {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Channel adapter '${type}' not found`);
    }
    const logoutFn = (adapter as unknown as { logout?: () => Promise<void> }).logout;
    if (typeof logoutFn !== "function") {
      throw new Error(`Channel '${type}' does not support logout`);
    }

    channelLog.info(`Logging out channel: ${type}`);
    await logoutFn.call(adapter);

    // Persist the cleared credentials. Adapters expose the wipe shape via a
    // static CLEARED_CREDENTIALS field; fall back to {} if absent.
    const clearOptions =
      (adapter.constructor as { CLEARED_CREDENTIALS?: Record<string, unknown> })
        .CLEARED_CREDENTIALS ?? {};
    await this.updateConfig(type, { enabled: false, options: clearOptions });
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
