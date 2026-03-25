// ============================================================================
// WeCom Message Transport
// Implements MessageTransport for WeCom (企业微信).
// Handles sending messages to users and groups via WeCom REST API.
// Note: WeCom does NOT support message editing — updateText is a no-op.
// ============================================================================

import type { MessageTransport } from "../streaming/message-transport";
import type { TokenManager } from "../streaming/token-manager";
import type { TokenBucket } from "../streaming/rate-limiter";
import { channelLog } from "../../services/logger";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

export class WeComTransport implements MessageTransport {
  constructor(
    private tokenManager: TokenManager,
    private rateLimiter: TokenBucket,
    private agentId: number,
  ) {}

  /**
   * Send a text message. Target is encoded as "user:userId" or "group:chatId".
   * Returns a msgid on success, or empty string on failure.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    const { type, id } = this.parseTarget(chatId);
    if (type === "group") {
      return this.sendToGroup(id, "text", { content: text });
    }
    return this.sendToUser(id, "text", { content: text });
  }

  /** WeCom does NOT support message editing — no-op. */
  async updateText(_messageId: string, _text: string): Promise<void> {
    // No-op: WeCom messages cannot be edited after sending
  }

  /** Recall (delete) a message by msgid. */
  async deleteMessage(messageId: string): Promise<void> {
    if (!messageId) return;
    await this.rateLimiter.consume();
    const token = await this.tokenManager.getToken();
    const res = await fetch(`${WECOM_API_BASE}/message/recall?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgid: messageId }),
    });
    const data = (await res.json()) as { errcode: number; errmsg: string };
    if (data.errcode !== 0) {
      throw new Error(`WeCom recall failed for ${messageId}: ${data.errmsg}`);
    }
  }

  /**
   * Send rich content (markdown) message.
   * Target is encoded as "user:userId" or "group:chatId".
   */
  async sendRichContent(chatId: string, content: string): Promise<string> {
    const { type, id } = this.parseTarget(chatId);
    if (type === "group") {
      return this.sendToGroup(id, "markdown", { content });
    }
    return this.sendToUser(id, "markdown", { content });
  }

  // =========================================================================
  // WeCom-specific Methods
  // =========================================================================

  /** Send markdown message to a target. */
  async sendMarkdown(chatId: string, content: string): Promise<string> {
    return this.sendRichContent(chatId, content);
  }

  /** Send a message to an individual user via the message/send API. */
  async sendToUser(
    userId: string,
    msgType: string,
    content: Record<string, string>,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      const payload: Record<string, unknown> = {
        touser: userId,
        msgtype: msgType,
        agentid: this.agentId,
        [msgType]: content,
      };
      const res = await fetch(`${WECOM_API_BASE}/message/send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { errcode: number; errmsg: string; msgid?: string };
      if (data.errcode !== 0) {
        channelLog.error(`[WeCom] Failed to send to user ${userId}: ${data.errmsg}`);
        return "";
      }
      return data.msgid ?? "";
    } catch (err) {
      channelLog.error(`[WeCom] Failed to send to user ${userId}:`, err);
      return "";
    }
  }

  /** Send a message to a group chat via the appchat/send API. */
  async sendToGroup(
    chatId: string,
    msgType: string,
    content: Record<string, string>,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      const payload: Record<string, unknown> = {
        chatid: chatId,
        msgtype: msgType,
        [msgType]: content,
      };
      const res = await fetch(`${WECOM_API_BASE}/appchat/send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { errcode: number; errmsg: string };
      if (data.errcode !== 0) {
        channelLog.error(`[WeCom] Failed to send to group ${chatId}: ${data.errmsg}`);
        return "";
      }
      // appchat/send does not return msgid
      return `group_${chatId}_${Date.now()}`;
    } catch (err) {
      channelLog.error(`[WeCom] Failed to send to group ${chatId}:`, err);
      return "";
    }
  }

  /** Create a group chat via the appchat/create API. */
  async createGroup(
    name: string,
    owner: string,
    userList: string[],
    chatId?: string,
  ): Promise<string | null> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      const payload: Record<string, unknown> = {
        name,
        owner,
        userlist: userList,
      };
      if (chatId) payload.chatid = chatId;

      const res = await fetch(`${WECOM_API_BASE}/appchat/create?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { errcode: number; errmsg: string; chatid?: string };
      if (data.errcode !== 0) {
        channelLog.error(`[WeCom] Failed to create group: ${data.errmsg}`);
        return null;
      }
      return data.chatid ?? null;
    } catch (err) {
      channelLog.error("[WeCom] Failed to create group:", err);
      return null;
    }
  }

  /** Update a group chat via the appchat/update API. */
  async updateGroup(
    chatId: string,
    updates: { name?: string; add_user_list?: string[]; del_user_list?: string[] },
  ): Promise<boolean> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      const payload: Record<string, unknown> = { chatid: chatId, ...updates };
      const res = await fetch(`${WECOM_API_BASE}/appchat/update?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { errcode: number; errmsg: string };
      if (data.errcode !== 0) {
        channelLog.error(`[WeCom] Failed to update group ${chatId}: ${data.errmsg}`);
        return false;
      }
      return true;
    } catch (err) {
      channelLog.error(`[WeCom] Failed to update group ${chatId}:`, err);
      return false;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Parse a target string into type and id.
   * Targets are encoded as "user:userId" or "group:chatId".
   */
  private parseTarget(target: string): { type: "user" | "group"; id: string } {
    if (target.startsWith("group:")) {
      return { type: "group", id: target.slice(6) };
    }
    if (target.startsWith("user:")) {
      return { type: "user", id: target.slice(5) };
    }
    // Default to user target
    return { type: "user", id: target };
  }
}
