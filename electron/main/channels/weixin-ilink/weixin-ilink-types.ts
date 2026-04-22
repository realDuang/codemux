// ============================================================================
// WeChat iLink Channel Types
// Type definitions for the WeChat iLink (微信个人号) bot channel adapter.
// All chats are P2P (private). iLink does not expose group APIs.
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import { GATEWAY_PORT } from "../../../../shared/ports";

// Re-export shared streaming types for convenience
export type { StreamingSession } from "../streaming/streaming-types";
export { createStreamingSession } from "../streaming/streaming-types";

// --- iLink protocol constants ---

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CHANNEL_VERSION = "1.0.2";
/** errcode / ret value that signals a session expiry requiring re-auth */
export const SESSION_EXPIRED_CODE = -14;

// --- Configuration ---

export interface WeixinIlinkConfig {
  /** Bot token obtained from QR login */
  botToken: string;
  /** Base URL for iLink API (defaults to ILINK_BASE_URL, may be overridden by server response) */
  baseUrl: string;
  /** ilink_bot_id — used as part of context_token cache key */
  accountId: string;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_WEIXIN_ILINK_CONFIG: WeixinIlinkConfig = {
  botToken: "",
  baseUrl: ILINK_BASE_URL,
  accountId: "",
  autoApprovePermissions: true,
  gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- iLink protocol types (snake_case) ---

export interface WeixinMessageItem {
  /** 1=text, 2=image, 3=voice, 4=file, 5=video */
  type: 1 | 2 | 3 | 4 | 5;
  text_item?: { text: string };
  voice_item?: { text: string };
  image_item?: Record<string, unknown>;
  file_item?: { filename?: string };
  video_item?: Record<string, unknown>;
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  /** Server-assigned numeric ID */
  message_id?: number;
  /** 1=USER (inbound), 2=BOT (outbound) */
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: WeixinMessageItem[];
}

export interface GetUpdatesResponse {
  /** May be absent on success — treat missing as 0 */
  ret?: number;
  errcode?: number;
  msgs?: WeixinMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/**
 * QR code request response.
 * iLink returns: { qrcode: string, qrcode_img_content: string (URL) }
 * No `ret` field on success.
 */
export interface GetQrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

/**
 * QR scan status response.
 * iLink returns: { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id? }
 * No `ret` field on success.
 */
export interface QrCodeStatusResponse {
  status?: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// --- P2P chat state (no groups for iLink) ---

export interface WeixinIlinkP2PChatState {
  chatId: string;
  /** WeChat user ID (from_user_id from inbound) */
  userId: string;
  /** Display name (often equals userId for iLink) */
  displayName?: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType?: EngineType;
    projectId: string;
  };
  pendingSelection?: WeixinIlinkPendingSelection;
  tempSession?: WeixinIlinkTempSession;
}

export interface WeixinIlinkTempSession {
  conversationId: string;
  engineType: EngineType;
  directory: string;
  projectId: string;
  lastActiveAt: number;
  streamingSession?: import("../streaming/streaming-types").StreamingSession;
  messageQueue: string[];
  processing: boolean;
}

export interface WeixinIlinkPendingSelection {
  type: "project" | "session";
  projects?: UnifiedProject[];
  sessions?: UnifiedSession[];
  engineType?: EngineType;
  directory?: string;
  projectId?: string;
  projectName?: string;
}

// --- Command parser types ---

export interface ParsedCommand {
  command: string;
  subcommand?: string;
  args: string[];
  raw: string;
}
