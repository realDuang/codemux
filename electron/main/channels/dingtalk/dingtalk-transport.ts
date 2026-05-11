// ============================================================================
// DingTalk Message Transport
// Implements MessageTransport for DingTalk using REST APIs.
// Handles rate limiting and all DingTalk message API calls.
//
// API Reference:
//   - Individual: POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
//   - Group:      POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
//   - Recall:     POST https://api.dingtalk.com/v1.0/robot/otoMessages/batchRecall
//                 POST https://api.dingtalk.com/v1.0/robot/groupMessages/recall
// ============================================================================

import type { MessageTransport } from "../streaming/message-transport";
import type { TokenManager } from "../streaming/token-manager";
import type { TokenBucket } from "../streaming/rate-limiter";
import { dingtalkLog } from "../../services/logger";

/** Base URL for DingTalk new API */
const API_BASE = "https://api.dingtalk.com/v1.0";

export class DingTalkTransport implements MessageTransport {
  constructor(
    private tokenManager: TokenManager,
    private rateLimiter: TokenBucket,
    private robotCode: string,
  ) {}

  // =========================================================================
  // MessageTransport Interface
  // =========================================================================

  /**
   * Send a text message to a DingTalk chat.
   * Uses sampleText msgtype for plain text messages.
   *
   * For group chats, chatId is the openConversationId.
   * For individual chats, chatId is the user's staffId/userId.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();

      // Determine if this is a group or individual message by chatId format.
      // DingTalk openConversationId for groups is typically "cid..." format.
      // We use a heuristic: if it starts with "cid", it's a group chat.
      if (chatId.startsWith("cid")) {
        return await this.sendGroupMessage(token, chatId, "sampleText", text);
      } else {
        return await this.sendIndividualMessage(token, chatId, "sampleText", text);
      }
    } catch (err) {
      dingtalkLog.error("Failed to send text message:", err);
      return "";
    }
  }

  /** Send a markdown-formatted message via DingTalk sampleMarkdown msgKey. */
  async sendMarkdown(chatId: string, markdown: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      if (chatId.startsWith("cid")) {
        return await this.sendGroupMessage(token, chatId, "markdown", markdown);
      } else {
        return await this.sendIndividualMessage(token, chatId, "markdown", markdown);
      }
    } catch (err) {
      dingtalkLog.error("Failed to send markdown message:", err);
      return "";
    }
  }

  /**
   * Update an existing message with new text content.
   * DingTalk does not support editing regular messages natively.
   * This is a no-op — the StreamingController will adapt via capability flags.
   */
  async updateText(_messageId: string, _text: string): Promise<void> {
    // DingTalk does not support message editing for regular robot messages.
    // The adapter uses AI Card (sendCard/updateCard) for streaming instead.
  }

  /**
   * Delete (recall) a message by its processQueryKey.
   * DingTalk supports message recall for robot messages.
   */
  async deleteMessage(messageId: string): Promise<void> {
    if (!messageId) return;

    await this.rateLimiter.consume();
    const token = await this.tokenManager.getToken();

    // Try group recall first, fall back silently if it fails
    const res = await fetch(`${API_BASE}/robot/groupMessages/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode: this.robotCode,
        processQueryKeys: [messageId],
      }),
    });

    if (!res.ok) {
      throw new Error(`DingTalk group recall failed for ${messageId}: ${res.status}`);
    }
  }

  /**
   * Send rich content (ActionCard) to a DingTalk group chat.
   * Uses markdown-based ActionCard for formatted responses.
   */
  async sendRichContent(chatId: string, content: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();

      if (chatId.startsWith("cid")) {
        return await this.sendGroupMessage(token, chatId, "actionCard", content);
      } else {
        // Individual messages: fall back to markdown
        return await this.sendIndividualMessage(token, chatId, "markdown", content);
      }
    } catch (err) {
      dingtalkLog.error("Failed to send rich content:", err);
      return "";
    }
  }

  // =========================================================================
  // Extended Capabilities (AI Card for streaming)
  // =========================================================================

  /**
   * Send an AI Card for streaming updates.
   * Creates a new interactive card instance that can be updated.
   *
   * @param chatId - openConversationId for groups, userId for individuals
   * @param cardData - JSON string with card template and initial content
   * @returns Card instance ID for subsequent updates
   */
  async sendCard(chatId: string, cardData: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();

      const res = await fetch(`${API_BASE}/im/v1.0/robot/interactiveCards/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: cardData,
      });

      if (!res.ok) {
        dingtalkLog.error(`Failed to send card: ${res.status} ${await res.text()}`);
        return "";
      }

      const data = (await res.json()) as { result?: { processQueryKey?: string } };
      return data.result?.processQueryKey ?? "";
    } catch (err) {
      dingtalkLog.error("Failed to send interactive card:", err);
      return "";
    }
  }

  /**
   * Update an interactive card's content (for AI streaming).
   *
   * @param cardId - processQueryKey from sendCard
   * @param content - JSON string with updated card body
   */
  async updateCard(cardId: string, content: string): Promise<void> {
    if (!cardId) return;

    try {
      const token = await this.tokenManager.getToken();

      const res = await fetch(`${API_BASE}/im/v1.0/robot/interactiveCards`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          processQueryKey: cardId,
          cardBizId: cardId,
          cardData: JSON.parse(content),
        }),
      });

      if (!res.ok) {
        dingtalkLog.error(`Failed to update card ${cardId}: ${res.status}`);
      }
    } catch (err) {
      dingtalkLog.error(`Failed to update card ${cardId}:`, err);
    }
  }

  /**
   * Finalize an interactive card (mark streaming as complete).
   */
  async finalizeCard(cardId: string): Promise<void> {
    if (!cardId) return;

    try {
      const token = await this.tokenManager.getToken();

      // Finalize by updating with a "completed" status indicator
      const res = await fetch(`${API_BASE}/im/v1.0/robot/interactiveCards`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          processQueryKey: cardId,
          cardBizId: cardId,
          cardData: { status: "completed" },
        }),
      });

      if (!res.ok) {
        dingtalkLog.verbose(`Card finalize returned ${res.status} (may be expected)`);
      }
    } catch (err) {
      dingtalkLog.error(`Failed to finalize card ${cardId}:`, err);
    }
  }

  // =========================================================================
  // DingTalk-Specific Methods (not part of MessageTransport interface)
  // =========================================================================

  /**
   * Send a message to a specific user via robot oToMessages.
   * Used for both text-based and rich content individual messages.
   */
  async sendMessageToUser(
    userId: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const token = await this.tokenManager.getToken();
      return await this.sendIndividualMessage(token, userId, msgType, content);
    } catch (err) {
      dingtalkLog.error(`Failed to send message to user ${userId}:`, err);
      return "";
    }
  }

  /**
   * Create a DingTalk scene group (场景群).
   *
   * @returns openConversationId of the created group, or empty string on failure
   */
  async createSceneGroup(
    token: string,
    title: string,
    ownerUserId: string,
    userIds: string[],
    templateId?: string,
  ): Promise<string> {
    try {
      const body: Record<string, unknown> = {
        title,
        ownerUserId,
        userIds,
        showHistoryType: 0,
        searchable: 0,
        validationType: 0,
        managementType: 0,
        chatBannedType: 0,
      };
      if (templateId) {
        body.templateId = templateId;
      }

      const res = await fetch(`${API_BASE}/im/interconnections/groups`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        dingtalkLog.error(`Failed to create scene group: ${res.status} ${await res.text()}`);
        return "";
      }

      const data = (await res.json()) as { openConversationId?: string };
      return data.openConversationId ?? "";
    } catch (err) {
      dingtalkLog.error("Failed to create scene group:", err);
      return "";
    }
  }

  // =========================================================================
  // Internal API Methods
  // =========================================================================

  /** Send a message to a group via robot groupMessages API */
  private async sendGroupMessage(
    token: string,
    openConversationId: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    const msgParam = this.buildMsgParam(msgType, content);

    const res = await fetch(`${API_BASE}/robot/groupMessages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode: this.robotCode,
        openConversationId,
        msgParam: JSON.stringify(msgParam),
        msgKey: this.getMsgKey(msgType),
      }),
    });

    if (!res.ok) {
      dingtalkLog.error(`Failed to send group message: ${res.status} ${await res.text()}`);
      return "";
    }

    const data = (await res.json()) as { processQueryKey?: string };
    return data.processQueryKey ?? "";
  }

  /** Send a message to an individual via robot oToMessages API */
  private async sendIndividualMessage(
    token: string,
    userId: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    const msgParam = this.buildMsgParam(msgType, content);

    const res = await fetch(`${API_BASE}/robot/oToMessages/batchSend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode: this.robotCode,
        userIds: [userId],
        msgParam: JSON.stringify(msgParam),
        msgKey: this.getMsgKey(msgType),
      }),
    });

    if (!res.ok) {
      dingtalkLog.error(`Failed to send individual message: ${res.status} ${await res.text()}`);
      return "";
    }

    const data = (await res.json()) as { processQueryKey?: string };
    return data.processQueryKey ?? "";
  }

  /** Build the msgParam object based on message type */
  private buildMsgParam(msgType: string, content: string): Record<string, unknown> {
    switch (msgType) {
      case "actionCard":
        // content is a JSON string with ActionCard fields
        try {
          return JSON.parse(content);
        } catch {
          return { title: "CodeMux", text: content, singleTitle: "查看详情", singleURL: "" };
        }
      case "markdown":
        return { title: "CodeMux", text: content };
      case "sampleText":
      default:
        return { content };
    }
  }

  /** Map message type to DingTalk msgKey */
  private getMsgKey(msgType: string): string {
    switch (msgType) {
      case "actionCard":
        return "sampleActionCard";
      case "markdown":
        return "sampleMarkdown";
      case "sampleText":
      default:
        return "sampleText";
    }
  }
}
