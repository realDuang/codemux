// ============================================================================
// WeChat iLink Message Transport
// Implements MessageTransport for the WeChat iLink (微信个人号) bot HTTP API.
//
// Protocol notes (verified from hello-halo ilink-api.ts):
//   - Base URL: https://ilinkai.weixin.qq.com (overridable per response)
//   - Headers: Content-Type=application/json, AuthorizationType=ilink_bot_token,
//              X-WECHAT-UIN=<random uint32 base64>, Authorization=Bearer <token>
//   - getupdates is a long-poll (POST, server holds up to 35s)
//   - sendmessage requires per-message context_token (no expiry, server-issued)
//   - errcode/ret == -14 → session expired → re-auth required
// ============================================================================

import https from "https";
import http from "http";
import { URL } from "url";
import { randomUUID } from "crypto";
import type { MessageTransport } from "../streaming/message-transport";
import { channelLog } from "../../services/logger";
import {
  CHANNEL_VERSION,
  ILINK_BASE_URL,
  SESSION_EXPIRED_CODE,
  type GetUpdatesResponse,
  type SendMessageResponse,
} from "./weixin-ilink-types";

const LOG_PREFIX = "[WeixinIlink]";

/** Generate a random uint32 value encoded as base64 — required for X-WECHAT-UIN. */
export function randomUint32Base64(): string {
  const n = Math.floor(Math.random() * 4_294_967_296);
  return Buffer.from(String(n)).toString("base64");
}

/** Build the iLink auth headers. Authorization is included only when botToken is provided. */
export function buildIlinkAuthHeaders(botToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomUint32Base64(),
  };
  if (botToken) {
    headers["Authorization"] = `Bearer ${botToken}`;
  }
  return headers;
}

/**
 * Perform an HTTP(S) JSON request and return the parsed response.
 * Supports AbortSignal cancellation for long-polling cleanup.
 */
export function fetchIlinkJson<T>(
  method: "GET" | "POST",
  urlStr: string,
  headers: Record<string, string>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = { ...headers };
    if (bodyStr) {
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }

    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    if (signal) {
      const onAbort = () => req.destroy(new Error("Aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * WeChat iLink message transport. Handles the iLink HTTP API and tracks
 * per-recipient context_token (required for replies, no expiry).
 *
 * Implements MessageTransport but iLink has no message edit / delete API,
 * so updateText / deleteMessage are no-ops and sendRichContent falls back
 * to sendText (the channel runs in batch mode via StreamingController).
 */
export class WeixinIlinkTransport implements MessageTransport {
  /** Cache: `${accountId}:${userId}` → most recent context_token from that user */
  private readonly contextTokens = new Map<string, string>();

  constructor(
    private botToken: string,
    private baseUrl: string,
    private accountId: string,
  ) {
    if (!this.baseUrl) this.baseUrl = ILINK_BASE_URL;
  }

  /** Update credentials (e.g. after QR re-auth). Clears context_token cache. */
  updateCredentials(botToken: string, baseUrl: string, accountId: string): void {
    this.botToken = botToken;
    this.baseUrl = baseUrl || ILINK_BASE_URL;
    this.accountId = accountId;
    this.contextTokens.clear();
  }

  // -- iLink-specific API --

  /** Long-poll for updates. Returns the raw response so caller can pull cursor. */
  async getUpdates(updatesBuf: string, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    const url = `${this.baseUrl}/ilink/bot/getupdates`;
    const headers = buildIlinkAuthHeaders(this.botToken);
    const body = {
      get_updates_buf: updatesBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    return fetchIlinkJson<GetUpdatesResponse>("POST", url, headers, body, signal);
  }

  /** Send a text message. Requires the per-recipient context_token captured from inbound. */
  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string,
  ): Promise<SendMessageResponse> {
    if (!this.botToken) {
      throw new Error(`${LOG_PREFIX} Cannot send: no botToken configured`);
    }
    if (!contextToken) {
      throw new Error(`${LOG_PREFIX} Cannot send to ${toUserId}: missing context_token`);
    }

    const url = `${this.baseUrl}/ilink/bot/sendmessage`;
    const headers = buildIlinkAuthHeaders(this.botToken);
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    return fetchIlinkJson<SendMessageResponse>("POST", url, headers, body);
  }

  // -- Context token cache --

  /** Build cache key — uses `${accountId}:${userId}` when accountId is known. */
  contextTokenKey(userId: string): string {
    return this.accountId ? `${this.accountId}:${userId}` : userId;
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(this.contextTokenKey(userId), token);
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(this.contextTokenKey(userId));
  }

  clearContextTokens(): void {
    this.contextTokens.clear();
  }

  /** Whether a response code signals session expiry (-14). */
  static isSessionExpired(ret?: number, errcode?: number): boolean {
    return ret === SESSION_EXPIRED_CODE || errcode === SESSION_EXPIRED_CODE;
  }

  // -- MessageTransport interface --

  /**
   * Send a plain text message. The chatId IS the recipient userId for iLink.
   * Returns a synthetic message id (`${chatId}:${epoch}`) — iLink does not
   * return a message id usable for edit/delete (those APIs do not exist).
   */
  async sendText(chatId: string, text: string): Promise<string> {
    const contextToken = this.getContextToken(chatId);
    if (!contextToken) {
      channelLog.warn(
        `${LOG_PREFIX} Cannot send to ${chatId}: no context_token cached (waiting for inbound message)`,
      );
      return "";
    }

    try {
      const resp = await this.sendMessage(chatId, text, contextToken);
      const ret = resp.ret ?? resp.errcode ?? 0;
      if (WeixinIlinkTransport.isSessionExpired(ret, resp.errcode)) {
        throw new Error(`${LOG_PREFIX} Session expired (code -14) — re-auth required`);
      }
      if (ret !== 0) {
        channelLog.error(
          `${LOG_PREFIX} sendmessage to ${chatId} failed: ret=${ret} errmsg=${resp.errmsg ?? ""}`,
        );
        return "";
      }
      return this.composeMessageId(chatId, String(Date.now()));
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send text to ${chatId}:`, err);
      return "";
    }
  }

  /** Send markdown. iLink client auto-renders markdown in text messages. */
  async sendMarkdown(chatId: string, markdown: string): Promise<string> {
    return this.sendText(chatId, markdown);
  }

  /** iLink has no message-edit API. Updates degrade to no-op (batch mode). */
  async updateText(_messageId: string, _text: string): Promise<void> {
    /* not supported by iLink */
  }

  /** iLink has no message-delete API. */
  async deleteMessage(_messageId: string): Promise<void> {
    /* not supported by iLink */
  }

  /** iLink has no rich content; fall back to plain text. */
  async sendRichContent(chatId: string, content: string): Promise<string> {
    return this.sendText(chatId, content);
  }

  /** Compose a synthetic message id "userId:timestamp". */
  composeMessageId(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }
}
