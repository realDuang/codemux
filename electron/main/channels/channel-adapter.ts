// ============================================================================
// Channel Adapter — Abstract interface for external chat platform integration
// Each platform (Feishu, DingTalk, Slack, etc.) implements this.
// Channels consume Engine capabilities via Gateway WebSocket.
// ============================================================================

import { EventEmitter } from "events";

// --- Channel Capabilities ---

/** Declarative capability flags for a channel platform */
export interface ChannelCapabilities {
  /** Whether sent messages can be updated/edited after sending */
  supportsMessageUpdate: boolean;
  /** Whether sent messages can be deleted */
  supportsMessageDelete: boolean;
  /** Whether the platform supports rich content (cards, embeds, etc.) */
  supportsRichContent: boolean;
  /** Maximum message size in bytes (for truncation) */
  maxMessageBytes: number;
}

// --- Channel Status ---

export type ChannelStatus = "stopped" | "starting" | "running" | "error";

// --- Channel Config ---

export interface ChannelConfig {
  /** Unique channel type identifier (e.g., "feishu", "dingtalk") */
  type: string;
  /** Human-readable display name */
  name: string;
  /** Whether the channel is enabled */
  enabled: boolean;
  /** Channel-specific configuration (e.g., appId, appSecret for Feishu) */
  options: Record<string, unknown>;
}

// --- Channel Info ---

export interface ChannelInfo {
  type: string;
  name: string;
  status: ChannelStatus;
  error?: string;
  /** Channel-specific stats (e.g., connected chats count) */
  stats?: Record<string, unknown>;
}

// --- Channel Adapter Events ---

export interface ChannelAdapterEvents {
  /** Channel connected and ready */
  "connected": () => void;
  /** Channel disconnected */
  "disconnected": (reason: string) => void;
  /** Channel error */
  "error": (err: Error) => void;
  /** Status changed */
  "status.changed": (status: ChannelStatus) => void;
}

// Type-safe event emitter
export declare interface ChannelAdapter {
  on<K extends keyof ChannelAdapterEvents>(
    event: K,
    listener: ChannelAdapterEvents[K],
  ): this;
  off<K extends keyof ChannelAdapterEvents>(
    event: K,
    listener: ChannelAdapterEvents[K],
  ): this;
  emit<K extends keyof ChannelAdapterEvents>(
    event: K,
    ...args: Parameters<ChannelAdapterEvents[K]>
  ): boolean;
}

/**
 * Abstract base class for channel adapters.
 * Each channel platform implementation extends this and provides concrete
 * implementations for all abstract methods.
 */
export abstract class ChannelAdapter extends EventEmitter {
  abstract readonly channelType: string;

  // --- Lifecycle ---

  /** Start the channel (connect to external platform + gateway WS) */
  abstract start(config: ChannelConfig): Promise<void>;

  /** Stop the channel (disconnect everything, clean up) */
  abstract stop(): Promise<void>;

  /** Get current channel info and status */
  abstract getInfo(): ChannelInfo;

  /** Update configuration at runtime (may trigger restart if running) */
  abstract updateConfig(config: Partial<ChannelConfig>): Promise<void>;
}
