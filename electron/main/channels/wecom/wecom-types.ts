// ============================================================================
// WeCom Channel Types
// Type definitions for the WeCom (企业微信) channel adapter.
// Architecture: P2P (userId) = entry point, Group (chatId) = session interaction.
// ============================================================================

import type { BaseGroupBinding } from "../base-session-mapper";
import { GATEWAY_PORT } from "../../../../shared/ports";

// --- WeCom Configuration ---

export interface WeComConfig {
  /** 企业 ID */
  corpId: string;
  /** 应用 Secret */
  corpSecret: string;
  /** 应用 AgentId */
  agentId: number;
  /** 回调验证 Token */
  callbackToken: string;
  /** 回调加密 Key (Base64, 43 chars) */
  callbackEncodingAESKey: string;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_WECOM_CONFIG: WeComConfig = {
  corpId: "",
  corpSecret: "",
  agentId: 0,
  callbackToken: "",
  callbackEncodingAESKey: "",
  autoApprovePermissions: true,
  gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- Group Binding ---

/** Binding between a WeCom group chat and a CodeMux session */
export interface WeComGroupBinding extends BaseGroupBinding {
  /** UserId of the user who created this group */
  ownerUserId: string;
}

// --- Decrypted Incoming Message ---

/** Decrypted incoming message (parsed from XML callback) */
export interface WeComIncomingMessage {
  /** Receiving CorpID */
  toUserName: string;
  /** Sender UserId */
  fromUserName: string;
  /** Message creation timestamp */
  createTime: number;
  /** Message type: text, image, voice, video, location, link */
  msgType: string;
  /** Text message content (only for msgType=text) */
  content?: string;
  /** Message ID */
  msgId: string;
  /** Application AgentId */
  agentId: number;
}

// --- Command Parser Types ---
// (ParsedCommand moved to ../shared/command-types.ts)

