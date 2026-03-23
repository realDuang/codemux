// ============================================================================
// Feishu Message Transport
// Implements MessageTransport for Feishu (Lark) using the Lark SDK.
// Handles rate limiting and all Feishu message API calls.
// ============================================================================

import type * as lark from "@larksuiteoapi/node-sdk";
import type { MessageTransport } from "../streaming/message-transport";
import type { TokenBucket } from "../streaming/rate-limiter";
import { feishuLog } from "../../services/logger";

export class FeishuTransport implements MessageTransport {
  constructor(
    private larkClient: lark.Client,
    private rateLimiter: TokenBucket,
  ) {}

  async sendText(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error("Failed to send text message:", err);
      return "";
    }
  }

  async updateText(messageId: string, text: string): Promise<void> {
    if (!messageId) return;

    try {
      await this.rateLimiter.consume();
      await this.larkClient.im.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      feishuLog.error(`Failed to update message ${messageId}:`, err);
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!messageId) return;

    await this.rateLimiter.consume();
    await this.larkClient.im.message.delete({
      path: { message_id: messageId },
    });
  }

  async sendRichContent(chatId: string, cardJson: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: cardJson,
          msg_type: "interactive",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error("Failed to send card message:", err);
      return "";
    }
  }

  /**
   * Send a message using either chat_id or open_id as receive_id.
   * This is Feishu-specific (not part of MessageTransport interface).
   */
  async sendMessageTo(
    receiveId: string,
    receiveIdType: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: receiveIdType as any },
        data: {
          receive_id: receiveId,
          content,
          msg_type: msgType as any,
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error(`Failed to send message (${receiveIdType}=${receiveId}):`, err);
      return "";
    }
  }
}
